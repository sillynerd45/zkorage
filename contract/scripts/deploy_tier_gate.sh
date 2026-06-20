#!/usr/bin/env bash
# Build + deploy the zkorage tier-gate (BP5 — an anonymous bonded tier / membership expiring at X) to
# testnet and initialize it against the bare Groth16 verifier + the canonical tier guest image. The gate
# verifies the anonymous bonded-tier Groth16 proof (image 2671938b...), binds it to an admin-pinned
# enrolled-member root + a publicly-recomputable qualifying-set root + the deadline X. It reads NO lock
# (that would de-anonymize the member) — freshness is the deadline-only `now < X`, sound because qualifying
# locks are non-revocable. The enrolled-member root + the per-tier qual roots are set AFTER init
# (set_member_root / set_qual_root), so the gate fails closed until it is enrolled.
#
# Usage: contract/scripts/deploy_tier_gate.sh [identity-alias]
# Requires: stellar CLI 26.x, wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # contract/
GATE_WASM="$HERE/target/wasm32v1-none/release/tier_gate.wasm"

# ---- pinned config (testnet) ----
VERIFIER="CBAPC663PTWIWDLYNCG5WAD5MIZF4SKY43U6L2NM5ZUU5XFOS4JDYAFW"            # bare Groth16 verifier (risc0 5)
IMAGE_ID="2671938b59598c129913fee8e0ef29159e6475dd61c37c503429bdaf0fba4e69"  # tier guest (risc0 5)
CLAIM_TYPE=13

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] deployer/admin = $ADMIN  network = $NETWORK"

echo "[*] building tier-gate wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package tier-gate >/dev/null
ls -la "$GATE_WASM" | awk '{print "[ok] wasm bytes:", $5}'

echo "[*] deploying tier-gate..."
GATE_ID="$(stellar contract deploy --wasm "$GATE_WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-tier-gate 2>/dev/null | tail -1)"
echo "$GATE_ID" > "$HERE/.tier_gate_id.$NETWORK"
echo "[ok] tier_gate_id=$GATE_ID"

echo "[*] initializing (admin, verifier, image_id, claim_type)..."
stellar contract invoke --id "$GATE_ID" --source "$ALIAS" --network "$NETWORK" -- initialize \
  --admin "$ADMIN" \
  --verifier "$VERIFIER" \
  --image_id "$IMAGE_ID" \
  --claim_type "$CLAIM_TYPE" >/dev/null
echo "[ok] initialized"

echo "[*] read-back get_config (expect image $IMAGE_ID, claim_type $CLAIM_TYPE):"
stellar contract invoke --send=no --id "$GATE_ID" --source "$ALIAS" --network "$NETWORK" -- get_config 2>/dev/null

echo "[*] read-back get_member_root (expect None — fail-closed until enrolled):"
stellar contract invoke --send=no --id "$GATE_ID" --source "$ALIAS" --network "$NETWORK" -- get_member_root 2>/dev/null

echo "[done] tier_gate_id=$GATE_ID"
