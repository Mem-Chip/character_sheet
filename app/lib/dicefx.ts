/**
 * 3D 掷骰动画的接入层（动画本身在 ./dice3d，外包写的独立模块）。
 *
 * - 结果从来不由动画决定：引擎 / 服务器先掷好，这里只是把「掷了什么、各是几」交给 dice3d 去演。
 * - 播什么：战斗事务 tape 里新出现的、由引擎掷的骰子（source = engine；手填的实体骰不播），
 *   以及指令框的 /r（/pr 只给本人播）。玩家看不到怪物的骰子（和日志一样保密）。
 * - 种子按「遭遇 + 第几笔 + 第几次掷」算，各端滚法一样。物理参数（会改变滚法）在战役遭遇里由 DM 设、存在遭遇上，
 *   大家共用；本地遭遇存在本机。
 * - 骰子颜色每人一种：战役里存在遭遇上（别人看到的也是这个颜色），本地存在本机。
 * - 其余参数（镜头、灯光、外观、时长、播谁的）只影响自己的屏幕，存在本机。
 * - dice3d 连同 three.js 一起按需加载：第一次要播的时候才下载。
 */
import { describeRoll, type ChatRoll, type RolledExpr, type Session } from '../../src/combat';
import type { DiceOptions, DieSpec, RollRequest } from './dice3d';
import { DEFAULT_DICE_OPTIONS } from './dice3d/options';

export type DiceFxScope = 'all' | 'mine' | 'off';
const PREF_KEY = 'dnd2024-engine:dice3d';

export function diceFxScope(): DiceFxScope {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === 'mine' || v === 'off' ? v : 'all';
  } catch { return 'all'; }
}
export function setDiceFxScope(v: DiceFxScope): void {
  try { localStorage.setItem(PREF_KEY, v); } catch { /* 无所谓 */ }
}

/** 别人的暗骰（/pr、DM 的暗骰、怪物的骰子）在我这里怎么显示：空白骰子（看得到在掷，看不到点数）/ 不显示 */
export type DarkShow = 'blank' | 'none';
const DARK_KEY = 'dnd2024-engine:dice3d:dark';
export function diceDarkShow(): DarkShow {
  try { return localStorage.getItem(DARK_KEY) === 'none' ? 'none' : 'blank'; } catch { return 'blank'; }
}
export function setDiceDarkShow(v: DarkShow): void {
  try { localStorage.setItem(DARK_KEY, v); } catch { /* 无所谓 */ }
}
/** 把骰子换成空白的（面上不印数字） */
const blankOf = (dice: DieSpec[]): DieSpec[] => dice.map(({ faces, color, dropped }) => ({ faces, color, dropped, blank: true }));

/** 会改变滚法的物理参数（各端必须一样，否则同一个种子滚法不同）；没给的用默认 */
export interface DicePhysics { tableWidth?: number; tableDepth?: number; tableGrow?: boolean; dieScale?: number; layFlat?: boolean }
export const PHYS_KEYS = ['tableWidth', 'tableDepth', 'tableGrow', 'dieScale', 'layFlat'] as const;

/** 只影响自己屏幕的参数（dice3d 的 DiceOptions 去掉物理、主题；maxDice 不影响同步，也算个人的） */
export type DiceLocal = Omit<DiceOptions, 'physics' | 'theme'> & { physics?: { maxDice?: number } };
const LOCAL_KEY = 'dnd2024-engine:dice3d:opts';
const PHYS_KEY = 'dnd2024-engine:dice3d:phys';
const COLOR_KEY = 'dnd2024-engine:dice3d:color';
const readJson = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const writeJson = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 无所谓 */ } };

export const diceLocal = (): DiceLocal => readJson<DiceLocal>(LOCAL_KEY, {});
export function setDiceLocal(v: DiceLocal): void {
  writeJson(LOCAL_KEY, v);
  if (mod) void mod.then((m) => m.configureDice(localFull(v)));
}
/** 本地遭遇用的物理参数 */
export const diceLocalPhys = (): DicePhysics => readJson<DicePhysics>(PHYS_KEY, {});
export const setDiceLocalPhys = (v: DicePhysics): void => writeJson(PHYS_KEY, v);
/** 本地遭遇里自己的骰子颜色 */
export const diceLocalColor = (): string | null => readJson<string | null>(COLOR_KEY, null);
export const setDiceLocalColor = (v: string | null): void => writeJson(COLOR_KEY, v);

/** 个人参数叠在默认值上（清空的项要能退回默认，所以每次给全） */
function localFull(v: DiceLocal): DiceOptions {
  const d = DEFAULT_DICE_OPTIONS;
  return {
    camera: { ...d.camera, ...v.camera },
    // shadowOpacity 默认是 null（按主题），dice3d 认 null
    lighting: { ...d.lighting, ...v.lighting } as DiceOptions['lighting'],
    look: { ...d.look, ...v.look },
    timing: { ...d.timing, ...v.timing },
    physics: { maxDice: v.physics?.maxDice ?? d.physics.maxDice },
  };
}

type Mod = typeof import('./dice3d');
let mod: Promise<Mod> | null = null;
let applied = '';
function load(): Promise<Mod> {
  if (!mod) {
    mod = import('./dice3d').then((m) => {
      m.mountDice(document.body, { ...localFull(diceLocal()), theme: themeNow() });
      // 跟着页面的深浅色走
      new MutationObserver(() => m.configureDice({ theme: themeNow() })).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return m;
    });
  }
  return mod;
}
const themeNow = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

/* ───── 提示条：正在掷什么（和动画一起出现、一起消失，可以手动关） ───── */
/** rolling：骰子还在滚，只写在干什么（title）；停稳后补上结果（result + detail） */
export interface DiceCaption { id: number; title: string; result?: string; detail?: string; settled: boolean }
let caption: DiceCaption | null = null;
let capSeq = 0;
const capSubs = new Set<() => void>();
export const diceCaption = () => caption;
export const subscribeCaption = (f: () => void) => { capSubs.add(f); return () => { capSubs.delete(f); }; };
const setCaption = (c: DiceCaption | null) => { caption = c; for (const f of capSubs) f(); };
export const closeCaption = () => setCaption(null);

let chain: Promise<void> = Promise.resolve();
/** 排队播；轮到这一次时换上它的提示条，播完收起 */
function play(req: RollRequest, physics?: DicePhysics, cap?: { title: string; result?: string; detail?: string }): Promise<void> {
  if (!req.dice.length) return Promise.resolve();
  const job = chain.then(async () => {
    const c: DiceCaption | null = cap ? { id: ++capSeq, ...cap, settled: false } : null;
    setCaption(c);
    const onSettle = () => { if (c && caption?.id === c.id) setCaption({ ...c, settled: true }); };
    try { await playNow({ ...req, onSettle }, physics); } finally { if (c && caption?.id === c.id) setCaption(null); }
  });
  chain = job.catch(() => {});
  return job;
}

async function playNow(req: RollRequest, physics?: DicePhysics): Promise<void> {
  const m = await load();
  const key = JSON.stringify(physics ?? {});
  if (key !== applied) {
    applied = key;
    // 没设的回到默认（DM 清掉某项时要能退回去）
    const d = m.DEFAULT_DICE_OPTIONS.physics;
    m.configureDice({ physics: { ...d, ...(physics ?? {}), maxDice: diceLocal().physics?.maxDice ?? d.maxDice } });
  }
  await m.rollDice(req);
}

/** 字符串 → 32 位种子 */
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 每个人一种颜色：自己选的优先，没选按用户 id 挑一个 */
const COLORS = ['#4f5bd5', '#2f8f5b', '#c0392b', '#b7791f', '#7b4bb7', '#1f7a99', '#b0436e', '#5c6b2f'];
export const diceColor = (user: number | 'dm' | null | undefined, chosen?: Record<string, string>): string =>
  (user != null && chosen?.[user]) || (typeof user === 'number' && user ? COLORS[user % COLORS.length] : COLORS[0]);

/** 设置界面的「试掷一下」 */
export function previewDice(color: string, physics?: DicePhysics): void {
  const r = (n: number) => 1 + Math.floor(Math.random() * n);
  void play({ dice: [{ faces: 20, value: r(20), color }, { faces: 20, value: r(20), color, dropped: true }, { faces: 6, value: r(6), color }, { faces: 8, value: r(8), color }] }, physics, { title: '试掷' });
}

const SUPPORTED = new Set([4, 6, 8, 10, 12, 20, 100]);

/** 指令框掷的一个表达式 → 骰子（没被取的变暗；d2、d3 这类没有模型的不播） */
function diceOfExpr(r: RolledExpr, color: string): DieSpec[] {
  const out: DieSpec[] = [];
  for (const t of r.terms) {
    const faces = /^-?[ad]d20$/i.test(t.text) ? 20 : Number(/d(\d+)/i.exec(t.text)?.[1] ?? 0);
    if (!SUPPORTED.has(faces)) continue;
    t.faces.forEach((v, i) => out.push({ faces: faces as DieSpec['faces'], value: v, dropped: t.dropped.includes(i), color }));
  }
  return out;
}

/* ───── 指令框 ───── */
const seenChat = new Set<string>();
let chatPrimed = '';

/**
 * 新出现的 /r 播一下。换了遭遇（或第一次打开）只记下已有的，不补播历史。
 * 调用方要保证这时候拿到的是完整的记录（战役遭遇：服务器的状态到了之后再调）。
 */
export function scanChat(encounter: string, chat: ReadonlyArray<ChatRoll>, me: number, physics?: DicePhysics, colors?: Record<string, string>): void {
  if (chatPrimed !== encounter) { chatPrimed = encounter; for (const c of chat) seenChat.add(c.id); return; }
  const scope = diceFxScope();
  for (const c of chat) {
    if (seenChat.has(c.id)) continue;
    seenChat.add(c.id);
    if (scope === 'off' || !c.results.length) continue;
    const mine = c.by === me;
    if (scope === 'mine' && !mine) continue;
    const color = diceColor(c.by, colors);
    const dice = c.results.flatMap((r) => diceOfExpr(r, color));
    // 别人的 /pr：空白骰子（或者不显示）
    if (c.private && !mine) {
      if (diceDarkShow() === 'none') continue;
      void play({ dice: blankOf(dice), seed: seedOf('chat:' + c.id) }, physics, { title: `${c.byName} 暗骰` });
      continue;
    }
    void play({ dice, seed: seedOf('chat:' + c.id) }, physics, {
      title: `${c.byName} 掷骰${c.note ? `：${c.note}` : ''}`,
      result: c.results.map((r) => r.total).join('，'),
      detail: c.results.map((r) => describeRoll(r).replace(/~(\d+)~/g, '($1)')).join('\n'),
    });
  }
}

/* ───── 战斗事务 ───── */
const seenTape = new Set<string>();
let tapePrimed = '';

export interface TapeCtx {
  /** 遭遇 id（种子用；换了遭遇重新开始记） */
  encounter: string;
  physics?: DicePhysics;
  /** 这笔事务是谁的（命令针对的参与者） */
  subject: (cmd: unknown) => string | null;
  /** 我能不能看这个人的骰子（玩家看不到怪物的） */
  visible: (id: string | null) => boolean;
  /** 这一次在我这里是不是暗骰（显示空白骰子）：DM 选了暗骰掷、或者是怪物的骰子而 DM 没开明骰 */
  dark: (who: string | null, entry: { dark?: boolean }) => boolean;
  mine: (id: string | null) => boolean;
  color: (id: string | null) => string;
  label: (cmd: unknown) => string;
  /** 这次掷骰对应的那行日志（标题 + 掷骰明细）；找不到返回 null */
  line?: (events: ReadonlyArray<unknown>, from: number) => { title: string; result?: string; detail?: string } | null;
}

/** 扫一遍事务（含正在等待决定的那笔）：tape 里新出现的、引擎掷的骰子播一下 */
export function scanTape(s: Session, ctx: TapeCtx): void {
  const txs: Array<{ events?: ReadonlyArray<unknown>; input: { cmd: unknown; tape: Array<{ sig: string; faces: number[][]; source: string; ev?: number; dark?: boolean } | undefined> } }> = [...s.transactions];
  const p = (s as unknown as { pending?: { input?: (typeof txs)[number]['input'] } | null }).pending;
  if (p?.input) txs.push({ input: p.input });
  const keys: Array<{ key: string; tx: number; i: number }> = [];
  txs.forEach((t, ti) => t.input.tape.forEach((e, i) => { if (e) keys.push({ key: `${ctx.encounter}|${ti}|${i}|${e.sig}|${e.faces.join(';')}`, tx: ti, i }); }));
  // 换了遭遇（或第一次打开）：只记下，不补播
  if (tapePrimed !== ctx.encounter) { tapePrimed = ctx.encounter; for (const k of keys) seenTape.add(k.key); return; }
  const scope = diceFxScope();
  for (const k of keys) {
    if (seenTape.has(k.key)) continue;
    seenTape.add(k.key);
    const t = txs[k.tx].input;
    const e = t.tape[k.i]!;
    if (scope === 'off' || e.source !== 'engine') continue;
    const who = ctx.subject(t.cmd);
    if (!ctx.visible(who) || (scope === 'mine' && !ctx.mine(who))) continue;
    const dark = ctx.dark(who, e);
    if (dark && diceDarkShow() === 'none') continue;
    const color = ctx.color(who);
    // sig：2d20、1d8+2d6 …… 和 faces 一一对应
    const reqs = e.sig.split('+').map((x) => Number(x.split('d')[1]));
    const dice: DieSpec[] = [];
    e.faces.forEach((vals, j) => {
      const faces = reqs[j];
      if (SUPPORTED.has(faces)) for (const v of vals) dice.push({ faces: faces as DieSpec['faces'], value: v, color });
    });
    if (dark) {
      void play({ dice: blankOf(dice), seed: seedOf(`${ctx.encounter}|${k.tx}|${k.i}`) }, ctx.physics, { title: `${ctx.label(t.cmd)}（暗骰）` });
      continue;
    }
    const ev = txs[k.tx].events;
    const detail = ev && e.ev != null && ctx.line ? ctx.line(ev, e.ev) : null;
    void play({ dice, seed: seedOf(`${ctx.encounter}|${k.tx}|${k.i}`) }, ctx.physics, detail ?? { title: ctx.label(t.cmd) });
  }
}
