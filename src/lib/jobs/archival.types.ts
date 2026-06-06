/**
 * Types for the cold-archival worker (`archival.worker.ts`). Kept out of the
 * worker file per CLAUDE.md §5 (no inline interfaces in logic files).
 */

/**
 * One table to sweep, with the timestamp column that marks when a row was
 * "created". These are NOT all `created_at`: `payment_webhook_events` uses
 * `received_at` and `agent_earnings` uses `earned_at`.
 */
export interface ArchivalTable {
    name: string;
    tsColumn: string;
}

/** Knobs for a single `archiveRegion` run — overridable in tests. */
export interface ArchiveRunOptions {
    batchSize?: number;
    maxRuntimeMs?: number;
    /** Injectable clock for tests; defaults to `Date.now`. */
    now?: () => number;
}

/** Outcome of one region's archival run. */
export interface ArchiveRunResult {
    region: string;
    /** rows moved per table */
    moved: Record<string, number>;
    /** sum across all tables */
    totalMoved: number;
    /** true if the run stopped early because it hit the runtime cap */
    timedOut: boolean;
}
