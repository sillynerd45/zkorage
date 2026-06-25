#!/usr/bin/env bash
# Room Management / TRUE bond-only — in-place upgrades (storage preserved):
#   1. bond-gate: adds submit_bond_open_proof (claim_type 15) + the bond-open grant/recipient reads, then
#      pins the canonical bond-open guest image via set_open_image_id.
#   2. DataRoom: adds the BondOpen(room) flag + set_bond_open_requirement + the no-approval bond leg +
#      admission_recipient_pub (the unified keeper key read).
# Same native update_current_contract_wasm mechanism as DR2-DR6 / BA3. Git Bash / POSIX only.
# Usage: contract/scripts/upgrade_bondonly.sh [identity-alias]
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # contract/
BOND_WASM="$HERE/target/wasm32v1-none/release/bond_gate.wasm"
DR_WASM="$HERE/target/wasm32v1-none/release/dataroom.wasm"
BOND_GATE="${BOND_GATE_ID:-CCKX6B7QIE42YA27Y4KTB6CTXRB3OBGR5EW7N2BLAG4AB3V6CFDKXCZU}"
DATAROOM="${DATAROOM_ID:-CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN}"
BOND_OPEN_IMAGE="${BOND_OPEN_IMAGE_ID:-a035500d61ee7be7164c23e44c7a5df87a3b38d1e6bb931d7612ccf81de58b78}"

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] admin=$ADMIN  bond_gate=$BOND_GATE  dataroom=$DATAROOM"
echo "[*] bond_open_image=$BOND_OPEN_IMAGE"

echo "[*] building wasm (bond-gate + dataroom)..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package bond-gate >/dev/null
stellar contract build --manifest-path "$HERE/Cargo.toml" --package dataroom >/dev/null
ls -la "$BOND_WASM" "$DR_WASM" | awk '{print "[ok]", $9, $5, "bytes"}'

# ── 1. bond-gate upgrade + pin the bond-open image ──
echo "[*] uploading bond-gate wasm..."
BOND_HASH="$(stellar contract upload --wasm "$BOND_WASM" --source "$ALIAS" --network "$NETWORK" 2>/dev/null | tail -1)"
echo "[ok] bond_gate wasm_hash=$BOND_HASH"
echo "[*] bond-gate upgrade (in place)..."
stellar contract invoke --id "$BOND_GATE" --source "$ALIAS" --network "$NETWORK" -- \
  upgrade --new_wasm_hash "$BOND_HASH" --operator "$ADMIN" >/dev/null
echo "[ok] bond-gate upgraded"
echo "[*] set_open_image_id..."
stellar contract invoke --id "$BOND_GATE" --source "$ALIAS" --network "$NETWORK" -- \
  set_open_image_id --image_id "$BOND_OPEN_IMAGE" >/dev/null
echo -n "  get_open_image_id = "; stellar contract invoke --send=no --id "$BOND_GATE" --source "$ALIAS" --network "$NETWORK" -- get_open_image_id 2>/dev/null
echo -n "  get_open_count    = "; stellar contract invoke --send=no --id "$BOND_GATE" --source "$ALIAS" --network "$NETWORK" -- get_open_count 2>/dev/null

# ── 2. DataRoom upgrade ──
echo "[*] uploading dataroom wasm..."
DR_HASH="$(stellar contract upload --wasm "$DR_WASM" --source "$ALIAS" --network "$NETWORK" 2>/dev/null | tail -1)"
echo "[ok] dataroom wasm_hash=$DR_HASH"
echo "[*] dataroom upgrade (in place; storage preserved)..."
stellar contract invoke --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- \
  upgrade --new_wasm_hash "$DR_HASH" --operator "$ADMIN" >/dev/null
echo "[ok] dataroom upgraded"
echo -n "  room_count (preserved)  = "; stellar contract invoke --send=no --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- get_room_count 2>/dev/null
echo -n "  is_bond_open(demo room) = "; stellar contract invoke --send=no --id "$DATAROOM" --source "$ALIAS" --network "$NETWORK" -- is_bond_open --room_id 46745e986e85e583e76eb57217419021e3e3e23835c9b27bb562a596b7b34209 2>/dev/null || echo "(read ok)"

echo "[done] bond_gate wasm_hash=$BOND_HASH | dataroom wasm_hash=$DR_HASH"
