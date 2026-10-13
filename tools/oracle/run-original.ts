/**
 * 用原项目（参照实现）把 tests/fixtures/chars.json 里的每个角色算一遍，
 * 归一化后写到 .oracle/<id>.json（不进 git）。npm run oracle
 *
 * 移植验证已经完成（见 PORTING.md），现在只用来手动对照：想知道某处和原项目差在哪，
 * 就跑它，再和 tests/fixtures/snapshots/ 里同名文件比。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeSheet, normalizeValue } from '../../src/sheet/normalize';
import { loadOriginal } from './sandbox';

const ROOT = resolve(import.meta.dirname, '..', '..');
const OUT = resolve(ROOT, '.oracle');
const chars = JSON.parse(readFileSync(resolve(ROOT, 'tests', 'fixtures', 'chars.json'), 'utf8')) as Array<{ id: string; note: string; char: unknown }>;
const only = process.argv[2];

const o = await loadOriginal();
const FeatRules = o.get('FeatRules');
const MasteryRules = o.get('MasteryRules');
const WildShape = o.get('WildShape');
const Unlocks = o.get('Unlocks');
const classSkillBudget = o.get('classSkillBudget');

mkdirSync(OUT, { recursive: true });
for (const fx of chars) {
  if (only && fx.id !== only) continue;
  const char = { ...o.Character.blank(), ...structuredClone(fx.char as object) };
  const sheet = await o.Character.compute(char);
  const slots = FeatRules.slots(char, char._resolved);
  const extras = {
    featSlots: slots,
    featAssign: FeatRules.assign(o.Character.featNames(char), slots),
    featCandidates: Object.fromEntries(['O', 'G', 'FS', 'EB'].map((cat) => [
      cat,
      FeatRules.candidates(cat, sheet, char).map((x: any) => `${x.feat.name}:${x.ok ? 'ok' : x.reasons.join('/')}`),
    ])),
    masteryAllowance: MasteryRules.allowance(char),
    skillBudget: classSkillBudget(char),
    wildShape: WildShape.limits(char),
    unlocks: Unlocks.all(char),
  };
  const out = {
    id: fx.id,
    note: fx.note,
    sheet: normalizeSheet(sheet),
    extras: normalizeValue(extras),
    char: normalizeValue(Object.fromEntries(Object.entries(char).filter(([k]) => !k.startsWith('_')))),
  };
  writeFileSync(resolve(OUT, `${fx.id}.json`), JSON.stringify(out, null, 1) + '\n');
  console.log(`✓ ${fx.id}：${Object.keys(out.sheet).length} 项`);
}
process.exit(0);
