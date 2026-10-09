# ADR-0012: 梯队匹配去残差化——三梯队完全同构 + 锚定排除 excludeTiers + 未分类第四态

## 状态

Implemented — 2026-10-09
关联：[ADR-0011](0011-pure-direct-execution-no-daemon.md)（沿用「不可路由的供给显式排除而非静默降级」）、[ADR-0009](0009-cost-aware-resilience-and-hierarchical-retry.md)（跨梯队 failover / 反向防降级）、[ADR-0004](0004-hierarchical-classification-and-data-flywheel.md)（Layer 1/2 请求侧分档，**不在本 ADR 范围**）。

## 背景

候选池成员判定只有一个依据（smart match），但三个梯队**不同构**：`fast` / `reasoning` 有「名称 pattern + 价格区间 + 本梯队 exclude」，`flagship` 被设计成**残差梯队**（residual）——所有没被别人认领的模型自动落进它。由此产生的硬编码不对称：

1. `providers/tier-match.ts`：`flagship: {}`（无区间基线）；价格区间只对 `fast` / `reasoning` 调用 `bandHit`；末尾 `return 'flagship'` 无条件兜底。
2. `pages/RulesPage.tsx`：三处 `tier !== 'flagship'`（构造 payload ×2、渲染输入框 ×1）→ Flagship 卡片没有价格区间输入框。
3. Flagship 卡片的 exclude 文本框实际读写**全局** denylist `tiers.exclude`，与 fast/reasoning 的「本梯队否决」语义不同。

后果：手工往 `config.yaml` 写 `tiers.flagship.match.minInputPerM`，`resolveTierMatch()` 会 merge 进来，但 `classifyTier()` 从不查询 —— **死配置**。

用户诉求：每个梯队一样的配置方式，一切条件可由用户修改；明确否决「残差兜底」这种隐性规则；并要求排除以**梯队侧**表达（本梯队声明不收哪些梯队的模型），运行时把那些梯队的条件当作排除过滤。

实测约束（`~/.cache/opencode-router/catalog/`，2026-10-09）：`models-dev.json` 8461 个模型中 **446 个（5.3%）没有数值型 `cost.input`**；`openrouter.json` 468 个全部有价。`bandHit()` 对 `price == undefined` 返回 false，所以去残差后这 446 个缺价模型不再属于任何梯队。

## 备选方案与否决理由

| 方案 | 内容 | 结论 |
| :--- | :--- | :--- |
| A | flagship 区间只作「软条件」，仍保留兜底 | **否决**：等于不生效，假配置项 |
| C | 保留残差但改名 `tiers.fallbackTier`（默认 flagship） | **否决**：隐性兜底只是换了个显式名字 |
| C' | 仅缺价模型保留窄残差（`unpricedTier`） | **否决**：把数据质量问题编码进梯队语义 |
| D₁ | `excludeTiers` 放**模型侧**（overrides.json / opencode.jsonc 逐模型声明） | **否决**：需要贯通目录存储 + 新增 UI，且用户无法在一屏内看懂梯队规则 |
| D₂（本 ADR） | `excludeTiers` 放**梯队侧**：本梯队不收哪些梯队的模型 | **采纳**：零新增存储，运行时取被引梯队的条件做过滤 |

## 决策

### 1. 第四态是「标记位」，不是梯队枚举成员

`types/router.ts` 新增 `PoolMembership = TierLevel | 'unclassified'`，`classifyTier()` 返回它；`ModelRegistration` 的 `tier: TierLevel` **不变**，另加 `unclassified?: boolean`。

理由：`TIER_RANK`、`targetTier`、`escalateTier`、`layer1-classifier.ts` 的 `tierMap`、flywheel `groundTruthTier`、会话棘轮 `maxTier` 全是**请求侧三态**语义 —— 把第四态塞进 `TierLevel` 会破坏排序全序与训练标签类型。未分类模型仍带占位 `tier`，但被标记排除在所有候选池与梯队代表之外。**Layer 1/2 分类器零改动。**

### 2. 三梯队完全同构（五项）

每梯队一律 `patterns` / `minInputPerM` / `maxInputPerM` / `exclude` / `excludeTiers`，`RulesPage.tsx` 三处 `tier !== 'flagship'` 特例全部删除。`DEFAULT_TIER_MATCH.flagship` 基线 = **闭区间 `[0.8, 5]`**（原残差语义的字面补集，>5 由 reasoning 下限接住）。

**pin 语义取消**：原 flagship pattern 是唯一不受 exclude 否决的「救回」通道（`tier-match.ts` 旧 :90）。同构后各梯队 pattern 一律受判定顺序与本梯队 gate 约束；强制钉选只走目录页显式 `tier`（overrides > `configTier`，本就是链上最高权威）。

### 3. 判定链

```
denied = 命中全局 tiers.exclude                        // 池查询层无条件过滤，连人工钉选也否决

1. 显式 tier / configTier（人工钉选，registry 短路，不看梯队 gate）
2. 名称 pattern：fast → reasoning → flagship
3. 价格区间 bandOrder()：闭区间按下限升序 → 开区间按下限降序；重叠归下限更低者；缺价不命中
4. reasoning 标记 → reasoning
5. 都不命中 → unclassified
```

每个认领都被两级 gate 拦住：

```
claim(tier, hits) = hits
                  && !(tiers[tier].match.exclude 命中该模型)
                  && !(tiers[tier].match.excludeTiers 中任一梯队的【条件】命中该模型)
```

`excludeTiers`（锚定排除）判定的正是「那个梯队的条件集合是否认领此模型」—— `matchesTierConditions()`：**patterns / price band / reasoning 标记**三者任一命中即为真，且**不看**被引梯队自己的 exclude（锚定的语义是"那些梯队的模型"，不是"那些梯队最终池子里的模型"）。自指（`excludeTiers` 含本梯队）被忽略。

> **`exclude` / `excludeTiers` 不是"更早的一个 stage"，而是每次认领上的 gate。** 认领是 `return`：把排除做成独立前置 stage，放在认领之后就没有执行机会，放在之前又只能表达全局无条件 denylist（那已是 `tiers.exclude` 的职责）。

> ⚠️ `bandOrder()` 的两段式次序是本 ADR 的关键补丁：开区间（无上限）是**弱条件**，必须排在所有闭区间之后，且彼此之间按下限**降序**——否则 `{min: 0.8}` 的开区间会在区间阶段吞掉 `$15` 的高价模型，把 reasoning 池清空。

### 4. `tiers.exclude` 保留字段，但 /tiers 页不再放卡片

用户明确不要「全局排除名单」卡片，也不要「未分类」卡片。因此：

- `tiers.exclude` 仍在后端生效（池查询层 `applyTierPolicy`），编辑入口是**原始 YAML 页**；
- `/tiers` 保存时把已加载的 `tiers.exclude` **原样回传**：`saveConfig` 是浅合并 `{...current, ...newConfig}`，`tiers` 整体替换，payload 省略该字段会**静默销毁**用户已有的 denylist（`config.yaml` 当前无此字段，但保存路径对所有用户都成立）；
- 池明细弹窗里既有的「排除」按钮仍写入该字段（原有能力，未新增 UI）。

### 5. 未分类的可见性：靠目录页与日志，不新增卡片

- 目录页 tier 建议新增原因码 `unclassified`（`lib/tierMatch.ts` 的 `TierReasonCode` + `catalogPage.ocrTierWhyUnclassified`）——单个模型可在这里看到"没有任何条件命中"。
- 配置保存后若某梯队池为空，`warnOnEmptyTierPools()`（`routes/console.ts`，两条保存路径都调）在网关日志点名该梯队并提示放宽 match 或在目录页钉选。
- **未分类模型对梯队路由不可见但没有消失**：仍可按模型 id 直连、或经 combo 调用。

> 实现取舍：曾把 `pools.unclassified` 加进 `/api/ui/tier-pools` 与 `/tier-pools/live` 并做过两张卡片，按用户「不要残留」的指示已全部撤回；`resolveTierPool` 仍接受 `PoolMembership`（第四态在纯投影层可用，便于诊断），但不再作为 API 输出面。

### 6. 空池行为：允许降级，禁止静默

残差在时梯队池几乎不可能空；去残差后空池成为常态可能。旧代码空池 → `tierDefaults.get('flagship') || fast || reasoning || models[0]`，**无任何日志**（`registry.ts` 旧 :309-318），即"请求 flagship 实际拿到 fast 模型"不留痕迹。现改为：

1. 降级链显式化：`fallback.escalateTier` → flagship → fast → reasoning，逐级跳过 unclassified；
2. 每一跳 `console.warn` 记录 `requested / actual / reason=empty-pool`；
3. 全部梯队都无可路由模型 → 抛错（不再抓 `models[0]` 假装可用）；
4. 梯队代表选择改为**显式两阶段**（先定全部成员，再选代表），且 `registerModel`、`reclassifyTiers`、`sync.ts` 的动态代表选择全部跳过 unclassified —— 未分类模型永远不能当梯队代表。

## 行为差异（相对旧残差语义，必须知晓）

1. **缺价 + 无 pattern + 无推理标记 → 未分类**（旧：落 flagship）。目录 446/8461（5.3%）落此列，需在目录页显式钉选。
2. **价格落在 flagship 区间内且带推理标记 → flagship**（旧：落 reasoning）。因为「区间优先于推理标记」这条既有规则现在对 flagship 同样生效。修法：调低 flagship 上限、给该模型加 reasoning pattern、或目录页钉选。
3. 价格恰为 $5（flagship 上限 = reasoning 下限）归 flagship。
4. 已写 `tiers.flagship.match.patterns` 的配置，其 pattern 从「救回」降级为「普通认领」。当前仓库 `config.yaml` 的 flagship 有 `*opus*` / `*sonnet*`，语义随之变化 —— 若想恢复旧效果，给 flagship 加 `excludeTiers` 的反向配置或改用目录页钉选。

## 风险与边界

- 主回归（缺价模型）无 UI 兜底，仅目录页可见 —— 这是用户在"彻底未分类 + UI 可见 + 批量钉"与"不要残留"之间选择的后者，代价已知。
- `tiers.exclude` 由 /tiers 页改为 YAML 页编辑：字段语义与后端行为完全不变。
- 单测覆盖（`backend/tests/tier-match.test.ts` 全量重写，12 例 / 33 断言）：三梯队同构、缺价 → unclassified、flagship 区间真实生效、`bandOrder` 开闭区间次序、区间重叠归低下限、`exclude` 否决、`excludeTiers` 锚定否决（含跨条件 patterns/band/flag、自指忽略）、被否决模型可被其他梯队接住。

## 改动面（已落地）

后端：`types/router.ts`（`PoolMembership`）、`providers/tier-match.ts`（链重写 + `bandOrder` + `matchesTierConditions` + flagship 闭区间基线 + gate）、`providers/registry.ts`（`projectedTier`、两阶段 `reclassifyTiers`、`registerModel` 代表保护、`getCandidateModelsForTier` 过滤、`getModelForTier` 显式降级链 + warn、`resolveTierPool` 放宽为 `PoolMembership`）、`config/types.ts`（`unclassified`、`TierPolicy.match.excludeTiers`、注释）、`config/index.ts`（tiers 字段说明，含新增 `tiers.*.match.excludeTiers`）、`providers/boot-direct.ts`、`opencode/sync.ts`（第四态 + 代表选择跳过未分类）、`routes/console.ts`（`warnOnEmptyTierPools` ×2 保存路径）。
前端：`lib/tierMatch.ts`（镜像重写：`Membership` / `bandOrder` / `matchesTierConditions` / `excludeTiers` gate）、`pages/RulesPage.tsx`（三张同构卡 + 锚定排除勾选；另修复了工作区遗留的 JSX 未闭合）、`pages/CatalogSourcesPage.tsx`（`unclassified` 原因码）、`lib/api.ts`（`match` 类型补 `exclude` / `excludeTiers`）、`i18n/{types,locales/zh-CN,locales/en-US}.ts`。
测试：`backend/tests/tier-match.test.ts` 全量重写（原 6 条 `toBe('flagship')` 残差断言按新语义改写）。

## 后果

- 三梯队配置项与 UI 完全一致，不存在"写了也不生效"的字段；flagship 的价格区间、排除、锚定排除全部用户可改。
- 成员判定从「隐式兜底」变为「显式归属」，代价是缺价/无条件的模型需要人工钉一次，且当前只在目录页可见。
- 空池从「静默跨梯队降级」变为「带日志的显式降级，全无模型则报错」，与 ADR-0009 / ADR-0011 的容灾语义一致。
