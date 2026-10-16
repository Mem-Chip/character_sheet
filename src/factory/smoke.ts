/**
 * 数据化工厂：战斗试算（COMBAT-DESIGN §15.6 的「沙盒遭遇」）。
 *
 * 检查只能看出「写得合不合法」；有些错误只有跑起来才看得见（比如徒手攻击没写命中加值，
 * 缺省成了 self.spell.atk，武僧没有法术就在运行时报错）。这里把候选条目放进规则书，
 * 让它的持有者在一场小遭遇里把所有动作用一遍、攻击和被攻击、做豁免和检定、受伤、过几个回合，
 * 所有决定自动回答（可选能力全部接受，好让触发器也跑到），收集运行时的规则错误。
 * 不判断写得对不对 —— 只保证「不会在跑的时候炸」。
 */
import {
  RuleBook, Session, createEncounter, engineDice, makeCombatant, makeView, seededRng,
  type AttackRow, type CombatantView, type Command, type DispatchResult, type Entry, type RuleFile,
} from '../combat';

export interface SmokeResult {
  /** 运行时的规则错误（空 = 通过） */
  errors: string[];
  /** 没跑成但不算错的（条件不满足、付不起代价…） */
  notes: string[];
}

const SWORD: AttackRow = { id: 'sword', name: '长剑', bonus: 7, damage: '1d8 + 4', damageType: '挥砍', melee: true, ranged: false, finesse: false, ability: 'str', mastery: null };
const CLAW: AttackRow = { id: 'claw', name: '爪击', bonus: 5, damage: '1d6 + 3', damageType: '挥砍', melee: true, ranged: false, finesse: false, ability: 'str' };

/** 没有职业探针时的通用持有者：20 级、各种资源都有一些、1–9 环法术位 */
export function genericOwner(key: string, resources: Record<string, string>): CombatantView {
  return makeView({
    name: '持有者', score: { str: 16, dex: 16, con: 14, int: 16, wis: 16, cha: 16 }, pb: 6, level: 20, hpMax: 120, ac: 16,
    spell: { dc: 17, atk: 9, mod: 3, ability: 'int' },
    slots: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 2, 8: 1, 9: 1 },
    resources: Object.fromEntries(Object.keys(resources).map((id) => [id, 3])),
    resourceNames: resources,
    sources: [key], attacks: [SWORD],
  });
}

export function smoke(key: string, entry: Entry, files: RuleFile[], owner: CombatantView): SmokeResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const base = files.map((f) => {
    if (!(key in f.entries)) return f;
    const entries = { ...f.entries };
    delete entries[key];
    return { ...f, entries };
  });
  const rules = new RuleBook([...base, { entries: { [key]: entry } } as RuleFile]);
  const rng = seededRng(20261013);
  const s = new Session(createEncounter('smoke'), { rules, diceFor: () => engineDice(rng) });

  const view: CombatantView = {
    ...owner,
    sources: [...new Set([...owner.sources, key])],
    attacks: owner.attacks.length ? owner.attacks : [SWORD],
    // 不替持有者补施法能力：武僧的徒手攻击漏写命中加值时，缺省的 self.spell.atk 要在这里炸出来
  };
  const add = (id: string, side: string, v: CombatantView, hp?: number) =>
    s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id, kind: side === 'party' ? 'pc' : 'monster', side, view: v, hp }) });
  add('a', 'party', view, Math.max(1, Math.floor(view.hpMax / 2)));
  add('b', 'party', makeView({ name: '盟友', score: { str: 16, dex: 12, con: 14 }, ac: 16, hpMax: 60, attacks: [SWORD] }), 30);
  add('e', 'enemy', makeView({ name: '敌人', type: '类人生物', score: { str: 14, dex: 12 }, ac: 12, hpMax: 300, attacks: [CLAW] }));
  add('u', 'enemy', makeView({ name: '亡灵', type: '不死生物', score: { str: 14, dex: 10 }, ac: 12, hpMax: 300, attacks: [CLAW] }));

  /** 自动回答所有决定：问题答「是」、可选能力全部接受、选择取第一个、数取缺省值 */
  const drive = (r: DispatchResult, what: string): DispatchResult => {
    for (let i = 0; i < 30 && r.status === 'pending'; i++) {
      const d = r.decision;
      const v = d.kind === 'ask' ? Object.fromEntries((d.questions ?? []).map((q) => [q.id, true]))
        : d.kind === 'optionalTrigger' ? d.options.map((o) => o.id)
          : d.kind === 'number' ? d.default
            : d.kind === 'physicalDice' ? (d.dice ?? []).map((x) => Array.from({ length: x.count }, () => 1))
              : [d.options[0]?.id ?? '0'];
      r = s.decide(v);
    }
    if (r.status === 'pending') {
      errors.push(`${what}：决定一直问不完（最后一个：${r.decision.prompt}）`);
      s.cancelPending();
    }
    return r;
  };
  const run = (cmd: Command, what: string, retryForce = true): DispatchResult => {
    const before = s.events.length;
    let r = drive(s.dispatch(cmd), what);
    if (r.status === 'rejected' && retryForce && cmd.type === 'useAction' && !/规则执行出错/.test(r.reason)) {
      notes.push(`${what}：${r.reason}（改为强制执行再试）`);
      r = drive(s.dispatch({ ...cmd, force: true }), what);
    }
    if (r.status === 'rejected') {
      if (/规则执行出错/.test(r.reason)) errors.push(`${what}：${r.reason}`);
      else notes.push(`${what}：${r.reason}`);
    }
    for (const ev of s.events.slice(before)) {
      if (ev.type === 'ruleError') errors.push(`${what}：${String(ev.payload.where)}：${String(ev.payload.message)}`);
    }
    return r;
  };

  run({ type: 'startCombat', order: ['a', 'e', 'b', 'u'] }, '开始战斗');

  // ① 用一遍所有主动动作（窗口触发的动作要等时机，下面的攻击会触发它们）
  for (const act of entry.actions ?? []) {
    if (act.trigger) continue;
    const ref = `${key}#${act.id}`;
    const slot = (act.cost ?? []).find((c): c is { slot: { min: number; max?: number } } => 'slot' in c);
    const t = act.targeting?.type;
    const tries: string[][] = t === 'area' ? [['e', 'u']] : t === 'creature' ? [['e'], ['b'], ['a']] : [['a']];
    for (const targets of tries) {
      const r = run({ type: 'useAction', actor: 'a', action: ref, targets, slotLevel: slot?.slot.min }, `动作「${act.name}」`, true);
      if (r.status !== 'rejected' || !/不是「.*」的合法目标|最多 \d+ 个目标/.test(r.reason)) break;
    }
  }

  // ② 攻击与被攻击（偷袭、至圣斩、直觉闪避、护盾术这类在这里触发）
  const atk = view.attacks[0].id;
  run({ type: 'useAction', actor: 'a', action: `weapon:${atk}`, targets: ['e'], force: true }, '持有者攻击');
  run({ type: 'useAction', actor: 'a', action: `weapon:${atk}`, targets: ['u'], force: true }, '持有者攻击亡灵');
  run({ type: 'useAction', actor: 'e', action: 'weapon:claw', targets: ['a'], force: true }, '敌人攻击持有者');
  run({ type: 'useAction', actor: 'u', action: 'weapon:claw', targets: ['b'], force: true }, '亡灵攻击盟友');

  // ③ 检定与豁免（d20 窗口里的能力）
  for (const ability of ['str', 'dex', 'con', 'wis'] as const) {
    run({ type: 'roll', roller: 'a', kind: 'save', ability, dc: 15 }, `${ability} 豁免`);
  }
  run({ type: 'roll', roller: 'a', kind: 'check', ability: 'str', dc: 15 }, '力量检定');
  run({ type: 'roll', roller: 'b', kind: 'save', ability: 'wis', dc: 15 }, '盟友豁免');

  // ④ 受伤、回合推进、时间流逝
  run({ type: 'damage', id: 'a', amount: 12, damageType: '火焰', source: 'e' }, '持有者受到伤害');
  for (let i = 0; i < 5; i++) run({ type: 'nextTurn' }, `下一回合 ${i + 1}`);
  run({ type: 'advanceTime', minutes: 10 }, '时间流逝');
  return { errors: [...new Set(errors)], notes };
}
