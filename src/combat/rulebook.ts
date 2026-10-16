import type { EffectTemplate, Entry } from './types';

/**
 * 规则书：官方数据（多份文件按顺序逐字段合并）+ 房规层（§十五）。
 *
 * 合并顺序 = 优先级：`官方文件… → 全服 → 战役 → 本卡 → 场景`，**靠后的覆盖靠前的**
 * （沿用原项目 Rulepack 的定稿：卡比团具体，团比全局具体）。
 */

export interface RuleFile {
  version?: number;
  note?: string;
  core?: Record<string, unknown>;
  entries: Record<string, Entry>;
}

/** 规则包里的一条（COMBAT-DESIGN §15.5，沿用原项目 ABILITIES.md §3.40.4 的形状） */
export interface HouseRule {
  id: string;
  /** 新内容用 `HR:<id>`；覆盖官方写官方键；核心参数写 `core.<名>` */
  key: string;
  /** 展示用正文，必填（家规没有原文可读） */
  text: string;
  /** 整条替换 / 新条目 */
  entry?: Entry;
  /** 字段级覆盖：路径 → 新值。路径必须在被覆盖的条目里存在 */
  patch?: Record<string, unknown>;
  /** 核心参数的新值（key 为 `core.*` 时） */
  value?: unknown;
  /** 官方能力还没有战斗数据，这条（entry）是给它补上的：键不存在不算错 */
  fill?: boolean;
}

export interface RuleLayer {
  scope: 'server' | 'camp' | 'card' | 'scene';
  name: string;
  rules: HouseRule[];
}

/**
 * 遭遇的规则层：官方文件 → 本团（战役挂载且 DM 开着的）→ 每个参战者自己的资料库（按加入顺序，靠后的盖前面）。
 * 服务器开遭遇 / 加人时用它定格快照，客户端拿同一份（`state.rules` / `state.ownerRules`）重放，两边才一模一样。
 */
export function encounterLayers(
  camp: HouseRule[] | undefined,
  owners: Array<{ name: string; rules: HouseRule[] }> | undefined,
): RuleLayer[] {
  const out: RuleLayer[] = [];
  if (camp?.length) out.push({ scope: 'camp', name: '本团', rules: camp });
  for (const o of owners ?? []) if (o.rules?.length) out.push({ scope: 'card', name: o.name || '玩家的资料库', rules: o.rules });
  return out;
}

export interface Overridden {
  layer: string;
  scope: RuleLayer['scope'];
  ruleId: string;
  text: string;
}

const SCOPE_CN: Record<RuleLayer['scope'], string> = { server: '全服规则', camp: '本团房规', card: '本卡家规', scene: '场景裁定' };

export class RuleBook {
  private readonly entries = new Map<string, Entry>();
  private readonly core: Record<string, unknown> = {};
  private readonly overrides = new Map<string, Overridden>();
  /** 房规合并时发现的问题（路径不存在、覆盖了不存在的键…）—— 不静默吞掉，交给界面显示 */
  readonly problems: string[] = [];

  constructor(files: RuleFile[], readonly layers: RuleLayer[] = []) {
    for (const f of files) {
      Object.assign(this.core, f.core ?? {});
      for (const [k, e] of Object.entries(f.entries)) {
        const prev = this.entries.get(k);
        // 官方文件之间逐字段合并：动态层覆盖文件只补自己的字段，不冲掉静态数据
        this.entries.set(k, prev ? { ...prev, ...structuredClone(e) } : structuredClone(e));
      }
    }
    for (const layer of layers) for (const r of layer.rules) this.applyHouseRule(layer, r);
  }

  /** 换一组房规层，得到新的规则书（官方数据共用同一份文件） */
  static from(files: RuleFile[], layers: RuleLayer[] = []): RuleBook {
    return new RuleBook(files, layers);
  }

  private applyHouseRule(layer: RuleLayer, r: HouseRule): void {
    const where = `${SCOPE_CN[layer.scope]}「${layer.name}」的 ${r.id}`;
    if (!r.text?.trim()) this.problems.push(`${where}：缺少正文 text（房规必须写清楚它是什么）`);
    const mark = () => this.overrides.set(r.key, { layer: layer.name, scope: layer.scope, ruleId: r.id, text: r.text });

    if (r.key.startsWith('core.')) {
      const name = r.key.slice(5);
      if (!(name in this.core)) { this.problems.push(`${where}：没有核心参数「${name}」`); return; }
      this.core[name] = r.value;
      mark();
      return;
    }
    const isNew = r.key.startsWith('HR:');
    const cur = this.entries.get(r.key);
    // 官方键还没有战斗数据：写明了 fill（给它补上）才行，不然多半是键拼错了
    if (!isNew && !cur && !(r.entry && r.fill)) { this.problems.push(`${where}：要覆盖的官方条目「${r.key}」不存在`); return; }
    if (r.entry && r.patch) { this.problems.push(`${where}：一条房规不能同时整条替换和字段覆盖`); return; }

    if (r.entry) {
      this.entries.set(r.key, structuredClone(r.entry));
      mark();
      return;
    }
    if (r.patch) {
      if (!cur) { this.problems.push(`${where}：新条目不能用 patch，请写 entry`); return; }
      const next = structuredClone(cur);
      for (const [path, value] of Object.entries(r.patch)) {
        const err = setPath(next, path, value);
        if (err) { this.problems.push(`${where}：路径「${path}」${err}`); return; }
      }
      this.entries.set(r.key, next);
      mark();
    }
  }

  entry(key: string): Entry | undefined { return this.entries.get(key); }
  has(key: string): boolean { return this.entries.has(key); }
  keys(): string[] { return [...this.entries.keys()]; }

  /** 被哪条房规改过（回执上显示「本团房规」） */
  overriddenBy(key: string): Overridden | undefined {
    const entryKey = key.split('#')[0];
    return this.overrides.get(entryKey);
  }
  scopeLabel(o: Overridden): string { return SCOPE_CN[o.scope]; }

  coreParam<T = unknown>(name: string): T {
    if (!(name in this.core)) throw new Error(`规则数据缺少核心参数 core.${name}`);
    return this.core[name] as T;
  }
  coreAll(): Readonly<Record<string, unknown>> { return this.core; }

  /** 对所有参与者生效的条目（武器精通、可选核心规则） */
  globals(): Array<[string, Entry]> {
    return [...this.entries].filter(([, e]) => e.global);
  }

  /**
   * 效应模板引用解析：
   * - `XPHB:spell:祝福术#祝福` —— 显式
   * - `XPHB:condition:倒地`     —— 条目里与键末段同名的效应，或唯一的效应
   * - `祝福`                     —— 相对于 `baseKey` 所在条目
   * 返回规范全键 `<条目键>#<效应名>`。
   */
  resolveTemplate(ref: string, baseKey: string): { key: string; tpl: EffectTemplate } | null {
    let entryKey: string;
    let name: string | undefined;
    if (ref.includes('#')) {
      [entryKey, name] = ref.split('#');
    } else if (ref.includes(':')) {
      entryKey = ref;
    } else {
      entryKey = baseKey.split('#')[0];
      name = ref;
    }
    const e = this.entries.get(entryKey);
    if (!e?.effects) return null;
    if (!name) {
      const last = entryKey.split(':').at(-1)!;
      const names = Object.keys(e.effects);
      name = e.effects[last] ? last : names.length === 1 ? names[0] : undefined;
      if (!name) return null;
    }
    const tpl = e.effects[name];
    return tpl ? { key: `${entryKey}#${name}`, tpl } : null;
  }

  template(fullKey: string): EffectTemplate | null {
    return this.resolveTemplate(fullKey, fullKey)?.tpl ?? null;
  }
}

/**
 * 按路径设置值。段可以是对象键、数组下标，或数组里元素的 `id`
 * （`actions.cast.trigger` 指的是 id 为 cast 的那个动作）。
 * 返回错误说明；成功返回 null。
 */
export function setPath(root: unknown, path: string, value: unknown): string | null {
  const segs = path.split('.');
  let cur: unknown = root;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (Array.isArray(cur)) {
      const idx = /^\d+$/.test(seg) ? Number(seg) : cur.findIndex((x) => x && typeof x === 'object' && (x as { id?: unknown }).id === seg);
      if (idx < 0 || idx >= cur.length) return `在第 ${i + 1} 段「${seg}」处找不到`;
      if (last) { cur[idx] = structuredClone(value); return null; }
      cur = cur[idx];
    } else if (cur && typeof cur === 'object') {
      const o = cur as Record<string, unknown>;
      if (!(seg in o)) return `在第 ${i + 1} 段「${seg}」处找不到`;
      if (last) { o[seg] = structuredClone(value); return null; }
      cur = o[seg];
    } else {
      return `在第 ${i + 1} 段「${seg}」处不是对象`;
    }
  }
  return null;
}
