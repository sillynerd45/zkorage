#!/usr/bin/env bash
# Build + deploy the zkorage Confidential Data Room contract (DR1 data plane) to testnet and initialize
# it with the live verifier, the canonical DR1 seal guest image_id, and claim_type=8.
# Usage: contract/scripts/deploy_dataroom.sh [identity-alias]
# Env overrides: VERIFIER_ID, SEAL_IMAGE_ID, CLAIM_TYPE
# Requires: stellar CLI 26.x, wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # contract/
WASM="$HERE/target/wasm32v1-none/release/dataroom.wasm"

VERIFIER="${VERIFIER_ID:-CB75PMLNOMDATZ7BMEYYJMQUEMPUIVZKBGMAHZKDJH6BBG57LI6DZ2JH}"
SEAL_IMAGE_ID="${SEAL_IMAGE_ID:-20adf66afb62143a951a16f8260c4c0fbc6cb0779996ac55394f1c57f3b9df42}"
CLAIM_TYPE="${CLAIM_TYPE:-8}"

echo "[*] building dataroom wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package dataroom >/dev/null

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] admin=$ADMIN  verifier=$VERIFIER"
echo "[*] seal_image_id=$SEAL_IMAGE_ID  claim_type=$CLAIM_TYPE"

echo "[*] deploying dataroom to $NETWORK..."
CID="$(stellar contract deploy --wasm "$WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-dataroom 2>/dev/null | tail -1)"
echo "[ok] dataroom_id=$CID"
echo "$CID" > "$HERE/.dataroom_id.$NETWORK"

echo "[*] initialize..."
stellar contract invoke --id "$CID" --source "$ALIAS" --network "$NETWORK" -- \
  initialize \
  --admin "$ADMIN" \
  --verifier "$VERIFIER" \
  --seal_image_id "$SEAL_IMAGE_ID" \
  --claim_type "$CLAIM_TYPE" >/dev/null

echo "[*] verifying config..."
stellar contract invoke --send=no --id "$CID" --source "$ALIAS" --network "$NETWORK" -- get_config
echo "[done] dataroom_id=$CID -> $HERE/.dataroom_id.$NETWORK"
