import fs from 'node:fs';
import path from 'node:path';

/**
 * T3 retrieval-quality evaluation (golden set).
 *
 * Runs a fixed set of (query → expected file) pairs against the live
 * server in THREE modes — pure semantic, hybrid (BM25), and hybrid +
 * docTypes filter — and reports hit@1 / hit@3 / MRR per mode.
 *
 * Usage: server must be running (real embeddings). Writes
 * test-reports/retrieval-quality.md.
 *
 *   npx tsx scripts/eval-golden.ts [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://localhost:8787';
const PROJECT = 'token-consumption-leaderboard';

/** [query, expectedFiles (any counts as hit), docTypesForFilteredMode?] */
const GOLDEN: [string, string[], string[]?][] = [
    ['这个项目的目标是什么', ['GOAL.md']],
    ['系统怎么获取 token 用量数据', ['GOAL.md', 'ARCHITECTURE.md']],
    ['CLI 改名为 tokboard', ['2026-06-23_236bd97_rename-cli-to-tokboard.md']],
    ['--version 命令行 flag', ['2026-06-23_4aba528_add-version-flag.md']],
    ['实时 token 计数器 SSE', ['2026-06-27_32ca2a1_live-counter.md', 'live-counter.md']],
    ['日历视图 手势', ['2026-07-07_c90cc94_live+calendar.md', 'calendar.md']],
    ['架构 数据流 模块划分', ['ARCHITECTURE.md'], ['architecture', 'module']],
    ['localStorage 键迁移', ['2026-06-23_236bd97_rename-cli-to-tokboard.md']],
    ['所有模块的清单', ['00-index.md']],
    ['变更记录的历史清单', ['00-index.md'], ['change-index']],
    ['产品品牌 设计', ['product-branding.md'], ['module']],
    ['CLI 二进制 入口', ['cli-binary.md'], ['module']],
    ['教练设置 默认值', ['coach-settings.md'], ['module']],
    ['截图 文档 站点', ['docs-screenshots.md'], ['module']],
    ['SSE 不可用时的降级策略', ['2026-06-27_32ca2a1_live-counter.md', 'live-counter.md'], ['change', 'module']],
    ['message.id 去重 重复计数', ['2026-06-27_32ca2a1_live-counter.md']],
    ['监听哪个目录的 jsonl 文件', ['ARCHITECTURE.md', 'live-counter.md']],
    ['临时目录 TEMP 位置', ['2026-06-23_236bd97_rename-cli-to-tokboard.md']],
    ['如何在脚本里获取版本号', ['2026-06-23_4aba528_add-version-flag.md']],
    ['前端如何接收实时数据', ['live-counter.md', '2026-06-27_32ca2a1_live-counter.md']],
];

interface ModeResult {
    hit1: number;
    hit3: number;
    mrrSum: number;
    perQuery: { query: string; rank: number | null; top: string; score: number }[];
}

async function searchOnce(q: string, isBm25: boolean, docTypes?: string[]) {
    const params = new URLSearchParams({ q, projects: PROJECT, maxResults: '10', minScore: '-1' });
    if (isBm25) params.set('isBm25', 'true');
    if (docTypes) params.set('docTypes', docTypes.join(','));
    const res = await fetch(`${BASE}/api/search?${params.toString()}`);
    if (!res.ok) {
        throw new Error(`search failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as { results: { file?: string; uri: string; score: number }[]; errors: { project: string; message: string }[] };
}

function rankOf(files: string[], results: { file?: string; uri: string }[]): number | null {
    for (let i = 0; i < results.length; i++) {
        const name = (results[i].file ?? results[i].uri).split(/[\\/]/).pop() ?? '';
        if (files.some((f) => name == f || (f == '00-index.md' && name == '00-index.md'))) {
            return i + 1;
        }
    }
    return null;
}

async function evaluate(label: string, isBm25: boolean, useFilters: boolean): Promise<ModeResult> {
    const result: ModeResult = { hit1: 0, hit3: 0, mrrSum: 0, perQuery: [] };
    for (const [q, expected, docTypes] of GOLDEN) {
        const { results, errors } = await searchOnce(q, isBm25, useFilters ? docTypes : undefined);
        if (errors.length > 0) {
            console.warn(`  [warn] "${q}" -> ${JSON.stringify(errors)}`);
        }
        const rank = rankOf(expected, results);
        if (rank == 1) result.hit1++;
        if (rank != null && rank <= 3) result.hit3++;
        if (rank != null) result.mrrSum += 1 / rank;
        result.perQuery.push({
            query: q,
            rank,
            top: results[0] ? (results[0].file ?? results[0].uri.split(/[\\/]/).pop() ?? '') : '(无结果)',
            score: results[0]?.score ?? 0,
        });
        // Pace real embedding calls to stay under provider rate limits.
        await new Promise((r) => setTimeout(r, 400));
    }
    console.log(`${label}: hit@1=${result.hit1}/${GOLDEN.length} hit@3=${result.hit3}/${GOLDEN.length} MRR=${(result.mrrSum / GOLDEN.length).toFixed(3)}`);
    return result;
}

async function main(): Promise<void> {
    console.log(`golden set: ${GOLDEN.length} queries against ${BASE} (project: ${PROJECT})\n`);
    const modes: Record<string, ModeResult> = {
        '纯语义': await evaluate('纯语义', false, false),
        '混合(BM25)': await evaluate('混合(BM25)', true, false),
        '混合+类型过滤': await evaluate('混合+类型过滤', true, true),
    };

    const n = GOLDEN.length;
    const lines: string[] = [
        '# 检索质量评估报告（T3 golden set）',
        '',
        `- 评估时间：${new Date().toISOString()}`,
        `- 语料：${PROJECT}（真实知识库，embo-01 向量）`,
        `- 查询数：${n}（含期望命中文件的标准答案）`,
        '',
        '## 总体指标',
        '',
        '| 模式 | hit@1 | hit@3 | MRR |',
        '|---|---|---|---|',
    ];
    for (const [label, m] of Object.entries(modes)) {
        lines.push(`| ${label} | ${(m.hit1 / n * 100).toFixed(0)}% (${m.hit1}/${n}) | ${(m.hit3 / n * 100).toFixed(0)}% (${m.hit3}/${n}) | ${(m.mrrSum / n).toFixed(3)} |`);
    }
    lines.push('', '## 逐查询明细（rank 为期望文档的排名，空 = 未进前 10）', '');
    for (const [label, m] of Object.entries(modes)) {
        lines.push(`### ${label}`, '', '| 查询 | rank | top1 |', '|---|---|---|');
        for (const q of m.perQuery) {
            lines.push(`| ${q.query} | ${q.rank ?? ''} | ${q.top} (${q.score.toFixed(2)}) |`);
        }
        lines.push('');
    }
    const outDir = path.resolve(__dirname, '..', 'test-reports');
    await fs.promises.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, 'retrieval-quality.md');
    await fs.promises.writeFile(outFile, lines.join('\n'), 'utf8');
    console.log(`\nreport written: ${outFile}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
