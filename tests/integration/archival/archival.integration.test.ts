import {randomUUID} from "crypto";
import {db, dbArchive, destroyAll} from "../../../src/lib/knex/knex";
import {archiveRegion} from "../../../src/lib/jobs/archival.worker";
import {truncateAll} from "../../helpers/db";

const REGION = "eg";
const PRIOR = new Date(Date.UTC(2023, 5, 1, 12, 0, 0)); // 2023-06-01 — a prior year
const CURRENT = new Date(); // this year — stays hot

const hot = () => db(REGION);
const archive = () => dbArchive(REGION);

let seq = 0;
function nextOrderId(): number {
    // order ids are app-assigned in the partitioned table via a sequence, but
    // for seeding we insert explicit ids to keep child FKs predictable.
    seq += 1;
    return 1000 + seq;
}

async function seedOrder(createdAt: Date): Promise<number> {
    const id = nextOrderId();
    await hot()("orders").insert({
        id,
        region: REGION,
        public_id: randomUUID(),
        country_code: "EG",
        restaurant_id: 1,
        restaurant_owner_id: 999,
        branch_id: 1,
        customer_id: 500,
        customer_address_id: 1,
        delivery_lat: 30.0,
        delivery_lng: 31.0,
        delivery_address_text_snapshot: "addr",
        branch_lat: 30.1,
        branch_lng: 31.1,
        status: "delivered",
        subtotal: 10000,
        delivery_fee: 1500,
        service_fee: 500,
        total: 12000,
        currency: "EGP",
        payment_method: "cod",
        created_at: createdAt,
        updated_at: createdAt,
    });
    return id;
}

async function seedChildren(orderId: number, ts: Date): Promise<void> {
    await hot()("order_items").insert({
        region: REGION,
        order_id: orderId,
        product_id: 10,
        quantity: 2,
        unit_price_snapshot: 5000,
        name_snapshot: "Burger",
        line_total: 10000,
        created_at: ts,
    });
    await hot()("transactions").insert({
        region: REGION,
        order_id: orderId,
        transaction_type: "cod_collection",
        method: "cod",
        status: "succeeded",
        amount: 12000,
        currency: "EGP",
        src_acc_id: 500,
        dst_acc_id: 999,
        idempotency_key: `cod:${orderId}`,
        created_at: ts,
        updated_at: ts,
    });
    await hot()("payment_sessions").insert({
        region: REGION,
        order_id: orderId,
        provider_id: 1,
        provider_session_id: `sess-${orderId}`,
        redirect_url: "http://x",
        amount: 12000,
        currency: "EGP",
        status: "captured",
        raw_init_payload: JSON.stringify({k: "v", orderId}),
        created_at: ts,
        updated_at: ts,
    });
    // payment_webhook_events uses `received_at`, not created_at.
    await hot()("payment_webhook_events").insert({
        region: REGION,
        provider_id: 1,
        provider_event_id: `evt-${orderId}`,
        signature: "sig",
        payload: JSON.stringify({event: "pay", orderId}),
        received_at: ts,
    });
    // agent_earnings uses `earned_at`, not created_at.
    await hot()("agent_earnings").insert({
        region: REGION,
        agent_id: 7,
        order_id: orderId,
        amount: 1200,
        currency: "EGP",
        earned_at: ts,
    });
}

async function count(conn: ReturnType<typeof hot>, table: string): Promise<number> {
    const row = await conn(table).count<{n: string}[]>("* as n").first();
    return Number(row?.n ?? 0);
}

describe("cold archival worker", () => {
    beforeEach(async () => {
        await truncateAll(hot());
        await truncateAll(archive());
        seq = 0;
    });

    afterAll(async () => {
        await destroyAll();
    });

    it("moves prior-year rows to archive and keeps current-year rows hot", async () => {
        const priorOrder = await seedOrder(PRIOR);
        await seedChildren(priorOrder, PRIOR);
        const currentOrder = await seedOrder(CURRENT);
        await seedChildren(currentOrder, CURRENT);

        const result = await archiveRegion(REGION, {batchSize: 100});

        // One prior-year row per table moved.
        expect(result.timedOut).toBe(false);
        expect(result.moved).toEqual({
            agent_earnings: 1,
            payment_webhook_events: 1,
            payment_sessions: 1,
            transactions: 1,
            order_items: 1,
            orders: 1,
        });

        // Hot keeps ONLY the current-year cohort.
        for (const t of ["orders", "order_items", "transactions", "payment_sessions", "payment_webhook_events", "agent_earnings"]) {
            expect(await count(hot(), t)).toBe(1);
            expect(await count(archive(), t)).toBe(1);
        }

        // The surviving hot order is the current-year one; archived is the prior one.
        const hotOrder = await hot()("orders").select("id").first();
        const archivedOrder = await archive()("orders").select("id").first();
        expect(Number(hotOrder!.id)).toBe(currentOrder);
        expect(Number(archivedOrder!.id)).toBe(priorOrder);

        // JSONB survived the round-trip as real JSON (not "[object Object]").
        const movedSession = await archive()("payment_sessions").select("raw_init_payload").first();
        expect(movedSession!.raw_init_payload).toMatchObject({k: "v"});
    });

    it("is a no-op on a second run (nothing left to move)", async () => {
        const priorOrder = await seedOrder(PRIOR);
        await seedChildren(priorOrder, PRIOR);

        const first = await archiveRegion(REGION, {batchSize: 100});
        expect(first.totalMoved).toBe(6);

        const second = await archiveRegion(REGION, {batchSize: 100});
        expect(second.totalMoved).toBe(0);
        expect(Object.values(second.moved).every((n) => n === 0)).toBe(true);
    });

    it("does not duplicate rows when the same row is re-archived (ON CONFLICT DO NOTHING)", async () => {
        const priorOrder = await seedOrder(PRIOR);
        await seedChildren(priorOrder, PRIOR);

        // Simulate a crash that committed the archive copy but not the hot delete:
        // pre-copy the order into the archive, leave it in hot too.
        const hotRow = await hot()("orders").where({id: priorOrder}).first();
        await archive()("orders").insert(hotRow).onConflict().ignore();
        expect(await count(archive(), "orders")).toBe(1);

        // Re-running must not throw and must not create a duplicate.
        await archiveRegion(REGION, {batchSize: 100});
        expect(await count(archive(), "orders")).toBe(1);
        expect(await count(hot(), "orders")).toBe(0);
    });

    it("batches correctly across many rows", async () => {
        for (let i = 0; i < 5; i++) {
            const o = await seedOrder(PRIOR);
            await seedChildren(o, PRIOR);
        }
        const result = await archiveRegion(REGION, {batchSize: 2}); // forces multiple batches
        expect(result.moved.orders).toBe(5);
        expect(await count(hot(), "orders")).toBe(0);
        expect(await count(archive(), "orders")).toBe(5);
    });

    it("stops early and moves nothing when the runtime cap is already exceeded", async () => {
        const priorOrder = await seedOrder(PRIOR);
        await seedChildren(priorOrder, PRIOR);

        const result = await archiveRegion(REGION, {batchSize: 100, maxRuntimeMs: 0});
        expect(result.timedOut).toBe(true);
        expect(result.totalMoved).toBe(0);
        expect(await count(hot(), "orders")).toBe(1); // untouched
    });
});
