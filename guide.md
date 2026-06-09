# QuickBite — AWS Deployment (turn-by-turn)

Follow top to bottom. Each phase only uses things made in earlier phases.
Region: pick ONE and stay in it (top-right of console). Services: `core-service`, `order-service`, `analytics-service`.

---

## Phase 1 — Network (VPC)

1. Console → **VPC** → **Create VPC** → choose **"VPC and more"**.
2. Set: Name `quickbite`, **2 AZs**, **2 public subnets**, **2 private subnets**, **NAT gateway = In 1 AZ**, **VPC endpoints = S3 Gateway**.
3. Create. Wait until it's done.
4. Still in **VPC → Endpoints → Create endpoint** — make 4 **Interface** endpoints (so private tasks can pull images/secrets without leaning on NAT). For each: pick your VPC, the **2 private subnets**, **Enable DNS name = ON** (required — else the AWS hostnames won't resolve to the endpoint), and (for now) the **default SG**:
    - `com.amazonaws.<region>.ecr.api`
    - `com.amazonaws.<region>.ecr.dkr`
    - `com.amazonaws.<region>.secretsmanager`
    - `com.amazonaws.<region>.logs`

✅ Done when: VPC has 2 public + 2 private subnets, 1 NAT, 5 endpoints.

---

## Phase 2 — Security Groups

VPC → **Security Groups → Create security group** (repeat 6×, same VPC). Leave outbound default (all). Set **inbound** as below:

1. `alb-sg` → inbound: HTTP 80 + HTTPS 443 from `0.0.0.0/0`.
2. `ecs-sg` → inbound: **each service's container port** from `alb-sg` (**core-service 3000**, **order-service 4000**, **analytics-service 4100**). Then **edit it again** and add (a) those same ports from `ecs-sg` itself (Service Connect) and (b) TCP **443** from `ecs-sg` itself (so tasks can reach the interface endpoints in Phase 1.4 — without this, tasks fail at startup with `CannotPullSecretsException`).
3. `rds-sg` → inbound: TCP **5432** from `ecs-sg`.
4. `docdb-sg` → inbound: TCP **27017** from `ecs-sg`.
5. `redis-sg` → inbound: TCP **6379** from `ecs-sg`.
6. `mq-sg` → inbound: TCP **5671** from `ecs-sg`.

✅ Rule of thumb: every data SG only allows `ecs-sg`. That's what keeps DBs private.
🔧 Go back to the 4 interface endpoints (Phase 1.4) and set their SG to `ecs-sg`.

---

## Phase 3 — ECR (image repos)

ECR → **Repositories → Create repository** (×3): `core-service`, `order-service`, `analytics-service`.
- Turn on **Scan on push**. Leave the rest default.

✅ Done when: 3 empty repos exist. Copy one repo's URI for later.

---

## Phase 4 — Secrets

Secrets Manager → **Store a new secret** → type **Other**. Create one per item (key/value JSON):
- `core/db` → host, port, user, password, dbname of the core RDS.
- `order/db/eg`, `order/db/ksa`, … → one per order shard (4 total).
- `docdb` → cluster endpoint, user, password.
- `mq` → AMQP url/user/password.

(You don't know the endpoints yet — that's fine, create them now with placeholders and **edit the values after Phase 5**.)

✅ Done when: ~7 secrets exist. Copy their **ARNs** for the task definition.

---

## Phase 5 — Data stores (all private, no public access)

Make each one with: **VPC = quickbite**, **subnet group = the 2 private subnets**, **Public access = No**, and the matching SG.

1. **RDS Postgres ×5** (1 core + 4 order shards)
   RDS → Create database → Postgres → Template **Production** (or Dev/Test for cost) → set the subnet group + `rds-sg` → **Public access No**.
   After each is up, copy its **endpoint** into the matching secret (Phase 4).
2. **DocumentDB ×1** (used by analytics-service)
   DocumentDB → Create cluster → subnet group (private) + `docdb-sg` → no public access. Save endpoint to `docdb` secret.
3. **ElastiCache Redis**
   ElastiCache → Redis → Create → cluster-mode **disabled** → private subnet group + `redis-sg`. Copy primary endpoint.
4. **Amazon MQ — RabbitMQ**
   Amazon MQ → Create broker → **RabbitMQ** → single-instance (one env) → private subnets + `mq-sg`. Note the **amqps://…:5671** endpoint + creds → `mq` secret.

✅ Done when: all endpoints filled into Secrets Manager.

---

## Phase 6 — ECS cluster, task defs, services

### 6a. Cluster
ECS → **Clusters → Create cluster** → name `quickbite` → **Fargate** (default). Create.
(The Service Connect namespace `quickbite` gets created when you first enable it on a service in 6c — no separate step needed, but you can pre-make it in **Cloud Map → Create namespace** type **HTTP**, name `quickbite`.)

### 6b. Task definition (repeat per service)
ECS → **Task definitions → Create new** → **Fargate**.
- Name `core-service`. CPU `0.5 vCPU`, Memory `1 GB`.
- **Container**: name `app`, Image URI = ECR repo `:latest`, **Port = that service's port** (core-service **3000**, order-service **4000**, analytics-service **4100**).
- **Environment variables → Add from secret/ValueFrom**: map each app env var to a Secrets Manager ARN (Phase 4).
- **Task role**: app permissions (start empty). **Task execution role**: pick `ecsTaskExecutionRole` and make sure it has `secretsmanager:GetSecretValue` (add inline policy if missing) — else container won't start. If your secrets use a **customer-managed KMS key**, also grant `kms:Decrypt` on that key.
- **Logging**: leave **awslogs** on.
- Repeat for `order-service` (port 4000) and `analytics-service` (port 4100).

### 6c. Service (repeat per service)
From the task definition → **Deploy → Create service** → cluster `quickbite`.
- Launch type **Fargate**, **Desired tasks 2**.
- **Networking**: VPC `quickbite`, **2 private subnets**, SG = `ecs-sg`, **Public IP Off**.
- **Service Connect**: Enable → namespace `quickbite` → port name = the service name (the DNS alias others call) → **maps to the container port** (3000 core / 4000 order / 4100 analytics).
- **Load balancing** (only for internet-facing services): **Application Load Balancer → Create new** → name `quickbite-alb`, **public subnets**, SG `alb-sg`, target group **type = IP**, **port = the service's container port** (3000/4000/…), health check path `/health`. For HTTPS, first request a DNS-validated cert in **ACM**, then add an **HTTPS:443 listener** with that cert (+ an HTTP:80→443 redirect). No domain yet? Use an **HTTP:80 listener only** and drop 443 from `alb-sg`. For the next service, reuse the same ALB and add a listener rule (host/path).
- **Autoscaling**: Enable → min 2 / max 6 → **target tracking, ECSServiceAverageCPUUtilization = 60**.
- Create.

✅ Done when: tasks reach **RUNNING** and ALB target group is **healthy**.

### 6d. Worker services (core + order only)
core-service and order-service each run a **second process** — a queue consumer (`dist/worker.js`) — that the API task does **not** start (the Dockerfile's default command is `node dist/server.js`). Deploy the worker as its **own ECS service**, off the **same image**:
- **Task def**: copy the service's task def → name `core-worker` (order: `order-worker`) → set the container **Command** override to `node,dist/worker.js` → **remove the port mapping** (it's not an HTTP server). Keep the same secrets/env + execution role.
- **Service**: Deploy → Create service → cluster `quickbite` → Fargate, **Desired 1–2**, **2 private subnets**, SG `ecs-sg`, **Public IP Off**.
- **No load balancing, no Service Connect, no `/health`** — nothing calls it; it pulls jobs from RabbitMQ (outbound to `mq-sg:5671` is already allowed via `ecs-sg`).
- **Autoscaling**: optional — CPU works, but workers scale best on **RabbitMQ queue depth**. Fixed count is fine for a demo.
- **analytics-service needs no worker** — its consumer (`lib/coreevents/consumer.go`) runs inside the same Go binary as the API.

So each Node service = **2 ECS services** (api + worker) off one image; analytics = **1**.

✅ Done when: `core-worker` + `order-worker` tasks are **RUNNING** and draining the queue.

---

## Phase 7 — Internal communication

Nothing to click — Service Connect (6c) already gives DNS. In each service's config/env, point the HTTP clients at the other services (host = service name, port = that service's container port):
```
http://core-service:3000      # core      (Postgres)
http://order-service:3000     # order     (Postgres shards)
http://analytics-service:3000 # analytics (Go + DocumentDB)
```
Traffic stays in the VPC, no ALB hop. Set these as `CORE_SERVICE_URL` / `ORDER_SERVICE_URL` (or equivalent) env/secrets.

---

## Phase 8 — CI/CD (GitHub Actions, per repo)

### 8a. One-time: OIDC role
IAM → **Identity providers → Add provider** → OpenID Connect → URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
IAM → **Roles → Create role** → Web identity → that provider → name `github-deploy`. **Scope the trust policy to your repo** (else any GitHub repo can assume it):
```json
"Condition": {
  "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
  "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:<org>/<repo>:ref:refs/heads/main" }
}
```
Attach perms: ECR push (**with `ecr:GetAuthorizationToken` on resource `*`**), `ecs:UpdateService`/`RunTask`/`DescribeTasks`, and `iam:PassRole` for **both** the app task role and `ecsTaskExecutionRole` (scope with condition `iam:PassedToService = ecs-tasks.amazonaws.com`).

### 8b. One-time: migration task definitions (only for services with SQL migrations)
Copy each Postgres service's task def → name `<service>-migrate` (`core-migrate`, `order-migrate`) → same image + secrets, run later with a one-off command. (No service, no ALB.) **analytics-service needs none** — it's Go + DocumentDB and creates its indexes on boot (`EnsureIndexes`), so there's nothing to migrate.

### 8c. The deploy workflow (already committed to each repo)
Each repo already has a `ci.yml` (test + build). The deploy file — **`.github/workflows/deploy.yml`** — is now committed to all three repos and does **build → push → migrate → deploy**. Per-repo values:

| repo | deploy branch | container port | migrate command | ECR repo / ECS service |
|------|---------------|----------------|-----------------|------------------------|
| `quickbite-core-service`      | `master` | 3000 | `npm run migrate` (1 Postgres DB)    | `core-service`      |
| `quickbite-order-service`     | `main`   | 4000 | `npm run migrate:all` (loops shards) | `order-service`     |
| `quickbite-analytcis-service` | `main`   | 4100 | — none (Go + DocumentDB, indexes on boot) | `analytics-service` |

> ⚠️ The analytics repo is literally `quickbite-analytcis-service` (the typo is in the real repo name).
> **Migrations differ per service:** order-service has `migrate:all` (`scripts/migrate-all.ts` — loops every region in `env.regions`); core-service has one Postgres DB → `npm run migrate`; **analytics-service has no migrations** — its `deploy.yml` has **no Migrate step**. The Dockerfile sits at each repo **root** (analytics is a multi-stage Go build), so the build context is `.` for all three.

**The full, line-by-line-commented workflow lives in each repo at `.github/workflows/deploy.yml`** — read it there. Only the `env:` block at the top and the `branches:` trigger differ between repos (per the table). The migrate step runs as a Fargate task **inside the private subnet** (so it reaches private DBs), and its exit-code check makes a failed migration **fail the deploy** — nothing ships on bad SQL.

For **core** and **order**, the Deploy step rolls **both** the API service *and* its `*-worker` service (Phase 6d) — same image, two `update-service` calls. **analytics** rolls just its one service.

---

## Phase 9 — Logs (CloudWatch)

The `awslogs` driver (left on in Phase 6b) ships every container's stdout/stderr to CloudWatch Logs over the `…logs` interface endpoint (Phase 1.4) — nothing extra to wire up. When the ECS console enables `awslogs` it auto-fills:
- **Log group**: `/ecs/<task-def-name>` → `/ecs/core-service`, `/ecs/order-service`, `/ecs/analytics-service`.
- **Stream prefix**: `ecs`, so each task gets a stream `ecs/app/<task-id>` (`app` = the container name from 6b).

### 9a. Quickest path (per task)
ECS → **Clusters → quickbite → Services →** pick the service → **Tasks** tab → click a task → **Logs** tab. This reads straight from CloudWatch and auto-tails the running task — best for "why did this one task die?".

### 9b. Browse a service's logs
CloudWatch → **Logs → Log groups → `/ecs/core-service`** → pick a **log stream** (one per task). Use this when the task is already gone (crashed/scaled-in) and the ECS Logs tab no longer shows it.

### 9c. Search across all tasks (Logs Insights)
CloudWatch → **Logs → Logs Insights** → select log group(s) `/ecs/*` → run e.g.:
```
fields @timestamp, @message
| filter @message like /ERROR/
| sort @timestamp desc
| limit 100
```
Pick multiple groups to grep across services at once (e.g. trace one order across `core` + `order`).

### 9d. From the terminal
Same creds/region as the rest of the doc:
```
aws logs tail /ecs/core-service --follow            # live tail
aws logs tail /ecs/order-service --since 1h         # last hour
```

### 9e. Migration-task logs (debug a failed deploy)
The `order-migrate` run-task (Phase 8b/8c) ships to its own group `/ecs/order-migrate`. When a deploy fails the exit-code check, that's where the SQL error is:
```
aws logs tail /ecs/order-migrate --since 10m
```

### 9f. Set retention (do this once per group)
New log groups keep logs **forever** = a slow cost leak. CloudWatch → **Log groups** → select each `/ecs/*` group → **Actions → Edit retention** → e.g. **30 days**. Or:
```
aws logs put-retention-policy --log-group-name /ecs/core-service --retention-in-days 30
```

### 9g. Container Insights (per-task CPU/mem + perf logs)
One toggle adds CPU/memory/network metrics per task and a performance log group. ECS → **Clusters → quickbite → Update cluster → Container Insights → On**. Or:
```
aws ecs update-cluster-settings --cluster quickbite --settings name=containerInsights,value=enabled
```
View under CloudWatch → **Insights → Container Insights** (filter to cluster `quickbite`). Note: this is billed per metric/log — handy for right-sizing the 0.5 vCPU / 1 GB tasks, off by default.

✅ Done when: each service's `/ecs/<name>` group shows live streams, and retention is set (not "Never expire").

---

## Final checklist (the stuff that bites)

- [ ] 4 interface endpoints: **Private DNS ON**, SG `ecs-sg`, and `ecs-sg` allows inbound **443** from itself (else tasks stuck "CannotPullContainer"/`CannotPullSecretsException`).
- [ ] Execution role has `secretsmanager:GetSecretValue` (+ `kms:Decrypt` if secrets use a CMK) — else container won't start.
- [ ] Every data store: **Public access = No**, SG only allows `ecs-sg`.
- [ ] DocumentDB connection uses **TLS** (CA bundle in the image).
- [ ] MQ URL is **amqps://** on **5671**, not 5672.
- [ ] `/health` endpoint exists and returns 200 (ALB + ECS use it).
- [ ] First deploy: push an image to ECR **before** creating the ECS service (chicken-and-egg).
- [ ] OIDC `github-deploy` trust policy is scoped to your repo's `sub` (else any repo can assume it).
- [ ] Migrate command matches the repo: order-service `npm run migrate:all` (shards), core-service `npm run migrate` (1 DB).
- [ ] Container port / target-group port / `ecs-sg` rule match the service: **core 3000**, **order 4000**, **analytics 4100** (a 3000-everywhere copy/paste = failing health checks).
- [ ] ALB has an HTTPS:443 listener + ACM cert (or run HTTP-only and drop 443 from `alb-sg`).
- [ ] analytics-service (`quickbite-analytcis-service`, port **4100**, Go + DocumentDB): **no migrate step / no `*-migrate` task def** — indexes build on boot.
- [ ] core & order: a separate **`*-worker` ECS service** runs `node dist/worker.js` (the API task only runs the server); its `deploy.yml` rolls both. analytics needs none.
- [ ] ECS service drain: set deregistration delay ~30s so in-flight orders/WS finish.
