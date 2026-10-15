/**
 * 3D 掷骰动画的接入层（动画本身在 ./dice3d，外包写的独立模块）。
 *
 * - 结果从来不由动画决定：引擎 / 服务器先掷好，这里只是把「掷了什么、各是几」交给 dice3d 去演。
 * - 播什么：战斗事务 tape 里新出现的、由引擎掷的骰子（source = engine；手填的实体骰不播），
 *   以及指令框的 /r（/pr 只给本人播）。玩家看不到怪物的骰子（和日志一样保密）。
 * - 种子按「遭遇 + 第几笔 + 第几次掷」算，各端滚法一样。物理参数（会改变滚法）由 DM 在遭遇上设，大家共用。
 * - 个人设置（开关、只播自己的）存在本机。
 * - dice3d 连同 three.js 一起按需加载：第一次要播的时候才下载。
 */
import type { ChatRoll, RolledExpr, Session } from '../../src/combat';
import type { DieSpec, RollRequest } from './dice3d';

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

/** DM 设的物理参数（各端必须一样，否则同一个种子滚法不同） */
export interface DicePhysics { tableWidth?: number; tableDepth?: number; dieScale?: number; layFlat?: boolean }

type Mod = typeof import('./dice3d');
let mod: Promise<Mod> | null = null;
let applied = '';
function load(): Promise<Mod> {
  if (!mod) {
    mod = import('./dice3d').then((m) => {
      m.mountDice(document.body, { theme: themeNow() });
      // 跟着页面的深浅色走
      new MutationObserver(() => m.configureDice({ theme: themeNow() })).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return m;
    });
  }
  return mod;
}
const themeNow = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

async function play(req: RollRequest, physics?: DicePhysics): Promise<void> {
  if (!req.dice.length) return;
  const m = await load();
  const key = JSON.stringify(physics ?? {});
  if (key !== applied) {
    applied = key;
    // 没设的回到默认（DM 清掉某项时要能退回去）
    const d = m.DEFAULT_DICE_OPTIONS.physics;
    m.configureDice({ physics: { ...d, ...(physics ?? {}) } });
  }
  await m.rollDice(req);
}

/** 字符串 → 32 位种子 */
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 每个玩家一种颜色（按用户 id 挑），DM / 本地用主题蓝 */
const COLORS = ['#4f5bd5', '#2f8f5b', '#c0392b', '#b7791f', '#7b4bb7', '#1f7a99', '#b0436e', '#5c6b2f'];
export const diceColor = (user: number | null | undefined): string => (user ? COLORS[user % COLORS.length] : COLORS[0]);

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
let chatPrimed = false;

/** 新出现的 /r 播一下。第一次调用只记下已有的（刚打开页面不补播历史） */
export function scanChat(chat: ReadonlyArray<ChatRoll>, me: number, physics?: DicePhysics): void {
  if (!chatPrimed) { chatPrimed = true; for (const c of chat) seenChat.add(c.id); return; }
  const scope = diceFxScope();
  for (const c of chat) {
    if (seenChat.has(c.id)) continue;
    seenChat.add(c.id);
    if (scope === 'off' || !c.results.length) continue;
    const mine = c.by === me;
    if ((c.private || scope === 'mine') && !mine) continue;
    const color = diceColor(c.by);
    const dice = c.results.flatMap((r) => diceOfExpr(r, color));
    void play({ dice, seed: seedOf('chat:' + c.id), label: `${c.byName}${c.note ? `：${c.note}` : ''}` }, physics);
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
  mine: (id: string | null) => boolean;
  color: (id: string | null) => string;
  label: (cmd: unknown) => string;
}

/** 扫一遍事务（含正在等待决定的那笔）：tape 里新出现的、引擎掷的骰子播一下 */
export function scanTape(s: Session, ctx: TapeCtx): void {
  const txs: Array<{ input: { cmd: unknown; tape: Array<{ sig: string; faces: number[][]; source: string } | undefined> } }> = [...s.transactions];
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
    const color = ctx.color(who);
    // sig：2d20、1d8+2d6 …… 和 faces 一一对应
    const reqs = e.sig.split('+').map((x) => Number(x.split('d')[1]));
    const dice: DieSpec[] = [];
    e.faces.forEach((vals, j) => {
      const faces = reqs[j];
      if (SUPPORTED.has(faces)) for (const v of vals) dice.push({ faces: faces as DieSpec['faces'], value: v, color });
    });
    void play({ dice, seed: seedOf(`${ctx.encounter}|${k.tx}|${k.i}`), label: ctx.label(t.cmd) }, ctx.physics);
  }
}
