/**
 * 规则环境：原项目里散落的全局单例（Store / Abilities / ToolRules / Resources …）在这里收拢成一个对象。
 * 一个环境 = 一套数据 + 一套能力表 + 一条管线 + 家规层。浏览器、服务器、测试各建各的，互不干扰。
 */
import { AbilityBook, type HomeRuleEntry } from './abilities';
import { applyOriginFeatDefault, computeCharacter, type CharData } from './character';
import { MasteryRules, SoftLimits, Unlocks, WildShape, classSkillBudget } from './class-state';
import { FeatRules } from './feats';
import { FeatureOptions, ItemRules, LanguageRules, OptionalFeatureRules, ToolRules } from './items';
import { createRules, type Pipeline } from './pipeline';
import { Resources, Rest } from './resources';
import { States } from './states';
import { DataStore, type DataProvider, type Json } from './store';

export interface SheetEnvOptions {
  provider: DataProvider;
  /** 内嵌兜底能力表（data/abilities-builtin.json 的 entries） */
  builtinAbilities: Record<string, Json>;
  /** abilities-2024.json 的 entries；null = 只用内嵌兜底 */
  abilities: Record<string, Json> | null;
  /** 全服 / 战役两层家规（本卡那层在角色自己的 homerules 里） */
  homelib?: { server?: HomeRuleEntry[]; camp?: (char: CharData) => HomeRuleEntry[] };
  log?: (msg: string, level?: number) => void;
}

export class SheetEnv {
  readonly store: DataStore;
  readonly abilities: AbilityBook;
  readonly rules: Pipeline;
  readonly tools: ToolRules;
  readonly languages: LanguageRules;
  readonly items: ItemRules;
  readonly optional: OptionalFeatureRules;
  readonly options: FeatureOptions;
  readonly feats: FeatRules;
  readonly resources: Resources;
  readonly rest: Rest;
  readonly mastery: MasteryRules;
  readonly softLimits: SoftLimits;
  readonly wildShape: WildShape;
  readonly unlocks: Unlocks;
  readonly states: States;
  readonly homelib: { server: HomeRuleEntry[]; camp: (char: CharData) => HomeRuleEntry[] };
  /** 计算前改角色的钩子（原项目 Plugins.applyCharHooks） */
  readonly charHooks: Array<(char: CharData) => void> = [];
  readonly log: (msg: string, level?: number) => void;

  constructor(o: SheetEnvOptions) {
    this.log = o.log ?? (() => {});
    this.store = new DataStore(o.provider, this.log);
    this.homelib = { server: o.homelib?.server ?? [], camp: o.homelib?.camp ?? (() => []) };
    this.tools = new ToolRules(this);
    this.languages = new LanguageRules(this);
    this.items = new ItemRules(this);
    this.optional = new OptionalFeatureRules(this);
    this.options = new FeatureOptions(this);
    this.feats = new FeatRules(this);
    this.resources = new Resources(this);
    this.rest = new Rest(this);
    this.mastery = new MasteryRules(this);
    this.softLimits = new SoftLimits(this);
    this.wildShape = new WildShape(this);
    this.unlocks = new Unlocks();
    this.states = new States();
    this.abilities = new AbilityBook(this, o.builtinAbilities, o.abilities);
    this.rules = createRules();
  }

  /** 装载建卡骨架 + 规则计算要的数据，并补齐能力表里抽取漏掉的专长选择 */
  async init(extra?: string[]): Promise<string[]> {
    const bad = await this.store.bootstrap(extra);
    this.abilities.augmentFromFeatData();
    this.abilities.audit();
    return bad;
  }

  compute(char: CharData): Promise<Record<string, any>> { return computeCharacter(this, char); }
  applyOriginFeatDefault(char: CharData): boolean { return applyOriginFeatDefault(this, char); }
  classSkillBudget(char: CharData) { return classSkillBudget(this, char); }
}
