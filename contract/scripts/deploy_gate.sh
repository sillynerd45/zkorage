#!/usr/bin/env bash
# Build + deploy the zkorage relying-party KYC gate to testnet and initialize it with the live
# verifier, the canonical (deterministic) IDENTITY guest image_id, claim_type=3, and the mock KYC
# provider in the allowlist.
# Usage: contract/scripts/deploy_gate.sh [identity-alias]
# Env overrides: VERIFIER_ID, IMAGE_ID, CLAIM_TYPE, ISSUER_ID
# Requires: stellar CLI 26.x, wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # contract/
WASM="$HERE/target/wasm32v1-none/release/gate.wasm"

VERIFIER="${VERIFIER_ID:-CB75PMLNOMDATZ7BMEYYJMQUEMPUIVZKBGMAHZKDJH6BBG57LI6DZ2JH}"
IMAGE_ID="${IMAGE_ID:-99e3fdb8185e52ef8a1fd2b0bdf708ba46bfea483e6a7c98dbd08acf2d810ac2}"
CLAIM_TYPE="${CLAIM_TYPE:-3}"
ISSUER="${ISSUER_ID:-fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618}"

echo "[*] building gate wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package gate >/dev/null

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] admin=$ADMIN  verifier=$VERIFIER"
echo "[*] image_id=$IMAGE_ID  claim_type=$CLAIM_TYPE  kyc_issuer=$ISSUER"

echo "[*] deploying gate to $NETWORK..."
CID="$(stellar contract deploy --wasm "$WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-gate 2>/dev/null | tail -1)"
echo "[ok] gate_id=$CID"
echo "$CID" > "$HERE/.gate_id.$NETWORK"

echo "[*] initialize..."
stellar contract invoke --id "$CID" --source "$ALIAS" --network "$NETWORK" -- \
  initialize \
  --admin "$ADMIN" \
  --verifier "$VERIFIER" \
  --image_id "$IMAGE_ID" \
  --claim_type "$CLAIM_TYPE" \
  --issuers "[\"$ISSUER\"]" >/dev/null

echo "[*] verifying config..."
stellar contract invoke --send=no --id "$CID" --source "$ALIAS" --network "$NETWORK" -- get_config
echo "[done] gate_id=$CID -> $HERE/.gate_id.$NETWORK"
