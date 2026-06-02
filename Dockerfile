# ---------- builder stage: compiles TypeScript ----------

# No platform pin: locally we build for the host's native arch (fast on Apple Silicon).
# GitHub CI will set --platform=linux/amd64 when pushing to ECR.
FROM node:22-alpine AS builder

# All commands run inside /app inside the container.
WORKDIR /app

# Copy only the manifests first so npm install is cached when source changes.
COPY package*.json ./

# Install every dep (incl. devDeps like typescript) — needed to build.
RUN npm ci

# Now bring in the rest of the source tree.
COPY . .

# Run "tsc" to compile TypeScript -> /app/dist.
RUN npm run build


# ---------- runtime stage: tiny image ECS actually runs ----------

# Same: no pin locally; CI will produce the linux/amd64 image for Fargate.
FROM node:22-alpine

# Tells Node + libs to use production behavior (no dev warnings, faster express).
ENV NODE_ENV=production

# Working dir inside the container.
WORKDIR /app

# Copy manifests so the next npm install matches the lockfile.
COPY package*.json ./

# Install ONLY production deps — no typescript, no tsx, no tests.
RUN npm ci --omit=dev

# Copy the compiled JS from the builder stage — nothing else from source.
COPY --from=builder /app/dist ./dist

# Document the app port (ECS task def maps it; EXPOSE itself opens nothing).
EXPOSE 4000

# Drop root — run as the built-in unprivileged "node" user (AWS security baseline).
USER node

# Start the HTTP + WebSocket server. For clean SIGTERM handling on ECS,
# set "initProcessEnabled": true in the task def's linuxParameters.
CMD ["node", "dist/server.js"]
