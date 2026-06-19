# deploy/ — Frontend + Backend containers (internet exposure)

Containerized Frontend + Backend, exposed via the **existing Cloudflare Tunnel on the prover VM**
(`<user>-VMware`, `<vm-host>`, several cores) — the same `cloudflared` that already serves
`prover.wazowsky.id`. The FE/BE containers run **on that VM**, so the VM's `cloudflared` routes to them
over its own `localhost`. (The GPU prover worker stays in the Windows box's WSL2 and *pulls* jobs from the
VM — unaffected by this.)

| Public hostname | Cloudflare dashboard route (VM localhost) | Container |
|---|---|---|
| `zkorage.wazowsky.id` | `http://localhost:4173` | `zkorage-frontend` |
| `apizk.wazowsky.id`   | `http://localhost:8787` | `zkorage-backend`  |
| `prover.wazowsky.id`  | `http://localhost:8080` (pre-existing) | python prover gateway |

The VM's tunnel is **token-based / remotely-managed**, so routes live in the **Cloudflare dashboard**
(Zero Trust → Networks → Tunnels → *the tunnel* → Public Hostnames), not a local `config.yml`. Add the two
rows above to the existing tunnel — no new tunnel/daemon needed.

## Files (committed in the repo on the Windows dev box)
- `docker-compose.yml` (repo root) — both services, `restart: unless-stopped`, ports 4173 / 8787.
- `deploy/frontend.Dockerfile` — serves the **prebuilt** `frontend/dist` with `serve` + `serve.json`
  (index.html `no-store`; `assets/**` immutable 1y; SPA deep-link fallback). The version badge
  (`vX.Y.Z · <git-sha>`) is stamped into `dist/` at host build time, so the bundle is built on the Windows
  box (where git lives) and shipped to the VM.
- `deploy/backend.Dockerfile` — runs the Express API via `tsx`. Config/secrets + state are NOT baked in:
  `env_file: backend/.env` + volume `backend/data` (blob store, demo bundles, DR4 issuer key, DR2 set).
  Installs the SDK's own runtime deps in `/app/sdk` (npm symlinks `file:../sdk`; Node resolves the SDK's
  imports from the symlink's *real* path, not the backend's hoisted `node_modules`).
- `.dockerignore` (repo root) — lean context (both images build from the root for `file:../sdk`).
- `.gitattributes` — pins LF for `*.sh` / `.dockerignore` / `*.Dockerfile` / compose (`core.autocrlf=true`
  would otherwise hand out CRLF → breaks `.dockerignore` matching).

## VM deploy location + run
Deploy dir on the VM: **`/home/<user>/Project/Stellar/zkorage-web`** (kept separate from the prover dir).
```bash
ssh -i ~/.ssh/id_<user>_vm <user>@<vm-host>
cd /home/<user>/Project/Stellar/zkorage-web
docker compose up -d --build      # build + start both, detached
docker compose ps                 # STATUS should show (healthy)
docker compose logs -f backend    # tail logs
docker compose down               # stop + remove (does NOT touch the <user>-* containers)
```
Verify on the VM: `curl http://localhost:8787/health` → `{"ok":true}`; `curl -I http://localhost:4173/` →
`no-store`. Explicit `container_name`s (`zkorage-frontend`/`zkorage-backend`) + a `zkorage-web` compose
project keep this isolated from the VM's other (`<user>-*`) stacks.

## (Re)deploy from the Windows dev box → VM
The version badge is stamped on the **Windows box** at `npm run build`, so build there, then ship + rebuild
on the VM:
```bash
# On the Windows dev box (Git Bash), from the repo root:
cd frontend && npm run build && cd ..        # stamps dist/ with the current commit's short SHA
tar czf - --exclude='backend/node_modules' --exclude='sdk/node_modules' --exclude='keyper/node_modules' \
  --exclude='keyper/data' --exclude='*.tsbuildinfo' \
  backend sdk keyper frontend/dist frontend/serve.json deploy docker-compose.yml .dockerignore .gitattributes \
| ssh -i ~/.ssh/id_<user>_vm <user>@<vm-host> \
  'tar xzf - -C /home/<user>/Project/Stellar/zkorage-web'
# Then on the VM:
ssh -i ~/.ssh/id_<user>_vm <user>@<vm-host> \
  'cd /home/<user>/Project/Stellar/zkorage-web && docker compose up -d --build'
```
The tar now ships `keyper/` too (the keeper image builds from the same root context) and EXCLUDES
`keyper/data` so the VM keeps its own Shamir share stores (mirrors the `backend/.env` + `backend/data`
rule). The keeper share stores live in Docker named volumes (`keyper{1,2,3}-data`), so a rebuild keeps them.
Bump the version with `npm version patch|minor|major` in `frontend/` per deploy (single source of truth =
`frontend/package.json`). First diagnostic for a "stale view" report: the badge's `<sha>` vs the commit you
shipped.

## Unified UX redesign — LIVE on the main domain (:4173)

The unified marketing-site + sidebar-app frontend is a SINGLE `vite build` → `frontend/dist` (no more
`VITE_VARIANT` / `dist-a` / `dist-b`). **As of 2026-06-19 it is the main site at `zkorage.wazowsky.id`**
(VM `:4173`, container `zkorage-frontend`, the `docker-compose.yml` `frontend` service). The old violet
build and the throwaway A/B + preview deploys are **decommissioned**: containers `zkorage-frontend-a`
(:4174), `zkorage-frontend-b` (:4175), and `zkorage-frontend-preview` are removed and the `zkorage-ab`
compose project is torn down — so the `zkorage-a.wazowsky.id` / `zkorage-b.wazowsky.id` Public Hostnames
can be removed from the Cloudflare tunnel. (`docker-compose.ab.yml`, `docker-compose.preview.yml`, and
`deploy/frontend-*.Dockerfile` are kept in-repo as history but are no longer used.)

Redeploy the main site from the Windows dev box (the badge SHA is stamped at `npm run build`):
```bash
cd frontend && npm run build && cd ..                 # stamps dist/ with the current commit SHA
tar czf - frontend/dist frontend/serve.json \
| ssh -i ~/.ssh/id_<user>_vm <user>@<vm-host> \
  'tar xzf - -C /home/<user>/Project/Stellar/zkorage-web'
ssh -i ~/.ssh/id_<user>_vm <user>@<vm-host> \
  'cd /home/<user>/Project/Stellar/zkorage-web && docker compose up -d --build frontend'
```
Verify: `curl -I https://zkorage.wazowsky.id/` → `200` + `no-store`; the badge `<sha>` matches the shipped
commit. No Cloudflare change needed (the `zkorage.wazowsky.id` → localhost:4173 route already exists).

## The 3-keeper threshold committee (DR3 / Pattern-2 key release)

The Data Room key-release step (collect 2-of-3 sealed shares, rebuild the document key, decrypt) needs the
keeper committee live. Three keepers run as compose services `keyper1` / `keyper2` / `keyper3` (image
`deploy/keyper.Dockerfile`, one Shamir share each). They are **VM-internal only**: no published host ports
and no Cloudflare route, so only the backend aggregator reaches them by service-name DNS
(`http://keyper{1,2,3}:880{1,2,3}`). The public path stays `apizk.../dataroom/committee/collect`.

Each keeper reads its OWN testnet RPC (keyper1 + keyper3 on SDF, keyper2 on Gateway.fm) so the committee
does not trust a single shared oracle. With three keepers over two providers one provider serves two
keepers (= the threshold); a third independent RPC provider would close that, and the `STELLAR_RPC_URL` per
keeper in `docker-compose.yml` is the single knob to do it. The keepers gate `/share` on the on-chain
`is_doc_admitted` (the Pattern-2 per-document policy), rate-limit `/share` (`SHARE_RATE_PER_MIN`), and
restrict browser CORS (`KEYPER_ALLOWED_ORIGINS`); `GET /health` echoes both so you can confirm they are on.

**Per-box secrets/config live in `./.env`** next to `docker-compose.yml` on the VM (compose interpolation,
NOT shipped by the deploy tar, so a redeploy never clobbers it):
```bash
# /home/<user>/Project/Stellar/zkorage-web/.env  (create once; chmod 600)
KEYPER_DEAL_TOKEN=<a strong random token>     # shared by the backend dealer + all 3 keepers; gates /deal
DATAROOM_CONTRACT_ID=<the live DataRoom C... > # match backend/.env
SIM_SOURCE_PUBKEY=<a funded testnet G...>      # the keepers' read-only simulation source (match backend/.env)
```
`docker compose up` fails loudly (the `:?` guards) if any of these is missing, so the keepers can never
silently fall back to the demo token and mismatch the backend.

**Seed the demo committee docs' shares to the fresh keepers** (their share stores start empty), AFTER all 3
are healthy (a partial deal aborts):
```bash
ssh -i ~/.ssh/id_<user>_vm <user>@<vm-host> \
  'docker exec zkorage-backend node scripts/dr-prod-reseal-committee.mjs'
```
This re-splits a fresh K' for the DR3 demo doc (`a17388e8…/614664eb…`) and the DR6 / Pattern-2 demo doc
(`db16742c…/8b041fe3…`), deals one share per keeper, re-anchors on-chain (bumps `key_epoch`), and verifies
the round-trip. The room/doc/recipient IDs and the demo recipient secret are unchanged, so the frontend
demo constants and the key-free opener keep working.

Verify the committee: `curl -s http://localhost:8787/dataroom/committee/info` shows `online: 3` and each
keeper's `shares` count > 0 after the reseal.

## Durability
`restart: unless-stopped` + the VM is an always-on server whose `cloudflared` and Docker already run for the
prover — so the FE/BE containers come back on crash and on a VM reboot (docker starts on boot there). The
tunnel needs no per-deploy action once the two Public Hostnames are added in the dashboard.

## Notes
- The frontend calls the backend at the **public** `https://apizk.wazowsky.id` (baked from
  `frontend/.env.production`), so end-to-end FE→BE needs the tunnel routes live.
- CORS on the backend is open (`app.use(cors())`); its state-changing endpoints are unauthenticated demo
  endpoints — fine for a resettable demo, but anyone who can reach `apizk` can call them.
- `PROVER_URL=https://prover.wazowsky.id` works from the VM (hairpins through Cloudflare); it could also be
  pointed at `http://localhost:8080` since the gateway is on the same VM, but that's not required.
