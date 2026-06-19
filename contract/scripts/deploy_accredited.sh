#!/usr/bin/env bash
# Build + deploy the zkorage accredited-investor gate (Week 8 — the identity leg of the fundraising
# composition) to testnet and initialize it with the live verifier, the canonical (deterministic)
# ACCREDITED guest image_id, claim_type=7, and the mock accreditation provider in the issuer allowlist.
# Usage: contract/scripts/deploy_accredited.sh [identity-alias]
# Env overrides: VERIFIER_ID, IMAGE_ID, CLAIM_TYPE, ISSUER_ID
# Requires: stellar CLI 26.x, wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # contract/
WASM="$HERE/target/wasm32v1-none/release/accredited.wasm"

VERIFIER="${VERIFIER_ID:-CB75PMLNOMDATZ7BMEYYJMQUEMPUIVZKBGMAHZKDJH6BBG57LI6DZ2JH}"
# Canonical accredited guest image_id (deterministic Docker build, Week 8).
IMAGE_ID="${IMAGE_ID:-04fe8d3e971c616419fba35d519cbf35c8d58c545edf413ee872466354cd66ab}"
CLAIM_TYPE="${CLAIM_TYPE:-7}"
# Mock accreditation provider pubkey (ed25519 seed [13;32]) — `accreditedIssuerPubkey()`.
ISSUER="${ISSUER_ID:-91a28a0b74381593a4d9469579208926afc8ad82c8839b7644359b9eba9a4b3a}"

echo "[*] building accredited wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package accredited >/dev/null

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] admin=$ADMIN  verifier=$VERIFIER"
echo "[*] image_id=$IMAGE_ID  claim_type=$CLAIM_TYPE  issuer=$ISSUER"

echo "[*] deploying accredited gate to $NETWORK..."
CID="$(stellar contract deploy --wasm "$WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-accredited 2>/dev/null | tail -1)"
echo "[ok] accredited_id=$CID"
echo "$CID" > "$HERE/.accredited_id.$NETWORK"

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
echo "[done] accredited_id=$CID -> $HERE/.accredited_id.$NETWORK"
