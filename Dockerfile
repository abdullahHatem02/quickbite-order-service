# =====================================================================
# order-service — multi-stage Dockerfile
# Stage 1: builder  -> install ALL deps + compile TypeScript to dist/
# Stage 2: runtime  -> small image with only what production needs
# =====================================================================

# ---------- Stage 1: builder ----------
# Use a Node 22 image based on Debian "slim" (small but has glibc, which
# native modules like bcrypt need). Tag "AS builder" so the next stage
# can copy artifacts from it.
FROM node:22-bookworm-slim AS builder

# All following commands run inside /app inside the container.
WORKDIR /app

# Copy ONLY the dependency manifests first. Doing this before copying
# the source lets Docker cache the "npm install" layer: as long as
# package.json + package-lock.json don't change, npm install is skipped
# on rebuilds (huge speedup).
COPY package.json package-lock.json* ./

# Install EVERY dependency (including devDependencies like typescript
# and tsx) because we need them to compile and to run TS migrations.
# "npm ci" is the CI-friendly install: it respects the lockfile exactly
# and fails if it's out of sync.
RUN npm ci

# Now copy the rest of the source tree. .dockerignore filters out
# node_modules, dist, .env, etc. so we don't bust the layer cache.
COPY . .

# Compile TypeScript -> dist/ using the project's tsconfig.json.
# Output goes to /app/dist (see "outDir" in tsconfig.json).
RUN npm run build


# ---------- Stage 2: runtime ----------
# Start fresh from the same slim Node image so we don't ship build tools.
FROM node:22-bookworm-slim AS runtime

# Standard practice: run the app in production mode.
ENV NODE_ENV=production

WORKDIR /app

# tini is a tiny init process. Without it, Node becomes PID 1 inside the
# container and doesn't forward signals correctly — Ctrl+C / docker stop
# would not gracefully shut down the server. tini fixes that.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Bring over the lockfile so npm ci is reproducible here too.
COPY package.json package-lock.json* ./

# Install only production deps in the runtime image.
# NOTE: we keep "tsx" (a devDep) available by NOT pruning, because the
# migration script (scripts/migrate-all.ts) and Knex migrations are
# TypeScript files that we run with tsx. If you ever pre-compile
# migrations to JS, switch this to "npm ci --omit=dev" for a smaller image.
RUN npm ci

# Copy the compiled JS produced by the builder stage.
COPY --from=builder /app/dist ./dist

# Copy the TypeScript sources that are still needed at runtime:
#   - src/migrations: Knex reads .ts migration files directly via tsx
#   - scripts/      : migrate-all.ts loops over regions and runs migrations
#   - tsconfig.json : tsx needs it to resolve compiler options
COPY --from=builder /app/src/migrations ./src/migrations
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# The HTTP server listens on PORT (defaults to 4000 — see .env.example).
# EXPOSE is documentation only; it doesn't open the port. The actual
# port mapping is done in docker-compose.yml.
EXPOSE 4000

# Run as the built-in non-root "node" user for safety. If anything in
# the container is compromised, the attacker is not root.
USER node

# tini -> node dist/server.js. tini reaps zombies and forwards SIGTERM
# so graceful shutdown in server.ts (destroyAll, close broker) runs.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Default command: start the HTTP/WebSocket server. docker-compose
# overrides this for the worker service.
CMD ["node", "dist/server.js"]
