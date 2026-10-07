# ADR-0010: 路由决策缓存(Layer 2 Judge 结果复用)

## 状态

Accepted — 2026-10-07
关联:[ADR-0006 会话棘轮](0006-monotonic-session-ratchet-and-prefix-fingerprinting.md)(会话内粘性,本 ADR 管跨会话复用)、[ADR-0001](../0001-purge-fuzzy-semantic-cache.md)(响应级缓存仍维持移除,**不在本 ADR 范围**)。

## 背景

"路由缓存"在本项目语境下 = **路由决策的缓存**,不是响应缓存。两个既有机制已覆盖大部分场景:

- 会话棘轮(ADR-0006):会话内锁定 `pinnedModel`,跨 turn 粘性——已上线;
- Layer 1 本地分类器:正则/意图探测,<2ms 零网络——无需缓存。

剩余空档:**Layer 2 语义 judge**(`backend/src/router/layer2-judge.ts`)每次判档都要发起一次外部模型调用(`timeoutMs` 默认 2000ms + token 成本),而相同对话上下文的判档结果是确定的——重复请求白白重复付费。

## 决策

在 `Layer2Judge.evaluate()` 内置 LRU+TTL 决策缓存:

1. **缓存键** = `${provider}::${model}::sha256(userText)`(userText 即 evaluate 内部构造的最后 4 turns 拼接文本;判别 provider/model 变更后旧缓存自然失配);
2. **缓存值** = `{ targetTier, confidence, reason }`(不存 rawResponse,省内存);命中时 `reason` 前缀 `[Decision Cache]`,在 ExecutionTrace.routing.reason 中可见;
3. **只缓存 Layer 2 成功决策**(null/超时/异常不写缓存);Layer 1 不缓存;
4. **配置**:`Layer2JudgeConfig.decisionCache: { enabled(默认 true), ttlSeconds(默认 1800), maxEntries(默认 500) }`;改动需重启网关生效;
5. **观测**:`Layer2Judge.getCacheStats()` → `{ entries, hits, misses, hitRatio }`,聚合进 `GET /api/ui/cache-stats` 的 `routingCache` 段,CachePage 展示。

## 风险与边界

- **判错代价 = 路由次优**(tier 偏了),不会内容污染——这是与 ADR-0001 否决的响应缓存的本质区别,风险低一个量级;
- 相同文本但用户意图切换的场景(同文重发)命中同决策——决策是分类值而非内容,可接受;
- 单测覆盖:同文本命中 / 异文本不命中 / TTL 过期 / LRU 淘汰 / provider/model 失配。

## 后果

- Layer 2 重复判档零网络零 token;Layer 2 本身仅在 Layer 1 未决时触发,故收益集中在首判后的重复/相似上下文;
- 未来若 Layer 2 换 embedding 化输入,键构造需同步升级(留接口于 `buildCacheKey`)。
