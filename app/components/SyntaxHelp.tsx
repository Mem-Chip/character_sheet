/**
 * 语法速查（给「留空 = 自己写 JSON」的人看的）：点开是一个弹窗，分卡面 / 战斗 / 表达式三页。
 *
 * 内容尽量从代码里的 schema 生成（卡面部分直接读 `mod-form.ts` 的 MOD_FORMS / GRANT_FORMS），
 * 战斗部分手写一张紧凑的表——这些字段在 `src/factory/lint.ts` 的 NODE_KEYS 里也有，
 * 但那边只有字段名、没有「这里是干嘛的」。
 */
import { useState } from 'react';
import { Dialog } from './ui';
import { GRANT_FORMS, MOD_FORMS } from '../lib/mod-form';

const WINDOWS: Array<[string, string]> = [
  ['turnStarted', '有人开始回合'], ['turnEnded', '有人结束回合'], ['turnEnding', '回合即将结束'],
  ['combatStarted', '战斗开始'], ['roundStarted', '新的一轮'], ['initiativeRolled', '掷先攻'],
  ['spellCast', '有人施法'], ['d20Rolled', '掷了 d20'], ['attackHit', '攻击命中'], ['attackMissed', '攻击未命中'],
  ['saveForced', '强制豁免'], ['damageIncoming', '即将受到伤害'], ['damageTaken', '受到伤害之后'],
  ['reducedTo0', '生命降到 0'], ['leftReach', '离开触及'], ['restCompleted', '休息结束'],
];
const ROLES: Array<[string, string]> = [['any', '任何人（别人的窗口也能用）'], ['actor', '这次动作的发起者'], ['target', '被作用的那个人'], ['ally', '自己人']];
const MODIFY_OPS: Array<[string, string, string]> = [
  ['reroll', 'die, keep', '重骰（取高 / 取低）'],
  ['addToRoll', 'value', '这次检定加/减一个骰或数'],
  ['succeed', '', '把这次豁免/检定直接判成功'],
  ['reduceDamage', 'value, types', '减伤'],
  ['halveDamage', '', '伤害减半'],
  ['doubleDamage', '', '伤害加倍'],
  ['evasion', '', '反射闪避：成功不受、失败减半'],
  ['setHp', 'value', '把生命设成某个值'],
  ['cancel', 'refundSlot', '打断施法（退不退法术位）'],
  ['cancelUnlessSave', 'ability, dc, refundSlot', '先掷豁免，失败了才打断'],
  ['unlessSave', 'ability, dc, onFail, onSuccess', '先掷豁免，按结果应用一组修改'],
  ['setDc / setAttackBonus / setDamageType', 'value', '改这道法术的 DC / 攻击加值 / 伤害类型'],
  ['redirect', 'to', '把伤害转给别人'],
  ['absorb', 'from', '替别人承受（临时生命值 / 生命值）'],
  ['clearAdv', 'which', '取消优势'],
];
const NODES: Array<[string, string, string]> = [
  ['damage', 'dice, type, to, scale', '立刻造成伤害；to = target / attacker / self / each；scale: 0.5 = 减半'],
  ['save', 'ability, dc, to, onFail, onSuccess', '豁免；分支里还是节点'],
  ['attack', 'bonus, onHit, onMiss', '攻击检定（bonus 缺省是法术攻击）'],
  ['heal', 'amount, to', '治疗'],
  ['tempHp', 'amount, to', '给临时生命值'],
  ['applyEffect', 'template, to, duration, state', '挂效应（template 写本条目的 effects 名，或绝对键 XPHB:condition:中毒）'],
  ['removeEffect', 'match, from', '移除效应'],
  ['grantAction', 'from, fromVar, cost, activation, targeting, until', '临时给一个动作（免法术位施放）'],
  ['castFrom', 'from, fromVar, to, cost, activation', '借一道动作当场结算（战地施法者）'],
  ['modifyCast', 'cancel, dc, attackBonus, damageType', '改正在施展的那道法术'],
  ['resource', 'id, delta', '加减资源池'],
  ['economy', 'action, bonus, reaction, attacks, move', '加减动作经济'],
  ['choose', 'prompt, options, pool, var, count', '让人选；pool 可以现算（ownSpells / ownCantrips）'],
  ['number', 'prompt, var, min, max', '让人填一个数'],
  ['if', 'when, then, else', '条件分支'],
  ['forEach', 'in, do', '对一组目标各做一遍'],
  ['repeat', 'n, do', '重复 n 次'],
  ['move', 'mode, ft', '推 / 拉 / 传送（mode: push | pull | teleport）'],
  ['zone', 'on, do, while, rounds, oncePerTurn', '在地图上留下一块区域（while：待在里面才有的效应）'],
  ['moveZone', 'key', '把自己放下的区域挪到这次选的范围'],
  ['summon', 'name, count, hp, ac, speed, attacks…', '召唤'],
  ['note', 'text', '只写一行说明'],
];
const COSTS: Array<[string, string]> = [
  ['{"economy":"action"}', '花一个动作（bonus / reaction / free 同理）'],
  ['{"slot":{"min":3}}', '花 3 环或更高的法术位'],
  ['{"resource":"wildshape-uses"}', '花一次资源'],
  ['{"item":"治疗药水"}', '消耗一个物品'],
  ['{"hp":10}', '付出 10 点生命值'],
];
const EXPRS: Array<[string, string]> = [
  ['self', '用能力的那个人'], ['target', '当前目标'], ['attacker', '攻击/伤害的来源'],
  ['self.pb', '熟练加值'], ['mod.str', '力量调整值（也支持 mod:str 写法）'], ['self.hp', '当前生命'],
  ['self.level', '等级'], ['self.levelOf(\'德鲁伊\')', '某个职业的等级'],
  ['within(self, target, 30)', '两者距离 ≤ 30 尺'], ['dist(self, target)', '精确距离'],
  ['ask(\'这句话成立吗？\')', '判断不了时问人（三值逻辑）'],
];

function Table({ rows, head }: { rows: Array<string[]>; head: string[] }) {
  return (
    <table className="rows small">
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{j === 0 ? <code>{c}</code> : c}</td>)}</tr>)}</tbody>
    </table>
  );
}

export function SyntaxHelp({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'sheet' | 'combat' | 'expr'>('sheet');
  const modRows = Object.entries(MOD_FORMS).map(([kind, f]) => [kind, f.fields.map((x) => x.key).join(', '), f.label]);
  const grantRows = Object.entries(GRANT_FORMS).map(([kind, f]) => [kind, f.fields.map((x) => x.key).join(', '), f.label]);
  return (
    <Dialog title="语法速查" onClose={onClose} footer={<button className="btn" onClick={onClose}>知道了</button>}>
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        <button className={tab === 'sheet' ? 'btn sm primary' : 'btn sm'} onClick={() => setTab('sheet')}>卡面</button>
        <button className={tab === 'combat' ? 'btn sm primary' : 'btn sm'} onClick={() => setTab('combat')}>战斗</button>
        <button className={tab === 'expr' ? 'btn sm primary' : 'btn sm'} onClick={() => setTab('expr')}>表达式</button>
      </div>

      {tab === 'sheet' && (
        <div className="stack">
          <div className="small bold">加值 / 改动（mods）</div>
          <Table head={['kind', '字段', '干什么']} rows={modRows} />
          <div className="small bold">授予（grants）</div>
          <Table head={['kind', '字段', '干什么']} rows={grantRows} />
          <div className="small bold">次数池（resources）</div>
          <div className="small">
            <code>{'{"name":"回气","formula":"1","recovery":"short"}'}</code>
            ：<b>name</b> 显示名，<b>formula</b> 上限（数字 / pb / wis / max(1, cha) 这类），
            <b>recovery</b> = short / long / none / '?'。
          </div>
          <div className="small bold">选择框（choices）</div>
          <div className="small">
            <code>{'{"id":"t","kind":"skill","count":1,"pool":"skill"}'}</code>
            ：kind 是选什么（skill / language / tool / feat / spell / cantrip / ability / classFeature），
            count 是选几个，pool 是候选池。这一块目前请用「原始 JSON」编辑。
          </div>
        </div>
      )}

      {tab === 'combat' && (
        <div className="stack">
          <div className="small bold">节点（动作的 root / 触发器的 do 里）</div>
          <Table head={['kind', '字段', '干什么']} rows={NODES} />
          <div className="small bold">触发器的时机（on）× 谁的能力（role）</div>
          <Table head={['on', '含义']} rows={WINDOWS.map(([a, b]) => [a, b])} />
          <Table head={['role', '含义']} rows={ROLES.map(([a, b]) => [a, b])} />
          <div className="small bold">窗口里的修改（modify）</div>
          <Table head={['op', '字段', '干什么']} rows={MODIFY_OPS.map(([a, b, c]) => [a, b, c])} />
          <div className="small bold">代价（cost）</div>
          <Table head={['写法', '含义']} rows={COSTS.map(([a, b]) => [a, b])} />
        </div>
      )}

      {tab === 'expr' && (
        <div className="stack">
          <div className="small">表达式用在 <code>when</code>、<code>dc</code>、<code>dice</code>、<code>amount</code> 这些字段里，写法就是四则运算 + 下面这些名字和函数：</div>
          <Table head={['写法', '含义']} rows={EXPRS.map(([a, b]) => [a, b])} />
          <div className="small muted">
            判断不了的事情可以让引擎问人：<code>ask('这次伤害来自攻击吗？')</code> —— 三值逻辑，
            答「是/否」后继续。复杂到家规都写不下的，就把整条写成 {'{ "automation": "manual" }'}，只给说明。
          </div>
        </div>
      )}
    </Dialog>
  );
}
