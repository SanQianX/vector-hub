import path from 'node:path';
import { VectorHub, createMiniMaxEmbeddings } from '../src';

/**
 * Seeds the hub with three demo projects so the console and API can be
 * explored immediately. Requires MINIMAX_API_KEY.
 */
const SEED: Record<string, { uri: string; text: string; docType?: string }[]> = {
    'tech-notes': [
        {
            uri: 'doc://vectra/intro',
            docType: 'md',
            text: '# Vectra 简介\n\nVectra 是一个本地文件型向量数据库。每个索引就是磁盘上的一个文件夹，包含向量、文档全文和目录映射。查询使用余弦相似度排序，小索引延迟在毫秒级。支持 MongoDB 风格的元数据过滤和 BM25 混合搜索。',
        },
        {
            uri: 'doc://vectra/index-types',
            docType: 'md',
            text: '# 索引类型选择\n\nLocalIndex 是底层向量索引，用户自己管理向量和元数据。LocalDocumentIndex 是文档级索引，自动完成切块、向量化、全文存储和片段渲染，适合 RAG 场景。一个向量索引不能混用不同 embedding 模型产生的向量。',
        },
        {
            uri: 'doc://embeddings/minimax',
            docType: 'md',
            text: '# MiniMax 向量模型\n\nMiniMax 的 embo-01 模型输出 1536 维向量，接口不是 OpenAI 兼容格式：请求用 texts 数组且必须带 type 字段（db 表示入库文档，query 表示查询），响应用 vectors 返回。Coding Plan 订阅 key 可以直接调用 embedding 接口，额度从套餐池扣。',
        },
        {
            uri: 'doc://rag/concepts',
            docType: 'md',
            text: '# RAG 核心概念\n\n检索增强生成的流程：把文档切块并向量化入库，用户提问时把问题也向量化，用余弦相似度找出最相关的片段，拼接成上下文交给大模型生成答案。相似度分数用于排序和过滤，不是百分比，阈值需要在自己的语料上校准。',
        },
    ],
    'dev-sessions': [
        {
            uri: 'doc://session/2026-09-15-minimax-adapter',
            docType: 'md',
            text: '# 开发会话：MiniMax 适配器\n\n用户提示词：帮我测试 MiniMax 的 embedding 接口能不能用订阅 key 调用。\n\nLLM 回复：用 curl 向 api.minimax.cn/v1/embeddings 发送 embo-01 请求，返回 1536 维向量，HTTP 200，额度走套餐。注意请求必须带 type 字段。\n\n代码变动：新增 src/MiniMaxEmbeddings.ts 和 8 个单元测试，全部通过。',
        },
        {
            uri: 'doc://session/2026-09-16-vector-hub-design',
            docType: 'md',
            text: '# 开发会话：vector-hub 设计\n\n用户提示词：我想把 Vectra 封装成通用向量检索库，UI 搜索和 AI 调用要走同一个接口。\n\nLLM 回复：推荐分层设计：core 纯库零依赖、server 薄封装提供 /api/search、UI 纯静态页面只调 REST。嵌入式模式，每个项目 import core，数据按项目分索引文件夹。\n\n代码变动：创建 vector-hub 项目，src/core/hub.ts 实现 VectorHub 类，支持多项目并行检索和分数合并。',
        },
        {
            uri: 'doc://session/2026-09-17-retrieval-tuning',
            docType: 'md',
            text: '# 开发会话：检索调参\n\n用户提示词：检索结果里出现了很多无关文档怎么办？\n\nLLM 回复：设置相似度阈值过滤低分结果，开启 BM25 混合搜索提升精确词命中，用 golden set 评估 hit@k 和 MRR 来客观对比参数。\n\n代码变动：UI 增加阈值滑杆和混合搜索开关，状态栏显示每次请求的完整 API URL。',
        },
    ],
    'team-wiki': [
        {
            uri: 'doc://wiki/onboarding',
            docType: 'md',
            text: '# 新人指南\n\n团队知识库使用 markdown 文档管理，源文件夹是唯一权威数据，向量索引是派生缓存可随时重建。遇到检索问题先用控制台搜索验证，再检查项目索引状态。',
        },
        {
            uri: 'doc://wiki/deploy-runbook',
            docType: 'md',
            text: '# 部署手册\n\nvector-hub 服务启动命令：vector-hub serve --port 8787。健康检查访问 /api/health，项目列表访问 /api/projects。服务异常时先看未建索引的项目，再确认 MINIMAX_API_KEY 环境变量。',
        },
        {
            uri: 'doc://wiki/cost-notes',
            docType: 'md',
            text: '# 成本说明\n\nembedding 调用按 token 计费，批量建索引一次约几十分钟。Vectra 的 skip-if-unchanged 机制让内容未变的文档重新同步时零成本。个人知识库场景下 MiniMax 套餐额度绰绰有余。',
        },
    ],
};

async function main(): Promise<void> {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey) {
        console.error('Missing MINIMAX_API_KEY environment variable.');
        process.exit(1);
    }

    const root = path.resolve(process.argv[2] ?? './data');
    const hub = new VectorHub({ rootPath: root, embeddings: createMiniMaxEmbeddings(apiKey) });

    let total = 0;
    for (const [project, docs] of Object.entries(SEED)) {
        for (const doc of docs) {
            await hub.upsertDocument({ project, uri: doc.uri, text: doc.text, docType: doc.docType });
            total++;
            console.log(`  upserted ${project}${path.sep}${doc.uri}`);
        }
    }

    const projects = await hub.listProjects();
    console.log(`\nSeeded ${total} documents into ${root}:`);
    for (const project of projects) {
        console.log(`  ${project.name}: ${project.docCount} docs, ${project.chunkCount} chunks`);
    }
}

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
});
