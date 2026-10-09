import { CircuitBreaker } from './circuit-breaker.js';
import {
  CircuitBreakerConfig,
  CircuitBreakerSnapshot,
  CircuitBreakerState,
  ErrorDiagnosis,
} from './types.js';
import { ModelRegistration } from '../config/types.js';

export interface CircuitBreakerSummary {
  object: 'circuit_breaker_summary';
  total: number;
  healthy: number;
  tripped: number;
  halfOpen: number;
  breakers: CircuitBreakerSnapshot[];
}

// Manual trip defaults: 1h unless a duration is provided; hard-clamped to 7d
export const MANUAL_TRIP_DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
export const MANUAL_TRIP_MAX_COOLDOWN_MS = 7 * 24 * 3600 * 1000;

export class CircuitBreakerManager {
  private breakers = new Map<string, CircuitBreaker>();
  private config: CircuitBreakerConfig;
  private nowFn: () => number;

  constructor(config?: CircuitBreakerConfig, nowFn: () => number = Date.now) {
    this.config = config || {};
    this.nowFn = nowFn;
  }

  public registerModel(model: ModelRegistration): CircuitBreaker {
    let breaker = this.breakers.get(model.id);
    if (!breaker) {
      breaker = new CircuitBreaker(
        model.id,
        model.provider,
        model.tier,
        this.config,
        this.nowFn
      );
      this.breakers.set(model.id, breaker);
    }
    return breaker;
  }

  public getBreaker(modelId: string): CircuitBreaker | undefined {
    return this.breakers.get(modelId);
  }

  public getOrCreateBreaker(
    modelId: string,
    provider = 'unknown',
    tier?: any
  ): CircuitBreaker {
    let breaker = this.breakers.get(modelId);
    if (!breaker) {
      breaker = new CircuitBreaker(modelId, provider, tier, this.config, this.nowFn);
      this.breakers.set(modelId, breaker);
    }
    return breaker;
  }

  public canExecute(modelId: string): { allowed: boolean; reason?: string; state: CircuitBreakerState } {
    const breaker = this.breakers.get(modelId);
    if (!breaker) {
      return { allowed: true, state: 'CLOSED' };
    }
    const check = breaker.canExecute();
    return {
      allowed: check.allowed,
      reason: check.reason,
      state: breaker.getState(),
    };
  }

  /**
   * NON-CONSUMING availability check (peek) — safe for selection, filtering
   * and introspection; never takes a HALF_OPEN probe slot. The consuming
   * gate is getBreaker(modelId)?.canExecute() at the execution site only.
   */
  public isAvailable(modelId: string): boolean {
    const breaker = this.breakers.get(modelId);
    if (!breaker) {
      return true;
    }
    return breaker.peekExecute().allowed;
  }

  public recordSuccess(modelId: string): void {
    const breaker = this.breakers.get(modelId);
    if (breaker) {
      breaker.recordSuccess();
    }
  }

  public recordFailure(modelId: string, diagnosis: ErrorDiagnosis, provider = 'unknown'): void {
    const breaker = this.getOrCreateBreaker(modelId, provider);
    breaker.recordFailure(diagnosis);
  }

  public reset(modelId?: string): { resetCount: number; message: string } {
    if (modelId) {
      const breaker = this.breakers.get(modelId);
      if (breaker) {
        breaker.reset();
        return { resetCount: 1, message: `Circuit breaker for model '${modelId}' reset to CLOSED.` };
      }
      return { resetCount: 0, message: `Model '${modelId}' not found in circuit breaker registry.` };
    }

    let count = 0;
    for (const breaker of this.breakers.values()) {
      breaker.reset();
      count++;
    }
    return { resetCount: count, message: `All ${count} circuit breakers successfully reset to CLOSED.` };
  }

  /**
   * Manually trip a model into OPEN state (admin takes it out of rotation from the console).
   * In-memory only: cleared on gateway restart; use the exclude lists (config.tiers) for a persistent exclusion.
   */
  public trip(
    modelId: string,
    options?: { reason?: string; cooldownMs?: number },
    provider = 'unknown'
  ): { tripped: boolean; message: string } {
    const breaker = this.getOrCreateBreaker(modelId, provider);
    const cooldownMs = Math.max(
      1000,
      Math.min(options?.cooldownMs ?? MANUAL_TRIP_DEFAULT_COOLDOWN_MS, MANUAL_TRIP_MAX_COOLDOWN_MS)
    );
    const reason = options?.reason?.trim() || 'Manual trip via console';
    breaker.trip(`Manual trip: ${reason}`, 'MANUAL', cooldownMs);
    return {
      tripped: true,
      message: `Circuit breaker for model '${modelId}' manually tripped (OPEN) for ~${Math.round(cooldownMs / 60000)} min.`,
    };
  }

  public getSnapshot(modelId: string): CircuitBreakerSnapshot | undefined {
    return this.breakers.get(modelId)?.getSnapshot();
  }

  public getAllSnapshots(): CircuitBreakerSnapshot[] {
    return Array.from(this.breakers.values()).map(b => b.getSnapshot());
  }

  public getSummary(): CircuitBreakerSummary {
    const snapshots = this.getAllSnapshots();
    const healthy = snapshots.filter(s => s.state === 'CLOSED').length;
    const tripped = snapshots.filter(s => s.state === 'OPEN').length;
    const halfOpen = snapshots.filter(s => s.state === 'HALF_OPEN').length;

    return {
      object: 'circuit_breaker_summary',
      total: snapshots.length,
      healthy,
      tripped,
      halfOpen,
      breakers: snapshots,
    };
  }
}
