#!/usr/bin/env bash
# Rebuild the zkorage GPU prover-worker image and recreate the container. Run on the Windows box's WSL2
# (where the v5 CUDA host bins live, ~/zkorage-r5):
#   wsl bash /mnt/d/Project/Stellar/Real-World-ZK/zkorage/deploy/build-worker-gpu.sh
#
# Stages a build context (the 11 canonical CUDA host bins, each embedding its deterministic guest ELF, +
# worker.sh + the Dockerfile), builds `zkorage-worker-gpu`, then recreates the container with --gpus all +
# the risc0 cache mount. The bins MUST be the v5 canonical (Docker-ELF) ones or the worker emits a
# non-canonical image_id and proofs are rejected on-chain (ImageMismatch). Mirrors the BP3/BP5 prover update.
set -euo pipefail

REL="$HOME/zkorage-r5/prover/target/release"
REPO="/mnt/d/Project/Stellar/Real-World-ZK/zkorage"
CTX="$HOME/worker-build-gpu"
BINS="host host_identity host_compliance host_payroll host_accredited host_dataroom_seal host_membership host_docauth host_solvency host_tier host_bond"
# The worker pulls jobs from the VM gateway with this token; demo defaults, overridable for a real deploy.
VM_URL="${VM_URL:-https://prover.wazowsky.id}"
WORKER_TOKEN="${WORKER_TOKEN:-zkw_demo_5070ti}"

echo "=== stage build context: $CTX ==="
rm -rf "$CTX"; mkdir -p "$CTX"
for b in $BINS; do
  [ -f "$REL/$b" ] || { echo "MISSING cuda bin: $REL/$b"; exit 1; }
  ln -f "$REL/$b" "$CTX/$b" 2>/dev/null || cp "$REL/$b" "$CTX/$b"
done
cp "$REPO/prover/worker/worker.sh" "$CTX/worker.sh"
cp "$REPO/deploy/worker-gpu.Dockerfile" "$CTX/Dockerfile"
echo "staged: $(ls -1 "$CTX" | tr '\n' ' ')"

echo "=== docker build zkorage-worker-gpu ($(date +%T)) ==="
docker build -t zkorage-worker-gpu -f "$CTX/Dockerfile" "$CTX"

echo "=== recreate container ($(date +%T)) ==="
docker rm -f zkorage-worker-gpu 2>/dev/null || true
docker run -d --restart unless-stopped --gpus all \
  -v "$HOME/.risc0:/root/.risc0:ro" --dns 1.1.1.1 \
  -e VM_URL="$VM_URL" -e WORKER_TOKEN="$WORKER_TOKEN" \
  --name zkorage-worker-gpu zkorage-worker-gpu

sleep 3
docker ps --filter name=zkorage-worker-gpu --format "{{.Names}}  {{.Status}}  {{.Image}}"
echo "=== worker startup log ==="
docker logs zkorage-worker-gpu 2>&1 | head -12
echo "=== verify host_tier + host_bond baked in ==="
docker exec zkorage-worker-gpu sh -c 'ls -la /prover/target/release/host_tier /prover/target/release/host_bond && echo HOST_TIER_BIN=$HOST_TIER_BIN HOST_BOND_BIN=$HOST_BOND_BIN'
echo "=== DONE $(date +%T) ==="
