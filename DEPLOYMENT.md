# VACUUM Deployment & Architecture Guide (`DEPLOYMENT.md`)

## 1. Why Cloudflare Pages/Workers Cannot Host `node:sqlite` Directly

VACUUM's backend persistence layer (`src/lib/db.ts`) uses Node.js's native synchronous **`node:sqlite` (`DatabaseSync`)** with **SQLite Write-Ahead Logging (`PRAGMA journal_mode = WAL`)**, atomic `BEGIN IMMEDIATE ... COMMIT` transactions (`runInTransaction`), and native OpenSSL Ed25519 signature verification (`node:crypto`).

- **Cloudflare Workers / Pages Functions** run on the `workerd` V8 isolate runtime rather than full Node.js. `workerd` does **not** support `node:sqlite` or local POSIX `.db` / `.db-wal` / `.db-shm` file locking.
- Migrating to Cloudflare D1 would require rewriting all synchronous `DatabaseSync` queries and nested savepoint transactions across `db.ts`, `sweepOrchestrator.ts`, `sponsorshipService.ts`, `tokenDiscoveryService.ts`, `historyService.ts`, and `walletService.ts` into asynchronous network-bound D1 bindings.

### Recommended Architecture: Unified Node.js 22+ Container / PaaS Host
Deploying the full Next.js 15 application as a single unified Node.js 22+ service (via Docker or native Node 22 buildpack on **Render**, **Fly.io**, **Railway**, or **Koyeb**) preserves 100% of existing code, `node:sqlite` WAL transactions, and API routes with zero rewrite risk and zero CORS complexity.

| Hosting Option | Free Tier Support | `node:sqlite` + WAL | Persistent Disk Option | Deployment Complexity |
| :--- | :--- | :--- | :--- | :--- |
| **Render.com (Web Service via `render.yaml` / `Dockerfile`)** | **Yes (Free Plan)** | **Supported natively (`node:22-bookworm-slim`)** | `/tmp/vacuum-data/vacuum.db` on Free Plan, or attach Persistent Disk at `/app/data` | **1-Click / Single Blueprint** |
| **Fly.io (Docker + Fly Volume)** | **Yes (Trial / Hobby)** | **Supported natively** | 1GB Free/Low-cost Persistent Volume mounted at `/app/data` | **2 CLI Commands (`fly launch && fly deploy`)** |
| **Railway.app** | **Yes ($5 Trial Credit)** | **Supported natively** | Persistent Volume mounted at `/app/data` | **1 CLI Command (`railway up`)** |

---

## 2. Pre-Deployment Verification Commands

```bash
# 1. Run all 36 unit, integration & Phase 9 security audit tests
npm test

# 2. Verify live Devnet sponsorship & on-chain execution
npm run test:devnet

# 3. Build optimized Next.js 15 production bundle
npm run build
```

---

## 3. Exact Deployment Commands

### Option A: Render.com Free Tier (Recommended Fastest Public URL)
1. Push repository to GitHub (includes `Dockerfile` and `render.yaml`).
2. In the Render Dashboard, click **New + → Blueprint** and select the repository, or run with Render CLI:
   ```bash
   render blueprint launch
   ```
3. Add secret environment variable `SPONSOR_FEE_PAYER_SECRET_KEY` (and optional `JUPITER_API_KEY`) in the Render Environment tab.
4. Render builds the `Dockerfile` (`node:22-bookworm-slim`), verifies `/api/status`, and publishes an HTTPS URL (`https://vacuum-solana-sweeper.onrender.com`).

### Option B: Local / VPS Docker Deployment
```bash
# Build production container image
docker build -t vacuum-solana-sweeper:latest .

# Run with persistent ./data volume mounted and port 3000 exposed
docker run -d \
  --name vacuum-app \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  --env-file .env \
  vacuum-solana-sweeper:latest
```

### Option C: Fly.io Deployment with Persistent SQLite WAL Volume
```bash
fly launch --no-deploy --name vacuum-solana-sweeper
fly volumes create vacuum_data --size 1 --region iad
fly secrets set SPONSOR_FEE_PAYER_SECRET_KEY="<base58_secret_key>"
fly deploy
```
