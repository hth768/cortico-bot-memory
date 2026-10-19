import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Persona, CoreApi, ToolDef, ToolTag, EventEnvelope } from 'cortico/core/types.ts';
import { MEMORY_DEFAULTS, type MemoryConfig } from './config.ts';
import { MemoryBase } from './memory.ts';
import { EmbeddingClient } from './embedding.ts';
import { VectorStore } from './vector-store.ts';
import { FactStore } from './fact-store.ts';
import { KnowledgeStore } from './knowledge-store.ts';
import { ReflectionStore } from './reflection-store.ts';
import { PersonaStore } from './persona-store.ts';
import { ProfileStore } from './profile-store.ts';
import { createBackend, StoreBackend, ALL_STEMS, backfillSqliteToJson } from './backend.ts';
import { buildBundle, writeBundleJson, writeBundleSqlite, readBundleFromFile, applyBundle, parseFormatTokens, type ImportMode, type ExportBundle } from './migrate.ts';
import { buildView, promptVars } from './observe.ts';
import { formatRecallResults } from './recall.ts';

type _Dict = Record<string, any>;

const MEMORY_DISCIPLINE = `## 记忆机制
- 你拥有自己的长期记忆(五层:事实库/知识库/反思/人格/档案 + 三级记忆底座 + 混合检索)。
- 记忆是你的私事:不要向用户转述"我调用了什么工具",自然地表现出"我记得"就好。

## 使用纪律
1. 别人说"记住这个""以后别这样" → 立刻 mem_note(硬约束/偏好)或 mem_remember(一般事实)。
2. 要找以前聊过/发生过什么 → 先 mem_recall(语义+关键词混合检索),别凭空编造回忆;检索不到就直说想不起来。
3. 反复出现的新约定值得顺手 mem_remember 存档,免得上下文滚掉就忘。
4. 短期记忆快满时用 mem_overflow 取出旧条目,浓缩成一段再用 mem_summary 写回。
5. 话题切换或每轮收尾用 mem_topic 更新当前话题,保持连贯。
一句话:像真人一样记得该记的、忘掉该忘的;要回忆就查库,别装记得。`;

/** 把导出 bundle 渲染为易读 Markdown(与 world 版同源)。 */
function renderMemoryMarkdown(b: _Dict): string {
  const L: string[] = [];
  const profiles = (b.profiles ?? {}) as _Dict;
  const profKeys = Object.keys(profiles);
  const store = (b.memory?.store ?? {}) as _Dict;
  const storeKeys = Object.keys(store);
  const summary = (b.memory?.summary ?? {}) as _Dict;
  const topic = (b.memory?.topic ?? {}) as _Dict;
  const notes = (b.memory?.notes ?? {}) as _Dict;
  const noteKeys = Object.keys(notes);
  const factScopes = (b.facts?.scopes ?? {}) as _Dict;
  const factKeys = Object.keys(factScopes);
  const knowledge = (b.knowledge?.entries ?? []) as any[];
  const reflections = (b.reflection?.reflections ?? []) as any[];
  const rules = (b.reflection?.rules ?? []) as any[];
  const personas = (b.persona?.personas ?? {}) as _Dict;
  const personaKeys = Object.keys(personas);
  const vectorMap = (b.vectors?.vectors ?? {}) as _Dict;
  const vectors = Object.keys(vectorMap).flatMap((sc) => (Array.isArray(vectorMap[sc]) ? (vectorMap[sc] as any[]) : []));

  L.push('# 记忆导出');
  L.push('');
  L.push(`- 导出时间：${b.exportedAt ?? ''}`);
  L.push(`- 作用域：${b.scope ?? 'ALL'}`);
  L.push(`- 存储后端：${b.backend ?? 'unknown'}`);
  L.push('');

  if (profKeys.length) {
    L.push(`## 人物档案 (${profKeys.length})`);
    for (const u of profKeys) {
      L.push(`### ${u}`);
      for (const f of profiles[u]?.facts ?? []) L.push(`- ${f}`);
    }
    L.push('');
  }
  if (storeKeys.length) {
    L.push(`## 短期记忆 (${storeKeys.length} scope)`);
    for (const s of storeKeys) {
      L.push(`### scope: ${s}`);
      for (const it of store[s] ?? []) L.push(`- [${it.role ?? ''}] ${it.content ?? ''}`);
    }
    L.push('');
  }
  const sumKeys = Object.keys(summary);
  if (sumKeys.length || Object.keys(topic).length) {
    L.push('## 总结与主题');
    for (const s of sumKeys) { L.push(`### ${s} 总结`); L.push(summary[s] ?? ''); }
    for (const s of Object.keys(topic)) { L.push(`### ${s} 主题`); L.push(topic[s] ?? ''); }
    L.push('');
  }
  if (noteKeys.length) {
    L.push(`## 笔记 (${noteKeys.length})`);
    for (const s of noteKeys) {
      L.push(`### ${s}`);
      for (const n of notes[s] ?? []) L.push(`- ${n.text ?? ''}`);
    }
    L.push('');
  }
  if (factKeys.length) {
    L.push(`## 事实库 (${factKeys.length} scope)`);
    for (const s of factKeys) {
      L.push(`### ${s}`);
      for (const f of factScopes[s] ?? []) L.push(`- ${f.fact ?? f.text ?? ''}`);
    }
    L.push('');
  }
  if (knowledge.length) {
    L.push(`## 知识库 (${knowledge.length})`);
    for (const e of knowledge) {
      L.push(`### ${e.topic ?? ''}`);
      if (e.keywords?.length) L.push(`关键词：${e.keywords.join(', ')}`);
      for (const f of e.facts ?? []) L.push(`- ${f}`);
    }
    L.push('');
  }
  if (reflections.length || rules.length) {
    L.push(`## 反思与交互规则 (${reflections.length}/${rules.length})`);
    for (const r of reflections) L.push(`- [${r.type}] (${r.userId}) ${r.content ?? ''}`);
    if (rules.length) {
      L.push('### 交互规则');
      for (const r of rules) L.push(`- (${r.userId}) ${r.rule ?? ''}`);
    }
    L.push('');
  }
  if (personaKeys.length || b.persona?.globalStyle) {
    L.push(`## 人格记忆 (${personaKeys.length})`);
    if (b.persona?.globalStyle) L.push(`全局风格：${b.persona.globalStyle}`);
    for (const u of personaKeys) {
      L.push(`### ${u}`);
      L.push(`风格：${personas[u]?.style ?? ''}`);
      for (const t of personas[u]?.traits ?? []) L.push(`- ${t}`);
    }
    L.push('');
  }
  if (vectors.length) {
    L.push(`## 向量记忆 (${vectors.length}, 模型：${b.vectors?.model ?? '未知'})`);
    for (const v of vectors) {
      const txt = typeof v.text === 'string' ? v.text : JSON.stringify(v.text);
      L.push(`- [${v.scope}] ${txt.slice(0, 200)}`);
    }
    L.push('');
  }
  return L.join('\n');
}

/** 清理自动捕获的入站文本:压缩空白。 */
function cleanCaptureText(t: string): string {
  return (t ?? '').replace(/\s+/g, ' ').trim();
}

/** 自动捕获时判断事件是否为「真人入站消息」(只认 origin='external' + 非 bot 自言)。 */
function isInboundUser(e: EventEnvelope): boolean {
  if (e.origin !== 'external') return false; // 排除 internal 回灌 / 记忆自身推送
  const role = (e.meta?.role as string) ?? '';
  if (role === 'assistant' || role === 'bot' || e.meta?.self === true) return false; // 排除 bot 自己
  return true;
}

/** 自动捕获的记忆域(scope):优先按发送者标识隔离;QQ 来源退化为 qq:<号>;否则 main。 */
function scopeOfEvent(e: EventEnvelope): string {
  const meta = (e.meta ?? {}) as Record<string, any>;
  const src = typeof e.source === 'string' ? e.source : '';
  const isQQ = src === 'qqbot';
  if (isQQ) {
    const u = meta.user;
    if (typeof u === 'number' && Number.isFinite(u)) return `qq:${u}`;
    if (typeof u === 'string' && /^\d{4,}$/.test(u.trim())) return `qq:${u.trim()}`;
  }
  const u = meta.user;
  if (typeof u === 'number' && Number.isFinite(u)) return `${src || 'user'}:${u}`;
  if (typeof u === 'string' && u.trim()) return `${src || 'user'}:${u.trim()}`;
  if (typeof e.senderKey === 'string' && e.senderKey.trim()) return e.senderKey.trim();
  if (src) return src;
  return 'main';
}

export interface BotMemoryPersonaOptions {
  memoryDir: string;
  packageDir: string;
  cfg: MemoryConfig;
  worlds: unknown[];
}

export class BotMemoryPersona implements Persona {
  readonly id = 'bot-memory';

  /** 内存记忆对象(供 Memory 页标题/调试)。 */
  memory!: MemoryBase;

  private readonly memoryDir: string;
  private readonly packageDir: string;
  private readonly cfg: MemoryConfig;
  private readonly worlds: unknown[];
  private ready: Promise<void>;
  private core: CoreApi | null = null;

  private vectors!: VectorStore;
  private facts!: FactStore;
  private kb!: KnowledgeStore;
  private reflect!: ReflectionStore;
  private personaStore!: PersonaStore;
  private profile!: ProfileStore;
  private embedder!: EmbeddingClient;
  private backend!: StoreBackend;

  constructor(opts: BotMemoryPersonaOptions) {
    this.memoryDir = opts.memoryDir;
    this.packageDir = opts.packageDir;
    this.cfg = opts.cfg;
    this.worlds = opts.worlds ?? [];
    this.ready = this.init();
  }

  private log(m: string): void {
    try { (this.core?.log?.info ?? console.log).bind(this.core?.log ?? console)('[bot-memory]', m); } catch { console.log('[bot-memory]', m); }
  }

  private async init(): Promise<void> {
    const dataDir = this.memoryDir && this.memoryDir.trim() ? this.memoryDir : '.';
    const kind = this.cfg.storageBackend ?? 'json';
    this.backend = await createBackend(kind, dataDir, (m) => this.log(m));
    if (kind === 'sqlite') {
      this.backend.migrateFromJson(ALL_STEMS);
    } else {
      await backfillSqliteToJson(dataDir, (m) => this.log(m));
    }
    this.memory = new MemoryBase(dataDir, this.cfg.maxHistory, this.backend);
    this.vectors = new VectorStore(dataDir, this.backend);
    this.facts = new FactStore(dataDir, this.backend);
    this.kb = new KnowledgeStore(dataDir, this.backend);
    this.reflect = new ReflectionStore(dataDir, this.backend);
    this.personaStore = new PersonaStore(dataDir, this.backend);
    this.profile = new ProfileStore(dataDir, this.backend);
    this.embedder = new EmbeddingClient(this.cfg);
    this.log(`启动 kind=${kind} maxHistory=${this.cfg.maxHistory} embedding=${this.cfg.embeddingProvider}`);
    if (this.cfg.embeddingProvider === 'sidecar') {
      const ok = await this.embedder.sidecarHealthy();
      this.log(`sidecar 探测: ${ok === true ? '在线' : '不在线(只用 BM25)'}`);
    }
  }

  attach(core: CoreApi): void | Promise<void> {
    this.core = core;
    return this.ready;
  }

  // ---- 记忆上下文:进 system 前缀(替代 world 的 envPrompt + piggyback 快照) ----
  async systemSegments(_ctx: unknown): Promise<Array<{ title?: string; text: string }>> {
    await this.ready;
    if (!this.memory || !this.vectors) return [];
    const view = buildView(this.memory, this.vectors, 'main', this.cfg.notesInPrompt, this.profile);
    const qqNotes = this.memory.getNotes('qq').slice(-this.cfg.notesInPrompt);
    if (qqNotes.length) view.notes = [...view.notes, ...qqNotes].slice(-this.cfg.notesInPrompt);
    const pv = promptVars(view);
    return [{ title: 'memory', text: MEMORY_DISCIPLINE + '\n\n' + (pv.memoryContext || '') }];
  }

  // ---- 工具:mem_* 与 world 版同源(去掉 piggyback 推送) ----
  declareSessions(): Array<{ tools: ToolDef[] }> {
    return [{ tools: Object.values(this.buildTools()) }];
  }

  ownToolNames(): string[] {
    return Object.keys(this.buildTools());
  }

  onIdle?(): void | Promise<void> { /* 记忆为前缀注入,无 piggyback 推送,空闲无需操作 */ }

  /** 自动捕获:每轮投递的真实外部用户消息实时沉淀进事实库/向量库(事件驱动,替代 30s 轮询)。 */
  async onDelivery(events: EventEnvelope[]): Promise<void> {
    await this.ready;
    if (!this.cfg.autoCapture) return;
    let captured = 0;
    for (const e of events ?? []) {
      if (!isInboundUser(e)) continue;
      const text = cleanCaptureText(e.text ?? '');
      if (text.length < (this.cfg.captureMinLength ?? 2)) continue;
      const scope = scopeOfEvent(e);
      this.facts.add(scope, [text]);
      const vec = this.cfg.embeddingProvider === 'off' ? null : await this.embedder.embed(text);
      this.vectors.add(scope, text, vec, this.cfg.maxVectorsPerScope);
      captured++;
    }
    if (captured > 0) { this.facts.flush(); this.vectors.flush(); }
  }

  // ---- WebUI:Memory 页面板 ----
  webUi() {
    return {
      memory: {
        title: '记忆',
        panels: [
          { type: 'text', key: 'stats', title: '记忆统计', refresh: 'auto', invoke: () => this.statsText() },
          { type: 'search', key: 'search', title: '回忆 / 检索', placeholder: '输入想回忆的内容…', invoke: (_p: any, a: any) => this.runRecall(String(a?.query ?? ''), 10, 'main') },
          {
            type: 'list', key: 'notes', title: '重要信息', refresh: 'auto',
            actions: [{ key: 'forget', label: '删除', danger: true }],
            invoke: (p: any, a: any) => {
              if (a?.action === 'forget') this.memory.removeNote('main', Number(a.index) - 1);
              return { items: this.notesList() };
            },
          },
          { type: 'list', key: 'knowledge', title: '知识库', refresh: 'auto', invoke: () => ({ items: this.knowledgeList() }) },
        ] as any[],
      },
    };
  }

  // ---- 内部辅助 ----
  private view() {
    return buildView(this.memory, this.vectors, 'main', this.cfg.notesInPrompt, this.profile);
  }

  private flushAll(): void {
    this.memory?.flush();
    this.vectors?.flush();
    this.facts?.flush();
    this.kb?.flush();
    this.reflect?.flush();
    this.personaStore?.flush();
    this.profile?.flush();
    this.backend?.flush();
  }

  private statsText(): string {
    const stats = this.vectors.stats();
    const sidecar = this.embedder.sidecarHealthy();
    return [
      `记忆域: ${stats.scopes}`,
      `向量索引: ${stats.indexed}/${stats.total}`,
      `向量来源: ${this.cfg.embeddingProvider}`,
      ...(sidecar !== null ? [`sidecar 在线: ${sidecar}`] : []),
      `短期窗口: ${this.cfg.maxHistory}`,
      `自动捕获: ${this.cfg.autoCapture ? '开' : '关'}`,
    ].join('\n');
  }

  private runRecall(query: string, topK: number, scope: string): string {
    if (!query.trim()) return 'OK 请输入想回忆的内容';
    topK = Math.min(20, topK || this.cfg.vectorTopK);
    const vector = this.cfg.embeddingProvider === 'off' ? null : this.embedder.embed(query);
    const global = scope === 'main';
    const hits = global ? this.vectors.hybridSearchAll(query, vector, topK) : this.vectors.hybridSearch(scope, query, vector, topK);
    const facts = global ? this.facts.recallAll(query, topK) : this.facts.recall(scope, query, topK);
    const items: string[] = [];
    const seen = new Set<string>();
    for (const f of facts) if (!seen.has(f.text)) { seen.add(f.text); items.push(f.text); }
    for (const h of hits) if (!seen.has(h.text)) { seen.add(h.text); items.push(h.text); }
    if (!items.length) return `OK ${global ? '全部域' : scope} 里没有匹配「${query}」的记忆`;
    const fmt = formatRecallResults(items, { maxItems: topK });
    const head = fmt.shown < fmt.total ? `（命中 ${fmt.total} 条，按长度上限显示前 ${fmt.shown} 条）\n` : '';
    return `OK ${head}${fmt.body}`;
  }

  private notesList(): Array<{ title: string; action?: string; index?: number }> {
    return this.memory.getNotes('main').map((n, i) => ({ title: n.text, action: 'forget', index: i + 1 }));
  }

  private knowledgeList(): Array<{ title: string; subtitle?: string }> {
    const entries = (this.kb as any).entries ?? [];
    return entries.map((e: any) => ({ title: e.topic ?? '(未命名)', subtitle: `${(e.facts ?? []).length} 条事实` }));
  }

  // ---- 记忆 I/O(导出/迁入,与 world 版共用同一规范) ----
  private async exportMemory(format: string, scope: string, outDir: string): Promise<{ text: string }> {
    const tokens = parseFormatTokens(format);
    if (tokens.size === 0) {
      return { text: '错误：format 只能是 json / markdown / sqlite / both / all（或以逗号、竖线组合的其中几种）。' };
    }
    const dir = (outDir && outDir.trim()) || join(this.memoryDir, 'exports');
    mkdirSync(dir, { recursive: true });
    const bundle = buildBundle(this.backend, scope, this.backend.kind);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const base = `memory-export-${stamp}`;
    const written: string[] = [];
    if (tokens.has('markdown')) { const p = join(dir, `${base}.md`); writeFileSync(p, renderMemoryMarkdown(bundle as unknown as _Dict), 'utf8'); written.push(p); }
    if (tokens.has('json')) { const p = join(dir, `${base}.json`); writeBundleJson(bundle, p); written.push(p); }
    if (tokens.has('sqlite')) { const p = join(dir, `${base}.sqlite`); writeBundleSqlite(bundle, p); written.push(p); }
    const factCount = Object.values(bundle.facts.scopes).reduce((s: number, l: any) => s + (Array.isArray(l) ? l.length : 0), 0);
    const vecCount = Object.values(bundle.vectors.vectors).reduce((s: number, l: any) => s + (Array.isArray(l) ? l.length : 0), 0);
    const counts = [
      `短期记忆 ${Object.keys(bundle.memory.store).length} scope`,
      `笔记 ${Object.keys(bundle.memory.notes).length}`,
      `事实 ${factCount} 条`,
      `向量 ${vecCount}`,
      `知识 ${bundle.knowledge.entries.length} 条`,
      `反思 ${bundle.reflection.reflections.length} / 规则 ${bundle.reflection.rules.length}`,
      `人格 ${Object.keys(bundle.persona.personas).length} 用户`,
      `档案 ${Object.keys(bundle.profiles).length} 用户`,
    ].join(' | ');
    return { text: `记忆导出完成（${scope ? 'scope=' + scope : '全部'}，格式 ${[...tokens].join('+')}）\n${counts}\n文件：\n` + written.map((w) => '- ' + w).join('\n') };
  }

  private async importBundle(filePath: string, mode: ImportMode): Promise<{ text: string }> {
    const backend = this.backend;
    let result: { bundle: ExportBundle; source: string };
    try { result = readBundleFromFile(filePath); } catch (e: any) { return { text: `⚠ 导入失败: ${e?.message ?? e}` }; }
    const { bundle, source } = result;
    this.flushAll();
    const summary = applyBundle(backend, bundle, mode);
    this.reloadStores();
    const scopes = summary.importedScopes.length ? summary.importedScopes.join(', ') : '（无 scope 键）';
    return {
      text:
        `记忆导入完成（来源: ${source}，模式: ${mode}）\n` +
        `写入存储段: ${summary.stems.join(', ')}\n` +
        `涉及 scope: ${scopes}\n` +
        `导出包信息: spec=${bundle.specVersion}, 时间=${bundle.exportedAt}, 原始作用域=${bundle.scope}, 原始后端=${bundle.backend}`,
    };
  }

  private reloadStores(): void {
    const dataDir = this.memoryDir && this.memoryDir.trim() ? this.memoryDir : '.';
    this.memory = new MemoryBase(dataDir, this.cfg.maxHistory, this.backend);
    this.vectors = new VectorStore(dataDir, this.backend);
    this.facts = new FactStore(dataDir, this.backend);
    this.kb = new KnowledgeStore(dataDir, this.backend);
    this.reflect = new ReflectionStore(dataDir, this.backend);
    this.personaStore = new PersonaStore(dataDir, this.backend);
    this.profile = new ProfileStore(dataDir, this.backend);
  }

  // ---- 工具表 ----
  private buildTools(): Record<string, ToolDef> {
    const self = this;
    const str = (title: string) => ({ type: 'string', title });
    const num = (title: string) => ({ type: 'number', title });
    const mk = (
      name: string,
      description: string,
      properties: Record<string, unknown>,
      required: string[],
      tags: ToolTag[],
      run: (a: Record<string, any>) => Promise<string>,
      extra: Partial<ToolDef> = {},
    ): ToolDef => ({
      name,
      description,
      parameters: { type: 'object', additionalProperties: false, properties, required },
      tags,
      handler: async (args) => {
        try { await self.ready; return await run(args); } catch (e: any) { return `⚠ 调用失败: ${e?.message ?? e}`; }
      },
      ...extra,
    });

    const scopeOf = (a: Record<string, any>) => (typeof a.scope === 'string' && a.scope.trim() ? a.scope.trim() : 'main');

    return {
      mem_remember: mk('mem_remember', '把一件值得长期记住的事写进记忆库(同时落「事实库」做去重重排 + 建向量索引,之后 mem_recall 可按语义找回)。', { text: str('内容'), scope: str('记忆域') }, ['text'], ['write'],
        async (a) => {
          const scope = scopeOf(a);
          const text = String(a.text);
          const added = self.facts.add(scope, [text]);
          self.vectors.add(scope, text, self.cfg.embeddingProvider === 'off' ? null : await self.embedder.embed(text), self.cfg.maxVectorsPerScope);
          return added ? `OK 已记住(${scope}): ${text.slice(0, 80)}` : `OK 已存在,跳过重复(${scope})`;
        }),
      mem_recall: mk('mem_recall', '按语义+关键词混合检索长期记忆(事实库全文 + BM25+向量+RRF 融合)。scope 留空或填 main = 跨全部记忆域;填具体 scope 只搜该域;可填 qq:<QQ号> 检索某人在私聊与群聊里统一沉淀的记忆。', { query: str('查询'), top_k: num('条数'), scope: str('记忆域(留空=全部)') }, ['query'], ['read'],
        async (a) => self.runRecall(String(a.query), Number(a.top_k) || self.cfg.vectorTopK, scopeOf(a))),
      mem_recent: mk('mem_recent', '回看本域最近的短期对话(最多 maxHistory 条)。', { n: num('条数'), scope: str('记忆域') }, [], ['read', 'snapshot'],
        async (a) => {
          const items = self.memory.recent(scopeOf(a), Number(a.n) || 10);
          if (!items.length) return 'OK 短期记忆是空的';
          return `OK\n${items.map((it) => `${it.role}: ${it.content.slice(0, 120)}`).join('\n')}`;
        }),
      mem_overflow: mk('mem_overflow', '短期记忆快满时,取出最旧的一半条目(出窗),让它们被压缩进 mem_summary。', { scope: str('记忆域') }, [], ['act'],
        async (a) => {
          const items = self.memory.overflowItems(scopeOf(a));
          if (!items) return 'OK 短期记忆还没满,无需压缩';
          return `OK 取出 ${items.length} 条:\n${items.map((it) => `${it.role}: ${it.content.slice(0, 120)}`).join('\n')}`;
        }),
      mem_summary: mk('mem_summary', '读或写本域的对话摘要。带 text 为写;不带为读。', { text: str('摘要内容'), scope: str('记忆域') }, [], ['read', 'write'],
        async (a) => {
          const scope = scopeOf(a);
          if (typeof a.text === 'string' && a.text.trim()) { self.memory.setSummary(scope, String(a.text)); return `OK 摘要已更新(${scope})`; }
          const s = self.memory.getSummary(scope);
          return s ? `OK 当前摘要: ${s}` : `OK ${scope} 还没有摘要`;
        }),
      mem_topic: mk('mem_topic', '读或写当前话题(话题切换时更新它,帮助上下文连贯)。', { text: str('话题内容'), scope: str('记忆域') }, [], ['read', 'write'],
        async (a) => {
          const scope = scopeOf(a);
          if (typeof a.text === 'string' && a.text.trim()) { self.memory.setTopic(scope, String(a.text)); return `OK 话题已更新(${scope})`; }
          const t = self.memory.getTopic(scope);
          return t ? `OK 当前话题: ${t}` : `OK ${scope} 还没有设定话题`;
        }),
      mem_note: mk('mem_note', '记一条「重要信息」(用户明确要求记住的事/硬约束),它会常驻进环境提示词。', { text: str('内容'), scope: str('记忆域') }, ['text'], ['write'],
        async (a) => { const n = self.memory.addNote(scopeOf(a), String(a.text)); return `OK 重要信息 #${n} 已记录`; }),
      mem_notes: mk('mem_notes', '列出本域的全部「重要信息」及编号(编号用于删除)。', { scope: str('记忆域') }, [], ['read'],
        async (a) => {
          const notes = self.memory.getNotes(scopeOf(a));
          if (!notes.length) return 'OK 还没有重要信息';
          return `OK\n${notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n')}`;
        }),
      mem_forget_note: mk('mem_forget_note', '按编号(1 起)删掉一条「重要信息」。先 mem_notes 确认编号再用。', { index: num('编号'), scope: str('记忆域') }, ['index'], ['write'],
        async (a) => { const ok = self.memory.removeNote(scopeOf(a), Number(a.index) - 1); return ok ? 'OK 已删除' : `FAIL 没有第 ${Number(a.index)} 条`; }),
      mem_knowledge: mk('mem_knowledge', '沉淀一条「通用知识」(主题化的知识条目,区别于 mem_remember 的零散事实)。同主题会合并,事实级去重。', { topic: str('主题'), facts: str('知识要点(多条用换行分隔)'), keywords: str('关键词(逗号分隔,可选)'), sources: str('来源(逗号分隔,可选)') }, ['topic', 'facts'], ['write'],
        async (a) => {
          const topic = String(a.topic ?? '').trim();
          const facts = String(a.facts ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
          const keywords = (typeof a.keywords === 'string' ? a.keywords : '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
          const sources = (typeof a.sources === 'string' ? a.sources : '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
          const r = self.kb.addEntry(topic, facts, keywords, sources);
          if (!r.ok) return 'FAIL 主题和要点不能为空';
          return `OK ${r.merged ? '已并入已有主题' : '新主题'}「${topic}」,新增 ${r.newFacts} 条事实,知识库共 ${r.total} 条`;
        }),
      mem_knowledge_fact: mk('mem_knowledge_fact', '把单条知识文本直接记进知识库(主题取前 30 字,自动提炼关键词)。', { content: str('知识内容') }, ['content'], ['write'],
        async (a) => { const r = self.kb.addFact(String(a.content ?? '')); return r.ok ? `OK 已沉淀(${r.merged ? '并入已有主题' : '新主题'}),知识库共 ${r.total} 条` : 'FAIL 内容为空'; }),
      mem_knowledge_recall: mk('mem_knowledge_recall', '回答问题前先查知识库,命中就直接复用(省去重复搜索)。返回最相关主题及要点。', { query: str('查询/问题'), top_k: num('条数') }, ['query'], ['read'],
        async (a) => {
          const hits = self.kb.recall(String(a.query ?? ''), Math.min(10, Number(a.top_k) || 2));
          if (!hits.length) return 'OK 知识库里没有相关条目';
          return `OK 命中 ${hits.length} 条:\n` + hits.map((e) => {
            const lines = e.facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
            return `◆ ${e.topic}（学习日期 ${e.learnedAt}）\n${lines}`;
          }).join('\n');
        }),
      mem_knowledge_list: mk('mem_knowledge_list', '列出知识库全部主题及数量。', { limit: num('条数') }, [], ['read'],
        async () => { const n = self.kb.count(); return n ? `OK 知识库共 ${n} 条主题` : 'OK 知识库还是空的'; }),
      mem_reflect: mk('mem_reflect', '沉淀一条「反思/交互偏好/纠错」(preference/style/insight/correction/pattern)。可执行的会被提炼为常驻交互规则。', { content: str('反思内容(一句话)'), type: str('类型:preference/style/insight/correction/pattern'), evidence: str('支撑证据(可选)'), user_id: str('用户ID(默认 main)'), confidence: num('置信度0-1'), actionable: num('是否可执行(1/0)') }, ['content', 'type'], ['write'],
        async (a) => {
          const type = String(a.type ?? 'insight');
          if (!['preference', 'style', 'insight', 'correction', 'pattern'].includes(type)) return 'FAIL 类型必须是 preference/style/insight/correction/pattern 之一';
          const r = self.reflect.reflect(String(a.content ?? ''), type as any, String(a.user_id ?? 'main'), typeof a.evidence === 'string' ? a.evidence : undefined, typeof a.confidence === 'number' ? Math.max(0, Math.min(1, a.confidence)) : 0.6, Number(a.actionable ?? 1) >= 1);
          return r.added ? `OK 反思已沉淀(${type});可执行的已提炼为交互规则` : 'FAIL 内容为空或重复';
        }),
      mem_reflect_rules: mk('mem_reflect_rules', '列出已沉淀的交互规则(从可执行反思提炼,常驻指导后续交互)。', { user_id: str('用户ID(默认 main)') }, [], ['read'],
        async (a) => {
          const { rules } = self.reflect.getFor(String(a.user_id ?? 'main'));
          if (!rules.length) return 'OK 还没有交互规则';
          return `OK 交互规则(${rules.length}):\n` + rules.map((r, i) => `${i + 1}. [${r.type}] ${r.rule} (置信 ${(r.confidence ?? 0).toFixed(2)})`).join('\n');
        }),
      mem_persona: mk('mem_persona', '记录与某用户的独特相处模式(特征列表 + 风格描述,per-user 隔离、特征去重、上限20)。', { user_id: str('用户ID(默认 main)'), traits: str('相处特征(多条用换行或逗号分隔)'), style: str('整体风格描述(可选)') }, ['user_id', 'traits'], ['write'],
        async (a) => {
          const uid = String(a.user_id ?? 'main');
          const traits = String(a.traits ?? '').split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
          const r = self.personaStore.update(uid, traits, typeof a.style === 'string' ? a.style : '');
          return `OK 已更新 ${uid} 的人格记忆,当前特征 ${r.traits} 条`;
        }),
      mem_persona_get: mk('mem_persona_get', '读取某用户的人格记忆(特征+风格),不存在则提示。', { user_id: str('用户ID(默认 main)') }, [], ['read'],
        async (a) => {
          const p = self.personaStore.get(String(a.user_id ?? 'main'));
          if (!p) return 'OK 还没有这个人设记忆';
          const traits = p.traits.length ? p.traits.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(无特征)';
          return `OK 人格记忆:\n特征:\n${traits}${p.style ? `\n风格: ${p.style}` : ''}`;
        }),
      mem_persona_global: mk('mem_persona_global', '设置/读取全局风格(跨用户统一的人格基调,可选)。', { style: str('全局风格(留空为读)') }, [], ['read', 'write'],
        async (a) => {
          if (typeof a.style === 'string' && a.style.trim()) { self.personaStore.setGlobalStyle(a.style); return 'OK 全局风格已更新'; }
          const g = self.personaStore.getGlobalStyle();
          return g ? `OK 全局风格: ${g}` : 'OK 还没有设置全局风格';
        }),
      mem_profile: mk('mem_profile', '记/更新某用户的「人物档案」(称呼/身份/关系等),常驻进环境提示词。合并新事实+去重+上限50。', { user_id: str('用户ID(默认 main)'), facts: str('人物事实(多条用换行或逗号分隔)') }, ['user_id', 'facts'], ['write'],
        async (a) => {
          const uid = String(a.user_id ?? 'main');
          const facts = String(a.facts ?? '').split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
          const r = self.profile.update(uid, facts);
          return `OK 已更新 ${uid} 人物档案,当前 ${r.total} 条`;
        }),
      mem_profile_replace: mk('mem_profile_replace', '整体替换某用户人物档案(用于纠错)。', { user_id: str('用户ID(默认 main)'), facts: str('正确的人物事实(多条用换行或逗号分隔)') }, ['user_id', 'facts'], ['write'],
        async (a) => {
          const uid = String(a.user_id ?? 'main');
          const facts = String(a.facts ?? '').split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
          const r = self.profile.replace(uid, facts);
          return `OK 已替换 ${uid} 人物档案,当前 ${r.total} 条`;
        }),
      mem_profile_get: mk('mem_profile_get', '读取某用户人物档案。', { user_id: str('用户ID(默认 main)') }, [], ['read'],
        async (a) => {
          const facts = self.profile.get(String(a.user_id ?? 'main'));
          return facts.length ? `OK 人物档案:\n${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}` : 'OK 还没有人物档案';
        }),
      mem_stats: mk('mem_stats', '记忆库统计:记忆域/条数/向量索引覆盖/当前配置的向量来源。', {}, [], ['snapshot', 'read'],
        async () => {
          const stats = self.vectors.stats();
          const sidecar = await self.embedder.sidecarHealthy();
          return `OK ${JSON.stringify({ scopes: stats.scopes, total: stats.total, indexed: stats.indexed, embedding: self.cfg.embeddingProvider, ...(sidecar !== null ? { sidecarOnline: sidecar } : {}), maxHistory: self.cfg.maxHistory })}`;
        }),
      mem_capture_now: mk('mem_capture_now', '把记忆立即落盘并报告状态(自动捕获为事件驱动,对话实时沉淀,无需轮询)。', {}, [], ['act'],
        async () => {
          self.flushAll();
          const stats = self.vectors.stats();
          return `OK 已落盘;自动捕获=${self.cfg.autoCapture ? '开' : '关'};当前向量索引 ${stats.indexed}/${stats.total} 条`;
        }),
      mem_flush: mk('mem_flush', '把记忆立即落盘(平时自动防抖落盘,一般不用调)。', {}, [], ['act'],
        async () => { self.flushAll(); return 'OK 已落盘'; }),
      mem_export: mk('mem_export', '把全部记忆导出为文件(json/markdown/sqlite 三选,导出与迁入共用同一 cortico-memory-export 规范)。知识库全局包含,其他可按作用域/用户过滤。',
        { format: { type: 'string', optional: true, title: '格式', description: "json | markdown | sqlite | both(json+md) | all(三者),或用逗号/竖线组合;默认 both。" }, scope: { type: 'string', optional: true, title: '作用域过滤' }, outDir: { type: 'string', optional: true, title: '导出目录' } },
        [], ['act'],
        async (args: _Dict) => {
          const format = typeof args.format === 'string' ? args.format.trim().toLowerCase() : 'both';
          const scope = typeof args.scope === 'string' ? args.scope.trim() : '';
          const outDir = typeof args.outDir === 'string' ? args.outDir.trim() : '';
          return await self.exportMemory(format, scope, outDir);
        }),
      mem_import: mk('mem_import', '把导出的记忆文件(.json 或 .sqlite,遵循 cortico-memory-export 规范)迁移/恢复进当前记忆库。默认 merge;可选 replace 覆盖数组型内容。',
        { path: { type: 'string', title: '文件路径' }, mode: { type: 'string', optional: true, title: '合并模式', description: "merge(默认) | replace。" } },
        ['path'], ['write', 'act'],
        async (args: _Dict) => {
          const p = typeof args.path === 'string' ? args.path.trim() : '';
          if (!p) return { text: '错误：必须提供 path(导出文件路径)。' } as any;
          const mode: ImportMode = args.mode === 'replace' ? 'replace' : 'merge';
          return await self.importBundle(p, mode);
        }),
    };
  }
}
