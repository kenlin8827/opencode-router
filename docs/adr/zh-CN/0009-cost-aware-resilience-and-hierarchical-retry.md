# ADR-0009: 经济性感知的高弹性两层重试与跨层级故障转移架构

## 状态
已接受并实现 (Accepted & Implemented) - 2026-09-30

## 上下文 (Context)
在生产级智能路由网关的长期高并发演进中，熔断机制（ADR-0008）成功隔离了上游故障，但直接触发模型故障转移（Failover）在大上下文应用中暴露出严重的经济学与工程隐患：

1. **KV Cache 与 Prompt Cache 经济学痛点**：
   - 主流大模型（Anthropic Claude 3.5 Sonnet、DeepSeek-V3、OpenAI GPT-4o）对 Prompt Cache 命中均提供高达 90% 的价格折扣（如每百万 Token 从 $3.00 骤降至 $0.30，或 DeepSeek 从 $0.14 降至 $0.014）。
   - 在长多轮会话（50k~100k Token）中，若遇到云厂商边缘网关偶发的瞬态抖动（503 Bad Gateway、502、ETIMEDOUT），若网关不分青红皂白直接切换至另一个模型（如将 Claude-3.5 切为 GPT-4o），上游已预热的 KV Cache 将**瞬间报废清零**，单次请求成本暴增 10 倍，带来极大的算力与资金浪费。
2. **盲目原地重试与无感知重试的低效**：
   - 传统网关要么完全不重试，要么对所有错误盲目重试。对于欠费（HTTP 402 `insufficient_quota`）或密钥失效（HTTP 401），原地重试毫无成功可能，徒增数百毫秒请求延迟；对于客户端语法错误（HTTP 400），重试更是毫无意义。
3. **模型故障转移的“跨级”边界模糊**：
   - 当主模型故障且原地重试失败时，能否跨 Tier 切换？
   - 若任意切换，可能导致开发原本需要旗舰（Plus）模型的代码重构任务在故障时被悄然“降级”至廉价小型模型（Lite），产生严重的智力断崖（Intellectual Cliff）与幻觉污染；反之，若 Lite 模型全量故障时完全不提升，又会导致用户界面直接报错瘫痪。

## 决策 (Decision)
全面确立**经济性感知的高弹性两层重试（In-Place & Failover）与层级防降级（Anti-Downgrade）故障转移架构**：

### 1. 两层重试拓扑结构 (`retry: { inplace, failover }`)
网关将重试职责严格分层解耦为两级流水线：

```text
               +----------------------------------------------------+
               |                Client Request                      |
               +----------------------------------------------------+
                                         |
                                         v
               +----------------------------------------------------+
               |            Candidate 1 (Primary Model)             |
               +----------------------------------------------------+
                                         |
                       +-----------------+-----------------+
                       |                                   |
                  [Transient 5xx/Timeout]            [402/401 Hard Trip]
                       |                                   |
                       v                                   v
        +-----------------------------+         (Bypass In-Place Retry)
        |  Tier 1: In-Place Retry     |                    |
        |  (200ms + 100ms Jitter)     |                    |
        +-----------------------------+                    |
          | (Success)             | (Failed)               |
          v                       +------------------------+
   [Return 200 OK]                                         |
   (100% KV Cache Saved!)                                  v
                                        +-------------------------------------+
                                        |      Tier 2: Multi-Model Failover   |
                                        |   (Exhaust Same Tier -> Escalate)   |
                                        +-------------------------------------+
                                                           |
                                                           v
                                        +-------------------------------------+
                                        |    Candidate 2 (Backup Model)       |
                                        +-------------------------------------+
```

* **第一层：原地重试 (In-Place Retry - 细粒度抖动诊断与挽救 KV Cache)**：
  * **细粒度网络抖动分类学 (Network Failure Taxonomy)**：
    系统通过 [`ErrorClassifier`](file:///d:/Projects/llm-router/src/resilience/error-classifier.ts) 对异常进行精准底层剖析，解构为 `networkCause` 并判定 `isInPlaceRetriable`：
    1. `CONNECTION_RESET`（连接中断：`ECONNRESET`、`ECONNABORTED`、`socket hang up`、`EPIPE`、`und_err_socket`）：**极速原地重试**；
    2. `NETWORK_TIMEOUT`（超时抖动：`ETIMEDOUT`、`ESOCKETTIMEDOUT`、HTTP 504 Gateway Timeout、`AbortError`）：**极速原地重试**；
    3. `GATEWAY_ERROR`（网关瞬断：HTTP 502 Bad Gateway、HTTP 503 Service Unavailable、Cloudflare 52x）：**极速原地重试**；
    4. `DNS_ERROR`（DNS 抖动：`EAI_AGAIN`、`ENOTFOUND` 短暂网络解析故障）：**极速原地重试**；
    5. `RATE_LIMIT_BURST`（瞬时短频控：HTTP 429 且 `Retry-After <= maxRateLimitWaitMs`，默认 2s）：**按需原地等待重试**，原地等待 1~2 秒即可挽救 50k~100k Token 的高价值 KV Cache，经济效益巨大；若超过 2s 则立即切换备用模型；
    6. `SERVER_INTERNAL_ERROR`（HTTP 500 内部服务错误）：默认不原地重试（上游代码异常重试大概率仍挂），但可通过配置显式开启；
    7. `HARD_FAILURE`（HTTP 402 欠费、HTTP 401 密钥失效、HTTP 400 传参错误）：**绝对严禁原地重试**（0 次重试立即穿透至 Failover 或返回）。
  * **策略配置参数 (`retry.inplace`)**：
    * `maxAttempts`: 原地重试次数上限（默认: 1 次）；
    * `backoffMs`: 基础退避时长（默认: 200ms）；
    * `jitterMs`: 随机抖动（默认: 100ms），避免高并发下对上游形成惊群冲击；
    * `retryOnCauses`: 允许原地重试的故障原因白名单（支持自由定制过滤）；
    * `maxRateLimitWaitMs`: 允许原地退避等待的 429 最大容忍时长（默认: 2000ms）。
  * **经济价值**：工业数据表明单次微退避可化解约 70% 的云厂商网关毛刺抖动，**100% 保全上游 KV 缓存状态**，彻底避免跨模型切换导致的 10x 成本暴涨。


* **第二层：候选池故障转移 (Candidate Pool Failover)**：
  * 当原地重试耗尽仍未恢复，或遭遇 402/429 错误时，熔断器记录失败，无缝激活备用候选模型；
  * 受控于 `retry.failover.maxAttempts`（默认 2 个模型），防止极端情况下无休止串行遍历模型引发超长延迟。

### 2. 跨层级切换策略与严格防降级体系 (`tierCrossPolicy`)
确立明确的越级规则边界，提供两档策略：

* **`allow_escalate`（默认推荐：同级耗尽 -> 向上升档保活，绝不向下跳水）**：
  1. **同级优先原则 (Same-Tier Exhaustion First)**：若路由裁决目标为 Lite Tier，必须优先遍历所有健康的 Lite 模型（`lite-primary` → `lite-backup`）；
  2. **向上升档保活 (Upward Escalation)**：仅当当前 Tier 的全部健康候选模型均不可用或请求失败后，允许透明升级至更高阶的 Plus/Pro/Ultra Tier 候选模型，杜绝业务端直接中断；
  3. **严格防降级铁律 (Strict Anti-Downgrade)**：**若请求本身判定或强制为 Plus/Pro/Ultra Tier，当该 Tier 全部不可用时，系统严禁向下降级至 Lite 模型！**
     * *动因*：在复杂系统架构、代码生成与数理逻辑场景下，向下降级导致的低质输出与隐蔽 Bug 危害，远大于明确返回 503 错误。
* **`same_tier_only`（严格同级封锁）**：
  * 故障转移严格限制在当前 Tier 的注册模型池内，绝不跨越任何 Tier 边界；
  * 适用于严格预算控制的大规模离线批量任务（Batch Processing），避免任务因上游拥堵自动跳档至高价旗舰模型造成账单失控。

### 3. 全链路可观测性扩展 (Observability & Headers)
所有 HTTP 响应（包含普通模式与 SSE 流式输出）均注入精准的弹性治理元数据：
* `X-OCR-InPlace-Retries`: 原地重试次数（`0` 或 `1`）；
* `X-OCR-Failover`: 是否发生跨模型故障转移（`true` / `false`）；
* `X-OCR-Failover-Attempts`: 实际尝试的候选模型数量；
* `X-OCR-Failover-Path`: 完整转移链路路径（例如 `gpt-4o -> claude-3-5-sonnet`）；
* `X-OCR-Breaker-State`: 最终模型的熔断器状态（`CLOSED` / `HALF_OPEN` / `OPEN`）；
* 会话轨迹跟踪器（`TraceTracker`）与监控日志将完整记录上述治理字段。

## 后果与影响 (Consequences)
- **正面影响**：
  - **最大化保护 Prompt Cache 经济收益**：消除绝大多数因上游网关毛刺导致的盲目模型切换，保全 90% 缓存折扣；
  - **零无效延迟**：402 欠费与 401 鉴权故障 0 次原地等待，直接触发同级快速故障转移；
  - **产研智力安全**：通过“单向升档、绝对禁降”的安全策略，阻绝因容灾引起的模型降级与智力断崖；
  - **极简语义配置**：在 `config.yaml` 中通过 `retry: { inplace, failover }` 结构清晰声明，兼顾简单场景与专业生产需求。
- **负面与权衡 (Trade-offs)**：
  - 在遇到持续不可恢复的 5xx 故障时，首个模型将经历额外的 ~250ms 原地退避耗时后才切向第二个模型，这是为了挽救高价值 KV Cache 所权衡付出的微小代价。
