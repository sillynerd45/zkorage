# zkorage backend (orchestration API) — runs the Express app via tsx.
# Build context = repo ROOT (so the backend's `file:../sdk` dependency resolves to ../sdk).
#   docker compose build backend   (or: docker build -f deploy/backend.Dockerfile .)
#
# Config + secrets are NOT baked in — supplied at runtime by docker-compose:
#   env_file: ./backend/.env          (contract IDs, ISSUER_SEED/SIGNER_SECRET, PROVER_URL, R2 creds, …)
#   volume:   ./backend/data:/app/backend/data   (blob store, demo bundles, dr4 issuer key, dr2 eligible set)
FROM node:22-slim

# tini = proper PID 1 (clean signal handling for restart/stop)
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# The SDK (prebuilt dist) sits at /app/sdk so the backend's file:../sdk resolves. npm symlinks that
# dependency, and Node resolves the SDK's OWN imports (@stellar/stellar-sdk, @noble/*) from the symlink's
# real path — so the SDK needs its own node_modules here, not just the backend's hoisted copy.
COPY sdk/package.json sdk/package-lock.json /app/sdk/
RUN cd /app/sdk && npm ci --omit=dev --no-audit --no-fund
COPY sdk/ /app/sdk/

WORKDIR /app/backend
# Install deps first (cached layer). tsx is a devDependency used at runtime, so keep dev deps.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci

# App source (env + data + node_modules are excluded via .dockerignore).
COPY backend/ ./

ENV NODE_ENV=production
EXPOSE 8787

# Liveness via the built-in /health route (node has global fetch; no curl needed in the image).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
