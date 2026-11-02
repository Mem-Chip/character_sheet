/**
 * 数据化工厂：检查一条候选条目（模型写的、人写的都一样）。
 *
 * 三层：
 *   ① 结构：只认识的字段名 —— 拼错的字段（`optinal`）引擎会静默忽略，这正是「写了却不生效」的来源；
 *   ② 审计：表达式编译与类型、模板引用、事件名、modify 用在哪个窗口（与 `npm run check:data` 同一套）；
 *   ③ 上下文：花的资源 id、读的职业表列名，必须是任务里给的。
 * 纯逻辑，浏览器和 Node 共用。
 */
import { RuleBook, auditRuleBook, type Entry, type RuleFile } from '../combat';

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);

const KEYS = {
  entry: ['name', 'text', 'global', 'actions', 'triggers', 'rollMods', 'auras', 'effects', 'automation', 'tags', 'resources'],
  /** 条目自己声明的资源池（人物卡那边还没有的），见说明书 §5 */
  resourceDecl: ['id', 'name', 'formula', 'recovery'],
  action: ['id', 'name', 'activation', 'trigger', 'cost', 'requires', 'targeting', 'concentration', 'root', 'tags', 'text'],
  triggerSpec: ['on', 'role', 'window', 'deferTo', 'when', 'aim'],
  trigger: ['id', 'on', 'role', 'window', 'deferTo', 'when', 'aim', 'optional', 'limit', 'cost', 'do', 'modify', 'label'],
  rollMod: ['on', 'who', 'when', 'op', 'value', 'label'],
  rollFilter: ['kind', 'ability', 'skill', 'attack', 'spell'],
  attackFilter: ['melee', 'ranged', 'weapon', 'spell'],
  template: ['name', 'duration', 'statics', 'rollMods', 'triggers', 'aura', 'flags', 'implies', 'stackKey', 'stack', 'deathAtLevel', 'onApply', 'onEnd', 'tags', 'text'],
  duration: ['instant', 'rounds', 'minutes', 'hours', 'until', 'max', 'saveEnds', 'endsOn', 'manual'],
  until: ['at', 'of', 'nth'],
  saveEnds: ['ability', 'dc', 'at'],
  endsOn: ['event', 'when'],
  flags: ['blocks', 'breaksConcentration', 'cannot', 'forbidTarget', 'quicken', 'ignores'],
  aura: ['id', 'radius', 'affects', 'includeSelf', 'requires', 'grant', 'stackKey'],
  grant: ['rollMods', 'statics', 'triggers'],
  targeting: ['type', 'count', 'repeat', 'range', 'area', 'filter'],
  area: ['shape', 'radius', 'size', 'length', 'width'],
  attackInfo: ['melee', 'ranged', 'weapon', 'spell', 'unarmed', 'finesse', 'reach', 'ability', 'damageType', 'item', 'mastery'],
} as const;

const NODE_KEYS: Record<string, readonly string[]> = {
  attack: ['bonus', 'attack', 'critRange', 'onHit', 'onMiss'],
  save: ['ability', 'dc', 'to', 'onFail', 'onSuccess'],
  check: ['ability', 'skill', 'dc', 'onFail', 'onSuccess'],
  damage: ['dice', 'type', 'id', 'ref', 'scale', 'to'],
  addDamage: ['dice', 'type', 'ignoreResist', 'ignoreImmunity'],
  modify: ['modify'],
  heal: ['amount', 'to'],
  tempHp: ['amount', 'to'],
  applyEffect: ['template', 'inline', 'name', 'to', 'duration', 'link', 'potency', 'state', 'whileInZone'],
  removeEffect: ['match', 'from'],  extendEffect: ['template'], endConcentration: [], grantAction: ['key', 'from', 'fromVar', 'action', 'name', 'text', 'cost', 'activation', 'targeting', 'until'], removeGrant: ['key'], castFrom: ['from', 'fromVar', 'to', 'cost', 'activation'], modifyCast: ['cancel', 'refundSlot', 'dc', 'attackBonus', 'damageType', 'note'],
  resource: ['id', 'delta'],
  economy: ['action', 'bonus', 'reaction', 'attacks', 'move'],
  choose: ['prompt', 'var', 'options', 'pool', 'count'],
  number: ['prompt', 'var', 'min', 'max', 'default'],
  if: ['when', 'then', 'else'],
  forEach: ['in', 'do'],
  repeat: ['n', 'do'],
  move: ['mode', 'ft'],
  zone: ['name', 'on', 'affects', 'oncePerTurn', 'rounds', 'do', 'while', 'difficult', 'fully'],
  moveZone: ['key'],
  summon: ['name', 'count', 'size', 'type', 'creatureType', 'ac', 'hp', 'speed', 'pb', 'score', 'attacksPerAction', 'attacks', 'actions', 'triggers', 'rollMods', 'resist', 'immune', 'conditionImmune', 'notes', 'link', 'group'],
  note: ['text'],
};

const STATIC_KEYS: Record<string, readonly string[]> = {
  ac: ['bonus'], speed: ['bonus'], hpMax: ['bonus'], spellDc: ['bonus'], speedSet: ['value', 'lock'],
  resist: ['values'], resistAll: [], immune: ['values'], vuln: ['values'], conditionImmune: ['values'],
};
const COST_KEYS: Array<[string, readonly string[]]> = [
  ['economy', ['economy', 'n']], ['resource', ['resource', 'n']], ['slot', ['slot']], ['recharge', ['recharge', 'id']], ['charges', ['charges', 'n']],
];
const MODIFY_KEYS: Record<string, readonly string[]> = {
  reroll: ['die', 'keep'], addToRoll: ['value'], succeed: [],
  reduceDamage: ['value', 'types'], halveDamage: [], doubleDamage: [], evasion: [],
  setHp: ['value'], cancel: ['refundSlot'], redirect: ['to'], absorb: ['from'], clearAdv: ['which'],
};

/** 结构检查：未知字段、该是数组 / 对象的不是 */
export function lintShape(entry: unknown): string[] {
  const out: string[] = [];
  const keys = (o: unknown, allowed: readonly string[], at: string) => {
    if (!isObj(o)) { out.push(`${at}：应该是对象`); return false; }
    for (const k of Object.keys(o)) if (!allowed.includes(k)) out.push(`${at}：不认识的字段「${k}」（可用：${allowed.join(' ')}）`);
    return true;
  };
  const list = (x: unknown, at: string, each: (y: unknown, at: string) => void) => {
    if (x === undefined) return;
    if (!Array.isArray(x)) { out.push(`${at}：应该是数组`); return; }
    x.forEach((y, i) => each(y, `${at}[${i}]`));
  };
  const modifyItem = (m: unknown, a: string) => {
    const allowed = isObj(m) ? MODIFY_KEYS[String(m.op)] : undefined;
    if (!allowed) out.push(`${a}：未知修改「${isObj(m) ? String(m.op) : m}」（可用：${Object.keys(MODIFY_KEYS).join(' ')}）`);
    else keys(m, ['op', ...allowed], a);
  };
  const nodes = (x: unknown, at: string) => list(x, at, node);
  const node = (n: unknown, at: string) => {
    if (!isObj(n)) { out.push(`${at}：节点应该是对象`); return; }
    const allowed = NODE_KEYS[String(n.kind)];
    if (!allowed) { out.push(`${at}：未知节点类型「${String(n.kind)}」（可用：${Object.keys(NODE_KEYS).join(' ')}）`); return; }
    keys(n, ['kind', ...allowed], `${at}（${n.kind}）`);
    if (n.attack !== undefined) keys(n.attack, KEYS.attackInfo, `${at}.attack`);
    for (const f of ['onHit', 'onMiss', 'onFail', 'onSuccess', 'then', 'else', 'do']) nodes(n[f], `${at}.${f}`);
    if (n.kind === 'choose') list(n.options, `${at}.options`, (o, a) => { if (keys(o, ['label', 'value', 'do', 'when'], a)) nodes((o as Obj).do, `${a}.do`); });
    if (n.kind === 'modify') list(n.modify, `${at}.modify`, modifyItem);
    if (n.kind === 'applyEffect' && n.inline !== undefined) template(n.inline, `${at}.inline`);
    if (n.kind === 'applyEffect' && n.duration !== undefined) duration(n.duration, `${at}.duration`);
    if (n.kind === 'removeEffect') keys(n.match, ['key', 'name', 'tag'], `${at}.match`);
    if (n.kind === 'summon') {
      if (n.score !== undefined) keys(n.score, ['str', 'dex', 'con', 'int', 'wis', 'cha'], `${at}.score`);
      list(n.attacks, `${at}.attacks`, (a, p) => {
        if (keys(a, ['id', 'name', 'melee', 'ranged', 'bonus', 'damage', 'damageType', 'extra', 'reach', 'range', 'long'], p)) {
          list((a as Obj).extra, `${p}.extra`, (x, xp) => keys(x, ['dice', 'type'], xp));
        }
      });
      list(n.actions, `${at}.actions`, (a, p) => {
        if (keys(a, KEYS.action, p)) nodes((a as Obj).root, `${p}.root`);
      });
      list(n.triggers, `${at}.triggers`, trigger);
      list(n.rollMods, `${at}.rollMods`, rollMod);
    }
  };
  const cost = (c: unknown, at: string) => {
    if (!isObj(c)) { out.push(`${at}：代价应该是对象`); return; }
    const hit = COST_KEYS.find(([k]) => k in c);
    if (!hit) { out.push(`${at}：认不出的代价（economy / resource / slot / recharge / charges 之一）`); return; }
    keys(c, hit[1], at);
    if ('slot' in c) keys(c.slot, ['min', 'max'], `${at}.slot`);
  };
  const rollMod = (m: unknown, at: string) => {
    if (!keys(m, KEYS.rollMod, at)) return;
    if (keys((m as Obj).on, KEYS.rollFilter, `${at}.on`) && (m as Obj & { on: Obj }).on.attack !== undefined) {
      keys(((m as Obj).on as Obj).attack, KEYS.attackFilter, `${at}.on.attack`);
    }
  };
  const trigger = (t: unknown, at: string) => {
    if (!keys(t, KEYS.trigger, at)) return;
    const o = t as Obj;
    list(o.cost, `${at}.cost`, cost);
    nodes(o.do, `${at}.do`);
    list(o.modify, `${at}.modify`, modifyItem);
  };
  const duration = (d: unknown, at: string) => {
    if (!keys(d, KEYS.duration, at)) return;
    const o = d as Obj;
    if (o.until !== undefined) keys(o.until, KEYS.until, `${at}.until`);
    if (o.max !== undefined) keys(o.max, ['rounds', 'minutes', 'hours'], `${at}.max`);
    if (o.saveEnds !== undefined) keys(o.saveEnds, KEYS.saveEnds, `${at}.saveEnds`);
    list(o.endsOn, `${at}.endsOn`, (x, a) => keys(x, KEYS.endsOn, a));
  };
  const template = (t: unknown, at: string) => {
    if (!keys(t, KEYS.template, at)) return;
    const o = t as Obj;
    if (o.duration !== undefined) duration(o.duration, `${at}.duration`);
    list(o.statics, `${at}.statics`, (s, a) => {
      const allowed = isObj(s) ? STATIC_KEYS[String(s.kind)] : undefined;
      if (!allowed) out.push(`${a}：未知静态修正「${isObj(s) ? String(s.kind) : s}」`);
      else keys(s, ['kind', ...allowed], a);
    });
    list(o.rollMods, `${at}.rollMods`, rollMod);
    list(o.triggers, `${at}.triggers`, trigger);
    if (o.aura !== undefined) aura(o.aura, `${at}.aura`);
    if (o.flags !== undefined) keys(o.flags, KEYS.flags, `${at}.flags`);
    nodes(o.onApply, `${at}.onApply`);
    nodes(o.onEnd, `${at}.onEnd`);
  };
  const aura = (a: unknown, at: string) => {
    if (!keys(a, KEYS.aura, at)) return;
    const g = (a as Obj).grant;
    if (keys(g, KEYS.grant, `${at}.grant`)) {
      list((g as Obj).rollMods, `${at}.grant.rollMods`, rollMod);
      list((g as Obj).triggers, `${at}.grant.triggers`, trigger);
    }
  };

  if (!keys(entry, KEYS.entry, '条目')) return out;
  const e = entry as Obj;
  list(e.actions, 'actions', (a, at) => {
    if (!keys(a, KEYS.action, at)) return;
    const o = a as Obj;
    if (o.trigger !== undefined) keys(o.trigger, KEYS.triggerSpec, `${at}.trigger`);
    list(o.cost, `${at}.cost`, cost);
    if (o.targeting !== undefined && keys(o.targeting, KEYS.targeting, `${at}.targeting`) && (o.targeting as Obj).area !== undefined) {
      keys((o.targeting as Obj).area, KEYS.area, `${at}.targeting.area`);
    }
    if (o.concentration !== undefined) duration(o.concentration, `${at}.concentration`);
    if (!Array.isArray(o.root)) out.push(`${at}：缺少 root（效果树，可以是空数组）`);
    nodes(o.root, `${at}.root`);
  });
  list(e.triggers, 'triggers', trigger);
  list(e.resources, 'resources', (r, at) => {
    if (!keys(r, KEYS.resourceDecl, at)) return;
    const o = r as Obj;
    if (typeof o.id !== 'string' || !o.id || typeof o.name !== 'string' || !o.name) out.push(`${at}：id 和 name 都要写`);
    if (o.formula === undefined || (typeof o.formula !== 'string' && typeof o.formula !== 'number')) out.push(`${at}：formula（上限公式）要写`);
    if (o.recovery !== 'short' && o.recovery !== 'long') out.push(`${at}：recovery 只能是 'short' 或 'long'`);
  });
  list(e.rollMods, 'rollMods', rollMod);
  list(e.auras, 'auras', aura);
  if (e.effects !== undefined) {
    if (!isObj(e.effects)) out.push('effects：应该是「名字 → 效应模板」的对象');
    else for (const [k, t] of Object.entries(e.effects)) template(t, `effects.${k}`);
  }
  return out;
}

export interface ResourceDecl { id: string; name: string; formula: string | number; recovery: 'short' | 'long' }

/** 条目顶层声明的资源池（人物卡那边还没有的次数） */
export function declaredResources(entry: unknown): ResourceDecl[] {
  const r = isObj(entry) ? entry.resources : undefined;
  return Array.isArray(r) ? (r.filter(isObj) as unknown as ResourceDecl[]) : [];
}

/** 条目里花掉的资源 id（cost 的 resource、resource 节点、表达式里的 resource('…')） */
export function spentResources(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) x.forEach((y) => spentResources(y, out));
  else if (isObj(x)) {
    if (Array.isArray(x.resources) && x.resources.every((r) => isObj(r) && 'formula' in r)) {
      Object.entries(x).filter(([k]) => k !== 'resources').forEach(([, y]) => spentResources(y, out));
      return out;
    }
    if (typeof x.resource === 'string') out.add(x.resource);
    if (x.kind === 'resource' && typeof x.id === 'string') out.add(x.id);
    Object.values(x).forEach((y) => spentResources(y, out));
  } else if (typeof x === 'string') {
    for (const m of x.matchAll(/resource\('([^']+)'\)/g)) out.add(m[1]);
  }
  return out;
}

export function classTableColumns(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) x.forEach((y) => classTableColumns(y, out));
  else if (isObj(x)) Object.values(x).forEach((y) => classTableColumns(y, out));
  else if (typeof x === 'string') for (const m of x.matchAll(/classTable\('([^']+)'\)/g)) out.add(m[1]);
  return out;
}

export interface LintContext {
  /** 其余的规则数据（不含这一条）：模板引用、通用动作、状态都从这里解析 */
  files: RuleFile[];
  /** 可以花的资源 id；不给就不查 */
  resourceIds?: string[];
  /** 可以读的职业表列名；不给就不查 */
  classTableColumns?: string[];
}

/** 完整检查。返回问题列表（空 = 通过） */
export function lintEntry(key: string, entry: unknown, ctx: LintContext): string[] {
  const out = lintShape(entry);
  if (out.length) return out;   // 结构不对时，后面的审计报出来的多半是连带问题
  const files = ctx.files.map((f) => {
    if (!(key in f.entries)) return f;
    const entries = { ...f.entries };
    delete entries[key];
    return { ...f, entries };
  });
  const book = new RuleBook([...files, { entries: { [key]: entry as Entry } } as RuleFile]);
  out.push(...auditRuleBook(book).filter((m) => m.startsWith(key + ' ') || m.startsWith(key + '：')));
  if (ctx.resourceIds) {
    const declared = declaredResources(entry).map((r) => r.id);
    for (const r of spentResources(entry)) {
      if (!ctx.resourceIds.includes(r) && !declared.includes(r)) {
        out.push(`花了资源「${r}」，但这条能力的持有者没有这个资源（可用：${ctx.resourceIds.join('、') || '无'}；需要新的资源池就在顶层 resources 里声明）`);
      }
    }
  }
  if (ctx.classTableColumns) {
    for (const c of classTableColumns(entry)) {
      if (!ctx.classTableColumns.includes(c)) out.push(`读了职业表的「${c}」列，但没有这一列（有：${ctx.classTableColumns.join('、') || '无'}）`);
    }
  }
  return out;
}
