/**
 * 账户资料库：结构检查（服务器收到条目时验一遍，不合格拒收）。
 *
 * 只查「形状对不对」：字段名、类型、id / 键的格式、大小。**不查规则对不对**——
 * 那是浏览器的 AI 检查（lintEntry / lintSheet / 试算）的事，服务器不跑引擎。
 */
import { lintShape } from '../factory';
import type { Json } from '../sheet';
import { brewSource, checkBrew, normalizeBrew, type Brew } from './brew';
import type { LibraryItem, ResPart, ShareState } from './types';
import { CORE_PREFIX, HR_PREFIX, isCoreKey, isHomeruleKey } from '../keys';

type Row = Record<string, unknown>;

export const ID_RE = /^hr-[0-9a-z]{4,16}$/;
export const KIND_RE = /^[a-zA-Z][\w-]{0,23}$/;
/** 一条资源的 JSON 上限（一个子职的原文 + 数据能有这么大） */
export const MAX_ITEM = 600_000;

const isObj = (x: unknown): x is Row => !!x && typeof x === 'object' && !Array.isArray(x);

/** 条目键合不合法：`HR:<id>`、`core.<名>`、或含冒号的官方键（`XPHB:野蛮人:狂暴:1`） */
export function keyProblem(key: string): string | null {
  if (!key) return '要写条目键（覆盖官方写官方键；新内容写 HR:<id>；核心参数写 core.<名>）';
  if (key.length > 200) return '条目键太长了';
  if (/\s/.test(key)) return '条目键里不能有空格';
  if (isHomeruleKey(key)) return ID_RE.test(key.slice(HR_PREFIX.length)) ? null : 'HR: 后面要写这条自己的 id（hr-xxxx）';
  if (isCoreKey(key)) return key.length > CORE_PREFIX.length ? null : 'core. 后面要写参数名';
  return key.includes(':') ? null : '官方条目键至少要有一段冒号（<来源>:<名字>）';
}

/** 这条 part 是不是在覆盖官方（决定挂到战役要不要 DM 点头） */
export const isOverridePart = (p: ResPart): boolean => !isHomeruleKey(p.key);

/** 一条资源挂到战役时的初始状态：覆盖了官方 = 待审，否则自动生效 */
export const shareStateOf = (item: LibraryItem): Extract<ShareState, 'auto' | 'pending'> =>
  (item.parts ?? []).some((p) => isOverridePart(p) && !isOwnBrewKey(item, p.key)) ? 'pending' : 'auto';

/** 这个键是不是这条内容自己的自制书里的特性（`HB-<id>:…`）—— 不算覆盖官方 */
export const isOwnBrewKey = (item: LibraryItem, key: string): boolean => !!item.brew && String(key).startsWith(`${brewSource(item.id)}:`);

/** 检查并整理一条库内容；返回问题（空 = 通过） */
export function checkItem(x: unknown, id: string): { item: LibraryItem | null; problems: string[] } {
  const p: string[] = [];
  if (!isObj(x)) return { item: null, problems: ['应该是一个对象'] };
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  if (!ID_RE.test(id)) p.push('id 不合法');

  const name = str(x.name, 60).trim();
  if (!name) p.push('要有名字');
  const kind = str(x.kind, 24).trim() || 'homerule';
  if (!KIND_RE.test(kind)) p.push('类别不合法');

  // 自制书（5etools 格式的子职）：检查结构、补齐关联字段；有它的条目可以先没有 parts（数据还没写）
  let brew: Brew | undefined;
  if (x.brew !== undefined && x.brew !== null) {
    const bp = checkBrew(x.brew);
    if (bp.length) p.push(...bp.map((m) => `自制书：${m}`));
    else brew = normalizeBrew(x.brew as Json, brewSource(id));
  }
  if (!Array.isArray(x.parts) || (!x.parts.length && !brew)) {
    p.push('要有 parts（至少一条；一条资源拆成几条就写几条）');
    return { item: null, problems: p };
  }
  const seen = new Set<string>();
  const seenKey = new Set<string>();
  const parts: ResPart[] = [];
  for (const [i, raw] of (x.parts as unknown[]).entries()) {
    const at = `第 ${i + 1} 条`;
    if (!isObj(raw)) { p.push(`${at}：应该是对象`); continue; }
    const pid = str(raw.id, 24);
    if (!ID_RE.test(pid)) p.push(`${at}：id 不合法（要 hr-xxxx）`);
    else if (seen.has(pid)) p.push(`${at}：id 和前面重复了`);
    seen.add(pid);
    const key = str(raw.key, 200).trim();
    const kp = keyProblem(key);
    if (kp) p.push(`${at}：${kp}`);
    else if (seenKey.has(key)) p.push(`${at}：条目键「${key}」和前面重复了`);
    seenKey.add(key);

    const sheet = isObj(raw.sheet) ? raw.sheet : undefined;
    if (raw.sheet !== undefined && !sheet) p.push(`${at}：卡面数据要是对象`);
    if (sheet) for (const k of ['mods', 'grants', 'choices', 'resources']) {
      if (sheet[k] !== undefined && !Array.isArray(sheet[k])) p.push(`${at}：卡面的 ${k} 要是数组`);
    }
    const combat = isObj(raw.combat) ? raw.combat : undefined;
    if (raw.combat !== undefined && !combat) p.push(`${at}：战斗数据要是对象`);
    if (combat) {
      const set = ['entry', 'patch', 'value'].filter((k) => combat[k] !== undefined);
      if (set.length > 1) p.push(`${at}：战斗数据只能写 entry（整条）或 patch（改字段）或 value（核心参数）之一`);
      if (!set.length) p.push(`${at}：战斗数据是空的`);
      if (combat.entry !== undefined) p.push(...lintShape(combat.entry).map((m) => `${at} 战斗数据：${m}`));
      if (combat.patch !== undefined && (typeof combat.patch !== 'object' || Array.isArray(combat.patch))) p.push(`${at}：patch 要是「路径 → 新值」`);
      if (combat.patch !== undefined && !isOverridePart({ id: pid, key })) p.push(`${at}：改字段（patch）只能用在覆盖官方条目上`);
      if (combat.value !== undefined && !key.startsWith('core.')) p.push(`${at}：核心参数的键要写成 core.<名字>`);
    }
    const removed = raw.removed === true;
    if (removed && !isOverridePart({ id: pid, key })) p.push(`${at}：「本版删除」只能用在覆盖官方的条目上（要填官方的条目键）`);
    if (removed && (sheet || combat)) p.push(`${at}：标了「本版删除」就不要再写卡面 / 战斗数据`);
    if (!removed && !sheet && !combat && !str(raw.text, 4000).trim() && !str(raw.name, 60).trim()) p.push(`${at}：卡面、战斗、说明、名字至少要有一样`);
    // 覆盖官方能力的条目按能力键生效，勾「选了才生效」没有意义（勾了也不会有作用，直接说清楚）
    if (raw.pickable && !isHomeruleKey(key)) p.push(`${at}：覆盖官方能力的条目不能勾「选了才生效」（覆盖是按能力生效的）`);

    parts.push({
      id: pid, key,
      ...(str(raw.name, 60).trim() ? { name: str(raw.name, 60).trim() } : {}),
      ...(str(raw.text, 20000).trim() ? { text: str(raw.text, 20000) } : {}),
      ...(raw.pickable ? { pickable: true } : {}),
      ...(removed ? { removed: true } : {}),
      ...(sheet ? { sheet: sheet as ResPart['sheet'] } : {}),
      ...(combat ? { combat: combat as ResPart['combat'] } : {}),
    });
  }
  if (!parts.length && !brew) return { item: null, problems: p };

  if (!brew && !parts.some((q) => q.sheet || q.combat || q.text || q.removed) && !str(x.text, 20000).trim()) {
    p.push('整条内容什么数据都没有（卡面、战斗、说明至少要有一样）');
  }

  const ref = isObj(x.ref) ? x.ref : undefined;
  const item: LibraryItem = {
    id, kind, name, text: str(x.text, 20000),
    ...(str(x.source, 24).trim() ? { source: str(x.source, 24).trim() } : {}),
    ...(ref && str(ref.name, 80).trim()
      ? {
        ref: {
          kind: str(ref.kind, 24), source: str(ref.source, 24), name: str(ref.name, 80).trim(),
          ...(str(ref.cls, 24).trim() ? { cls: str(ref.cls, 24).trim() } : {}),
          ...(Number.isFinite(Number(ref.level)) && ref.level !== undefined ? { level: Number(ref.level) } : {}),
        },
      }
      : {}),
    parts,
    ...(brew ? { brew } : {}),
    by: /^(hand|byok:[^\s]{1,80})$/.test(String(x.by)) ? String(x.by) : 'hand',
    reviewed: !!x.reviewed,
  };
  if (JSON.stringify(item).length > MAX_ITEM) p.push('太大了');
  return { item: p.length ? null : item, problems: p };
}
