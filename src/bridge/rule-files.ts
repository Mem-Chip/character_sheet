/**
 * 战斗规则书用的数据文件：浏览器和服务器（服务器跑遭遇）共用这一份列表。
 * AI 生成的数据（未审）在前，手写的在后：同键时手写的覆盖。books = 玩家手册以外的书（XGE、TCE…）；items = 物品（键 <来源>:item:<名字>）。
 */
import featuresDyn from '../../data/dyn/features.json';
import rules2024 from '../../data/rules-2024.json';
import spellsDyn from '../../data/dyn/spells.json';
import aiFeatures from '../../data/dyn/ai/features.json';
import aiSpells from '../../data/dyn/ai/spells.json';
import aiBooks from '../../data/dyn/ai/books.json';
import aiItems from '../../data/dyn/ai/items.json';
import reviewedDyn from '../../data/dyn/reviewed.json';
import type { RuleFile } from '../combat';

export const RULE_FILES = [aiItems, aiBooks, aiFeatures, aiSpells, rules2024, spellsDyn, featuresDyn, reviewedDyn] as unknown as RuleFile[];

/** 手写的（AI 数据化的例子从这里取） */
export const GOLDEN_FILES = [rules2024, spellsDyn, featuresDyn] as unknown as RuleFile[];


