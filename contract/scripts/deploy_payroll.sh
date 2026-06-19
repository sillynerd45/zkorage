#!/usr/bin/env bash
# Build + deploy the zkorage payroll gate (confidential proof-of-income + auditor view-key) to testnet
# and initialize it with the live verifier, the canonical (deterministic) PAYROLL guest image_id,
# claim_type=5, the mock payroll attester in the issuer allowlist, and the demo auditor x25519 key in
# the auditor allowlist.
# Usage: contract/scripts/deploy_payroll.sh [identity-alias]
# Env overrides: VERIFIER_ID, IMAGE_ID, CLAIM_TYPE, ATTESTER_ID, AUDITOR_PUB
# Requires: stellar CLI 26.x, wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # contract/
WASM="$HERE/target/wasm32v1-none/release/payroll.wasm"

VERIFIER="${VERIFIER_ID:-CB75PMLNOMDATZ7BMEYYJMQUEMPUIVZKBGMAHZKDJH6BBG57LI6DZ2JH}"
# Canonical payroll guest image_id (deterministic Docker build, Week 7).
IMAGE_ID="${IMAGE_ID:-b9c97e6b63cdc881b0a14948caa64a72c3929bb0d85973c508d148d3f0a9432f}"
CLAIM_TYPE="${CLAIM_TYPE:-5}"
# Mock payroll attester pubkey (ed25519 seed [11;32]) — `cd backend && npx tsx -e ...payrollAttesterPubkey`.
ATTESTER="${ATTESTER_ID:-66be7e332c7a453332bd9d0a7f7db055f5c5ef1a06ada66d98b39fb6810c473a}"
# Demo auditor x25519 public key (the view-key target) — `GET /info -> auditorPub`.
AUDITOR="${AUDITOR_PUB:-c275cf79ef891f9d1a725a7ecd74047854754b4445c92b75f193725f6376a83f}"

echo "[*] building payroll wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package payroll >/dev/null

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] admin=$ADMIN  verifier=$VERIFIER"
echo "[*] image_id=$IMAGE_ID  claim_type=$CLAIM_TYPE"
echo "[*] attester=$ATTESTER  auditor=$AUDITOR"

echo "[*] deploying payroll gate to $NETWORK..."
CID="$(stellar contract deploy --wasm "$WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-payroll 2>/dev/null | tail -1)"
echo "[ok] payroll_id=$CID"
echo "$CID" > "$HERE/.payroll_id.$NETWORK"

echo "[*] initialize..."
stellar contract invoke --id "$CID" --source "$ALIAS" --network "$NETWORK" -- \
  initialize \
  --admin "$ADMIN" \
  --verifier "$VERIFIER" \
  --image_id "$IMAGE_ID" \
  --claim_type "$CLAIM_TYPE" \
  --issuers "[\"$ATTESTER\"]" \
  --auditors "[\"$AUDITOR\"]" >/dev/null

echo "[*] verifying config..."
stellar contract invoke --send=no --id "$CID" --source "$ALIAS" --network "$NETWORK" -- get_config
echo "[done] payroll_id=$CID -> $HERE/.payroll_id.$NETWORK"
