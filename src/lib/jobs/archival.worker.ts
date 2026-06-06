import {db, dbArchive} from "../knex/knex";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {cacheProvider} from "../cache/init";
import {register} from "./job-registry";
import {ArchivalTable, ArchiveRunOptions, ArchiveRunResult} from "./archival.types";

/**
 * Cold-archival worker (implementation-plan Phase 5 / CLAUDE.md Phase 7).
 *
 * Every night, move rows whose creation timestamp falls in a PRIOR YEAR from
 * the hot cluster to the archive cluster, per region, keeping the hot DB small
 * enough that current-year queries stay fast.
 *
 * Safety model (matches the spec):
 *   - Tables are swept children-first so a crash never strands a child whose
 *     parent is already gone.
 *   - Each batch copies to the archive and commits there FIRST, then deletes
 *     from hot. A crash between the two leaves the row in BOTH places (safe);
 *     the re-run re-inserts with ON CONFLICT DO NOTHING (no duplicates) and the
 *     delete eventually removes it from hot.
 *   - A Redis lock (`archival:<region>:lock`) stops two processes running the
 *     same region's sweep concurrently.
 */

// FK-safe order: children before parents. `tsColumn` is the per-table "created"
// timestamp — they are deliberately not uniform (see schema migrations).
const ARCHIVAL_TABLES: ArchivalTable[] = [
    {name: "agent_earnings", tsColumn: "earned_at"},
    {name: "payment_webhook_events", tsColumn: "received_at"},
    {name: "payment_sessions", tsColumn: "created_at"},
    {name: "transactions", tsColumn: "created_at"},
    {name: "order_items", tsColumn: "created_at"},
    {name: "orders", tsColumn: "created_at"},
];

/**
 * pg returns JSONB columns as parsed JS objects/arrays and timestamps as Date
 * objects. Re-inserting a parsed object into a JSONB column via knex would
 * stringify it as `[object Object]`, so JSON-encode plain objects/arrays while
 * leaving Dates, Buffers, and scalars untouched.
 */
function serializeRowForInsert(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
        if (
            value !== null &&
            typeof value === "object" &&
            !(value instanceof Date) &&
            !Buffer.isBuffer(value)
        ) {
            out[key] = JSON.stringify(value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

/**
 * Move one region's prior-year rows hot → archive. Returns per-table counts.
 * Exported (without the lock) so tests can drive it deterministically.
 */
export async function archiveRegion(region: string, opts: ArchiveRunOptions = {}): Promise<ArchiveRunResult> {
    const hot = db(region);
    const archive = dbArchive(region);
    const batchSize = opts.batchSize ?? env.archival.batchSize;
    const maxRuntimeMs = opts.maxRuntimeMs ?? env.archival.maxRuntimeMin * 60_000;
    const clock = opts.now ?? Date.now;
    const startedAt = clock();

    const moved: Record<string, number> = {};
    let timedOut = false;

    for (const {name, tsColumn} of ARCHIVAL_TABLES) {
        moved[name] = 0;

        // Loop batches. Deleted rows drop out of the predicate, so the next
        // `limit(batchSize)` always returns the next slice — no offset needed.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (clock() - startedAt >= maxRuntimeMs) {
                timedOut = true;
                break;
            }

            const rows: Record<string, unknown>[] = await hot(name)
                .whereRaw(`?? < date_trunc('year', NOW())`, [tsColumn])
                .orderBy("id")
                .limit(batchSize);

            if (rows.length === 0) break;

            const ids = rows.map((r) => r.id as number | string);

            // Archive first (commit), then delete from hot. ON CONFLICT DO
            // NOTHING makes re-runs idempotent after a mid-batch crash.
            await archive(name).insert(rows.map(serializeRowForInsert)).onConflict().ignore();
            await hot(name).whereIn("id", ids).delete();

            moved[name] += rows.length;
            logger.info("archival batch moved", {
                region,
                table: name,
                rows: rows.length,
                tableTotal: moved[name],
            });
        }

        if (timedOut) {
            logger.warn("archival run hit max runtime; stopping mid-sweep", {region, table: name});
            break;
        }
    }

    const totalMoved = Object.values(moved).reduce((sum, n) => sum + n, 0);
    logger.info("archival run complete", {
        region,
        moved,
        totalMoved,
        timedOut,
        ms: clock() - startedAt,
    });

    return {region, moved, totalMoved, timedOut};
}

/**
 * Acquire the per-region Redis lock, run the sweep, release. If the lock is
 * already held (another worker process) we skip — the other run will finish
 * the work. The lock TTL outlives a full run so it auto-expires after a crash.
 */
async function runArchivalWithLock(region: string): Promise<void> {
    const lockKey = `archival:${region}:lock`;
    const lockTtlSec = env.archival.maxRuntimeMin * 60 + 60;

    const acquired = await cacheProvider.trySet(lockKey, String(Date.now()), lockTtlSec);
    if (!acquired) {
        logger.info("archival skipped; lock held by another process", {region});
        return;
    }

    try {
        await archiveRegion(region);
    } finally {
        await cacheProvider.del(lockKey);
    }
}

/**
 * Register one nightly archival job per configured region. Per-region jobs keep
 * one slow region from blocking another's sweep.
 */
export function registerArchivalJobs(): void {
    for (const region of env.regions) {
        register({
            name: `archival:${region}`,
            cron: env.archival.cron,
            handler: () => runArchivalWithLock(region),
        });
    }
}
