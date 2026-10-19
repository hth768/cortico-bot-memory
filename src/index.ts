import type { BotDefinition } from 'cortico/bot.ts';
import type { World } from 'cortico/core/types.ts';
import { MEMORY_DEFAULTS } from './config.ts';
import type { MemoryConfig } from './config.ts';
import { BotMemoryPersona } from './bot-persona.ts';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const id = 'bot-memory';

function resolveConfig(loaded: { cfg?: Record<string, any> }): MemoryConfig {
  const cfg = { ...MEMORY_DEFAULTS, ...(loaded.cfg ?? {}) } as MemoryConfig;
  return cfg;
}

const def: BotDefinition = {
  id,
  defaults() {
    return {
      ...MEMORY_DEFAULTS,
      memoryName: '记忆',
    } as any;
  },
  build(loaded: any, worlds: World[]): { persona: BotMemoryPersona } {
    const cfg = resolveConfig(loaded);
    const memoryDir = (typeof loaded.memoryDir === 'string' && loaded.memoryDir) ? loaded.memoryDir : '.';
    const packageDir = (typeof loaded.packageDir === 'string' && loaded.packageDir) ? loaded.packageDir : fileURLToPath(new URL('..', import.meta.url));
    return {
      persona: new BotMemoryPersona({ memoryDir, packageDir, cfg, worlds } as any),
    };
  },
};

// 让框架 dry-mount 自检在找不到真实 loaded 时不崩(只用 default 导出)。
export default def;
export { def };
// 避免某些打包器因未使用导入而报错。
void writeFileSync;
