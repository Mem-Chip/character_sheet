/**
 * 浏览器里的规则环境：静态层（SheetEnv）+ 战斗规则书（RuleBook）。整个页面共用一份。
 *
 * 数据：开发时从本地缓存（vite 中间件挂在 /5etools/）取；取不到再去站点。
 */
import abilities2024 from '../../data/abilities-2024.json';
import abilitiesBuiltin from '../../data/abilities-builtin.json';
import { RuleBook } from '../../src/combat';
import { RULE_FILES } from '../../src/bridge/rule-files';
import { BASE_URL, SheetEnv, type DataProvider } from '../../src/sheet';

const memo = new Map<string, Promise<unknown>>();

const browserProvider: DataProvider = {
  load(path: string) {
    let job = memo.get(path);
    if (!job) {
      job = (async () => {
        // 先取和页面放在一起的数据（开发时是中间件，部署后是 dist/5etools），取不到再去站点
        for (const url of [`${import.meta.env.BASE_URL}5etools${path}`, BASE_URL + path]) {
          try {
            const r = await fetch(url);
            if (!r.ok) continue;
            const text = await r.text();
            if (/^\s*</.test(text.slice(0, 32))) continue;   // 站点失效时会回首页 HTML
            return JSON.parse(text);
          } catch { /* 换下一个来源 */ }
        }
        throw new Error(`取不到 ${path}`);
      })();
      memo.set(path, job);
      job.catch(() => memo.delete(path));
    }
    return job;
  },
};

export { RULE_FILES };

export interface Engine {
  env: SheetEnv;
  rules: RuleBook;
  problems: string[];
}

let ready: Promise<Engine> | null = null;

export function loadEngine(): Promise<Engine> {
  ready ??= (async () => {
    const env = new SheetEnv({
      provider: browserProvider,
      builtinAbilities: (abilitiesBuiltin as { entries: Record<string, unknown> }).entries,
      abilities: (abilities2024 as { entries: Record<string, unknown> }).entries,
      log: (m, level) => { if (level) console.warn('[规则]', m); },
    });
    const bad = await env.init(['items', 'optionalfeatures', 'spellsXphb', 'spellsSources']);
    const rules = new RuleBook(RULE_FILES);
    return { env, rules, problems: [...bad.map((k) => `没能装载 ${k}`), ...rules.problems] };
  })();
  return ready;
}
