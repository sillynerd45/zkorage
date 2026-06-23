#!/usr/bin/env bash
# Build + deploy the zkorage bond-gate (BA1 — anonymous per-requirement Bonded Access) to testnet and
# initialize it against the bare Groth16 verifier + the canonical bond guest image. The generalized
# successor to the tier-gate: it keys everything by req_id = sha256(token || min_amount_i128 || deadline),
# so each Data Room document/room can require its OWN bond. It verifies the bond Groth16 proof (image
# dc4da02d...), recomputes req_id on-chain, binds the proof to a publicly-recomputable per-requirement
# qual root + the deadline, and records Grant(accessor, req_id) binding the member_root. It reads NO lock
# (that would de-anonymize the member) — freshness is the deadline-only `now < deadline`, sound because
# qualifying locks are non-revocable. Per-requirement qual roots are published AFTER init (set_qual_root),
# so the gate fails closed (no accepted root) until an indexer publishes one.
#
# Usage: contract/scripts/deploy_bond_gate.sh [identity-alias]
# Requires: stellar CLI 26.x, wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # contract/
GATE_WASM="$HERE/target/wasm32v1-none/release/bond_gate.wasm"

# ---- pinned config (testnet) ----
VERIFIER="CBAPC663PTWIWDLYNCG5WAD5MIZF4SKY43U6L2NM5ZUU5XFOS4JDYAFW"            # bare Groth16 verifier (risc0 5)
IMAGE_ID="dc4da02d887b3f388ffee26860a8416b393d4cfea982831183d15d5bfcf1f6c4"  # bond guest (risc0 5)
CLAIM_TYPE=14

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] deployer/admin = $ADMIN  network = $NETWORK"

echo "[*] building bond-gate wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package bond-gate >/dev/null
ls -la "$GATE_WASM" | awk '{print "[ok] wasm bytes:", $5}'

echo "[*] deploying bond-gate..."
GATE_ID="$(stellar contract deploy --wasm "$GATE_WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-bond-gate 2>/dev/null | tail -1)"
echo "$GATE_ID" > "$HERE/.bond_gate_id.$NETWORK"
echo "[ok] bond_gate_id=$GATE_ID"

echo "[*] initializing (admin, verifier, image_id, claim_type)..."
stellar contract invoke --id "$GATE_ID" --source "$ALIAS" --network "$NETWORK" -- initialize \
  --admin "$ADMIN" \
  --verifier "$VERIFIER" \
  --image_id "$IMAGE_ID" \
  --claim_type "$CLAIM_TYPE" >/dev/null
echo "[ok] initialized"

echo "[*] read-back get_config (expect image $IMAGE_ID, claim_type $CLAIM_TYPE):"
stellar contract invoke --send=no --id "$GATE_ID" --source "$ALIAS" --network "$NETWORK" -- get_config 2>/dev/null

echo "[done] bond_gate_id=$GATE_ID"
