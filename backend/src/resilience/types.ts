import { TierLevel } from '../types/router.js';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type ErrorCategory =
  | 'QUOTA_EXHAUSTED'      // 余额不足、配额耗尽、欠费停机 (HTTP 402, insufficient_quota)
  | 'AUTHENTICATION_ERROR' // API Key 无效、未授权 (HTTP 401)
  | 'RATE_LIMITED'         // 频控限流、TPM/RPM 超限 (HTTP 429)
  | 'SERVICE_UNAVAILABLE'  // 上游服务宕机、网关超时、连接拒绝 (HTTP 500/502/503/504, ETIMEDOUT, ECONNREFUSED)
  | 'CLIENT_ERROR'         // 客户端输入错误、上下文超限 (HTTP 400, context length exceeded)
  | 'MANUAL'               // 控制台手动熔断（管理员主动下线，非故障自动判定）
  | 'UNKNOWN';

export type NetworkFailureCause =
  | 'CONNECTION_RESET'       // 连接重置/中断: ECONNRESET, ECONNABORTED, socket hang up, EPIPE
  | 'NETWORK_TIMEOUT'        // 超时抖动: ETIMEDOUT, ESOCKETTIMEDOUT, HTTP 504 Gateway Timeout, AbortError
  | 'GATEWAY_ERROR'          // 网关临时不可用: HTTP 502 Bad Gateway, HTTP 503 Service Unavailable, Cloudflare 520-524
  | 'RATE_LIMIT_BURST'       // 瞬时小频控: HTTP 429 且 Retry-After <= 门限阈值 (如 2s)
  | 'DNS_ERROR'              // DNS 短暂解析抖动: EAI_AGAIN, ENOTFOUND
  | 'SERVER_INTERNAL_ERROR'  // 上游 500 内部服务错误
  | 'HARD_FAILURE'           // 402 欠费, 401 密钥失效, 400 传参错误 (严禁原地重试)
  | 'UNKNOWN';

export interface ErrorDiagnosis {
  category: ErrorCategory;
  networkCause?: NetworkFailureCause; // 细分网络抖动与故障原因
  statusCode?: number;
  isRetriable: boolean;               // 是否支持故障转移 (Failover)
  isInPlaceRetriable: boolean;        // 是否适合在同一模型上原地重试以挽救 KV Cache
  shouldTripBreaker: boolean;
  hardTrip: boolean; // 立即触发熔断，无需累积重试次数（如 402 欠费）
  suggestedCooldownMs?: number;
  reason: string;
  retryAfterSeconds?: number;
  rawError?: any;
}

export interface CircuitBreakerConfig {
  enabled?: boolean;
  failureThreshold?: number; // 连续 5xx/宕机失败次数阈值（默认: 3）
  slidingWindowSize?: number; // 请求滑动窗口大小（默认: 20）
  failureRateThreshold?: number; // 窗口内错误率阈值（默认: 0.5，即 50%）
  initialCooldownMs?: number; // 初始熔断冷却时长（默认: 30000 = 30秒）
  maxCooldownMs?: number; // 最大熔断冷却上限（默认: 18000000 = 5小时）
  cooldownMultiplier?: number; // 阶梯退避倍数（默认: 2.0）
  quotaCooldownMs?: number; // 402/余额不足熔断时长（默认: 43200000 = 12小时）
  halfOpenMaxProbes?: number; // HALF_OPEN 半开探活最大放行探针数（默认: 1）
  activeProbing?: {
    enabled?: boolean;
    intervalMs?: number; // 后台探活巡检间隔（默认: 60000 = 1分钟）
  };
}

export interface CircuitBreakerSnapshot {
  modelId: string;
  provider: string;
  tier?: TierLevel;
  state: CircuitBreakerState;
  reason?: string;
  category?: ErrorCategory;
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  trippedAt?: number;
  cooldownUntil?: number;
  remainingCooldownMs: number;
  currentCooldownMs: number;
  halfOpenProbes: number;
}

export type TierCrossPolicy = 'same_tier_only' | 'allow_escalate';

export type RetriableCauseConfig =
  | 'connection_reset'       // ECONNRESET, socket hang up, EPIPE
  | 'network_timeout'        // ETIMEDOUT, 504 Gateway Timeout
  | 'gateway_error'          // 502 Bad Gateway, 503 Service Unavailable, Cloudflare 52x
  | 'rate_limit_burst'       // 瞬时 429 (Retry-After <= maxRateLimitWaitMs)
  | 'dns_error'              // EAI_AGAIN 短暂解析抖动
  | 'server_internal_error'; // 500 内部服务错误 (默认不建议重试，除非显式启用)

export const DEFAULT_RETRIABLE_CAUSES: RetriableCauseConfig[] = [
  'connection_reset',
  'network_timeout',
  'gateway_error',
  'rate_limit_burst',
  'dns_error',
];

export interface InPlaceRetryConfig {
  enabled?: boolean;
  maxAttempts?: number; // 默认: 1 (瞬时网络抖动原地重试 1 次挽救 KV Cache)
  backoffMs?: number; // 默认: 200ms
  jitterMs?: number; // 默认: 100ms
  retryOnCauses?: RetriableCauseConfig[]; // 允许触发原地重试的故障原因白名单 (默认全选高频抖动)
  maxRateLimitWaitMs?: number; // 允许原地退避等待的 429 最大时长，毫秒 (默认 2000ms，超过则走 Failover)
}

export interface FailoverRetryConfig {
  enabled?: boolean;
  maxAttempts?: number; // 最多尝试的候选模型数 (默认: 2)
  tierCrossPolicy?: TierCrossPolicy; // 'same_tier_only' (严格同级) | 'allow_escalate' (允许向上升档保活，绝不向下跳水)
}

export interface RetryConfig {
  enabled?: boolean;
  inplace?: InPlaceRetryConfig;
  failover?: FailoverRetryConfig;
}

