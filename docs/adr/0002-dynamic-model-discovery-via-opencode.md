# ADR-0002: Dynamic Model Discovery via OpenCode

- **Status**: Accepted (2026-09)
- **Supersedes**: Static `providers:` and `models:` arrays in `config.yaml`.

## Context

The gateway previously required operators to manually enumerate every upstream model ID, API key, and price tier in `config.yaml`. This caused three failure modes:

1. Catalog drift (config ages out of date within days).
2. Brittle regex routing rules that broke on every vendor name change.
3. Operator time spent copy-pasting provider/model entries from each vendor's website.

## Decision

1. **Completely Purge Static Providers & Models from Configuration**:
   - Eliminated all static `providers` and `models` entries from `config.yaml` to prevent configuration drift.
2. **100% Dynamic Boot-Time Discovery**:
   - On startup, `OpenCodeConnector` auto-discovers credentials from `~/.config/opencode/service.json`.
   - Queries OpenCode's REST API dynamically to retrieve all active upstream models and pricing (90+ models across 7+ providers).
3. **Adaptive Price Pyramid & Capability Classification**:
   - Zero vendor or model ID regex string matching (no hardcoded `qwen`, `kimi`, or `gpt` tags).
   - Entirely data-driven dynamic tiering:
     - **Lite (≤$0.80/1M)**: Low-cost tier, with the lowest-cost model selected dynamically as default lead.
     - **Plus ($0.80–$3/1M)**: Workhorse tier, median-cost general-purpose models.
     - **Pro ($3–$8/1M)**: Thinking tier, filtered where `capabilities.thinkingEffort === true`, thinking parameters exist, or input pricing `>= $3.00/1M`.
     - **Ultra (≥$8/1M)**: Frontier tier for the highest-priced models (e.g. Claude Fable, GPT-5 Ultra).
4. **Keyless Proxy Delegation**:
   - All upstream providers are registered as `OpenCodeProxyProvider`, allowing zero-secret, keyless pass-through execution.

## Consequences

- **Positive**:
  - Zero-config onboarding: a fresh `config.yaml` discovers everything at boot.
  - Catalog additions (new vendor SKUs, price drops) take effect on the next restart with no config edits.
- **Negative**:
  - Pricing changes from upstream vendors do silently change a model's tier membership on restart.
  - The gateway inherits any availability/latency quirks of the OpenCode daemon's REST API.
