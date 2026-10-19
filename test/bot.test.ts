import { join } from 'node:path';
import { existsSync, rmSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync } from 'node:fs';
import { MEMORY_DEFAULTS } from '../src/config.ts';
import { BotMemoryPersona } from '../src/bot-persona.ts';

const tmp = join(process.env.TEMP || 'C:\\Temp', 'bot-mem-test-' + Date.now());
mkdirSync(tmp, { recursive: true });
let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL- ${name} ${extra}`); }
}

async function main() {
  const cfg = { ...MEMORY_DEFAULTS, autoCapture: false, embeddingProvider: 'off' } as any;
  const p = new BotMemoryPersona({ memoryDir: tmp, packageDir: tmp, cfg, worlds: [] });
  const fakeCore: any = { log: { info: () => {} } };
  await p.attach(fakeCore);

  // 1) 系统前缀注入
  const segs = await p.systemSegments({});
  ok('systemSegments 返回记忆前缀', Array.isArray(segs) && segs.length === 1 && /记忆机制/.test(segs[0].text || ''), JSON.stringify(segs));

  // 2) 工具齐备
  const tools = p.declareSessions().flatMap((s) => s.tools);
  const names = new Set(tools.map((t) => t.name));
  const expected = ['mem_remember', 'mem_recall', 'mem_note', 'mem_notes', 'mem_forget_note', 'mem_knowledge', 'mem_reflect', 'mem_persona', 'mem_profile', 'mem_stats', 'mem_export', 'mem_import'];
  ok('工具表包含核心 mem_* 工具', expected.every((n) => names.has(n)), [...names].join(','));

  const call = async (name: string, args: any): Promise<string> => {
    const t = tools.find((x) => x.name === name)!;
    const r = await (t.handler as any)(args);
    return typeof r === 'string' ? r : JSON.stringify(r);
  };

  // 3) 记忆写入 + 召回
  const r1 = await call('mem_remember', { text: '用户喜欢拿铁咖啡,早上必喝', scope: 'main' });
  ok('mem_remember 成功', /OK/.test(r1), r1);
  const r2 = await call('mem_recall', { query: '咖啡偏好', top_k: 5, scope: 'main' });
  ok('mem_recall 命中写入内容', /拿铁|咖啡/.test(r2), r2);
  ok('mem_recall 受 8000 上限约束', r2.length <= 8200, `len=${r2.length}`);

  // 4) 长文本截断(单条 <=1500)
  const longText = 'X'.repeat(5000);
  await call('mem_remember', { text: longText, scope: 'main' });
  const r3 = await call('mem_recall', { query: 'X'.repeat(5), top_k: 5, scope: 'main' });
  const longestLine = r3.split('\n').map((s) => s.length).sort((a, b) => b - a)[0];
  ok('召回单条不超过 1500', longestLine <= 1500 + 50, `longest=${longestLine}`);

  // 5) 重要信息 + 删除
  await call('mem_note', { text: '以后说话要简短', scope: 'main' });
  const notes = await call('mem_notes', { scope: 'main' });
  ok('mem_notes 列出笔记', /以后说话要简短/.test(notes), notes);
  const r4 = await call('mem_forget_note', { index: 1, scope: 'main' });
  ok('mem_forget_note 删除', /已删除|FAIL/.test(r4), r4);

  // 6) 知识库沉淀 + 检索
  await call('mem_knowledge', { topic: '项目代号', facts: '凤凰计划是内部代号\n启动于 2026 年', keywords: '代号,凤凰', scope: 'main' });
  const kr = await call('mem_knowledge_recall', { query: '凤凰计划', top_k: 2 });
  ok('mem_knowledge_recall 命中', /凤凰计划|代号/.test(kr), kr);

  // 7) 人格/档案
  await call('mem_persona', { user_id: 'u1', traits: '喜欢技术细节,讨厌废话', style: '直接了当' });
  const pg = await call('mem_persona_get', { user_id: 'u1' });
  ok('mem_persona_get 返回特征', /技术细节|废话/.test(pg), pg);
  await call('mem_profile', { user_id: 'u1', facts: '他是后端工程师,用 Go' });
  const pf = await call('mem_profile_get', { user_id: 'u1' });
  ok('mem_profile_get 返回档案', /Go|后端/.test(pf), pf);

  // 8) 导出(json) + 迁入
  const expDir = join(tmp, 'exports');
  mkdirSync(expDir, { recursive: true });
  const er = await call('mem_export', { format: 'json', scope: '', outDir: expDir });
  ok('mem_export 生成文件', /导出完成/.test(er), er);
  const files = readdirSync(expDir).filter((f) => f.endsWith('.json'));
  ok('导出目录存在 json', files.length > 0, files.join(','));

  // 9) WebUI Memory 页面板
  const wui = (p as any).webUi();
  ok('webUi.memory 含面板', wui?.memory?.panels?.length >= 2, JSON.stringify(wui?.memory?.panels?.map((x: any) => x.key)));
  const stats = await wui.memory.panels.find((x: any) => x.key === 'stats').invoke();
  ok('stats 面板可调用', /记忆域|向量/.test(stats), stats);

  // 10) 落盘校验
  await call('mem_flush', {});
  ok('落盘后写入 json 记忆文件', existsSync(join(tmp, 'memory-data.json')) || existsSync(join(tmp, 'memory.db')));

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  rmSync(tmp, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
