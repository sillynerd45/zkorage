#!/usr/bin/env bash
# Build + deploy the zkorage fundraise-access contract (Week 8 — the composition finale) to testnet and
# initialize it: the live verifier, the canonical generic-guest image (revenue claim, claim_type=6), the
# public revenue floor X, the mock revenue auditor in the issuer allowlist, and the deployed accredited
# gate it AND's against. request_investor_access grants only when revenue ≥ X is proven AND the investor
# is accredited (cross-call is_granted).
# Usage: contract/scripts/deploy_fundraise.sh [identity-alias]
# Env overrides: VERIFIER_ID, REVENUE_IMAGE_ID, REVENUE_CLAIM_TYPE, REVENUE_THRESHOLD, ISSUER_ID, ACCREDITED_ID
# Requires: stellar CLI 26.x, wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # contract/
WASM="$HERE/target/wasm32v1-none/release/fundraise.wasm"

VERIFIER="${VERIFIER_ID:-CB75PMLNOMDATZ7BMEYYJMQUEMPUIVZKBGMAHZKDJH6BBG57LI6DZ2JH}"
# Canonical generic (claim_predicate) guest image_id — the SAME image PoR uses; reused for the revenue
# value≥threshold claim (claim_type 6). Deterministic Docker build.
REVENUE_IMAGE="${REVENUE_IMAGE_ID:-82bbf7eeeba56a54ffb1e8a554d0e23efd2e5675299ea82897aa50b21c6f3d54}"
REVENUE_CLAIM_TYPE="${REVENUE_CLAIM_TYPE:-6}"
# Public revenue floor X (demo: $1,000,000, whole USD). The proof's committed threshold must equal this.
REVENUE_THRESHOLD="${REVENUE_THRESHOLD:-1000000}"
# Mock revenue auditor pubkey (ed25519 seed [15;32]) — `revenueAttesterPubkey()`.
ISSUER="${ISSUER_ID:-d9bf2148748a85c89da5aad8ee0b0fc2d105fd39d41a4c796536354f0ae2900c}"
# The deployed accredited gate (the identity leg). Defaults to the recorded deploy.
ACCREDITED="${ACCREDITED_ID:-$(cat "$HERE/.accredited_id.$NETWORK" 2>/dev/null || echo CCLSXZBOPCAJQS6L54EAGZQHTD5QUES2OSYCFX5XJT6ZXSICRPS4QKQZ)}"

echo "[*] building fundraise wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package fundraise >/dev/null

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] admin=$ADMIN  verifier=$VERIFIER"
echo "[*] revenue_image=$REVENUE_IMAGE  claim_type=$REVENUE_CLAIM_TYPE  threshold=$REVENUE_THRESHOLD"
echo "[*] issuer=$ISSUER  accredited_gate=$ACCREDITED"

echo "[*] deploying fundraise to $NETWORK..."
CID="$(stellar contract deploy --wasm "$WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-fundraise 2>/dev/null | tail -1)"
echo "[ok] fundraise_id=$CID"
echo "$CID" > "$HERE/.fundraise_id.$NETWORK"

echo "[*] initialize..."
stellar contract invoke --id "$CID" --source "$ALIAS" --network "$NETWORK" -- \
  initialize \
  --admin "$ADMIN" \
  --verifier "$VERIFIER" \
  --accredited_gate "$ACCREDITED" \
  --revenue_image_id "$REVENUE_IMAGE" \
  --revenue_claim_type "$REVENUE_CLAIM_TYPE" \
  --revenue_threshold "$REVENUE_THRESHOLD" \
  --issuers "[\"$ISSUER\"]" >/dev/null

echo "[*] verifying config..."
stellar contract invoke --send=no --id "$CID" --source "$ALIAS" --network "$NETWORK" -- get_config
echo "[done] fundraise_id=$CID -> $HERE/.fundraise_id.$NETWORK"
