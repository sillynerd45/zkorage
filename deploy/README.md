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
tar czf - --exclude='backend/node_modules' --exclude='sdk/node_modules' --exclude='*.tsbuildinfo' \
  backend sdk frontend/dist frontend/serve.json deploy docker-compose.yml .dockerignore .gitattributes \
| ssh -i ~/.ssh/id_<user>_vm <user>@<vm-host> \
  'tar xzf - -C /home/<user>/Project/Stellar/zkorage-web'
# Then on the VM:
ssh -i ~/.ssh/id_<user>_vm <user>@<vm-host> \
  'cd /home/<user>/Project/Stellar/zkorage-web && docker compose up -d --build'
```
Bump the version with `npm version patch|minor|major` in `frontend/` per deploy (single source of truth =
`frontend/package.json`). First diagnostic for a "stale view" report: the badge's `<sha>` vs the commit you
shipped.

## Unified UX redesign — preview at zkorage-a (:4174)

The unified marketing-site + sidebar-app build (branch `ux-redesign`) is a SINGLE `vite build` →
`frontend/dist` (no more `VITE_VARIANT` / `dist-a` / `dist-b`). It previews at **`zkorage-a.wazowsky.id`
→ `http://localhost:4174`** (reusing the existing A/B tunnel route), via `docker-compose.preview.yml` +
`deploy/frontend-preview.Dockerfile`. The live violet `zkorage.wazowsky.id` (:4173) is untouched until
cutover. Deploy from the Windows dev box:

```bash
# On the Windows dev box (Git Bash), repo root — build stamps dist/ with the current commit SHA:
cd frontend && npm run build && cd ..
tar czf - frontend/dist frontend/serve.json deploy/frontend-preview.Dockerfile \
  docker-compose.preview.yml .dockerignore .gitattributes \
| ssh -i ~/.ssh/id_<user>_vm <user>@<vm-host> \
  'tar xzf - -C /home/<user>/Project/Stellar/zkorage-web'
# Then on the VM: free the old A/B ports and bring up the single unified preview
ssh -i ~/.ssh/id_<user>_vm <user>@<vm-host> \
  'cd /home/<user>/Project/Stellar/zkorage-web && docker rm -f zkorage-frontend-a zkorage-frontend-b 2>/dev/null; \
   docker compose -f docker-compose.preview.yml up -d --build'
```
Verify on the VM: `curl -I http://localhost:4174/` → `200` + `no-store`; the badge `<sha>` matches the
shipped commit. The `zkorage-a.wazowsky.id` Public Hostname (→ localhost:4174) is already on the tunnel
from the A/B phase, so no Cloudflare dashboard change is needed. On sign-off, point the main
`zkorage.wazowsky.id` route at the unified build (or rebuild the :4173 `zkorage-frontend` from this `dist`).

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
