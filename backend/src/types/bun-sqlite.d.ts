/**
 * Ambient types for `bun:sqlite`. The backend typechecks against @types/node
 * (bun-types is not installed), but the gateway runtime is Bun where this
 * module always exists. Declared here for the compiler only — resolved
 * natively at runtime via dynamic import.
 */
declare module 'bun:sqlite' {
  export class Statement {
    all(params?: unknown[] | Record<string, unknown>): unknown[];
    get(params?: unknown[] | Record<string, unknown>): unknown;
    run(params?: unknown[] | Record<string, unknown>): unknown;
  }
  export class Database {
    constructor(filename: string, options?: { readonly?: boolean; create?: boolean });
    run(sql: string, params?: unknown[] | Record<string, unknown>): void;
    query(sql: string): Statement;
    close(): void;
  }
}
