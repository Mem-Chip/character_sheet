// 自带密钥的 AI 数据化：检查没过会把问题回给模型再改；输出带围栏 / 废话也能取出 JSON；怪物任务列出要写的能力
import { describe, expect, it } from 'vitest';
import { parseMonster } from '../../src/bridge/from-monster';
import { RULE_FILES } from '../../src/bridge/rule-files';
import { lintEntry } from '../../src/factory';
import { datafy, parseAnswer, renderMonsterTask, type ChatMsg } from '../../src/factory/ai';

describe('AI 数据化', () => {
  it('输出外面包了围栏、前后有话，也能取出 JSON', () => {
    expect(parseAnswer('```json\n{"skip":"x"}\n```')).toEqual({ skip: 'x' });
    expect(parseAnswer('好的：\n{"a":1}\n以上')).toEqual({ a: 1 });
    expect(() => parseAnswer('没有')).toThrow();
  });

  it('检查没过：把问题回给模型，改好了就停', async () => {
    const seen: ChatMsg[][] = [];
    const answers = [
      '{"name":"测试","actionz":[]}',
      '{"name":"测试","actions":[{"id":"use","name":"测试","activation":"bonus","root":[{"kind":"heal","amount":"1d4","to":"self"}]}]}',
    ];
    const r = await datafy({
      chat: async (m) => { seen.push(m.map((x) => ({ ...x }))); return answers[seen.length - 1]; },
      spec: '说明书', examples: '{}', task: '# 任务', check: (a) => lintEntry('XPHB:测试', a, { files: RULE_FILES }),
    });
    expect(r.rounds).toBe(2);
    expect(r.problems).toEqual([]);
    const fix = seen[1].at(-1)!.content;
    expect(fix).toContain('actionz');
  });

  it('改到上限还没过：带着剩下的问题返回', async () => {
    const r = await datafy({
      chat: async () => '{"name":"x","bogus":1}', spec: '', examples: '{}', task: '', maxFix: 1,
      check: (a) => lintEntry('XPHB:测试', a, { files: RULE_FILES }),
    });
    expect(r.rounds).toBe(2);
    expect(r.problems.join()).toContain('bogus');
  });

  it('修改意见：上一版和意见都进任务', async () => {
    let last = '';
    await datafy({
      chat: async (m) => { last = m.at(-1)!.content; return '{"skip":"纯叙事"}'; },
      spec: '', examples: '{}', task: '# 任务', previous: { name: '旧' }, feedback: '改成附赠动作', check: () => [],
    });
    expect(last).toContain('"旧"');
    expect(last).toContain('改成附赠动作');
  });

  it('怪物任务：列出要手动处理的能力，说清楚输出格式', () => {
    const p = parseMonster({
      name: '测试怪', source: 'HB', size: ['M'], type: 'monstrosity', ac: [13], hp: { average: 30 }, speed: { walk: 30 }, cr: '2',
      str: 14, dex: 12, con: 12, int: 3, wis: 10, cha: 5,
      trait: [{ name: '蛛行', entries: ['可以在墙上爬。'] }],
    });
    expect(p.notes.map((n) => n.name)).toContain('蛛行');
    const t = renderMonsterTask(p, '2');
    expect(t).toContain('### 蛛行');
    expect(t).toContain('键是上面每一条的名字');
  });
});
