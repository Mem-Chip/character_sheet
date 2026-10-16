/**
 * 数据化工厂：一条待写的规则 = 一个任务。任务里只有「原文 + 上下文 + 接口」，不含答案。
 * 纯逻辑，浏览器和 Node 共用。
 */

export interface TaskInterface {
  /** 对外提供的动作（界面、测试按 `<键>#<id>` 调用它们） */
  actions?: Array<{ id: string; name: string }>;
  /** 别处按名字引用的效应 */
  effects?: string[];
}

export interface Task {
  id: string;
  /** 规则条目键：`XPHB:<职业>:<特性>:<等级>` / `XPHB:<专长>` / `XPHB:spell:<法术>` */
  key: string;
  name: string;
  kind: 'classFeature' | 'subclassFeature' | 'feat' | 'spell' | 'optfeature' | 'race' | 'item';
  /** 「圣武士 3 级（奉献之誓）」「1 环法术」「起源专长」 */
  where: string;
  /** 原文（标签已去掉） */
  text: string;
  /** 法术：施法时间、距离、持续时间、升环 */
  spell?: { level: number; time: string; range: string; duration: string; concentration: boolean; higher?: string };
  /** 职业表当前行：列名 → 值（20 级时） */
  classTable?: Record<string, string | number>;
  /** 可以花的资源：id → 显示名 */
  resources?: Record<string, string>;
  /** 静态层**真的**算了的（属性 / 豁免加值、授予、资源池）—— 动态层不要重复 */
  staticPart?: string[];
  /** 静态层数据里的备注：只是说明文字，**没有任何效果** */
  staticNotes?: string[];
  interface?: TaskInterface;
  /** 补充说明（这一类条目共通的上下文：卓越骰多大、术法点叫什么…） */
  extra?: string[];
}

/**
 * 行内标签 → 站点上显示的文字。大多数标签显示第一段；几个例外要照站点的渲染来，
 * 否则意思会变：`{@scaledamage 2d8|1-9|1d8}` 在「升环」里显示的是**每环增加的 1d8**，不是基础的 2d8。
 */
const TAG_TEXT: Record<string, (parts: string[]) => string> = {
  scaledamage: (p) => p[2] ?? p[0],
  scaledice: (p) => p[2] ?? p[0],
  dc: (p) => `DC ${p[0]}`,
  chance: (p) => `${p[0]}%`,
};
const strip = (s: string): string => s
  .replace(/\{@(\w+)\s+([^}]*)\}/g, (_, tag: string, body: string) => {
    const parts = body.split('|').map((x) => x.trim());
    return (TAG_TEXT[tag] ?? ((p: string[]) => p[0]))(parts);
  })
  .replace(/\{@\w+\}/g, '');

/** 5etools 的 entries → 纯文本（保留段落、列表、表格的结构） */
export function flattenEntries(e: unknown, depth = 0): string {
  if (e == null) return '';
  if (typeof e === 'string') return strip(e);
  if (Array.isArray(e)) return e.map((x) => flattenEntries(x, depth)).filter(Boolean).join('\n');
  const o = e as Record<string, any>;
  const head = o.name ? `【${strip(String(o.name))}】` : '';
  switch (o.type) {
    case 'list':
      return (head ? head + '\n' : '') + (o.items || []).map((x: unknown) => `- ${flattenEntries(x, depth + 1).replace(/\n/g, ' ')}`).join('\n');
    case 'table': {
      const rows = (o.rows || []).map((r: unknown[]) => `| ${r.map((c) => flattenEntries(c).replace(/\n/g, ' ')).join(' | ')} |`);
      return [o.caption ? `【${strip(o.caption)}】` : '', `| ${(o.colLabels || []).map((c: string) => strip(c)).join(' | ')} |`, ...rows].filter(Boolean).join('\n');
    }
    case 'item':
      return `${head}${flattenEntries(o.entry ?? o.entries, depth + 1)}`;
    case 'refClassFeature':
    case 'refSubclassFeature':
    case 'refOptionalfeature':
      return `（见：${strip(String(o.classFeature || o.subclassFeature || o.optionalfeature || '').split('|')[0])}）`;
    default:
      if (o.entries) return (head ? head + '\n' : '') + flattenEntries(o.entries, depth + 1);
      if (o.entry) return head + flattenEntries(o.entry, depth + 1);
      return head;
  }
}

export function renderTask(t: Task): string {
  const lines: string[] = [];
  lines.push(`# 任务 ${t.id}：${t.name}`, '', `- 条目键：\`${t.key}\``, `- 出处：${t.where}`);
  if (t.spell) {
    const s = t.spell;
    lines.push(`- ${s.level ? `${s.level} 环` : '戏法'}；施法时间：${s.time}；距离：${s.range}；持续时间：${s.duration}${s.concentration ? '（专注）' : ''}`);
  }
  lines.push('', '## 原文', '', t.text.trim());
  if (t.spell?.higher) lines.push('', '## 升环', '', t.spell.higher.trim());
  if (t.classTable && Object.keys(t.classTable).length) {
    lines.push('', '## 职业表（20 级那一行；`classTable(\'列名\')` 读的是角色当前等级那一行）', '');
    lines.push(Object.entries(t.classTable).map(([k, v]) => `- ${k}：${v}`).join('\n'));
  }
  lines.push('', '## 可以花的资源（cost 里的 resource 只能用这些 id）', '');
  const res = Object.entries(t.resources ?? {});
  lines.push(res.length ? res.map(([id, name]) => `- \`${id}\`：${name}`).join('\n') : '- 没有（法术用法术位，`cost: [{ slot: { min: … } }]`）');
  if (t.staticPart?.length) {
    lines.push('', '## 人物卡（静态层）已经算进去的，不要重复写', '', t.staticPart.map((x) => `- ${x}`).join('\n'));
  }
  if (t.staticNotes?.length) {
    lines.push('', '## 人物卡数据里的备注（只是给人看的文字，**没有任何效果**；里面提到的战斗中的效果需要你写）', '', t.staticNotes.map((x) => `- ${x}`).join('\n'));
  }
  if (t.extra?.length) lines.push('', '## 补充', '', t.extra.map((x) => `- ${x}`).join('\n'));
  const ifc = t.interface;
  if (ifc && (ifc.actions?.length || ifc.effects?.length)) {
    lines.push('', '## 接口（别处按这些名字调用，必须一致）', '');
    for (const a of ifc.actions ?? []) lines.push(`- 动作：id \`${a.id}\`，name「${a.name}」`);
    for (const e of ifc.effects ?? []) lines.push(`- 效应名：「${e}」`);
  } else {
    lines.push('', '## 接口', '', '- 没有主动使用的动作（如果原文里确实有，id 用 `use`）');
  }
  return lines.join('\n') + '\n';
}
