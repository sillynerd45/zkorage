# zkorage DR3 — one threshold-ECIES keyper, containerized for the production committee on the VM.
# Build context = repo ROOT (shared with the FE/BE images), but only keyper/ is copied in. Run three of
# these (KEYPER_INDEX 1/2/3) as separate compose services so no single process can reconstruct K.
#   docker compose build keyper1   (or: docker build -f deploy/keyper.Dockerfile .)
#
# Config comes in at RUNTIME via docker-compose `environment:` — KEYPER_INDEX, KEYPER_PORT, DEAL_TOKEN,
# DATAROOM_CONTRACT_ID, STELLAR_RPC_URL, SIM_SOURCE_PUBKEY, plus the hardening knobs SHARE_RATE_PER_MIN /
# KEYPER_ALLOWED_ORIGINS. The Shamir share store is a mounted volume, NEVER baked into the image.
FROM node:22-slim

# tini = proper PID 1 (clean signal handling for restart/stop)
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/keyper

# Install deps first (cached layer). tsx is a devDependency used at runtime, so keep dev deps.
COPY keyper/package.json keyper/package-lock.json ./
RUN npm ci

# App source (node_modules + the share-store data dir are excluded via .dockerignore).
COPY keyper/ ./

ENV NODE_ENV=production

# Liveness via the keeper's own /health route (node has global fetch; no curl needed in the image).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://localhost:'+(process.env.KEYPER_PORT||8801)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "keyper"]
