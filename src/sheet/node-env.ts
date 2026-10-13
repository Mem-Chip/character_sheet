/** Node 下建一个规则环境：数据读本地缓存，能力表读 data/*.json */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SheetEnv, type SheetEnvOptions } from './env';
import { DEFAULT_DATA_DIR, dirProvider } from './node-provider';

const DATA = resolve(import.meta.dirname, '..', '..', 'data');
const readJson = (f: string) => JSON.parse(readFileSync(resolve(DATA, f), 'utf8'));

export async function createNodeEnv(o: Partial<SheetEnvOptions> & { dataDir?: string } = {}): Promise<SheetEnv> {
  const env = new SheetEnv({
    provider: o.provider ?? dirProvider(o.dataDir ?? DEFAULT_DATA_DIR),
    builtinAbilities: o.builtinAbilities ?? readJson('abilities-builtin.json').entries,
    abilities: o.abilities === undefined ? readJson('abilities-2024.json').entries : o.abilities,
    homelib: o.homelib,
    log: o.log,
  });
  const bad = await env.init();
  if (bad.length) throw new Error('数据没装载全：' + bad.join(', ') + '（先跑 npm run fetch:data）');
  return env;
}
