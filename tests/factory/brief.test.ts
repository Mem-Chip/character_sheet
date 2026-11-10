// 速览版说明书（按需查资料）：一万字以内、名字清单齐全、约定的编号和全文对得上
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBrief, buildSpec } from '../../src/factory';

const typesSource = readFileSync('src/combat/types.ts', 'utf8');
const full = buildSpec({ typesSource, mode: 'both' });
const brief = buildBrief({ typesSource, mode: 'both' });
const briefCombat = buildBrief({ typesSource, mode: 'combat' });

/** 全文第 N 节里编号条目的编号（速览必须一条不落，也不能多） */
function numbered(spec: string, section: string): number[] {
  const out: number[] = [];
  let on = false;
  for (const line of spec.split('\n')) {
    if (/^## /.test(line)) on = line.trim().startsWith(`## ${section}.`);
    const m = /^(\d+)\.\s/.exec(line);
    if (on && m) out.push(Number(m[1]));
  }
  return out;
}

describe('速览版说明书', () => {
  it('压到一万字以内（全文五万字）', () => {
    expect(full.length).toBeGreaterThan(40000);
    expect(brief.length).toBeLessThan(10000);
    expect(briefCombat.length).toBeLessThan(brief.length);
  });

  it('讲清楚查询协议：工具表、上限、查过的别再查', () => {
    expect(brief).toContain('{ "lookup": [ { "tool": "node", "q": "zone" }');
    for (const t of ['node', 'type', 'window', 'expr', 'spec', 'example', 'check']) expect(brief).toContain(`| \`${t}\` |`);
    expect(brief).toContain('一共最多 6 轮');
  });

  it('节点 kind、修改 op、窗口名都在清单里（细节让它们去查）', () => {
    const kinds = [...new Set([...typesSource.matchAll(/^\s*\|\s*\(?\{\s*kind:\s*'(\w+)'/gm)].map((m) => m[1]))];
    const ops = [...new Set([...typesSource.matchAll(/^\s*\|\s*\(?\{\s*op:\s*'(\w+)'/gm)].map((m) => m[1]))];
    expect(kinds.length).toBeGreaterThan(20);
    for (const k of kinds) expect(brief, k).toContain(k);
    for (const o of ops) expect(brief, o).toContain(o);
    for (const w of ['damageIncoming', 'attackHit', 'summoned', 'turnEnded', 'spellCast', 'moved']) expect(brief).toContain(w);
  });

  it('约定的编号和全文一致（新增一条忘了写速览会被抓到）', () => {
    const at5 = brief.indexOf('## 5. ');
    const at6 = brief.indexOf('## 6. ');
    const at7 = brief.indexOf('## 7. ');
    const sec = (from: number, to: number) => brief.slice(from, to < 0 ? undefined : to);
    /** 按编号排（全文里 28 写在 27 前面，顺序不重要，齐全才重要） */
    const nums = (s: string) => [...s.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
    expect(nums(sec(at5, at6))).toEqual([...numbered(full, '5')].sort((a, b) => a - b));
    expect(nums(sec(at6, at7))).toEqual([...numbered(full, '6')].sort((a, b) => a - b));
  });

  it('只有 both 才有卡面那一节；两种都指向「查 5.N / 7.N」', () => {
    expect(brief).toContain('## 7. 卡面数据');
    expect(brief).toContain('{"tool":"spec","q":"7.1"}');
    expect(briefCombat).not.toContain('## 7. 卡面数据');
    expect(briefCombat).toContain('不要写静态部分');
    expect(brief).toContain('{"tool":"spec","q":"5.N"}');
  });
});
