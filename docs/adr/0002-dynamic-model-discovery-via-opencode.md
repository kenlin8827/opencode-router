# ADR-0002: 100% Dynamic Model Discovery and Adaptive Tiering via OpenCode

## Status
Accepted - 2026-09-29
Partially superseded by [ADR-0011](./zh-CN/0011-pure-direct-execution-no-daemon.md) - 2026-10-08 (Section 4 "Keyless Proxy Delegation" to the OpenCode daemon is retired; direct execution replaces proxying. Dynamic-discovery and tiering ideas in Sections 1-3 remain in force, with the data source moved to the local catalog).

## Context
Traditional LLM routing gateways require hardcoding upstream providers, API keys, endpoints, model identifiers, and manual tiering maps directly into configuration files or codebase. This presents significant operational drawbacks:
1. **Maintenance Overhead**: Every pricing adjustment, newly introduced model, or key rotation requires editing code or restarting services with modified static configuration.
2. **Credential Sprawl & Security Risks**: Multiple upstream vendor API keys scattered across repository environments increase leakage vectors.
3. **Decoupled Local Developer Environment**: The developer system already runs OpenCode v2 as a local model proxy hub, which natively manages upstream authentication keys, provider proxies, and live model metadata (including per-token pricing and capability flags).

## Decision
1. **Completely Purge Static Providers & Models from Configuration**:
   - Eliminated all static `providers` and `models` entries from `config.yaml` to prevent configuration drift.
2. **100% Dynamic Boot-Time Discovery**:
   - On startup, `OpenCodeConnector` auto-discovers credentials from `~/.config/opencode/service.json`.
   - Queries OpenCode's REST API dynamically to retrieve all active upstream models and pricing (90+ models across 7+ providers).
3. **Adaptive Price Pyramid & Capability Classification**:
   - Zero vendor or model ID regex string matching (no hardcoded `qwen`, `kimi`, or `gpt` tags).
   - Entirely data-driven dynamic tiering:
     - **Fast ()**: Input pricing `<= $0.80/1M`, with the lowest-cost model selected dynamically as default lead.
     - **Flagship ()**: Median cost range general-purpose models, with median model assigned as flagship lead.
     - **Reasoning ()**: Filtered dynamically where `capabilities.reasoning === true`, reasoning parameters exist, or input pricing `>= $5.00/1M`.
4. **Keyless Proxy Delegation**:
   - All upstream providers are registered as `OpenCodeProxyProvider`, allowing zero-secret, keyless pass-through execution.

## Consequences
- **Positive**:
  - Zero hardcoding of model IDs, vendor names, or API tokens in the repository.
  - Adding, deleting, or switching models in OpenCode is instantly reflected on gateway reload.
  - Future-proof classification based purely on economic distributions and capability flags.
- **Negative / Constraints**:
  - The gateway relies on the local OpenCode daemon running (`http://127.0.0.1:49374`). Graceful fallback modes are provided if the daemon is unreachable.
