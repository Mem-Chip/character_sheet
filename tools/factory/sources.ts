/**
 * 数据化工厂（Node 侧）：任务怎么拼在 src/factory/build.ts（浏览器的自带密钥工具也用它），这里只接上本地数据。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTaskBuilder } from '../../src/factory/build';
import type { TaskInterface } from '../../src/factory';
import type { Json, SheetEnv } from '../../src/sheet';

const DATA = resolve(import.meta.dirname, '..', '..', 'data', '5etools', 'data');
const read = (p: string): Json => JSON.parse(readFileSync(resolve(DATA, p), 'utf8'));
const abilities = (JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'data', 'abilities-2024.json'), 'utf8')) as Json).entries as Record<string, Json>;

const builders = new WeakMap<SheetEnv, ReturnType<typeof createTaskBuilder>>();
const builder = (env: SheetEnv) => {
  let b = builders.get(env);
  if (!b) builders.set(env, (b = createTaskBuilder({ env, abilities, load: async (p) => read(p) })));
  return b;
};

/** 法术文件：XPHB 以外的书按站点的 spells/index.json 找（出题时同步用） */
export function spellsOf(source: string): Json[] {
  if (source === 'XPHB') return read('spells/spells-xphb.json').spell;
  const idx = read('spells/index.json') as Record<string, string>;
  const file = idx[source];
  if (!file) throw new Error(`站点没有 ${source} 的法术文件`);
  return read(`spells/${file}`).spell;
}

export const buildTask = (env: SheetEnv, id: string, key: string, iface?: TaskInterface) => builder(env).buildTask(id, key, iface);
export const ownerView = (env: SheetEnv, key: string) => builder(env).ownerView(key);
