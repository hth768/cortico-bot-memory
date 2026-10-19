# Changelog

## 0.1.0 (2026-10-19)

- 初版：在 Persona 层面复现 cortico-world-memory 的五层长期记忆系统，发布为 **bot 扩展**（kind=bot, api=7）。
- 记忆归 bot 私有：存于 `persona.memoryDir`，经系统前缀注入对话。
- `systemSegments` 替代 world 的 `envPromptVars` + piggyback 快照（persona 无 `WorldHost.push`，记忆进前缀更干净，且不需要快照去重）。
- 自动捕获改为 **事件驱动**（`onDelivery` 钩子捕获外部用户消息），替代 world 的 30s 轮询定时器，天然不堆积。
- 工具表与 world 版同源（`mem_*` 全部保留），移除 piggyback 推送逻辑。
- `mem_recall` 沿用总量 ≤8000 / 单条 ≤1500 的双截断兜底（防止上下文爆炸）。
- WebUI Memory 页：记忆统计 / 回忆检索 / 重要信息（可删除）/ 知识库列表。
- 导出 / 迁入沿用 cortico-memory-export 规范（specVersion 1，json/markdown/sqlite 同源可互换）。
