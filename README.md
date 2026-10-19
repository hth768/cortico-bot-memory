# cortico-bot-memory

Cortico **bot 模板**：在 **Persona 层面**复现 `cortico-world-memory` 的五层长期记忆系统。
记忆**归 bot 私有**（存于 `persona.memoryDir`），通过系统前缀注入对话、对话实时沉淀，无需挂载 world。

> 与 `cortico-world-memory` 的区别：world 版把记忆作为「注入式」工具挂到任意运行中的 bot 上、记忆共享；本扩展的记忆是 **bot 自己的内部记忆**（Persona），随 bot 走、随 bot 存。

## 记忆模型（与 world 版同源）

- **五层**：事实库 / 知识库 / 反思 / 人格 / 人物档案
- **三级底座**：短期记忆（滚动窗口） / 笔记（硬约束） / 向量记忆（BM25 + 可选 embedding，RRF 融合）
- **混合检索**：`mem_recall` 同时走关键词 + 语义，按 RRF 融合，单条 ≤1500 字、总量 ≤8000 字（防止上下文爆炸）

## 工具（bot 自带，随 Persona 装载）

`mem_remember` `mem_recall` `mem_recent` `mem_overflow` `mem_summary` `mem_topic`
`mem_note` `mem_notes` `mem_forget_note` `mem_knowledge` `mem_knowledge_fact`
`mem_knowledge_recall` `mem_knowledge_list` `mem_reflect` `mem_reflect_rules`
`mem_persona` `mem_persona_get` `mem_persona_global` `mem_profile` `mem_profile_replace`
`mem_profile_get` `mem_stats` `mem_capture_now` `mem_flush` `mem_export` `mem_import`

## 自动捕获

开启 `autoCapture`（默认）后，每轮投递的**外部用户消息**通过 `onDelivery` 钩子实时沉淀进事实库 + 向量库
（按发送者 scope 隔离，QQ 来源自动退化为 `qq:<号>`）。**事件驱动，无 30s 轮询**，天然不会堆积。

## 配置（MemoryConfig，默认值见 `src/config.ts`）

`storageBackend`(json|sqlite) · `embeddingProvider`(off|sidecar) · `maxHistory` · `notesInPrompt`
`autoCapture` · `captureMinLength` · `maxVectorsPerScope` · `vectorTopK` 等。

## WebUI

bot 的 Memory 页提供：记忆统计、回忆/检索、重要信息（可删除）、知识库列表。

## 导出 / 迁入

`mem_export` / `mem_import` 遵循 **cortico-memory-export 规范**（specVersion 1）：同一 `ExportBundle`
可派生 json / markdown / sqlite 三者，内容一致、可互换、可逆向迁入。

## 开发

```bash
npm test            # node --experimental-strip-types 跑 test/bot.test.ts
```

## 发布

```bash
npm publish --no-git-checks --registry=https://registry.npmjs.org/
```
