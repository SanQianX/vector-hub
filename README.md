# vector-hub

通用向量检索库 + 可视化控制台，基于 [Vectra](https://github.com/Stevenic/vectra) 构建。

**嵌入式架构**：core 是纯库（零 HTTP / 零 DOM），可以被任何 Node 项目 import；HTTP 层和 UI 是薄的可选附属。**UI 搜索和 AI 调用共用同一个 `/api/search` 接口**——UI 上检索正常，AI 检索就一定正常。

```
┌─────────────┐   fetch /api/search   ┌──────────────┐
│  浏览器 UI   │ ────────────────────▶ │              │
└─────────────┘                        │  vector-hub  │
┌─────────────┐   fetch /api/search   │  ┌────────┐  │      ┌────────┐
│  AI / 后端   │ ────────────────────▶ │  │ server │──┼─────▶│  core  │──▶ Vectra LocalDocumentIndex × N
└─────────────┘                        │  └────────┘  │      └────────┘
                         import { VectorHub } from 'vector-hub' ──────┘（进程内直接调用）
```

## 快速开始

```bash
npm install
npm run build

# 1. 写入示例数据（3 个项目 × 各 3-4 篇中文文档）
MINIMAX_API_KEY=sk-... npm run seed

# 2. 启动服务（REST + 可视化控制台）
MINIMAX_API_KEY=sk-... npm run serve
# 打开 http://localhost:8787
```

Embeddings 提供者可插拔：默认工厂是 MiniMax（`embo-01`，Coding/Token Plan 订阅 key 可直接用），也可用 `createOpenAIEmbeddings` 或任何 Vectra `EmbeddingsModel` 实现。

## 目录结构

```
src/core/       纯库层：VectorHub（多项目管理 + 检索 + 同步）
src/server/     HTTP 层：createServer(hub) → 原生 http.RequestListener，零第三方依赖
src/bin.ts      CLI：serve / sync / watch
ui/index.html   可视化控制台（纯静态单页，零构建）
test/           单元测试（mock embeddings + 内存存储，不碰网络）
scripts/seed.ts 示例数据
data/           运行时数据（每项目一个子文件夹 = 一个独立索引）
```

## REST API（UI 与 AI 的统一入口）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/search?q=&projects=a,b&maxResults=10&minScore=0&isBm25=true` | 跨项目检索，按分数合并排序 |
| GET | `/api/projects` | 项目列表 + 文档/块统计 |
| GET | `/api/health` | 健康检查（含各项目索引状态） |
| POST | `/api/documents` | `{project, uri, text, docType?, metadata?}` 写入 |
| DELETE | `/api/documents?project=&uri=` | 删除文档 |
| POST | `/api/sync` | `{project, sourceDir}` 同步源文件夹（md/txt/html） |

AI 侧调用示例：

```ts
const res = await fetch('http://localhost:8787/api/search?q=' + encodeURIComponent(userQuestion) + '&maxResults=5');
const { results } = await res.json();
// results: [{ project, uri, score, snippet }] — 按 score 降序
```

## 作为库嵌入（进程内，不走 HTTP）

```ts
import { VectorHub, createMiniMaxEmbeddings } from 'vector-hub';

const hub = new VectorHub({
    rootPath: './data',
    embeddings: createMiniMaxEmbeddings(process.env.MINIMAX_API_KEY!),
});

const { results } = await hub.search('怎么接入向量检索', { maxResults: 5, minScore: 0.3 });
await hub.syncFolder('my-project', 'D:/notes');       // 一次性同步文件夹
const watcher = await hub.watchFolder('my-project', 'D:/notes');  // 持续监控
```

## 数据原则

源文件夹是唯一权威数据（source of truth），向量索引是可随时重建的派生缓存。换 embedding 模型、调整切块参数后，删除对应项目文件夹重新 `syncFolder` 即可。

## 开发

```bash
npm test      # 单元测试（无网络依赖）
npm run build # 产 dist/cjs + dist/esm 双格式
```

依赖说明：`vectra` 使用本地路径依赖（`file:../vectra`），因为 `MiniMaxEmbeddings` 适配器尚未发布到 npm；上游合并发布后可换成正式版本号。
