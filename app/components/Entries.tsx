/**
 * 5etools 正文渲染：字符串里的 {@tag …} 标记 + 小节 / 列表 / 表格 / 引用条目。
 * 引用标记（法术、状态、专长、职业特性…）渲染成术语：悬停弹出原文，按 Ctrl 固定（见 Term.tsx）。
 */
import { Fragment, type ReactNode } from 'react';
import type { Json } from '../../src/sheet';
import type { TermRef } from '../lib/terms';
import { Term } from './Term';

const ATK: Record<string, string> = { m: '近战攻击检定', r: '远程攻击检定', 'm,r': '近战或远程攻击检定', ms: '近战法术攻击检定', rs: '远程法术攻击检定', 'ms,rs': '近战或远程法术攻击检定' };
/** 第 3 段才是显示名的标签（`{@variantrule 熟练|XPHB|熟练加值}`） */
const THIRD_IS_LABEL = new Set(['variantrule', 'spell', 'item', 'feat', 'condition', 'status', 'skill', 'sense', 'action', 'creature', 'race', 'background', 'hazard', 'deity', 'language', 'optfeature', 'itemMastery', 'quickref', 'card', 'disease', 'object', 'reward', 'vehicle', 'trap']);

/** 引用标记指向哪一条（给悬浮窗查） */
function tagRef(tag: string, args: string[]): TermRef | null {
  const name = (args[0] ?? '').trim();
  if (!name) return null;
  if (tag === 'classFeature') return { kind: tag, name, cls: args[1], level: Number(args[3]) || undefined };
  if (tag === 'subclassFeature') return { kind: tag, name, cls: args[1], level: Number(args[5]) || undefined };
  if (tag === 'itemProperty' || tag === 'itemMastery') return { kind: tag, name: name.split('|')[0], source: args[1] };
  if (THIRD_IS_LABEL.has(tag)) return { kind: tag, name, source: args[1] || undefined };
  return null;
}

function tagText(tag: string, args: string[]): { text: string; style?: 'b' | 'i' | 'ref' | 'num' } {
  const a0 = (args[0] ?? '').replace(/^[^;]*;\s*/, (m) => (tag === 'filter' ? m : ''));
  switch (tag) {
    case 'b': case 'bold': return { text: args[0], style: 'b' };
    case 'i': case 'italic': case 'note': return { text: args[0], style: 'i' };
    case 'hit': return { text: (/^[+-]/.test(args[0]) ? '' : '+') + args[0], style: 'num' };
    case 'dc': return { text: 'DC ' + args[0], style: 'num' };
    case 'd20': return { text: (/^[+-]/.test(args[0]) ? '' : '+') + args[0], style: 'num' };
    case 'dice': case 'damage': case 'scaledamage': case 'scaledice': case 'autodice': case 'chance':
      return { text: args[0], style: 'num' };
    case 'atk': case 'atkr': return { text: ATK[args[0]] ?? '攻击检定', style: 'i' };
    case 'h': return { text: '命中：', style: 'i' };
    case 'm': return { text: '失手：', style: 'i' };
    case 'hom': return { text: '命中或失手：', style: 'i' };
    case 'recharge': return { text: `（充能 ${args[0] || 6}–6）` };
    case 'filter': return { text: args[0], style: 'ref' };
    // {@book 显示文字|书|章|节}：显示的是第 1 段
    case 'book': case 'adventure': return { text: args[0], style: 'i' };
    case 'classFeature': case 'subclassFeature': return { text: args[0], style: 'ref' };
    case 'itemProperty': return { text: args[2] || args[0], style: 'ref' };
    default:
      if (THIRD_IS_LABEL.has(tag)) return { text: args[2] || a0 || args[0], style: 'ref' };
      return { text: args[0] ?? '' };
  }
}

/** 行内文字：把 {@tag a|b|c} 换成样式化文本（支持嵌套） */
export function Inline({ text }: { text: string }): ReactNode {
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const s = String(text);
  while (i < s.length) {
    const start = s.indexOf('{@', i);
    if (start < 0) { out.push(s.slice(i)); break; }
    if (start > i) out.push(s.slice(i, start));
    // 找配对的 }
    let depth = 0;
    let j = start;
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) break;
    }
    const inner = s.slice(start + 2, j);
    const sp = inner.search(/\s/);
    const tag = sp < 0 ? inner : inner.slice(0, sp);
    const rest = sp < 0 ? '' : inner.slice(sp + 1);
    const { text: t, style } = tagText(tag, rest.split('|'));
    const child = t.includes('{@') ? <Inline text={t} /> : t;
    out.push(
      style === 'b' ? <b key={k++}>{child}</b>
        : style === 'i' ? <i key={k++}>{child}</i>
          : style === 'ref' ? <RefSpan key={k++} tag={tag} args={rest.split('|')}>{child}</RefSpan>
            : style === 'num' ? <span key={k++} className="num">{child}</span>
              : <Fragment key={k++}>{child}</Fragment>,
    );
    i = j + 1;
  }
  return <>{out}</>;
}

function RefSpan({ tag, args, children }: { tag: string; args: string[]; children: ReactNode }) {
  const r = tagRef(tag, args);
  if (!r) return <span className="ref">{children}</span>;
  return <span className="ref"><Term {...r}>{children}</Term></span>;
}

function cellText(c: Json): string {
  if (c == null) return '';
  if (typeof c === 'string' || typeof c === 'number') return String(c);
  if (c.type === 'cell') {
    const r = c.roll;
    if (r?.exact != null) return String(r.exact);
    if (r?.min != null) return `${r.min}–${r.max}`;
    return cellText(c.entry);
  }
  if (c.type === 'dice') return (c.toRoll || []).map((t: Json) => `${t.number}d${t.faces}`).join('+');
  if (c.type === 'bonus' || c.type === 'bonusSpeed') return (c.value >= 0 ? '+' : '') + c.value + (c.type === 'bonusSpeed' ? ' 尺' : '');
  if (c.entries) return c.entries.map(cellText).join(' ');
  return '';
}

function Entry({ e }: { e: Json }): ReactNode {
  if (e == null) return null;
  if (typeof e === 'string') return <p><Inline text={e} /></p>;
  switch (e.type) {
    case 'list':
      return (
        <ul>
          {(e.items || []).map((it: Json, i: number) => (
            <li key={i}>
              {typeof it === 'string' ? <Inline text={it} />
                : <>{it.name && <b>{it.name}。</b>}<Inline text={[it.entry, ...(it.entries || [])].filter((x) => typeof x === 'string').join(' ')} /></>}
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <table>
          {e.caption && <caption className="small muted"><Inline text={e.caption} /></caption>}
          {e.colLabels && <thead><tr>{e.colLabels.map((l: string, i: number) => <th key={i}><Inline text={String(l)} /></th>)}</tr></thead>}
          <tbody>{(e.rows || []).map((r: Json[], i: number) => <tr key={i}>{r.map((c, j) => <td key={j}><Inline text={cellText(c)} /></td>)}</tr>)}</tbody>
        </table>
      );
    case 'inset': case 'insetReadaloud': case 'quote':
      return <div className="inset">{e.name && <h4>{e.name}</h4>}<Entries entries={e.entries || []} /></div>;
    case 'refClassFeature': case 'refSubclassFeature': case 'refOptionalfeature': {
      // `名|职业|来源|等级`：做成词条，鼠标停上去能看原文（以前只有一行死文字，没法知道是什么）
      const raw = String(e.classFeature || e.subclassFeature || e.optionalfeature || '');
      const [nm, cls, , lv] = raw.split('|');
      if (!nm) return null;
      const kind = e.type === 'refOptionalfeature' ? 'optfeature' : e.type === 'refSubclassFeature' ? 'subclassFeature' : 'classFeature';
      return (
        <p className="ref">
          · <Term kind={kind} name={nm} {...(cls ? { cls } : {})} {...(Number(lv) ? { level: Number(lv) } : {})}>{nm}</Term>
        </p>
      );
    }
    case 'abilityDc':
      return <p><b>{e.name} 豁免 DC</b> = 8 + 熟练加值 + {(e.attributes || []).join('/')} 调整值</p>;
    case 'abilityAttackMod':
      return <p><b>{e.name} 攻击加值</b> = 熟练加值 + {(e.attributes || []).join('/')} 调整值</p>;
    case 'item':
      return <p>{e.name && <b>{e.name}。</b>}<Inline text={[e.entry, ...(e.entries || [])].filter((x) => typeof x === 'string').join(' ')} /></p>;
    default:
      if (e.entries) return <>{e.name && <h4>{e.name}</h4>}<Entries entries={e.entries} /></>;
      if (e.entry) return <Entry e={e.entry} />;
      return null;
  }
}

export function Entries({ entries }: { entries: Json[] }) {
  return <>{(entries || []).map((e, i) => <Entry key={i} e={e} />)}</>;
}
