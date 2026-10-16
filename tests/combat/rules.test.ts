import { describe, expect, it } from 'vitest';
import { RuleBook, auditRuleBook, encounterLayers, type RuleFile, type RuleLayer } from '../../src/combat';
import {
  FILES, LONGSWORD, SHORTBOW, cleric, wizard, done, effectNames, evs, fighter, goblin, has, last, pending, rogue, setup,
} from './helpers';

const camp = (rules: RuleLayer['rules']): RuleLayer[] => [{ scope: 'camp', name: '测试团', rules }];

/* ==================== 遭遇的规则层（官方 → 本团 → 参战者各自的资料库） ==================== */

describe('#18 遭遇的规则层：本团 → 每个参战者自己的资料库', () => {
  const hr = (id: string, value: unknown, text = id) => ({ id, key: 'core.critDamage', text, value });

  it('层的顺序、名字；空的层不出现', () => {
    const ls = encounterLayers([hr('c1', 'max')], [{ name: '小明', rules: [hr('u1', 'maxPlusRoll')] }]);
    expect(ls.map((l) => [l.scope, l.name])).toEqual([['camp', '本团'], ['card', '小明']]);
    expect(encounterLayers(undefined, undefined)).toEqual([]);
    expect(encounterLayers([], [{ name: '没人', rules: [] }])).toEqual([]);
  });

  it('同一个键：参战者自己的资料库盖住本团（靠后的赢）', () => {
    const book = new RuleBook(FILES, encounterLayers([hr('c1', 'max')], [{ name: '小明', rules: [hr('u1', 'maxPlusRoll')] }]));
    expect(book.coreParam('critDamage')).toBe('maxPlusRoll');
    expect(book.overriddenBy('core.critDamage')?.layer).toBe('小明');
  });

  it('两个参战者改同一个键：后加入的那个赢（并记下是谁盖的）', () => {
    const book = new RuleBook(FILES, encounterLayers([], [
      { name: '小明', rules: [hr('u1', 'max')] },
      { name: '小红', rules: [hr('u2', 'maxPlusRoll')] },
    ]));
    expect(book.coreParam('critDamage')).toBe('maxPlusRoll');
    expect(book.overriddenBy('core.critDamage')?.layer).toBe('小红');
  });
});

/* ============================== 房规（§十五） ============================== */

describe('#16 房规：重击取最大值再加一次掷骰', () => {
  it('偷袭骰也按房规计算', () => {
    const { s, dice } = setup([rogue(), goblin('g', { hpMax: 100 })], {
      layers: camp([{ id: 'hr1', key: 'core.critDamage', text: '重击时伤害骰取最大值再加一次正常掷骰', value: 'maxPlusRoll' }]),
    });
    dice.push(20);
    pending(s.dispatch({ type: 'useAction', actor: 'r', action: 'weapon:rp', targets: ['g'] }));
    dice.push(2, 1, 1, 1);
    done(s.decide(['0']));
    expect(last(s, 'damageApplied').total).toBe((2 + 8 + 4) + (3 + 18));
  });
});

describe('#17 房规：覆盖倒地，去掉远程劣势', () => {
  const PRONE_NO_RANGED = camp([{
    id: 'hr2', key: 'XPHB:condition:倒地', text: '本团：倒地不影响远程攻击',
    patch: {
      'effects.倒地.rollMods': [
        { on: { kind: 'attack' }, who: 'bearer', op: 'disadv', label: '倒地' },
        { on: { kind: 'attack' }, who: 'against', when: 'dist(attacker, self) <= 5', op: 'adv', label: '目标倒地（5 尺内）' },
      ],
    },
  }]);

  it('远程攻击倒地目标：普通掷骰', () => {
    const { s, dice } = setup([fighter(), goblin('g')], { layers: PRONE_NO_RANGED });
    done(s.dispatch({ type: 'applyEffect', to: 'g', template: 'XPHB:condition:倒地' }));
    dice.push(10);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:sb', targets: ['g'] }));
    expect(last(s, 'd20Rolled').d20).toHaveLength(1);
  });

  it('近战优势仍在，回执标出「本团房规」', () => {
    const { s, dice } = setup([fighter(), goblin('g')], { layers: PRONE_NO_RANGED });
    done(s.dispatch({ type: 'applyEffect', to: 'g', template: 'XPHB:condition:倒地' }));
    dice.push(5, 12, 1);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] }));
    const m = last(s, 'd20Rolled').mods[0];
    expect(m.label).toBe('目标倒地（5 尺内）');
    expect(m.rule).toBe('本团房规');
  });
});

describe('#18 房规写错了要说出来，不能静默失效', () => {
  it('路径不存在 / 参数不存在 / 覆盖的官方条目不存在 / 缺正文', () => {
    const book = new RuleBook(FILES, camp([
      { id: 'a', key: 'XPHB:condition:倒地', text: '路径写错', patch: { 'effects.倒地.rollMod': [] } },
      { id: 'b', key: 'core.critDamge', text: '参数名拼错', value: 'x' },
      { id: 'c', key: 'XPHB:condition:倒下', text: '键拼错', entry: {} },
      { id: 'd', key: 'HR:hr-d', text: '', entry: { name: '铁胃' } },
    ]));
    expect(book.problems).toHaveLength(4);
    expect(book.problems[0]).toMatch(/路径「effects\.倒地\.rollMod」.*找不到/);
    expect(book.problems[1]).toMatch(/没有核心参数「critDamge」/);
    expect(book.problems[2]).toMatch(/官方条目「XPHB:condition:倒下」不存在/);
    expect(book.problems[3]).toMatch(/缺少正文/);
  });
});

describe('#19 「这条我们自己裁定」：automation = manual', () => {
  it('偷袭设为手动后，命中不再询问', () => {
    const { s, dice } = setup([rogue(), goblin('g', { hpMax: 100 })], {
      layers: camp([{ id: 'hr3', key: 'XPHB:游荡者:偷袭:1', text: '偷袭由 DM 裁定', patch: { automation: 'manual' } }]),
    });
    dice.push(15, 4);
    done(s.dispatch({ type: 'useAction', actor: 'r', action: 'weapon:rp', targets: ['g'] }));
    expect(last(s, 'damageApplied').total).toBe(8);
  });
});

/* ============================== 骰子来源（§6.1） ============================== */

describe('实体骰输入', () => {
  it('停下来等骰面；回答写进磁带', () => {
    const { s } = setup([fighter()], { physical: ['f'] });
    const d = pending(s.dispatch({ type: 'roll', roller: 'f', kind: 'check', ability: 'str', dc: 15 }));
    expect(d.kind).toBe('physicalDice');
    expect(d.dice).toEqual([{ faces: 20, count: 1 }]);
    expect(s.decide([[21]]).status).toBe('rejected');   // 不合法的骰面
    done(s.decide([[13]]));
    expect(last(s, 'd20Rolled').total).toBe(16);
    expect(s.transactions.at(-1)!.input.tape[0].source).toBe('physical');
  });
});

/* ============================== 反应时机（§9.5） ============================== */

describe('直觉闪避：看到伤害再决定（默认）/ 命中时决定（RAW）', () => {
  it('afterResult：先掷伤害，再问', () => {
    const { s, dice } = setup([rogue(), goblin('g')]);
    dice.push(15, 6);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['r'] }));
    expect(d.to).toBe('r');
    expect(s.pending!.preview.some((e) => e.type === 'damageRolled')).toBe(true);
    done(s.decide(['0']));
    expect(last(s, 'damageApplied').total).toBe(4);
    expect(s.state.combatants.r.live.hp).toBe(26);
  });

  it('raw：命中时就要决定，此时还没有掷伤害', () => {
    const { s, dice } = setup([rogue(), goblin('g')], { settings: { reactionTiming: 'raw' } });
    dice.push(15);
    pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['r'] }));
    expect(s.pending!.preview.some((e) => e.type === 'damageRolled')).toBe(false);
    dice.push(6);
    done(s.decide(['0']));
    expect(last(s, 'damageApplied').total).toBe(4);
  });
});

/* ============================== 灵光 ============================== */

describe('守护灵光', () => {
  const paladin = { id: 'p', kind: 'pc' as const, view: { name: '圣武士', score: { cha: 16 }, sources: ['XPHB:圣武士:守护灵光:6'] } };

  it('盟友豁免：先问在不在灵光里，回答在这个回合内记住', () => {
    const { s, dice } = setup([paladin, fighter()]);
    dice.push(5);
    const d = pending(s.dispatch({ type: 'roll', roller: 'f', kind: 'save', ability: 'con', dc: 10 }));
    expect(d.kind).toBe('ask');
    expect(d.questions![0].text).toMatch(/在 圣武士 的灵光（10 尺）范围内吗/);
    done(s.decide({ [d.questions![0].id]: true }));
    expect(last(s, 'd20Rolled').total).toBe(5 + 2 + 3);

    dice.push(5);
    done(s.dispatch({ type: 'roll', roller: 'f', kind: 'save', ability: 'con', dc: 10 }));   // 同一回合：不再问
    expect(last(s, 'd20Rolled').total).toBe(10);
  });

  it('圣武士自己的加值在人物卡上，战斗里不再加一次', () => {
    // 人物卡算出来的豁免总值已经含灵光（静态层的 saveBonus）
    const { s, dice } = setup([{ ...paladin, view: { ...paladin.view, save: { wis: 3 } } }]);
    dice.push(5);
    done(s.dispatch({ type: 'roll', roller: 'p', kind: 'save', ability: 'wis', dc: 10 }));
    expect(last(s, 'd20Rolled').total).toBe(5 + 3);
    expect(last(s, 'd20Rolled').mods).toEqual([]);
  });

  it('圣武士失能时，盟友的灵光失效', () => {
    const { s, dice } = setup([paladin, fighter()]);
    done(s.dispatch({ type: 'applyEffect', to: 'p', template: 'XPHB:condition:震慑' }));
    dice.push(5);
    done(s.dispatch({ type: 'roll', roller: 'f', kind: 'save', ability: 'con', dc: 10 }));
    expect(last(s, 'd20Rolled').total).toBe(5 + 2);
  });
});

/* ============================== 武器精通 ============================== */

const withMastery = (m: string) => ({ attacks: [{ ...LONGSWORD, mastery: m }, { ...SHORTBOW, mastery: m }] });

describe('武器精通', () => {
  it('失衡：命中后可选让目标体质豁免，失败倒地', () => {
    const { s, dice } = setup([fighter(withMastery('失衡')), goblin('g', { hpMax: 30 })]);
    dice.push(15, 4);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] }));
    expect(d.options[0].label).toContain('失衡');
    dice.push(5);
    done(s.decide(['0']));
    expect(last(s, 'saveForced').dc).toBe(8 + 3 + 2);
    expect(has(s, 'g', '倒地')).toBe(true);
  });

  it('削弱：目标的下一次攻击检定劣势，用掉就没了', () => {
    const { s, dice } = setup([fighter(withMastery('削弱')), goblin('g', { hpMax: 30 })]);
    dice.push(15, 4);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] }));
    expect(effectNames(s, 'g')).toContain('削弱');
    dice.push(10, 2);
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['f'] }));
    expect(last(s, 'd20Rolled').disadv).toBe(true);
    expect(effectNames(s, 'g')).not.toContain('削弱');
    dice.push(3);
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['f'] }));
    expect(last(s, 'd20Rolled').d20).toHaveLength(1);
  });

  it('侵扰：对同一目标的下一次攻击优势', () => {
    const { s, dice } = setup([fighter(withMastery('侵扰')), goblin('g', { hpMax: 30 }), goblin('h', { hpMax: 30 })]);
    dice.push(15, 3);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:sb', targets: ['g'] }));
    dice.push(10);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:sb', targets: ['h'] }));   // 别的目标：不优势
    expect(last(s, 'd20Rolled').adv).toBe(false);
    dice.push(4, 16, 2);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:sb', targets: ['g'] }));
    expect(last(s, 'd20Rolled').adv).toBe(true);
    expect(effectNames(s, 'f').filter((n) => n === '侵扰')).toHaveLength(1);   // 第二次命中又施加了新的
  });

  it('擦掠：失手时造成属性调整值的伤害', () => {
    const { s, dice } = setup([fighter(withMastery('擦掠')), goblin('g', { hpMax: 30 })]);
    dice.push(2);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] }));
    expect(last(s, 'damageApplied')).toMatchObject({ total: 3, byType: { 挥砍: 3 } });
  });

  it('缓速：速度 -10，重复命中不超过 10', () => {
    const { s, dice } = setup([fighter(withMastery('缓速')), goblin('g', { hpMax: 30 })]);
    dice.push(15, 1, 15, 1);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] }));
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] }));
    expect(s.view('g').speed).toBe(20);
  });
});

/* ============================== 擒抱 ============================== */

describe('擒抱与挣脱', () => {
  it('目标用较好的豁免；受擒速度 0、攻击别人劣势；用特技挣脱', () => {
    const { s, dice } = setup([fighter(), goblin('g', { hpMax: 30 }), cleric('c')]);
    dice.push(5);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'XPHB:action:擒抱#use', targets: ['g'] }));
    expect(last(s, 'saveForced')).toMatchObject({ ability: 'dex', dc: 13 });
    expect(has(s, 'g', '受擒')).toBe(true);
    expect(s.view('g').speed).toBe(0);

    dice.push(10, 3);
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['c'] }));
    expect(last(s, 'd20Rolled').disadv).toBe(true);
    dice.push(10);
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['f'] }));
    expect(last(s, 'd20Rolled').disadv).toBe(false);

    const d = pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'XPHB:action:结束擒抱#use' }));
    expect(d.kind).toBe('choose');
    dice.push(15);
    done(s.decide(['1']));
    expect(last(s, 'd20Rolled')).toMatchObject({ total: 17, vs: 13, outcome: 'success' });
    expect(has(s, 'g', '受擒')).toBe(false);
  });

  it('擒抱者陷入失能时，受擒结束', () => {
    const { s, dice } = setup([fighter(), goblin('g', { hpMax: 30 })]);
    dice.push(5);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'XPHB:action:擒抱#use', targets: ['g'] }));
    done(s.dispatch({ type: 'applyEffect', to: 'f', template: 'XPHB:condition:震慑' }));
    expect(has(s, 'g', '受擒')).toBe(false);
  });
});

/* ============================== 其他状态与动作 ============================== */

describe('力竭 6 级死亡；长休降 1 级', () => {
  it('', () => {
    const { s } = setup([fighter()]);
    for (let i = 0; i < 3; i++) done(s.dispatch({ type: 'applyEffect', to: 'f', template: 'XPHB:condition:力竭' }));
    done(s.dispatch({ type: 'rest', kind: 'long' }));
    expect(Object.values(s.state.effects).find((e) => e.name === '力竭')!.state.level).toBe(2);
    for (let i = 0; i < 4; i++) done(s.dispatch({ type: 'applyEffect', to: 'f', template: 'XPHB:condition:力竭' }));
    expect(s.state.combatants.f.live.dead).toBe(true);
  });
});

describe('死亡豁免（回合开始时）', () => {
  it('成功一次 → 天然 1 记两次失败 → 天然 20 恢复 1 点生命值', () => {
    const { s, dice } = setup([fighter(), goblin('g')]);
    done(s.dispatch({ type: 'damage', id: 'f', amount: 30, damageType: '钝击' }));
    dice.push(15);
    done(s.dispatch({ type: 'startCombat', order: ['f', 'g'] }));
    expect(s.state.combatants.f.live.deathSaves).toEqual({ s: 1, f: 0 });
    done(s.dispatch({ type: 'nextTurn' }));
    dice.push(1);
    done(s.dispatch({ type: 'nextTurn' }));
    expect(s.state.combatants.f.live.deathSaves).toEqual({ s: 1, f: 2 });
    done(s.dispatch({ type: 'nextTurn' }));
    dice.push(20);
    done(s.dispatch({ type: 'nextTurn' }));
    expect(s.state.combatants.f.live.hp).toBe(1);
    expect(has(s, 'f', '昏迷')).toBe(false);
    expect(s.state.combatants.f.live.deathSaves).toEqual({ s: 0, f: 0 });
  });
});

describe('隐形', () => {
  it('隐形者攻击优势；攻击隐形者劣势（按推测「看不见」走）', () => {
    const { s, dice } = setup([fighter(), goblin('g', { hpMax: 30 })]);
    done(s.dispatch({ type: 'applyEffect', to: 'f', template: 'XPHB:condition:隐形' }));
    dice.push(3, 15, 4);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] }));
    expect(last(s, 'd20Rolled').adv).toBe(true);
    dice.push(15, 3);
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['f'] }));
    expect(last(s, 'd20Rolled').disadv).toBe(true);
  });
});

describe('回避与协助', () => {
  it('回避：对你的攻击劣势，持续到你的下一回合开始', () => {
    const { s, dice } = setup([fighter(), goblin('g')]);
    done(s.dispatch({ type: 'startCombat', order: ['f', 'g'] }));
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'XPHB:action:回避#use' }));
    done(s.dispatch({ type: 'nextTurn' }));
    dice.push(15, 3);
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['f'] }));
    expect(last(s, 'd20Rolled').disadv).toBe(true);
    done(s.dispatch({ type: 'nextTurn' }));
    expect(effectNames(s, 'f')).not.toContain('回避');
  });

  it('协助攻击：盟友对该敌人的下一次攻击优势，用掉就没了', () => {
    const { s, dice } = setup([fighter(), fighter({}, 'f2'), goblin('g', { hpMax: 50 })]);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'f', action: 'XPHB:action:协助#use', targets: ['g'] }));
    done(s.decide(['0']));
    expect(d.kind).toBe('choose');
    dice.push(3, 15, 4);
    done(s.dispatch({ type: 'useAction', actor: 'f2', action: 'weapon:ls', targets: ['g'] }));
    expect(last(s, 'd20Rolled').adv).toBe(true);
    expect(effectNames(s, 'g')).not.toContain('协助攻击');
  });
});

describe('定身类人升环：每高一环多一个目标', () => {
  it('3 环可以指定 2 个目标', () => {
    const { s, dice } = setup([cleric('c'), goblin('g'), goblin('h')]);
    dice.push(5, 5);
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:定身类人#cast', targets: ['g', 'h'], slotLevel: 3 }));
    expect(has(s, 'g', '麻痹') && has(s, 'h', '麻痹')).toBe(true);
    expect(Object.values(s.state.effects).filter((e) => e.key === 'concentration')).toHaveLength(1);
  });
});

describe('升环：每高一环按原文增加', () => {
  it('火球术升环：4 环 9d6（3 环 8d6，每高一环多 1d6）', () => {
    const { s, dice } = setup([wizard({ slots: { 4: 1 } }), goblin('g', { hpMax: 100 })]);
    dice.push(2, 1, 1, 1, 1, 1, 1, 1, 1, 1);   // 豁免 2（失败），然后 9 颗 d6
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火球术#cast', targets: ['g'], slotLevel: 4 }));
    expect(last(s, 'damageRolled').parts.map((p: any) => p.dice)).toEqual(['9d6']);
    expect(dice.left()).toBe(0);
  });

  it('治愈真言升环：2 环 4d4（每高一环多 2d4）', () => {
    const { s, dice } = setup([cleric('c'), { ...fighter(), hp: 1 }]);
    dice.push(1, 1, 1, 1);
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:治愈真言#cast', targets: ['f'], slotLevel: 2 }));
    expect(s.state.combatants.f.live.hp).toBe(1 + 4 + 3);
    expect(dice.left()).toBe(0);
  });
});

describe('动作经济（战斗中）', () => {
  it('2024：动作和附赠动作只能在自己的回合用；别人的回合里攻击要用反应（DM 可以强制）', () => {
    const { s, dice } = setup([fighter(), goblin('g', { hpMax: 50 }), cleric('c')]);
    done(s.dispatch({ type: 'startCombat', order: ['g', 'f', 'c'] }));
    expect(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] }).status).toBe('rejected');
    expect(s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:治愈真言#cast', targets: ['f'], slotLevel: 1 }).status).toBe('rejected');
    dice.push(10, 4);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'], options: { as: 'reaction' } }));
    expect(s.state.combatants.f.economy.reaction).toBe(0);
    dice.push(10, 4);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'], force: true }));
  });

  it('2024：一个回合只能消耗一个法术位施法', () => {
    const { s, dice } = setup([cleric('c'), fighter()]);
    done(s.dispatch({ type: 'startCombat', order: ['c', 'f'] }));
    dice.push(1, 1);
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:治愈真言#cast', targets: ['f'], slotLevel: 1 }));
    const r = s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:祝福术#cast', targets: ['f'], slotLevel: 1 });
    expect(r.status === 'rejected' && r.reason).toMatch(/一个回合里只能消耗一个法术位/);
  });

  it('失能时不能执行动作', () => {
    const { s } = setup([fighter(), goblin('g')]);
    done(s.dispatch({ type: 'applyEffect', to: 'f', template: 'XPHB:condition:震慑' }));
    const r = s.dispatch({ type: 'useAction', actor: 'f', action: 'XPHB:action:疾走#use' });
    expect(r.status === 'rejected' && r.reason).toMatch(/无法执行动作/);
  });
});

/* ============================== 数据审计 ============================== */

describe('规则数据审计', () => {
  it('官方数据 + 黄金条目：没有问题', () => {
    expect(auditRuleBook(new RuleBook(FILES))).toEqual([]);
  });

  it('能抓出写坏的数据', () => {
    const bad: RuleFile = {
      entries: {
        'HR:test': {
          rollMods: [
            { on: { kind: 'attack' }, who: 'bearer', when: 'target.hpp > 0', op: 'adv', label: '拼错字段' },
            { on: { kind: 'save' }, who: 'bearer', op: 'add', label: '缺 value' },
            { on: { kind: 'save' }, who: 'bearer', when: 'roll.adv', op: 'adv', label: '修正里不能看合成后的优势' },
          ],
          triggers: [
            { id: 't1', on: 'attackLanded', role: 'actor', do: [{ kind: 'note', text: 'x' }] },
            { id: 't2', on: 'attackHit', role: 'actor', modify: [{ op: 'halveDamage' }] },
            { id: 't3', on: 'attackHit', role: 'actor' },
          ],
          actions: [{ id: 'a', name: '坏动作', activation: 'reaction', root: [{ kind: 'applyEffect', template: '不存在' }] }],
          effects: {
            双计: { statics: [{ kind: 'ac', bonus: 2 }], rollMods: [{ on: { kind: 'attack' }, who: 'against', op: 'targetAdd', value: 2, label: '掩护' }] },
          },
        },
      },
    };
    const problems = auditRuleBook(new RuleBook([...FILES, bad]));
    const text = problems.join('\n');
    expect(text).toMatch(/参与者没有「hpp」/);
    expect(text).toMatch(/「add」需要 value/);
    expect(text).toMatch(/没有「adv」/);
    expect(text).toMatch(/attackLanded/);
    expect(text).toMatch(/modify 只能用在 before 窗口/);
    expect(text).toMatch(/什么也不做/);
    expect(text).toMatch(/反应型动作必须写 trigger/);
    expect(text).toMatch(/效应模板「不存在」不存在/);
    expect(text).toMatch(/会双计/);
  });
});

void evs;
