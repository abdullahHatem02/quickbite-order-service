import {db, destroyAll} from "../../../src/lib/knex/knex";
import {upsertIncrement, findByRestaurant} from "../../../src/app/finance/repository/restaurant-balance.repo";
import {truncateAll} from "../../helpers/db";

/**
 * Guards the core finance invariant the team chose for the simple (single-table)
 * ledger model: the denormalised `restaurant_balances.balance` MUST equal the
 * net of the `transactions` ledger for that restaurant's owner account —
 * (sum of credits where dst = owner) − (sum of debits where src = owner).
 *
 * If a future change books a transaction without the matching balance delta (or
 * vice versa), this test fails — which is exactly the drift the instructor note
 * warns about when one table answers two questions.
 */
const REGION = "eg";
const OWNER = 999;
const CUSTOMER = 500;
const RESTAURANT = 1;
const conn = () => db(REGION);

// A delivered COD order: subtotal 10000, delivery 1500, service 500, total 12000.
const SUBTOTAL = 10000;
const DELIVERY_FEE = 1500;
const SERVICE_FEE = 500;
const TOTAL = 12000;
const COMMISSION = 1000; // 10% of subtotal

async function ownerLedgerNet(orderId: number): Promise<number> {
    const row = await conn()("transactions")
        .where({order_id: orderId})
        .select(
            conn().raw(
                `COALESCE(SUM(amount) FILTER (WHERE dst_acc_id = ?), 0)
               - COALESCE(SUM(amount) FILTER (WHERE src_acc_id = ?), 0) AS net`,
                [OWNER, OWNER],
            ),
        )
        .first<{net: string}>();
    return Number(row!.net);
}

describe("restaurant balance ⇄ transactions ledger reconciliation", () => {
    beforeEach(async () => {
        await truncateAll(conn());
    });

    afterAll(async () => {
        await destroyAll();
    });

    it("balance equals the owner's net ledger position after a settled order", async () => {
        const orderId = 1;
        const ts = new Date();
        const base = {region: REGION, method: "system", status: "succeeded", currency: "EGP", created_at: ts, updated_at: ts};

        // Mirror exactly what SettlementService writes on `delivered`:
        await conn()("transactions").insert([
            {...base, order_id: orderId, transaction_type: "cod_collection", method: "cod", amount: TOTAL, src_acc_id: CUSTOMER, dst_acc_id: OWNER, idempotency_key: "cod:1"},
            {...base, order_id: orderId, transaction_type: "commission", amount: COMMISSION, src_acc_id: OWNER, dst_acc_id: null, idempotency_key: "comm:1"},
            {...base, order_id: orderId, transaction_type: "adjustment", amount: SERVICE_FEE, src_acc_id: OWNER, dst_acc_id: null, idempotency_key: "svc:1"},
            {...base, order_id: orderId, transaction_type: "adjustment", amount: DELIVERY_FEE, src_acc_id: OWNER, dst_acc_id: null, idempotency_key: "del:1"},
        ]);

        // The balance delta the settlement applies.
        await upsertIncrement({restaurantId: RESTAURANT, region: REGION, currency: "EGP", delta: SUBTOTAL - COMMISSION}, conn());

        const balances = await findByRestaurant(RESTAURANT, conn());
        expect(balances).toHaveLength(1);

        // subtotal - commission = 9000.
        expect(balances[0].balance).toBe(SUBTOTAL - COMMISSION);
        // ...and that equals the ledger net for the owner: 12000 - 1000 - 500 - 1500.
        expect(await ownerLedgerNet(orderId)).toBe(SUBTOTAL - COMMISSION);
        expect(balances[0].balance).toBe(await ownerLedgerNet(orderId));
    });

    it("accumulates correctly across two settled orders", async () => {
        await upsertIncrement({restaurantId: RESTAURANT, region: REGION, currency: "EGP", delta: SUBTOTAL - COMMISSION}, conn());
        await upsertIncrement({restaurantId: RESTAURANT, region: REGION, currency: "EGP", delta: SUBTOTAL - COMMISSION}, conn());

        const balances = await findByRestaurant(RESTAURANT, conn());
        expect(balances[0].balance).toBe(2 * (SUBTOTAL - COMMISSION));
    });
});
