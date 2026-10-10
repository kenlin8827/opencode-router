# ADR-0006: 多轮会话单调递增升档与无粘性头前缀指纹追踪机制

## 状态
已接受并实现 (Accepted & Implemented) - 2026-09-29

## 上下文 (Context)
在通用 LLM 网关中，处理多轮对话（Multi-Turn Chat）面临两大严峻挑战：
1. **中途乱切导致智力倒退与能力断层**：
   - 用户第 1 轮要求设计复杂的分布式共识算法，第 2 轮随口追问：“*好的，为什么第三行要加 1？*”。
   - 如果网关每轮孤立无状态评估，会误将第 2 轮当成极简对话切入 Lite tier 小模型，而小模型面对长达数千 Token 的前序复杂上下文根本无法理解，导致严重幻觉与回复质量崩塌。
2. **中途换模型导致 Prompt Caching (KV 缓存) 彻底作废**：
   - 现代大模型（Kimi, DeepSeek, Claude, OpenAI）普遍支持前缀缓存（Prompt Caching），命中率可达 80%~95%，成本打 1~2 折；
   - 一旦在会话中途跨模型甚至跨 Provider 切换，累积的上万 Token 历史在前一个模型的 KV 缓存全部作废，必须在全新模型上重新全额付费做 Prefill 计算，FinOps 成本不仅没省反暴增几十倍！
3. **无粘性头现实（No Sticky Headers in Standard Clients）**：
   - 官方 SDK、OpenAI 协议客户端（Chatbox, NextChat, OpenWebUI, Cursor 等）默认只发无状态的 `messages` 数组，不携带自定义 `x-session-id`。

## 决策 (Decision)

### 1. 单调升档状态机 (Monotonic Ratchet Strategy)
采用**“只升不降 + 同梯队强固化模型”**机制：
- **定义梯队等级**：$\text{Rank}(\text{lite}) = 1 < \text{Rank}(\text{plus}) = 2 < \text{Rank}(\text{pro}) = 3 < \text{Rank}(\text{ultra}) = 4$；
- **升档机制 (Escalation)**：
  - 当本轮分类器决策等级高于会话历史最高等级（$T_{\text{proposed}} > T_{\text{session}}$）时，**允许升级**至新梯队，并重新固化新梯队的具体模型与 Provider；
- **降档拦截 (Ratchet Lock)**：
  - 当后续简短提问单轮评估等级低于历史最高（$T_{\text{proposed}} \le T_{\text{session}}$）时，**强制锁死在历史最高梯队**；
  - **核心保障**：直接复用会话固化的同一个物理模型 ID（`session.pinnedModel`），确保 100% 命中上游 Provider 的 KV 缓存，杜绝重复 Prefill 成本！

### 2. 双重指纹无感会话识别体系 (Prefix-Chain & Root Anchor)
在零客户端配合、零自定义 Header 的情况下，利用标准消息序列的天然拓扑学特性实现 100% 无碰撞识别：

```mermaid
flowchart TD
    Req[客户端请求流入 (无 Session Header)] --> CheckTurn{messages 轮次判断}
    
    CheckTurn -->|首轮提问: [U1]| Step1[1. 首消息根锚点 (Root Anchor)<br/>Hash = hash(clientIp + firstUserMsg)]
    CheckTurn -->|多轮提问: [U1, A1, U2]| Step2[2. 历史前缀链 (Prefix Chain)<br/>剥离最新提问 U2，提取包含上一轮AI回复的历史 [U1, A1]<br/>Hash = hash(messages.slice 0, -1)]
    
    Step1 --> QuerySession[查询会话状态管理器 SessionManager]
    Step2 --> QuerySession
    
    QuerySession --> Found{命中会话?}
    Found -->|是| ApplyRatchet[执行单调升档规则 (只升不降 + 固化模型)]
    Found -->|否| CreateSession[初始化新会话状态]
    
    ApplyRatchet & CreateSession --> Exec[上游模型执行 & 生成回复 A2]
    Exec --> RegisterPrefix[将完整历史 [U1, A1, U2, A2]<br/>注册为下一轮的前缀索引键]
```

- **历史前缀链 (Prefix Chain)**：针对第 2 轮及以上，剥离当前轮次的最新提问，前序历史包含了上一轮 AI 生成的回复（几百字、唯一句式与标点），全局指纹碰撞率严格为 0；
- **首词根锚点 (Root Anchor)**：针对第 1 轮，结合客户端网络标识（Client IP / Token）与首条用户问题内容哈希作为冷启动 Key；
- **后置自动注册**：每轮执行完成后，自动将包含 Assistant 最新输出的完整序列写入前缀映射池，保证下一轮发起时必定被毫秒级命中。

## 后果与影响 (Consequences)
- **正面影响**：
  - 彻底杜绝了因用户后续几句简短追问而跌落回弱模型的恶性降级问题；
  - 会话内只要未发生梯队跃升，始终与同一上游模型 Provider 交互，**最大化压榨 Prompt Caching 潜力**；
  - 零侵入兼容任意第三方 OpenAI Web UI 与官方 SDK，无需客户端作任何改造；
  - 提供了统一的 `/v1/sessions` 活跃会话调试与大盘透视接口。
