/**
 * Runs `knex migrate:latest` against every configured hot-cluster region.
 *   dev:  tsx src/scripts/migrate-all.ts
 *   prod: node dist/scripts/migrate-all.js   (compiled; used by the CD migrate step)
 */
import {spawnSync} from "child_process";
import {env} from "../lib/config/env";

const cluster = (process.env.CLUSTER ?? "hot") as "hot" | "archive";

// Compiled (dist/*.js) -> point knex at the compiled knexfile (no ts-node in the
// production image). In dev (tsx, *.ts) -> the TypeScript knexfile via ts-node.
const knexfile = __filename.endsWith(".js")
    ? "dist/lib/knex/knexfile.js"
    : "src/lib/knex/knexfile.ts";

function run(region: string) {
    console.log(`[${cluster}/${region}] migrate:latest`);
    const res = spawnSync(
        "npx",
        ["knex", "--knexfile", knexfile, "migrate:latest"],
        {
            stdio: "inherit",
            shell: true,
            env: {...process.env, REGION: region, CLUSTER: cluster},
        },
    );
    if (res.status !== 0) {
        process.exit(res.status ?? 1);
    }
}

for (const region of env.regions) {
    run(region);
}
