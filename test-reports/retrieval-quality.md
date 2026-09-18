# 检索质量评估报告（T3 golden set）

- 评估时间：2026-09-18T19:41:48.284Z
- 语料：token-consumption-leaderboard（真实知识库，embo-01 向量）
- 查询数：20（含期望命中文件的标准答案）

## 总体指标

| 模式 | hit@1 | hit@3 | MRR |
|---|---|---|---|
| 纯语义 | 20% (4/20) | 75% (15/20) | 0.446 |
| 混合(BM25) | 20% (4/20) | 55% (11/20) | 0.387 |
| 混合+类型过滤 | 40% (8/20) | 85% (17/20) | 0.604 |

## 逐查询明细（rank 为期望文档的排名，空 = 未进前 10）

### 纯语义

| 查询 | rank | top1 |
|---|---|---|
| 这个项目的目标是什么 | 2 | 2026-06-23_236bd97_rename-cli-to-tokboard.md (0.56) |
| 系统怎么获取 token 用量数据 | 3 | 2026-06-23_236bd97_rename-cli-to-tokboard.md (0.77) |
| CLI 改名为 tokboard | 2 | 00-index.md (0.91) |
| --version 命令行 flag | 2 | cli-binary.md (0.89) |
| 实时 token 计数器 SSE | 3 | ARCHITECTURE.md (0.76) |
| 日历视图 手势 | 1 | 2026-07-07_c90cc94_live+calendar.md (0.77) |
| 架构 数据流 模块划分 | 1 | ARCHITECTURE.md (0.74) |
| localStorage 键迁移 | 1 | 2026-06-23_236bd97_rename-cli-to-tokboard.md (0.94) |
| 所有模块的清单 |  | GOAL.md (0.59) |
| 变更记录的历史清单 |  | docs-screenshots.md (0.39) |
| 产品品牌 设计 |  | README.md (0.41) |
| CLI 二进制 入口 | 2 | ARCHITECTURE.md (0.81) |
| 教练设置 默认值 | 3 | ARCHITECTURE.md (0.66) |
| 截图 文档 站点 | 2 | 00-index.md (0.72) |
| SSE 不可用时的降级策略 | 3 | ARCHITECTURE.md (0.73) |
| message.id 去重 重复计数 |  | live-counter.md (0.65) |
| 监听哪个目录的 jsonl 文件 | 1 | live-counter.md (0.82) |
| 临时目录 TEMP 位置 | 3 | ARCHITECTURE.md (0.64) |
| 如何在脚本里获取版本号 | 4 | product-branding.md (0.82) |
| 前端如何接收实时数据 | 2 | 2026-07-07_c90cc94_live+calendar.md (0.80) |

### 混合(BM25)

| 查询 | rank | top1 |
|---|---|---|
| 这个项目的目标是什么 | 2 | 2026-06-23_236bd97_rename-cli-to-tokboard.md (0.56) |
| 系统怎么获取 token 用量数据 | 1 | GOAL.md (3.23) |
| CLI 改名为 tokboard |  | product-branding.md (7.30) |
| --version 命令行 flag | 3 | 00-index.md (9.23) |
| 实时 token 计数器 SSE | 4 | GOAL.md (3.45) |
| 日历视图 手势 | 1 | 2026-07-07_c90cc94_live+calendar.md (0.77) |
| 架构 数据流 模块划分 | 1 | ARCHITECTURE.md (0.74) |
| localStorage 键迁移 |  | GOAL.md (3.59) |
| 所有模块的清单 |  | GOAL.md (0.59) |
| 变更记录的历史清单 |  | docs-screenshots.md (0.39) |
| 产品品牌 设计 |  | README.md (0.41) |
| CLI 二进制 入口 |  | product-branding.md (4.23) |
| 教练设置 默认值 | 3 | ARCHITECTURE.md (0.66) |
| 截图 文档 站点 | 2 | 00-index.md (0.72) |
| SSE 不可用时的降级策略 | 2 | 2026-07-07_c90cc94_live+calendar.md (3.60) |
| message.id 去重 重复计数 | 1 | 2026-06-27_32ca2a1_live-counter.md (5.75) |
| 监听哪个目录的 jsonl 文件 | 4 | GOAL.md (3.36) |
| 临时目录 TEMP 位置 | 3 | ARCHITECTURE.md (0.64) |
| 如何在脚本里获取版本号 | 4 | product-branding.md (0.82) |
| 前端如何接收实时数据 | 2 | 2026-07-07_c90cc94_live+calendar.md (0.80) |

### 混合+类型过滤

| 查询 | rank | top1 |
|---|---|---|
| 这个项目的目标是什么 | 2 | 2026-06-23_236bd97_rename-cli-to-tokboard.md (0.56) |
| 系统怎么获取 token 用量数据 | 3 | 2026-06-23_236bd97_rename-cli-to-tokboard.md (0.77) |
| CLI 改名为 tokboard | 2 | 00-index.md (0.91) |
| --version 命令行 flag | 2 | cli-binary.md (0.89) |
| 实时 token 计数器 SSE | 3 | ARCHITECTURE.md (0.76) |
| 日历视图 手势 | 1 | 2026-07-07_c90cc94_live+calendar.md (0.77) |
| 架构 数据流 模块划分 | 1 | ARCHITECTURE.md (0.65) |
| localStorage 键迁移 | 1 | 2026-06-23_236bd97_rename-cli-to-tokboard.md (0.94) |
| 所有模块的清单 |  | GOAL.md (0.59) |
| 变更记录的历史清单 | 1 | 00-index.md (0.05) |
| 产品品牌 设计 | 1 | product-branding.md (0.06) |
| CLI 二进制 入口 | 1 | cli-binary.md (0.69) |
| 教练设置 默认值 | 2 | cli-binary.md (0.52) |
| 截图 文档 站点 | 1 | docs-screenshots.md (0.57) |
| SSE 不可用时的降级策略 | 3 | 2026-06-23_4aba528_add-version-flag.md (0.71) |
| message.id 去重 重复计数 |  | live-counter.md (0.65) |
| 监听哪个目录的 jsonl 文件 | 1 | live-counter.md (0.82) |
| 临时目录 TEMP 位置 | 3 | ARCHITECTURE.md (0.64) |
| 如何在脚本里获取版本号 | 4 | product-branding.md (0.82) |
| 前端如何接收实时数据 | 2 | 2026-07-07_c90cc94_live+calendar.md (0.80) |
