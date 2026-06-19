#!/bin/bash
set -e
mkdir -p $HOME/zkorage-r5/worker-build
cd $HOME/zkorage-r5/worker-build
R=$HOME/zkorage-r5/prover/target/release
cp "$R/host" "$R/host_identity" "$R/host_compliance" "$R/host_payroll" \
   "$R/host_accredited" "$R/host_dataroom_seal" "$R/host_membership" "$R/host_docauth" .
cp /mnt/d/Project/Stellar/Real-World-ZK/zkorage/prover/worker/Dockerfile.gpu ./Dockerfile
cp /mnt/d/Project/Stellar/Real-World-ZK/zkorage/prover/worker/worker.sh ./worker.sh
echo "=== staged context (sizes) ==="
ls -la
echo "=== docker build zkorage-worker-gpu (no GPU needed for build) ==="
docker build -t zkorage-worker-gpu . 2>&1 | tail -15
echo "BUILD_RC=${PIPESTATUS[0]}"
docker images zkorage-worker-gpu --format "{{.Repository}}:{{.Tag}} {{.Size}}"
