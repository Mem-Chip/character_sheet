/**
 * 数据化工厂：检查一份 Entry 答卷（结构、审计、资源、试算）。
 *
 * 浏览器（自带密钥的 AI 数据化）和 Node（考试 / 外包回收）都跑这一份，
 * 免得到时候界面上「检查通过」而命令行里不认。`check` 工具、自动改稿、人点「重新检查」用的都是它。
 */
import { RULE_FILES } from '../bridge/rule-files';
import type { CombatantView, Entry, RuleFile } from '../combat';
import { declaredResources, lintEntry } from './lint';
import { genericOwner, smoke } from './smoke';

export interface CheckCtx {
  key: string;
  resourceIds?: string[];
  classTableColumns?: string[];
  /** 有真角色就用它的数值试算；没有就用假角色（资源给 3 点） */
  owner?: CombatantView | null;
}

/** 检查一条 Entry：结构、审计、资源、试算（跑一场小遭遇，看运行时会不会出错） */
export function checkEntry(answer: unknown, c: CheckCtx, files: RuleFile[] = RULE_FILES): string[] {
  if (answer && typeof answer === 'object' && 'skip' in answer && Object.keys(answer).length === 1) {
    const reason = (answer as { skip?: unknown }).skip;
    return typeof reason === 'string' && reason.trim() ? [] : ['skip 要写一句原因'];
  }
  const problems = lintEntry(c.key, answer, { files, resourceIds: c.resourceIds, classTableColumns: c.classTableColumns });
  if (problems.length) return problems;
  const res: Record<string, string> = Object.fromEntries((c.resourceIds ?? []).map((id) => [id, id]));
  for (const d of declaredResources(answer)) res[d.id] = d.name ?? d.id;
  const owner: CombatantView = c.owner
    ? {
      ...c.owner,
      resources: { ...c.owner.resources, ...Object.fromEntries(Object.keys(res).map((id) => [id, c.owner!.resources[id] ?? 3])) },
      resourceNames: { ...c.owner.resourceNames, ...res },
    }
    : genericOwner(c.key, res);
  return smoke(c.key, answer as Entry, files, owner).errors.map((e) => `试算出错：${e}`);
}
