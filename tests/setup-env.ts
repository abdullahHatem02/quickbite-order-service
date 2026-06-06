import {config} from "dotenv";
import path from "path";

// Load test env BEFORE any module reads `src/lib/config/env.ts`. dotenv never
// overrides values already present in process.env, so CI (which injects the
// same vars via docker-compose.test.yml) takes precedence over this file.
config({path: path.resolve(__dirname, "../.env.test")});
