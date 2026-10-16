import { describe, expect, it } from 'vitest';
import { makeView, type ViewInit } from '../../src/combat';
import { autoYes, done, has, pending, setup, goblin, type Who } from './helpers';

const BROWN_BEAR: ViewInit = {
  name: '棕熊',
  size: '大型',
  type: '野兽',
  ac: 11,
  hpMax: 22,
  speed: 40,
  pb: 2,
  score: { str: 17, dex: 12, con: 15, int: 2, wis: 13, cha: 7 },
  skill: { 察觉: 3 },
  attacksPerAction: 2,
  attacks: [
    { id: 'bite', name: '啃咬', bonus: 5, damage: '1d8 + 3', damageType: '穿刺', melee: true, ranged: false, finesse: false, ability: 'str' },
    { id: 'claw', name: '爪击', bonus: 5, damage: '1d4 + 3', damageType: '挥砍', melee: true, ranged: false, finesse: false, ability: 'str' },
  ],
};

const DIRE_WOLF: ViewInit = {
  name: '恐狼',
  size: '大型',
  type: '野兽',
  ac: 14,
  hpMax: 22,
  speed: 50,
  pb: 2,
  score: { str: 17, dex: 15, con: 15, int: 3, wis: 12, cha: 7 },
  skill: { 察觉: 5, 隐匿: 4 },
  attacksPerAction: 1,
  attacks: [
    { id: 'bite', name: '啃咬', bonus: 5, damage: '1d10 + 3', damageType: '穿刺', melee: true, ranged: false, finesse: false, ability: 'str' },
  ],
};

function druid(over: Partial<ViewInit> = {}, id = 'd'): Who {
  const lv = over.level ?? 4;
  return {
    id,
    kind: 'pc',
    side: 'party',
    view: {
      name: '德鲁伊',
      size: '中型',
      type: '类人生物',
      ac: 14,
      hpMax: 31,
      speed: 30,
      pb: 2,
      level: lv,
      levels: { 德鲁伊: lv },
      score: { str: 10, dex: 14, con: 14, int: 12, wis: 18, cha: 10 },
      save: { str: 0, dex: 2, con: 2, int: 3, wis: 6, cha: 0 },
      skill: { 察觉: 6, 自然: 3, 运动: 2 }, // 察觉熟练(4+2=6)，自然熟练(1+2=3)，运动熟练(0+2=2)
      spell: { dc: 14, atk: 6, mod: 4, ability: 'wis' },
      slots: { 1: 4, 2: 3, 3: 2, 4: 1 },
      resources: { 'wildshape-uses': 2 },
      sources: [
        'XPHB:德鲁伊:荒野形态:2',
        'XPHB:德鲁伊:荒野伙伴:2',
        'XPHB:spell:疗伤术',
        'XPHB:spell:火球术',
      ],
      ...over,
    },
  };
}

describe('德鲁伊：荒野形态', () => {
  it('合并野兽与德鲁伊属性：物理属性/体型/速度/攻击取野兽，精神属性/生命上限取自身，豁免与技能取较高者', () => {
    const { s } = setup([druid(), goblin()]);
    const r = done(
      s.dispatch({
        type: 'useAction',
        actor: 'd',
        action: 'XPHB:德鲁伊:荒野形态:2#enter',
        options: { form: makeView(BROWN_BEAR) },
      }),
    );
    expect(r.status).toBe('done');

    const v = s.view('d');
    // 物理属性取棕熊（17/12/15），精神属性保留德鲁伊（12/18/10）
    expect(v.score).toEqual({ str: 17, dex: 12, con: 15, int: 12, wis: 18, cha: 10 });
    expect(v.mod).toEqual({ str: 3, dex: 1, con: 2, int: 1, wis: 4, cha: 0 });
    // 体型、类型、速度、AC、攻击来自棕熊
    expect(v.size).toBe('大型');
    expect(v.type).toBe('野兽');
    expect(v.speed).toBe(40);
    expect(v.ac).toBe(11);
    expect(v.attacksPerAction).toBe(2);
    expect(v.attacks.map((a) => a.name)).toEqual(['啃咬', '爪击']);
    // 生命值上限保留德鲁伊自身，获得等级点临时生命值（4 级 = 4 点）
    expect(v.hpMax).toBe(31);
    expect(s.state.combatants.d.live.tempHp).toBe(4);
    expect(s.state.combatants.d.live.resourcesUsed['wildshape-uses']).toBe(1);
    // 豁免：感知豁免熟练保留（4 + 2 = 6），力量豁免用新力量调整值（+3）
    expect(v.save.wis).toBe(6);
    expect(v.save.str).toBe(3);
    // 技能：德鲁伊原本运动熟练（力量 +0 + 熟练 2 = 2），变成棕熊后力量 +3 + 熟练 2 = 5！察觉保留 6（高于棕熊的 3）
    expect(v.skill['运动']).toBe(5);
    expect(v.skill['察觉']).toBe(6);
  });

  it('月亮结社：获得 3×等级临时生命值，AC 至少为 13+感知调整值，且可在荒野形态下施展结社法术', () => {
    const { s, dice } = setup([
      druid({
        level: 6,
        levels: { 德鲁伊: 6 },
        sources: [
          'XPHB:德鲁伊:荒野形态:2',
          'XPHB:德鲁伊:月亮结社:3',
          'XPHB:德鲁伊:结社形态:3',
          'XPHB:spell:疗伤术',
          'XPHB:spell:火球术',
        ],
      }),
      goblin(),
    ]);

    done(
      s.dispatch({
        type: 'useAction',
        actor: 'd',
        action: 'XPHB:德鲁伊:荒野形态:2#enter',
        options: { form: makeView(BROWN_BEAR) },
      }),
    );

    const v = s.view('d');
    // 棕熊 AC 11，月亮结社保底 13 + WIS(4) = 17
    expect(v.ac).toBe(17);
    // 临时生命值 = 3 * 6 = 18
    expect(s.state.combatants.d.live.tempHp).toBe(18);

    // 普通法术（火球术）在荒野形态下被禁止
    const fb = s.dispatch({ type: 'useAction', actor: 'd', action: 'XPHB:spell:火球术#cast', targets: ['g'], slotLevel: 3 });
    expect(fb.status).toBe('rejected');

    // 月亮结社法术（疗伤术）在荒野形态下允许施展！
    s.dispatch({ type: 'damage', id: 'd', amount: 25, damageType: '挥砍' });
    dice.push(5, 5); // 2d8 + 4 = 14
    const cw = done(s.dispatch({ type: 'useAction', actor: 'd', action: 'XPHB:spell:疗伤术#cast', targets: ['d'], slotLevel: 1 }));
    expect(cw.status).toBe('done');
  });

  it('18 级兽形施法：荒野形态下可施展任意法术', () => {
    const { s, dice } = setup([
      druid({
        level: 18,
        levels: { 德鲁伊: 18 },
        sources: ['XPHB:德鲁伊:荒野形态:2', 'XPHB:德鲁伊:兽形施法:18', 'XPHB:spell:火球术'],
      }),
      goblin(),
    ]);

    done(
      s.dispatch({
        type: 'useAction',
        actor: 'd',
        action: 'XPHB:德鲁伊:荒野形态:2#enter',
        options: { form: makeView(BROWN_BEAR) },
      }),
    );

    dice.push(1, 3, 3, 3, 3, 3, 3, 3, 3); // 豁免 d20=1，8d6=24
    const fb = done(s.dispatch({ type: 'useAction', actor: 'd', action: 'XPHB:spell:火球术#cast', targets: ['g'], slotLevel: 3 }));
    expect(fb.status).toBe('done');
  });

  it('切换形态、主动解除与失能自动解除', () => {
    const { s } = setup([druid(), goblin()]);
    done(
      s.dispatch({
        type: 'useAction',
        actor: 'd',
        action: 'XPHB:德鲁伊:荒野形态:2#enter',
        options: { form: makeView(BROWN_BEAR) },
      }),
    );
    expect(s.view('d').attacks[0].name).toBe('啃咬');
    expect(s.view('d').speed).toBe(40);

    // 再次变形为恐狼：自动替换棕熊形态，不叠加两个荒野形态效应
    done(
      s.dispatch({
        type: 'useAction',
        actor: 'd',
        action: 'XPHB:德鲁伊:荒野形态:2#enter',
        options: { form: makeView(DIRE_WOLF) },
      }),
    );
    const wsEffects = Object.values(s.state.effects).filter((e) => e.bearer === 'd' && e.tags.includes('wildshape'));
    expect(wsEffects).toHaveLength(1);
    expect(s.view('d').speed).toBe(50);
    expect(s.view('d').ac).toBe(14);

    // 陷入失能状态时自动解除荒野形态
    done(s.dispatch({ type: 'applyEffect', to: 'd', template: 'XPHB:condition:失能' }));
    expect(Object.values(s.state.effects).filter((e) => e.bearer === 'd' && e.tags.includes('wildshape'))).toHaveLength(0);
    expect(s.view('d').size).toBe('中型');
    expect(s.view('d').speed).toBe(30);
  });

  it('原力蛮击与月辉形态：荒野形态下天生武器命中可触发额外伤害', () => {
    const { s, dice } = setup([
      druid({
        level: 14,
        levels: { 德鲁伊: 14 },
        sources: [
          'XPHB:德鲁伊:荒野形态:2',
          'XPHB:德鲁伊:原力蛮击:7',
          'XPHB:德鲁伊:月亮结社:3',
          'XPHB:德鲁伊:月辉形态:14',
        ],
      }),
      goblin('g', { hpMax: 50 }, 50),
    ]);

    done(
      s.dispatch({
        type: 'useAction',
        actor: 'd',
        action: 'XPHB:德鲁伊:荒野形态:2#enter',
        options: { form: makeView(DIRE_WOLF) },
      }),
    );

    // 用恐狼的啃咬攻击地精
    dice.push(15, 6); // 命中 d20=15 (+5=20 vs AC 15)，基础伤害 1d10=6 (+3=9)
    const p1 = pending(s.dispatch({ type: 'useAction', actor: 'd', action: 'weapon:bite', targets: ['g'] }));
    expect(p1.kind).toBe('optionalTrigger');
    // 同时勾选原力蛮击与月辉形态（+2d10 光耀）
    const optIds = p1.options.map((o) => o.id);
    expect(optIds.length).toBe(2);

    // 选了两个触发器：原力蛮击先弹出伤害类型选择（寒冷/火焰/闪电/雷鸣），掷 1d8=5；月辉形态掷 2d10=4+3=7
    dice.push(5, 4, 3);
    const p2 = pending(s.decide(optIds));
    expect(p2.kind).toBe('choose');
    done(s.decide(['寒冷']));

    // 地精受到 9（穿刺）+ 5（寒冷）+ 7（光耀）= 21 点伤害
    expect(s.state.combatants.g.live.hp).toBe(50 - 21);
  });
});

describe('召唤与伙伴系统', () => {
  it('野兽召唤术：创建关联专注的召唤生物、继承施法者数值、紧随施法者行动、专注结束时自动离场', () => {
    const { s, dice } = setup([
      druid({
        level: 5,
        levels: { 德鲁伊: 5 },
        sources: ['XPHB:spell:野兽召唤术'],
      }),
      goblin(),
    ]);

    autoYes(s);

    // 先开始战斗：德鲁伊先攻高于地精
    dice.push(18, 5);
    done(s.dispatch({ type: 'startCombat' }));
    expect(s.state.order).toEqual(['d', 'g']);

    // 德鲁伊施展 2 环野兽召唤术，选择「大地野兽灵魄（攀爬 30 尺、群体战术）」
    const p = pending(s.dispatch({ type: 'useAction', actor: 'd', action: 'XPHB:spell:野兽召唤术#cast', slotLevel: 2 }));
    expect(p.kind).toBe('choose');
    done(s.decide([p.options[1].id]));

    // 召唤生物 s2（e1 占了专注效应 id）被加入战场，紧跟在德鲁伊 d 后面！
    expect(s.state.order).toEqual(['d', 's2', 'g']);
    const beast = s.state.combatants.s2;
    expect(beast).toBeDefined();
    expect(beast.name).toBe('大地野兽灵魄');
    expect(beast.summoner).toBe('d');
    expect(beast.side).toBe('party');
    expect(beast.controller).toBe('d');
    expect(beast.base.hpMax).toBe(30); // 30 + 5 * (2 - 2) = 30
    expect(beast.base.ac).toBe(13); // 11 + 2 = 13
    expect(beast.base.attacksPerAction).toBe(1); // floor(2 / 2) = 1
    expect(beast.base.attacks[0].bonus).toBe(6); // 德鲁伊法术攻击加值 +6

    // 轮到召唤生物行动并攻击地精（群体战术优势：掷 2 颗 d20）
    done(s.dispatch({ type: 'nextTurn' }));
    expect(s.state.order[s.state.turnIndex]).toBe('s2');
    dice.push(15, 12, 4); // d20=15, 12 (+6=21 vs AC 15)，伤害 1d8=4 (+4+2=10)
    done(s.dispatch({ type: 'useAction', actor: 's2', action: 'weapon:atk-1', targets: ['g'] }));
    expect(s.state.combatants.g.live.hp).toBe(0);

    // 德鲁伊结束专注 → 召唤生物自动从战场移除
    done(s.dispatch({ type: 'endConcentration', id: 'd' }));
    expect(s.state.combatants.s2).toBeUndefined();
    expect(s.state.order).toEqual(['d', 'g']);
  });

  it('4 环升环施展召唤法术：获得每个动作 2 次攻击（多重攻击）', () => {
    const { s } = setup([
      druid({
        level: 7,
        levels: { 德鲁伊: 7 },
        sources: ['XPHB:spell:妖精召唤术'],
      }),
      goblin(),
    ]);

    const p = pending(s.dispatch({ type: 'useAction', actor: 'd', action: 'XPHB:spell:妖精召唤术#cast', slotLevel: 4 }));
    done(s.decide([p.options[1].id]));

    const fey = s.state.combatants.s2;
    expect(fey).toBeDefined();
    expect(fey.name).toBe('欢欣妖精灵魄');
    expect(fey.base.hpMax).toBe(40); // 30 + 10 * (4 - 3)
    expect(fey.base.ac).toBe(16); // 12 + 4
    expect(fey.base.attacksPerAction).toBe(2); // floor(4 / 2) = 2
  });

  it('游侠原初伴侣：不占专注、按游侠等级计算生命值、重复召唤自动替换旧伴侣', () => {
    const { s } = setup([
      {
        id: 'r',
        kind: 'pc',
        side: 'party',
        view: {
          name: '游侠',
          level: 5,
          pb: 3,
          levels: { 游侠: 5 },
          score: { str: 12, dex: 18, con: 14, int: 10, wis: 16, cha: 10 },
          spell: { dc: 14, atk: 6, mod: 3, ability: 'wis' },
          sources: ['XPHB:游侠:原初伴侣:3'],
        },
      },
      goblin(),
    ]);

    const p1 = pending(s.dispatch({ type: 'useAction', actor: 'r', action: 'XPHB:游侠:原初伴侣:3#summon' }));
    done(s.decide([p1.options[0].id]));

    expect(s.state.combatants.s1).toBeDefined();
    expect(s.state.combatants.s1.name).toBe('大地野兽');
    expect(s.state.combatants.s1.base.hpMax).toBe(30); // 5 + 5 * 5
    expect(s.state.combatants.s1.base.ac).toBe(16); // 13 + 3
    expect(s.state.combatants.s1.linkEffect).toBeUndefined(); // 不绑定专注

    // 再次召唤天空野兽：自动替换掉旧伴侣 s1
    const p2 = pending(s.dispatch({ type: 'useAction', actor: 'r', action: 'XPHB:游侠:原初伴侣:3#summon' }));
    done(s.decide([p2.options[1].id]));
    expect(s.state.combatants.s1).toBeUndefined();
    expect(s.state.combatants.s2).toBeDefined();
    expect(s.state.combatants.s2.name).toBe('天空野兽');
    expect(s.state.combatants.s2.base.hpMax).toBe(24); // 4 + 4 * 5
  });

  it('战斗前召唤与 0 生命值规则：开战时不单独掷先攻、降到 0 生命值直接消失', () => {
    const { s, dice } = setup(
      [
        druid({ sources: ['XPHB:德鲁伊:荒野伙伴:2'] }),
        goblin(),
      ],
      { settings: { monsterAt0: 'unconscious' } },
    );
    autoYes(s);

    // 战斗开始前召唤荒野伙伴（猫头鹰）
    done(
      s.dispatch({
        type: 'useAction',
        actor: 'd',
        action: 'XPHB:德鲁伊:荒野伙伴:2#use',
        options: {
          form: makeView({
            name: '猫头鹰',
            size: '微型',
            type: '妖精',
            ac: 11,
            hpMax: 1,
            speed: 60,
          }),
        },
      }),
    );
    expect(s.state.combatants.s1.name).toBe('猫头鹰');

    // 开始战斗：只需要 2 颗先攻骰（德鲁伊和地精），猫头鹰继承德鲁伊先攻并排在德鲁伊后面
    dice.push(15, 8);
    done(s.dispatch({ type: 'startCombat' }));
    expect(s.state.order).toEqual(['d', 's1', 'g']);
    expect(s.state.combatants.s1.initiative).toBe(s.state.combatants.d.initiative);

    // 即使遭遇设置 monsterAt0 为 unconscious，召唤物降到 0 HP 也直接死亡/消散
    done(s.dispatch({ type: 'damage', id: 's1', amount: 5, damageType: '挥砍' }));
    expect(s.state.combatants.s1.live.dead).toBe(true);
    expect(has(s, 's1', '昏迷')).toBe(false);
  });
});
