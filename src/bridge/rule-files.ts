/**
 * 战斗规则书用的数据文件：浏览器和服务器（服务器跑遭遇）共用这一份列表。
 * AI 生成的数据（未审）在前，手写的在后：同键时手写的覆盖。
 */
import featuresDyn from '../../data/dyn/features.json';
import rules2024 from '../../data/rules-2024.json';
import spellsDyn from '../../data/dyn/spells.json';
import aiFeatures from '../../data/dyn/ai/features.json';
import aiSpells from '../../data/dyn/ai/spells.json';
import type { RuleFile } from '../combat';

export const RULE_FILES = [aiFeatures, aiSpells, rules2024, spellsDyn, featuresDyn] as unknown as RuleFile[];
