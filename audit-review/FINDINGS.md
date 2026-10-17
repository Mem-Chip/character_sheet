# 覆盖率审查结果（自动生成）

> 由 `npm run analyze:review -- --write` 从 `audit-review/answers/` 生成。

## 判定分布

| 判定 | 条数 |
|---|---|
| partial | 943 |
| manual | 166 |
| full | 58 |

按类型：

| 类型 | 共 | manual | partial | full |
|---|---|---|---|---|
| feature | 192 | 45 | 130 | 17 |
| classFeature | 399 | 80 | 290 | 29 |
| spell | 310 | 27 | 280 | 3 |
| item | 266 | 14 | 243 | 9 |

## 缺口（missing）按概念归类

| 概念 | 提到次数 |
|---|---|
| （其他 / 需要新概念） | 1412 |
| 视线 / 三维 / 地形 | 195 |
| 动态改抗性/免疫 | 103 |
| 动作经济 | 100 |
| 传送 / 强制位移 | 90 |
| 召唤 / 控制生物 | 76 |
| 灵光 | 52 |
| 变形 / 换体型 | 31 |
| 骰池（生命骰/偷袭骰） | 31 |
| 升环 / 降环 | 26 |
| 改写另一道法术（施法时间/成分/专注/持续） | 25 |
| 链式效应 | 24 |
| 两个生物换位 | 11 |
| 把生物移出/返回战场 | 11 |
| 重选/改目标集合 | 6 |

## 判成 full 的（现有接口就能做到，只差写数据）

### classFeature（29）

- `XPHB:德鲁伊:原力蛮击:7`（带可直接用的 patch） —— trigger 已在 attackHit 用 ask 判定「是否荒野形态攻击」并限每回合一次，补 oncePerTurn 与 addDamage(1d8 选定类型) 后即可完全自动：命中后让玩家选寒冷/火焰/闪电/雷鸣并加 1d8。
- `XPHB:游侠:精宸所与:11`（带可直接用的 patch） —— 免材料+免费一次（free_cast 池/长休恢复）+无需专注+持续1分钟+召唤妖精灵魄，均可用现有接口实现：建一个由 free_cast 门控、无 slot、无专注、召唤妖精灵魄的 action，无需改写原法术条目。
- `XPHB:术士:龙伴:18`（带可直接用的 patch） —— 免材料+无需法术位一次（资源「无需法术位施展」/长休恢复）+无需专注+持续1分钟+召唤龙类，均可实现：补资源并建由它门控、无 slot、无专注、召唤龙类的 action，玩家点一次即完成。
- `AU:法师:直觉魅惑:10`（带可直接用的 patch） —— 命中窗口已触发反应+资源、并自动掷感知豁免；再补上『失败时本次攻击改为未命中/改打别人』即可由 unlessSave+redirect 完整结算（原文：『失败时这次攻击直接改为未命中你，并弹出「这次攻击改打谁」的选择……改打别人时沿用同一次攻击检定』），玩家只需点反应并选择新目标。
- `AU:牧师:稳固法术:3`（带可直接用的 patch） —— d20Rolled 成功豁免+canSee+ask 确认后，消耗引导神力并对该豁免 addToRoll 减 1d6 可由接口完成（'法术来源与首次豁免需人工确认'用 ask 近似，属必要选择）；当前 modify 仅写 addToRoll 未配 -1d6，补上即 full。
- `AU:武僧:秘法战斗风格:6`（带可直接用的 patch） —— 原文：攻击动作中把一次徒手打击替换为施展一道施法时间动作的术士戏法；用choose(ownCantrips,castTime:action)挑选戏法、castFrom当场结算，cost economy:attack扣掉该次攻击即可完全自动，玩家只需点动作并选戏法。
- `FRHoF:术士:炽焰鼓舞:3`（带可直接用的 patch） —— 『1d4+魅力调整（14级起+术士等级）临时生命值、消耗至少1术法点、每回合限一次』均可用 tempHp 节点+术法点资源+回合标记效应自动结算，玩家只需选目标。
- `FRHoF:术士:辉耀之火:3`（带可直接用的 patch） —— 『30尺内可见生物受1d4（14级起1d8）火焰或光耀伤害、消耗至少1术法点、每回合限一次』可用 choose+damage 节点+术法点资源+回合标记效应自动结算，玩家只需选目标与伤害类型。
- `FRHoF:游侠:寒心复仇:11`（带可直接用的 patch） —— 「当你被一次攻击检定命中时，可用反应迫使攻击你的生物进行感知豁免（DC为你的法术豁免DC），豁免失败陷入震慑且速度降至0直到你的下个回合结束」可由 attackHit(target)触发+save(to:'attacker')+applyEffect 完全自动；次数=感知调整值（至少1）与长休恢复可用 resource
- `TCE:魔契师:元素赐福:6`（带可直接用的 patch） —— 原文「对宗主类型决定的伤害类型具有抗性」与「以附赠动作获得30尺飞行速度并可悬浮，持续10分钟」均可经 effect.statics 的 resist 与 speed(fly) 自动结算；仅「三维移动与飞行高度」属地图移动(一贯手动，非结算)。
- `TCE:圣武士:鼓舞斩:3`（带可直接用的 patch） —— 引擎可用 bonus 动作+resource(channel-divinity)+targeting(自身或30尺内盟友)+tempHp(2d8+圣武士等级) 完整结算‘以至圣斩造成伤害后以附赠动作分配合计 2d8+等级临时生命值给自身或所选生物’，无需再靠手动调整；原 partial 仅因‘分配给他人需手动调整’，该
- `XGE:圣武士:轻蔑呵斥:15`（带可直接用的 patch） —— 受击触发（未失能、attacker 存在）已由 trigger 实现，将 do 的 note 改为 damage（to:'attacker'、psychic、dice=max(chaMod,1)）即可自动对攻击者结算心灵反伤——damage/to:'attacker' 均有对应节点，无数值缩放/距离/视线判定
- `XGE:术士:暴风狂怒:14`（带可直接用的 patch） —— 被近战命中后反应对攻击者造成闪电伤害(=术士等级)、攻击者过力量豁免(你的法术DC)、失败被推开至多20尺——damage(to:attacker)、save(to:attacker, onFail move push)均有对应节点可完全自动；现有 root 仅占位，需补节点。
- `XGE:术士:风暴之心:6`（带可直接用的 patch） —— 施展1+环阶且造成闪电/雷鸣伤害的法术后(after spellCast, 条件用ask确认)，对10尺内可见生物造成等于术士等级一半的闪电或雷鸣伤害——area targeting+filter(canSee)、choose二选一、damage(to:target)均有接口可完全自动；现有 root 仅占位 choo
- `XGE:野蛮人:冻原:14` —— 激活灵光时选灵光内可见生物力量豁免(DC=8+熟练+体质)、失败速度降为0直至下个回合开始，已由 free 动作+save+applyEffect(speedSet, 至 source 下个 turnStart) 完整实现，按原文设计为『由人在激活灵光时使用』。
- `XGE:野蛮人:精魂之盾:6` —— 文本【已自动化】：反应时机、狂暴条件、30尺+可见判断、以及按等级自动选 2d6/3d6/4d6 减伤，已由 trigger(damageIncoming,role:any,window:before)+cost:reaction+modify:reduceDamage 完整实现。
- `XGE:吟游诗人:阴暗学识:14`（带可直接用的 patch） —— text 的机械部分——30 尺内能听见声音的生物感知豁免失败则被魅惑 8 小时、受攻击/伤害/被迫豁免时提前结束——可用 save + applyEffect(魅惑, duration 8h, endsOn) 完整自动结算；「共通语言要求与非战斗秘密恐吓角色扮演」属 DM 叙事，不在引擎范畴。
- `XGE:游荡者:梦幻舞步:3`（带可直接用的 patch） —— 原文「攻击目标与效应的时机、持续时间引擎自动处理（效应在你回合结束时消失）」已由 d20Rolled 触发+applyEffect+回合末消失实现；「它不能对你借机攻击」可用 effects flags cannot:['opportunityAttack']（interfaces §4 已支持，旧审计称「引擎没有开关
- `XGE:游侠:魔法使的克星:11`（带可直接用的 patch） —— 原文「迫使感知豁免（DC=你的法术豁免DC），豁免失败其法术或传送失败并浪费」可用 trigger(spellCast, before)+modify cancelUnlessSave（setDc=self.spellDc、失败即取消）全自动；反应与资源消耗由 cost 处理，60尺可见用 ask 桥接。
- `XGE:游侠:位面战士:3`（带可直接用的 patch） —— 「附赠动作指定30尺内可见的一名生物，本回合对其下一次武器攻击命中造成额外1d8（11级2d8）力场伤害」——bonus动作选目标(canSee判可见、range判30尺)，effect 挂一个 attackHit 触发器，在该生物武器攻击命中时对其攻击目标施加 1d8 force 伤害(damage节点)并自销，引擎
- `XGE:战士:不懈:10`（带可直接用的 patch） —— 「当你投掷先攻时，若你斗战之魂的使用次数已被用尽时，你将重获一次使用次数」——initiativeRolled 窗口事件 + when self.resource('fightingSpirit')==0 + resource 节点返还1次，引擎可完全结算。
- `XGE:战士:斗战之魂:3`（带可直接用的 patch） —— 「附赠动作为本回合任何武器攻击提供优势，并获得5点临时生命(10级10/15级15)，长休恢复3次」——bonus动作消耗 fightingSpirit 资源、tempHp(按等级缩放)、effect 对本回合武器攻击授优势(rollMods)、资源长休恢复全部3次，引擎可结算。
- `XPHB:法师:魅影生物:6`（带可直接用的 patch） —— 引擎可表达：两个动作各消耗一份长休恢复的次数池（phantom-beast/phantom-fey），经 choose 选法术后 castFrom 以最低环（无 slot 消耗）当场结算召唤；半血已写进召唤数据、专注 1 小时、共用先攻、专注结束消失均可由 summon/concentration 处理；改学派为纯叙事
- `XPHB:魔契师:唤醒心灵:3` —— 附赠动作已正确实现：30 尺内可见生物为目标的 applyEffect 建立链接，removeEffect 自动结束旧链接；持续时间按规则设为手动结束（effect.duration.manual=true，引擎支持），心灵感应距离属叙事不结算。
- `XPHB:圣武士:信实坐骑:5`（带可直接用的 patch） —— 「不消耗法术位施展寻获坐骑一次、长休后才能再次」可用附赠/动作 + resource(faithful-steed, 长休恢复) 配合 summon 节点自动召唤相同坐骑（AC12/HP25/异界猛击1d8+2 按二环计由坐骑模板提供）；文本明确「坐骑实体与骑乘、失能后的独立行动仍需人处理」属探索/骑乘范畴，非本规则自
- `XPHB:武僧:反射闪避:7`（带可直接用的 patch） —— interfaces.md 第 3 节的 modify op 已含 `evasion`，可在「允许敏捷豁免以只承受一半伤害的效应」上自动实现成功=0伤、失败=半伤，失能条件用 when 排除，旧线索「引擎无法分辨」已过时。
- `XPHB:武僧:返本还元:10`（带可直接用的 patch） —— 原文「每次自己的回合结束时，可以移除魅惑、恐慌或中毒之一」可用 turnEnded 触发器 + choose 选其一 + removeEffect 完整结算；「不吃不喝不提升力竭」按原文由人处理，不属本规则自动部分。
- `XPHB:武僧:散打技巧:3`（带可直接用的 patch） —— 原文「命中后可迫使承受慌神/推离/失衡之一」全部可用：choose 选其一；慌神用 effect 旗标 cannot:['opportunityAttack']（interfaces §4 已支持）；推离用 save(str)+move(push 15)；失衡用 save(dex)+applyEffect(倒地)；DC
- `XPHB:野蛮人:灵树枝杈:6` —— 「自动部分」已含：反应挂 turnStarted、范围内可见生物力量豁免（DC 8+力量+熟练），失败则传送（move teleport 由界面选落点，引擎支持），并令速度降为0至其回合结束（effect speedSet 已写），全部可由引擎结算。

### feature（17）

- `XPHB:星移步法`（带可直接用的 patch） —— 「不消耗法术位对自己施放浮空术」可用一个无 slot 代价的 action 直接 applyEffect 浮空术模板到自身实现，绕开法术位施法动作，玩家点一次即完成。
- `XPHB:幽影护甲`（带可直接用的 patch） —— 「不消耗法术位对自己施放法师护甲」可用一个无 slot 代价的 action 直接 applyEffect 法师护甲模板到自身实现，绕开法术位施法动作，玩家点一次即完成。
- `XGE:暗影寿衣`（带可直接用的 patch） —— 「随意施展隐形术且无需法术位」可由 cost:[]（免位）+ applyEffect(template:'spell:隐形术') 当场结算，法术效果按隐形术本身处理；全文数值/时机/限制均可由现有接口完成，玩家点动作并选目标即可。
- `TCE:永恒奴役`（带可直接用的 patch） —— 「不耗法术位每日一次施展活化死尸、长休恢复」可由 cost:[{resource:'永恒奴役'}]（免位+每日一次）+ applyEffect(template:'spell:活化死尸') 结算，restCompleted 触发器恢复资源；限制与时机均可由现有接口完成。
- `XGE:诡术师的逃脱术`（带可直接用的 patch） —— 「以自己为目标每日一次免位施展行动自如、长休恢复」可由 cost:[{resource:'诡术师的逃脱术'}] + applyEffect(template:'spell:行动自如'，targeting 自身) 结算，restCompleted 恢复资源；均可由现有接口完成。
- `XPHB:condition:中毒` —— 原文『你进行的攻击检定与属性检定具有劣势』是单一固定劣势效果，已由 effect 的 rollMods:1 自动结算，无数值缩放、无时机条件、无距离/视线判定，玩家无需额外操作。
- `XPHB:condition:束缚` —— 原文『速度变为 0』statics:speedSet、『以你为目标的攻击检定具有优势』『你进行的攻击检定具有劣势』『你进行的敏捷豁免检定具有劣势』均为固定效果，已由 statics 与 rollMods:3 自动结算，无数值缩放、无时机条件、无距离/视线判定，玩家无需额外操作。
- `XPHB:action:撤离`（带可直接用的 patch） —— 撤离=本回合移动不引发借机攻击，可由 effect 的 cannot:['provoke'] 旗标在 until turnEnd（of bearer）期间自动结算，玩家只需点动作。
- `XPHB:action:终止专注`（带可直接用的 patch） —— 规则只是「停止专注」，引擎有 endConcentration 节点（interfaces.md 第2节）可在满足 requires:self.concentrating 时一键结算；现有 data 用 removeEffect 但未指名要移除的效应，应改为 endConcentration。
- `XPHB:mastery:推离`（带可直接用的 patch） —— 命中且目标体型不超过大型（when：非巨型/超巨型）时，用 move 节点的 push 模式自动直线推离，能力完整；距离『至多 10 尺』可由玩家在必要选择里定（符合 full 的『回答必要选择』）。
- `AU:放逐弹`（带可直接用的 patch） —— 攻击命中→消耗奥术射击→addDamage心灵伤害→save魅力豁免→效应失能+速度0（speedSet）均可由接口完成；'离开与重新出现在空间需手动处理'为原文授权手动。当前缺：save未配能力/DC、效应未加失能旗标(blocks)，补上即full。
- `AU:魔宠密友` —— 忠实伙伴/魔契师施法两动作 root summon 自动召唤、强韧魔宠加值已写入召唤数据；得力助手用 d20Rolled+ask+reroll（重掷取高近似优势）自动。'魔宠形态由人挑选'为原文授权选择，引擎查不了熟练/5尺用 ask 近似。
- `AU:虚弱弹`（带可直接用的 patch） —— 原文自动了：远程武器命中→耗奥术射击→附加黯蚀伤害(addDamage)+体质豁免(save)→失败则中毒至目标下回合结束(效应 duration=turnEnd of bearer)；中毒期间目标命中时减伤一枚奥术射击骰，可用效应 triggers 的 attackHit + modify:reduceDamage 
- `TCE:护符庇佑`（带可直接用的 patch） —— 佩戴者（你或已交出的盟友）豁免失败时提供选项、答应用就在结果上加 1d4 并从次数池扣 1 次，已全部由 d20Rolled before + addToRoll + 资源池自动结算；引擎不知道戴在谁身上用 ask 确认佩戴者仍属自动结算范围；失败不退次数也符合原文。
- `TCE:枪手` —— text 明确‘引擎本身不会因为敌人在 5 尺内就给远程攻击加劣势，所以也不需要在战斗数据里取消’，该站位规则已被引擎默认行为满足；枪械熟练属静态层、LD（装填）词条忽略，无需任何动作/节点，data 留空即正确。
- `TCE:云雾符文`（带可直接用的 patch） —— 反应拦截 attackHit 并把攻击目标重定向给另一生物、按新目标 AC 用原检定值重新判定可由 trigger.modify:redirect 自动结算（text 已确认引擎支持），资源池与重定向补上后即全自动；仅'新目标须距你30尺内'引擎不检查需 DM 守规矩(非硬阻塞)
- `XPHB:灵巧步法`（带可直接用的 patch） —— 附赠动作消耗卓越骰（已扣资源）、执行撤离（补 cannot:opportunityAttack 旗标即不引发借机攻击）、AC 加值（applyEffect + number 让玩家填入骰值）均可由引擎结算。

### spell（3）

- `AU:spell:闪电之环`（带可直接用的 patch） —— 光环进入/结束回合触发用 zone 节点可实现（text「生物进入或在其内结束回合时…体质豁免」），电能射线用 area line + save 节点（text「60 尺长 5 尺宽的电能线…敏捷豁免，失败 6d6 闪电、成功半伤」），伤害/耳聋/半伤均可用 damage/applyEffect/scale:0.5 结
- `XGE:spell:西风打击`（带可直接用的 patch） —— 「移动不引发借机攻击」已用 cannot provoke 标记；「仅一次、本回合第一次武器攻击优势，命中+1d8力场，无论是否击中步行速度+30至回合结束」均可用 rollMods(优势) + effect 触发 attackHit/attackMissed(附加伤害/加速/removeEffect 消耗) + sta
- `XPHB:spell:再生术` —— 「触碰一名生物立即恢复 4d8 + 15 点生命值」与「接下来的 1 小时内每回合开始恢复 1 点生命值」均已完全由 heal 与触发器自动结算；断肢再生纯属叙事无需战斗引擎结算。

### item（9）

- `XDMG:item:坚不可摧护甲` —— 「着装期间具有钝击、穿刺和挥砍伤害抗性」由常驻抗性效应结算；「以魔法动作获得免疫持续 10 分钟（次日黎明恢复）」由动作、免疫效应与长休恢复资源完整自动结算。
- `XDMG:item:坚不可摧药水` —— 「饮用后 1 分钟内具有对所有伤害的抗性」已由附赠动作与持续 1 分钟的全部伤害抗性效应（statics: [resistAll]）完全自动结算。
- `XDMG:item:雷霆法杖` —— 「电闪、雷鸣、雷霆」3项近战命中触发器（含2d6闪电伤害、DC 17体质豁免震慑、附赠动作组合触发及独立限次资源）与「闪电打击、惊雷」2项区域动作（120尺线状/60尺球状豁免伤害及耳聋状态）全都能由现有接口自动结算。
- `XDMG:item:隐身戒指` —— 「可以一个魔法动作令自己获得隐形状态」与「以一个附赠动作显形」已完整配置动作、applyEffect 与附赠动作 removeEffect，戒指隐形不受攻击中断，引擎能完全自动结算。
- `XDMG:item:英勇药水` —— 「获得 10 临时生命值，持续 1 小时」与「攻击检定与豁免检定掷骰均可掷 1d4 并加入结果中」通过 tempHp 节点与英勇效应的 rollMods 完整自动结算，无需维持专注。
- `XDMG:item:治疗药水` —— 「饮用治疗药水」以附赠动作饮用、扣减物品资源并直接调用 heal 节点恢复生命值，规则结算完全自动化。
- `XPHB:item:抗毒剂` —— 「以一个附赠动作喝下一小瓶抗毒剂，使你在避免或结束中毒状态的豁免中具有优势，持续1小时」完整配置了附赠动作消耗物品、持续 1 小时的抗毒剂效应及豁免优势修正，引擎完全支持自动结算。
- `XPHB:item:强酸` —— 「将其中一次攻击替换为丢出一小瓶强酸……目标必须通过敏捷豁免（DC 8 + 敏捷调整值 + 熟练），否则承受2d6点强酸伤害」已完整配置射程、豁免 DC 公式与伤害结算，能够全自动结算。
- `XPHB:item:圣水` —— 「替换一次攻击投掷圣水……敏捷豁免，若目标为邪魔或不死生物豁免失败承受 2d8 光耀伤害」通过 save 节点结合目标阵营/种族条件判断与伤害完整配置，能够全自动结算。

