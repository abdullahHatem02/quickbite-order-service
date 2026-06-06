import {Knex} from "knex";

/**
 * Truncate every application table in the given connection (hot or archive),
 * leaving the knex bookkeeping tables intact. CASCADE handles the partitioned
 * `orders` parent + its partitions in one shot.
 */
export async function truncateAll(conn: Knex): Promise<void> {
    const result = await conn.raw<{rows: {tablename: string}[]}>(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = 'public'
            AND tablename NOT IN ('knex_migrations', 'knex_migrations_lock')`,
    );
    const names = result.rows.map((r) => `"${r.tablename}"`).join(", ");
    if (names.length === 0) return;
    await conn.raw(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}
