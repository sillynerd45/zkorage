#!/usr/bin/env bash
# DR5 — in-place upgrade of the live DataRoom contract (storage preserved): adds attest_teaser (faithful
# disclosure / data-side teaser) + the teaser image pin + the appraiser-attester allowlist. Same native
# update_current_contract_wasm mechanism as DR2/DR3/DR4. Git Bash / POSIX only.
# Usage: contract/scripts/upgrade_dataroom_dr5.sh [identity-alias]
# Env overrides: DATAROOM_ID, TEASER_IMAGE_ID, TEASER_ATTESTER
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # contract/
WASM="$HERE/target/wasm32v1-none/release/dataroom.wasm"

DATAROOM="${DATAROOM_ID:-CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN}"
# DR5 teaser = the generic value>=threshold guest (v5), claim_type 11 (no new guest).
TEASER_IMAGE_ID="${TEASER_IMAGE_ID:-973c983125ad3a9f115b2f4d8d12ec39e3f1b107f15c57643f72baf36f923502}"
# The dedicated data-room appraiser attester (signer seed [17]).
TEASER_ATTESTER="${TEASER_ATTESTER:-d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737}"

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] dataroom=$DATAROOM  admin=$ADMIN"

echo "[*] building dataroom wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package dataroom >/dev/null

echo "[*] uploading wasm..."
WASM_HASH="$(stellar contract upload --wasm "$WASM" --source "$ALIAS" --network "$NETWORK" 2>/dev/null | tail -1)"
echo "[ok] wasm_hash=$WASM_HASH"

echo "[*] upgrade (in place; storage preserved)..."
stellar contract invoke --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- \
  upgrade --new_wasm_hash "$WASM_HASH" --operator "$ADMIN" >/dev/null
echo "[ok] upgraded"

echo "[*] pin teaser image_id ($TEASER_IMAGE_ID)..."
stellar contract invoke --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- \
  set_teaser_image_id --teaser_image_id "$TEASER_IMAGE_ID" >/dev/null

echo "[*] allowlist teaser appraiser attester ($TEASER_ATTESTER)..."
stellar contract invoke --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- \
  set_teaser_attester --attester "$TEASER_ATTESTER" --allowed true >/dev/null

echo "[*] verifying DR5 reads (storage-preserving upgrade)..."
echo -n "  get_teaser_image_id    = "; stellar contract invoke --send=no --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- get_teaser_image_id 2>/dev/null
echo -n "  teaser attester allowed= "; stellar contract invoke --send=no --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- is_teaser_attester_allowed --attester "$TEASER_ATTESTER" 2>/dev/null
echo -n "  get_config (preserved) = "; stellar contract invoke --send=no --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- get_config 2>/dev/null
echo -n "  room_count (preserved) = "; stellar contract invoke --send=no --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- get_room_count 2>/dev/null
echo "[done] DR5 upgrade complete. wasm_hash=$WASM_HASH"
