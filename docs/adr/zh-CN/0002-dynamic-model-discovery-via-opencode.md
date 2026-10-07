# ADR-0002: 基于 OpenCode 的 100% 动态模型发现与自适应分层

## 状态
已接受 (Accepted) - 2026-09-29
部分废止 (Partially Superseded by [ADR-0011](./0011-pure-direct-execution-no-daemon.md)) - 2026-10-08：第 4 条"无密钥代理委托"（执行走 OpenCode daemon）已废止，改为网关直连；第 1–3 条动态发现与自适应分层理念保留，数据源迁移至本地 catalog。

## 上下文 (Context)
传统 LLM 网关往往要求在配置文件或代码中显式列出所有上游厂商的 API Key、BaseURL、模型名称及分级梯度。这种做法带来了以下痛点：
1. **运维硬编码负担严重**：每当上游增加新模型、调整模型定价或轮换 API Key 时，网关必须修改代码或重启更新静态配置。
2. **多源认证泄露风险**：多个上游的敏感 API Key 散落在各个项目的 YAML/ENV 文件中，管理脆弱且易泄露。
3. **开发环境本地解耦需求**：本地已部署有 OpenCode v2 作为本地模型代理中枢，OpenCode 自身已经托管了所有主流云厂商的 API Key、认证通道、代理路由与实时模型元数据（包括定价与能力标签）。

## 决策 (Decision)
1. **彻底废除配置文件中的静态 `providers` 与 `models`**：
   - 将 config.yaml 中的静态厂商和模型列表全部剔除，避免误导使用者。
2. **启动时 100% 动态同步与发现**：
   - 网关启动时通过 OpenCodeConnector 自动探测本地 OpenCode 后台服务凭据（`~/.config/opencode/service.json`）。
   - 通过 REST API 动态抓取当前已激活的所有模型及计费配置（实测动态接入 94 个模型、7 家上游 Provider）。
3. **自适应动态梯队分层 (Dynamic Tiering Algorithm)**：
   - 不依赖任何特定厂商或模型字符串名称（例如不做 `id.includes('qwen')` 或 `id.includes('kimi')` 的硬编码）。
   - 纯粹基于元数据特征做自适应归类：
     - **Fast ()**：`inputCost <= $0.8/1M`，并动态选出最低输入成本者作为该层默认冲锋模型。
     - **Flagship ()**：中位成本通用模型，选出中位数模型作为默认主力。
     - **Reasoning ()**：具备 `capabilities.reasoning === true`、带有 `thinking/effort` 参数或 `inputCost >= $5.0`。
4. **认证与调用全代理**：
   - 将所有上游 Provider 注册为 OpenCodeProxyProvider，网关无需持有任何第三方云厂商的 API Key，全链路零秘钥安全直通。

## 后果与影响 (Consequences)
- **正面影响**：
  - 源码与配置文件中没有任何模型名称、厂商名称或 API Key 的硬编码。
  - 用户在 OpenCode 控制台内添加、修改、启用或停用模型，网关重启即可秒级全量感知。
  - 模型分层完全数据驱动，具备长期的向后兼容性与灵活性。
- **负面影响 / 约束**：
  - 网关强依赖本地 OpenCode 后台服务的正常运转，若 OpenCode 服务不可达，网关需进入降级或等待恢复模式。
