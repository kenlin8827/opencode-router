/**
 * Wildcard (glob) matching — `*` matches any run of characters, `?` a single
 * character, case-insensitive. A pattern without wildcards is a substring
 * match (mirrors opencode/user-config.ts matchesGlobPattern semantics for a
 * single pattern, as a dependency-free util).
 */
export function globMatch(pattern: string, value: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const v = value.toLowerCase();
  if (!/[*?]/.test(p)) return v.includes(p);
  const regex = new RegExp(
    '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  );
  return regex.test(v);
}

/** True when any pattern matches (false for empty/undefined pattern lists). */
export function globMatchAny(patterns: string[] | undefined, value: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => globMatch(p, value));
}
