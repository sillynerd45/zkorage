#!/usr/bin/env bash
# Build + deploy the zkorage compliance gate (KYC ∧ not-sanctioned) to testnet and initialize it with the
# live verifier, the canonical (deterministic) COMPLIANCE guest image_id, claim_type=4, the sanctions
# deny-list Merkle root (from the backend tree-builder), and the mock KYC provider in the allowlist.
# Usage: contract/scripts/deploy_compliance.sh [identity-alias]
# Env overrides: VERIFIER_ID, IMAGE_ID, CLAIM_TYPE, DENY_ROOT, ISSUER_ID
# Requires: stellar CLI 26.x, wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # contract/
WASM="$HERE/target/wasm32v1-none/release/compliance.wasm"

VERIFIER="${VERIFIER_ID:-CB75PMLNOMDATZ7BMEYYJMQUEMPUIVZKBGMAHZKDJH6BBG57LI6DZ2JH}"
# Canonical compliance guest image_id (deterministic Docker build, Week 6).
IMAGE_ID="${IMAGE_ID:-eba31f8e5a9cccd2836b8a0eb07f64d19730b181fcc6b6b50e6efb0021005916}"
CLAIM_TYPE="${CLAIM_TYPE:-4}"
# Demo sanctions deny-list root (depth 20) — `cd backend && npx tsx scripts/w6-fixtures.ts | grep denyRoot`.
DENY_ROOT="${DENY_ROOT:-8cb45df8b0c8224c818ffc5e4d3c3d56cc6928d5c49f75528ba850def35fd18d}"
ISSUER="${ISSUER_ID:-fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618}"

echo "[*] building compliance wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package compliance >/dev/null

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] admin=$ADMIN  verifier=$VERIFIER"
echo "[*] image_id=$IMAGE_ID  claim_type=$CLAIM_TYPE"
echo "[*] deny_root=$DENY_ROOT  kyc_issuer=$ISSUER"

echo "[*] deploying compliance gate to $NETWORK..."
CID="$(stellar contract deploy --wasm "$WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-compliance 2>/dev/null | tail -1)"
echo "[ok] compliance_id=$CID"
echo "$CID" > "$HERE/.compliance_id.$NETWORK"

echo "[*] initialize..."
stellar contract invoke --id "$CID" --source "$ALIAS" --network "$NETWORK" -- \
  initialize \
  --admin "$ADMIN" \
  --verifier "$VERIFIER" \
  --image_id "$IMAGE_ID" \
  --claim_type "$CLAIM_TYPE" \
  --deny_root "$DENY_ROOT" \
  --issuers "[\"$ISSUER\"]" >/dev/null

echo "[*] verifying config..."
stellar contract invoke --send=no --id "$CID" --source "$ALIAS" --network "$NETWORK" -- get_config
echo "[done] compliance_id=$CID -> $HERE/.compliance_id.$NETWORK"
