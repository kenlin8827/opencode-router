import { globMatchAny, globMatch } from '../utils/glob.js';

/** True for loopback / unspecified hosts — never MITM'd (cycle safety + local dev). */
export function isLoopbackHost(host: string): boolean {
  const h = (host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    /^127\.\d+\.\d+\.\d+$/.test(h) ||
    h === '0.0.0.0'
  );
}

/**
 * Bypass entry: bare string (glob) = pure tunnel, direct egress; object form
 * carries a per-host egress choice — `viaProxy: true` tunnels through the
 * outbound proxy policy (config.proxy, e.g. clash).
 */
export interface BypassEntry {
  host: string;
  viaProxy?: boolean;
}

/**
 * Pure-tunnel decision: loopback targets always bypass (direct); the FIRST
 * matching bypass entry (glob over the bare hostname, same syntax as the
 * outbound proxy lists) decides — and carries its per-host egress flag.
 */
export function matchBypass(
  host: string,
  entries?: (string | BypassEntry)[]
): { bypassed: boolean; viaProxy: boolean } {
  if (!host) return { bypassed: true, viaProxy: false };
  if (isLoopbackHost(host)) return { bypassed: true, viaProxy: false };
  for (const e of entries || []) {
    const pattern = typeof e === 'string' ? e : e?.host;
    const viaProxy = typeof e === 'string' ? false : e?.viaProxy === true;
    if (pattern && globMatch(pattern, host)) return { bypassed: true, viaProxy };
  }
  return { bypassed: false, viaProxy: false };
}

/**
 * Pure-tunnel decision (legacy shape): loopback targets always bypass;
 * `bypassHosts` glob patterns match against the bare hostname.
 */
export function shouldBypassHost(host: string, bypassHosts?: (string | BypassEntry)[]): boolean {
  return matchBypass(host, bypassHosts).bypassed;
}