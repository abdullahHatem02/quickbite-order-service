import {coreClient} from "./core-client";
import {container} from "../di/container";
import {TOKENS} from "../di/tokens";
import {ICacheProvider} from "../../pkg/cache/cache.interface";
import {toSeconds} from "../../pkg/utils/time";
import {logger} from "../logger/logger";
import {
    CoreEnvelope,
    CoreBranchMetadata,
    CoreBranchProduct,
    ReserveStockItem,
    ReserveStockResult,
} from "./types";

const BRANCH_CACHE_TTL = toSeconds(1, "h");

function branchCacheKey(branchId: number): string {
    return `core:branch:${branchId}`;
}

function cache(): ICacheProvider {
    return container.resolve<ICacheProvider>(TOKENS.CacheProvider);
}

/**
 * Read-through cache for a single branch. Cache entries live at
 * `core:branch:<id>` and are invalidated by `core-data-cache.service`'s
 * inbound `branch.updated` / `branch.deactivated` AMQP handlers — so a
 * branch toggle in core propagates here within one event-loop cycle.
 */
export async function getBranch(branchId: number, correlationId?: string): Promise<CoreBranchMetadata> {
    const c = cache();
    const cached = await c.get(branchCacheKey(branchId));
    if (cached) {
        try { return JSON.parse(cached) as CoreBranchMetadata; } catch { /* fall through */ }
    }
    const res = await coreClient.request<CoreEnvelope<CoreBranchMetadata>>({
        method: "GET",
        path: `/api/internal/branches/${branchId}`,
        correlationId,
    });
    await c.set(branchCacheKey(branchId), JSON.stringify(res.data), BRANCH_CACHE_TTL).catch((err) => {
        logger.warn("getBranch cache set failed", {branchId, error: (err as Error).message});
    });
    return res.data;
}

/**
 * Batch variant. Returns a Map<branchId, metadata> covering only the ids that
 * resolved (missing/invalid ids are silently dropped — caller decides how to
 * handle them). Reads cache for every id, falls back to a SINGLE batch call
 * to core for the misses, populates the cache.
 *
 * Use this whenever you have a list of branch ids to enrich (agent task list,
 * restaurant order list with multiple branches, etc.) so the network is at
 * most one round-trip regardless of N.
 */
export async function getBranchesByIds(
    branchIds: number[],
    correlationId?: string,
): Promise<Map<number, CoreBranchMetadata>> {
    const result = new Map<number, CoreBranchMetadata>();
    if (branchIds.length === 0) return result;
    const unique = Array.from(new Set(branchIds));
    const c = cache();

    // Cache pass.
    const misses: number[] = [];
    await Promise.all(
        unique.map(async (id) => {
            const raw = await c.get(branchCacheKey(id));
            if (raw) {
                try {
                    result.set(id, JSON.parse(raw) as CoreBranchMetadata);
                    return;
                } catch { /* fall through to network */ }
            }
            misses.push(id);
        }),
    );
    if (misses.length === 0) return result;

    // Network pass — single batch call.
    const ids = misses.join(",");
    const res = await coreClient.request<CoreEnvelope<CoreBranchMetadata[]>>({
        method: "GET",
        path: `/api/internal/branches?ids=${encodeURIComponent(ids)}`,
        correlationId,
    });
    await Promise.all(
        res.data.map(async (b) => {
            result.set(Number(b.id), b);
            await c.set(branchCacheKey(Number(b.id)), JSON.stringify(b), BRANCH_CACHE_TTL).catch(() => {});
        }),
    );
    return result;
}

export async function getBranchProducts(
    branchId: number,
    productIds: number[],
    correlationId?: string,
): Promise<CoreBranchProduct[]> {
    if (productIds.length === 0) return [];
    const ids = productIds.join(",");
    const res = await coreClient.request<CoreEnvelope<CoreBranchProduct[]>>({
        method: "GET",
        path: `/api/internal/branches/${branchId}/products?ids=${encodeURIComponent(ids)}`,
        correlationId,
    });
    return res.data;
}

export async function reserveStock(
    branchId: number,
    items: ReserveStockItem[],
    idempotencyKey?: string,
    correlationId?: string,
): Promise<ReserveStockResult> {
    const res = await coreClient.request<CoreEnvelope<ReserveStockResult>>({
        method: "POST",
        path: `/api/internal/branches/${branchId}/reserve-stock`,
        body: {items},
        idempotencyKey,
        correlationId,
    });
    return res.data;
}

export async function releaseStock(
    branchId: number,
    items: ReserveStockItem[],
    idempotencyKey?: string,
    correlationId?: string,
): Promise<ReserveStockResult> {
    const res = await coreClient.request<CoreEnvelope<ReserveStockResult>>({
        method: "POST",
        path: `/api/internal/branches/${branchId}/release-stock`,
        body: {items},
        idempotencyKey,
        correlationId,
    });
    return res.data;
}
