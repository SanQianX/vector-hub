# vector-hub

Knowledge-engine integrations may opt into `GET /api/search?resultLevel=chunk&perProjectLimit=30`.
Chunk results use cosine scores, LF-normalized indexed-body SHA-256, and half-open UTF-16 character ranges (`startPos`, `endPos`). Document mode remains the default.
Per-project candidate limits prevent a large project from eliminating another project's candidates before the engine applies its scope policy.
Query embeddings are shared across projects and cached in memory for 10 minutes (100 hashed keys maximum); changing models clears the cache. Indexing still uses document embeddings independently.

通用向量检索库 + 可视化控制台，基于 [Vectra](https://github.com/Stevenic/vectra) 构建。

智脑托管模式的索引位置由外壳知识根目录派生（`<knowledge>/.indexes`）。鉴权的运行配置可以切换索引根目录：等待当前写入完成，后续写入使用新目录，并从登记的知识文件重建；旧索引原样保留。配置和凭据不随索引目录搬动，运行期密钥不落盘。独立运行的目录设置仍按原契约工作。

托管模式只同步正式 Markdown，排除 `dev-conversations`、`_ai`、`_backup`、`node_modules` 和隐藏目录。提交会话是分析证据，不直接进入知识向量；同步会移除旧索引里已排除的记录，但保留原证据文件。源策略升级只触发一次派生索引重建。独立控制台继续支持通用文档索引，不受这一托管策略限制。

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

受管 HTTP 写入按项目排队，模型重建的删除和同步共享同一写入队列。索引恢复不会与同项目重建同时写入；失败不阻塞后续重试，不同项目仍可并行。控制台支持知识文档之间的相对 Markdown 链接，读取仍受服务器的项目目录边界限制。

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

## 智脑托管模式

托管服务的供应商凭据来自工作台统一配置，通过鉴权本地运行接口进入内存，浏览器只读取不含密钥的配置状态。重启或撤销配置会清除运行凭据；旧配置迁移保留受保护备份，不修改独立服务的原配置。

嵌入检索页面使用引擎统一的知识事实与来源接口，并保留 vector-hub 的原生检索交互。`embed=1`、可配置 API 基址、同源项目/范围/主题消息避免请求误发到外壳或其他服务。

在托管模式中，引擎负责晋升完成后的索引更新，项目导入强制关闭目录监听，启动时也退出旧 `watch:true` 登记，避免两条更新路径竞态。已有知识和索引不因此删除；独立产品仍可使用 `watchFolder` 和通用管理能力。

## 开发

```bash
npm test      # 单元测试（无网络依赖）
npm run build # 产 dist/cjs + dist/esm 双格式
```

依赖说明：`vectra` 已作为内嵌后端吸收进本仓库（`packages/vectra`，squash 快照——**刻意不带上游历史**，因其中含一个泄漏的 OpenAI key；上游更新用 `git subtree pull -P packages/vectra https://github.com/Stevenic/vectra main --squash`）。`npm run build:all` 先构建 vectra 再构建 vector-hub；`npm run test:vectra` 跑 vectra 测试套件。
