/**
 * 档案页：身高、体重、瞳色、发色这类「跟规则无关但属于这个角色」的东西，外加外貌描述和背景故事。
 * 存在 char.profile 里（和立绘同一处），引擎不读它，只是替玩家存着、跟着卡同步。
 */
import type { CharData, Json } from '../../src/sheet';
import { Field, Panel } from '../components/ui';
import type { Engine } from '../lib/engine';
import { actions } from '../lib/store';

type Key = 'height' | 'weight' | 'age' | 'gender' | 'eyes' | 'hair' | 'skin' | 'appearance' | 'backstory';
const LOOKS: Array<[Key, string, string]> = [
  ['height', '身高', '如 175 cm'], ['weight', '体重', '如 70 kg'], ['age', '年龄', ''], ['gender', '性别', ''],
  ['eyes', '瞳色', ''], ['hair', '发色', ''], ['skin', '肤色', ''],
];

export function SheetProfile({ id, char }: { engine: Engine; id: string; char: CharData; sheet: Json }) {
  const pf = (char.profile || {}) as Partial<Record<Key, string>>;
  const set = (k: Key, v: string) => actions.update(id, (c) => { c.profile = { ...(c.profile || {}), [k]: v }; });
  return (
    <div className="stack">
      <Panel title="外貌">
        <div className="profile-grid">
          {LOOKS.map(([k, label, ph]) => (
            <Field key={k} label={label}><input value={pf[k] || ''} placeholder={ph} onChange={(e) => set(k, e.target.value)} /></Field>
          ))}
        </div>
        <Field label="外貌描述" style={{ marginTop: 8 }}>
          <textarea rows={3} value={pf.appearance || ''} placeholder="长相、穿着、一眼能看出来的特征…" onChange={(e) => set('appearance', e.target.value)} />
        </Field>
        <div className="tiny faint" style={{ marginTop: 6 }}>立绘在卡面抬头的头像那里换（点一下上传），战斗棋子和先攻条也用它。</div>
      </Panel>
      <Panel title="背景故事">
        <div className="tiny faint">跑团时念给队友听的那一段。跟规则无关，引擎不碰它，只是替你存着。</div>
        <textarea rows={12} style={{ width: '100%', marginTop: 6 }} value={pf.backstory || ''}
          placeholder="出身、为什么冒险、跟谁有仇、想要什么…" onChange={(e) => set('backstory', e.target.value)} />
      </Panel>
    </div>
  );
}
