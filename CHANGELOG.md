# Changelog

## 0.2.0 (2026-10-21)

- (同步 world 版 0.2.5) 捕获过滤加强：`isInboundUser` 新增黑名单，排除 `.self` 结尾、`meta.kind∈{activity,delivered}`、桌宠互动 `desktop-pet.touch`、`persona` 交接笔记，避免非真人消息污染事实库。
- (同步 world 版 0.2.5) `VectorStore.add` 增加「前 200 字相同」去重，新增 `pendingVectors`/`setVector` 原语与后台回填机制 `backfillVectors`/`scheduleBackfill`；捕获/记忆仅在事实新增时才嵌入，避免重复 embed 与向量堆积；新增 `mem_backfill` 手动回填工具。
- (同步 world 版 0.2.6) 新增 `mem_purge_capture` 清理捕获污染工具：默认仅预览各 scope 条数并标注疑似非真人域，`confirm=1` 才真正删除；`FactStore` 新增 `listScopes`/`purge`。
- (同步 world 版 0.2.7) 记忆页新增「清理捕获污染」存储项：点击弹危险确认框，预览写在 `note` 中，确认后只删除疑似 scope，其余数据不动。

## 0.1.0 (2026-10-19)

- 初版：在 Persona 层面复现 cortico-world-memory 的五层长期记忆系统，发布为 **bot 扩展**（kind=bot, api=7）。
- 记忆归 bot 私有：存于 `persona.memoryDir`，经系统前缀注入对话。
- `systemSegments` 替代 world 的 `envPromptVars` + piggyback 快照（persona 无 `WorldHost.push`，记忆进前缀更干净，且不需要快照去重）。
- 自动捕获改为 **事件驱动**（`onDelivery` 钩子捕获外部用户消息），替代 world 的 30s 轮询定时器，天然不堆积。
- 工具表与 world 版同源（`mem_*` 全部保留），移除 piggyback 推送逻辑。
- `mem_recall` 沿用总量 ≤8000 / 单条 ≤1500 的双截断兜底（防止上下文爆炸）。
- WebUI Memory 页：记忆统计 / 回忆检索 / 重要信息（可删除）/ 知识库列表。
- 导出 / 迁入沿用 cortico-memory-export 规范（specVersion 1，json/markdown/sqlite 同源可互换）。
