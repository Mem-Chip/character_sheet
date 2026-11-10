// 条目键的拆和拼（src/keys.ts）：各种形状都认得，别的书的键和 XPHB 的一样对待
import { describe, expect, it } from 'vitest';
import {
  candidateKeys, decisionOwner, entryKeyOf, featDecision, isCondition, isConditionKey, isHomeruleKey, isSpellKey,
  keyByName, keyKind, makeKey, nameOfKey, parseKey, sourceOfKey, splitRef, staleFeatDecisions, subOf, withSource,
} from '../src/keys';

describe('条目键：拆', () => {
  it('各种形状', () => {
    expect(parseKey('XPHB:警觉')).toEqual({ entry: 'XPHB:警觉', kind: 'named', source: 'XPHB', name: '警觉' });
    expect(parseKey('XPHB:野蛮人:狂暴:1')).toEqual({ entry: 'XPHB:野蛮人:狂暴:1', kind: 'classFeature', source: 'XPHB', cls: '野蛮人', name: '狂暴', level: '1' });
    expect(parseKey('XPHB:spell:祝福术#祝福')).toEqual({ entry: 'XPHB:spell:祝福术', sub: '祝福', kind: 'spell', source: 'XPHB', name: '祝福术' });
    expect(parseKey('XMM:怪物:地精').kind).toBe('monster');
    expect(parseKey('HR:hr-aa11bb')).toEqual({ entry: 'HR:hr-aa11bb', kind: 'homerule', name: 'hr-aa11bb' });
    expect(parseKey('core.critDamage')).toEqual({ entry: 'core.critDamage', kind: 'core', name: 'critDamage' });
    expect(parseKey('weapon:长剑').kind).toBe('local');
    expect(parseKey('concentration').kind).toBe('bare');
  });

  it('名字里有冒号的法术、类别词当职业名的四段键', () => {
    expect(parseKey('XGE:spell:防护系：甲:乙').name).toBe('防护系：甲:乙');
    // 两段的「XPHB:spell」是一个叫 spell 的专长，不是法术
    expect(keyKind('XPHB:spell')).toBe('named');
  });

  it('# 只切第一个', () => {
    expect(splitRef('XPHB:警觉#a#b')).toEqual(['XPHB:警觉', 'a#b']);
    expect(entryKeyOf('XPHB:警觉')).toBe('XPHB:警觉');
    expect(subOf('XPHB:警觉')).toBeUndefined();
  });

  it('名字、来源、类别判断不挑书', () => {
    expect(nameOfKey('HB-x1:condition:灼烧')).toBe('灼烧');
    expect(sourceOfKey('xge:spell:火球术')).toBe('XGE');
    expect(sourceOfKey('HR:hr-aa11bb')).toBeUndefined();
    expect(isConditionKey('HB-x1:condition:灼烧')).toBe(true);
    expect(isSpellKey('XPHB:spell:火球术#cast')).toBe(true);
    expect(isSpellKey('XPHB:战士:spell:3')).toBe(false);
    expect(isHomeruleKey('HR:hr-aa11bb')).toBe(true);
    expect(isCondition('TCE:condition:倒地#倒地', '倒地')).toBe(true);
    expect(isCondition('XPHB:spell:倒地', '倒地')).toBe(false);
    expect(isCondition(undefined, '倒地')).toBe(false);
  });
});

describe('条目键：拼', () => {
  it('拼出来的能拆回去', () => {
    for (const [kind, want] of [['spell', 'spell'], ['monster', 'monster'], ['condition', 'condition'], ['feat', 'named']] as const) {
      const k = parseKey(makeKey(kind, 'XPHB', '某某'));
      expect(k.kind).toBe(want);
      expect(k.name).toBe('某某');
    }
    expect(makeKey('classFeature', 'XPHB', '狂暴', '野蛮人', 1)).toBe('XPHB:野蛮人:狂暴:1');
    expect(makeKey('classFeature', 'XPHB', '狂暴')).toBe('');
    expect(makeKey('spell', '', '火球术')).toBe('');
  });

  it('候选键、换来源', () => {
    expect(candidateKeys('XMM', '地精')).toEqual(['XMM:地精', 'XMM:spell:地精', 'XMM:item:地精', 'XMM:怪物:地精']);
    expect(withSource('HB-x1:spell:火球术#cast', 'XPHB')).toBe('XPHB:spell:火球术#cast');
    expect(withSource('HR:hr-aa11bb', 'XPHB')).toBe('HR:hr-aa11bb');
  });

  it('按名字找：官方的优先，没有就用别的书的，都没有退回 XPHB 的写法', () => {
    const keys = ['HB-x1:condition:倒地', 'XPHB:condition:倒地', 'HB-x1:condition:灼烧', 'XPHB:spell:灼烧'];
    expect(keyByName(keys, 'condition', '倒地')).toBe('XPHB:condition:倒地');
    expect(keyByName(keys, 'condition', '灼烧')).toBe('HB-x1:condition:灼烧');
    expect(keyByName(keys, 'condition', '目盲')).toBe('XPHB:condition:目盲');
  });
});

describe('决策键', () => {
  it('职业特性的决策属于谁', () => {
    expect(decisionOwner('XPHB:野蛮人·狂战士:狂乱:3#pick')).toEqual({ cls: '野蛮人', sub: '狂战士', level: 3 });
    expect(decisionOwner('XPHB:战士:战斗风格:1#style')).toEqual({ cls: '战士', sub: null, level: 1 });
    expect(decisionOwner('XPHB:警觉#x')).toBeNull();
  });

  it('专长的三种决策键', () => {
    expect(featDecision('XPHB:熟习#skill', '熟习')).toEqual({});
    expect(featDecision('expanded:熟习#skill', '熟习')).toEqual({});
    expect(featDecision('XPHB:熟习:2#skill', '熟习')).toEqual({ nth: 2 });
    expect(featDecision('XPHB:熟习者#skill', '熟习')).toBeNull();
    // 专长名里有正则符号也不出事
    expect(featDecision('XPHB:a(b:2#x', 'a(b')).toEqual({ nth: 2 });
  });

  it('专长少了之后该删哪些决策', () => {
    const keys = ['XPHB:熟习#a', 'expanded:熟习#a', 'XPHB:熟习:1#a', 'XPHB:熟习:2#a', 'XPHB:熟习:3#a', 'XPHB:警觉#a'];
    expect(staleFeatDecisions(keys, '熟习', 0)).toEqual(keys.slice(0, 5));
    expect(staleFeatDecisions(keys, '熟习', 2)).toEqual(['XPHB:熟习:3#a']);
  });
});
