#!/usr/bin/env bash
# BA1/BA3 — in-place upgrade of the live DataRoom contract (storage preserved): adds the anonymous Bonded
# Access leg. New keys BondReq(room) / BondReqDoc(room,doc) + a BondRequirement struct + the setters/getters
# + the 3-arg bond-gate cross-call in is_doc_admitted / is_admitted. Same native update_current_contract_wasm
# mechanism as DR2-DR6. No image/attester to pin here (owners set per-room bond requirements after the
# upgrade). Git Bash / POSIX only.
# Usage: contract/scripts/upgrade_dataroom_bond.sh [identity-alias]
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # contract/
WASM="$HERE/target/wasm32v1-none/release/dataroom.wasm"
DATAROOM="${DATAROOM_ID:-CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN}"

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] dataroom=$DATAROOM  admin=$ADMIN"

echo "[*] building dataroom wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package dataroom >/dev/null
ls -la "$WASM" | awk '{print "[ok] wasm bytes:", $5}'

echo "[*] uploading wasm..."
WASM_HASH="$(stellar contract upload --wasm "$WASM" --source "$ALIAS" --network "$NETWORK" 2>/dev/null | tail -1)"
echo "[ok] wasm_hash=$WASM_HASH"

echo "[*] upgrade (in place; storage preserved)..."
stellar contract invoke --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- \
  upgrade --new_wasm_hash "$WASM_HASH" --operator "$ADMIN" >/dev/null
echo "[ok] upgraded"

echo "[*] verifying preserved storage + the NEW Bonded Access reads:"
echo -n "  get_config (preserved)      = "; stellar contract invoke --send=no --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- get_config 2>/dev/null
echo -n "  room_count (preserved)      = "; stellar contract invoke --send=no --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- get_room_count 2>/dev/null
echo -n "  get_bond_requirement(demo)  = "; stellar contract invoke --send=no --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- get_bond_requirement --room_id db16742c52d5f7c0e1f6b3d8c9a07e5f4b2138e09c6d5a4f3e2b1c0d9e8f7a6b5 2>/dev/null || echo "(none / read ok)"
echo "[done] DataRoom Bonded Access upgrade complete. wasm_hash=$WASM_HASH"
