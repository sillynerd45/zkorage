#!/usr/bin/env bash
# Build + deploy the zkorage Proof-of-Reserves policy contract to testnet and initialize it with
# the live verifier, the demo token, the canonical (deterministic) guest image_id, claim_type=2,
# and the demo custodian issuer in the allowlist.
# Usage: contract/scripts/deploy_policy.sh [identity-alias]
# Env overrides: VERIFIER_ID, IMAGE_ID, CLAIM_TYPE, ISSUER_ID  (TOKEN read from .token_id.testnet)
# Requires: stellar CLI 26.x, wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # contract/
WASM="$HERE/target/wasm32v1-none/release/policy.wasm"

VERIFIER="${VERIFIER_ID:-CB75PMLNOMDATZ7BMEYYJMQUEMPUIVZKBGMAHZKDJH6BBG57LI6DZ2JH}"
TOKEN="${TOKEN_ID:-$(cat "$HERE/.token_id.$NETWORK")}"
IMAGE_ID="${IMAGE_ID:-5bb5644b7aa0bd9639c537fc3dc5e63fbb1ef2528c402b261c9315ecd1e76ce2}"
CLAIM_TYPE="${CLAIM_TYPE:-2}"
ISSUER="${ISSUER_ID:-ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c}"

echo "[*] building policy wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package policy >/dev/null

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] admin=$ADMIN  verifier=$VERIFIER  token=$TOKEN"
echo "[*] image_id=$IMAGE_ID  claim_type=$CLAIM_TYPE  issuer=$ISSUER"

echo "[*] deploying policy to $NETWORK..."
CID="$(stellar contract deploy --wasm "$WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-policy 2>/dev/null | tail -1)"
echo "[ok] policy_id=$CID"
echo "$CID" > "$HERE/.policy_id.$NETWORK"

echo "[*] initialize..."
stellar contract invoke --id "$CID" --source "$ALIAS" --network "$NETWORK" -- \
  initialize \
  --admin "$ADMIN" \
  --verifier "$VERIFIER" \
  --token "$TOKEN" \
  --image_id "$IMAGE_ID" \
  --claim_type "$CLAIM_TYPE" \
  --issuers "[\"$ISSUER\"]" >/dev/null

echo "[*] verifying config..."
stellar contract invoke --send=no --id "$CID" --source "$ALIAS" --network "$NETWORK" -- get_config
echo "[done] policy_id=$CID -> $HERE/.policy_id.$NETWORK"
