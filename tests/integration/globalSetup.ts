import {config} from "dotenv";
import path from "path";
import {spawnSync} from "child_process";

const ROOT = path.resolve(__dirname, "../..");

// Load test env into process.env BEFORE spawning the migration children, so the
// knex CLI subprocesses target the *_test databases. dotenv never overrides
// values already set, so CI's docker-injected vars still win.
config({path: path.resolve(ROOT, ".env.test")});

/**
 * Migrate one region+cluster by shelling out to the knex CLI — exactly how
 * `scripts/migrate-all.ts` does it. knex auto-registers ts-node for the `.ts`
 * knexfile in that child process, so jest's own module pipeline stays clean
 * (registering a ts-node require hook in-process breaks globalTeardown).
 */
function migrate(region: string, cluster: "hot" | "archive"): void {
    const res = spawnSync(
        "npx",
        ["knex", "--knexfile", "src/lib/knex/knexfile.ts", "migrate:latest"],
        {
            cwd: ROOT,
            stdio: "inherit",
            shell: true,
            env: {...process.env, REGION: region, CLUSTER: cluster},
        },
    );
    if (res.status !== 0) {
        throw new Error(`migrate:latest failed for ${cluster}/${region} (exit ${res.status})`);
    }
}

export default function globalSetup(): void {
    const regions = (process.env.REGIONS ?? "eg").split(",").map((s) => s.trim()).filter(Boolean);
    // Hot AND archive clusters share the same schema (archive is a cold copy).
    for (const region of regions) {
        migrate(region, "hot");
        migrate(region, "archive");
    }
}
