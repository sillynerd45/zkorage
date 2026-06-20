#!/usr/bin/env bash
# Build + deploy the zkorage Bonded-Proofs escrow (BP1) to testnet, plus a fresh clawback-disabled
# "zkUSD" bond-token instance (a second copy of the demo SEP-41 token, kept separate from the PoR
# supply token so the two demos don't share state). Then run an on-chain acceptance smoke test:
# deposit -> is_locked -> unbond -> is_locked, asserting the funds round-trip.
#
# Usage: contract/scripts/deploy_escrow.sh [identity-alias]
# Requires: stellar CLI 26.x, wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
DECIMALS=7
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # contract/
ESCROW_WASM="$HERE/target/wasm32v1-none/release/escrow.wasm"
TOKEN_WASM="$HERE/target/wasm32v1-none/release/token.wasm"
ZERO32="0000000000000000000000000000000000000000000000000000000000000000"

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] deployer = $ADMIN  network = $NETWORK"

echo "[*] building escrow + token wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package escrow >/dev/null
stellar contract build --manifest-path "$HERE/Cargo.toml" --package token  >/dev/null

# ---- 1. fresh bond token (zkUSD), decoupled from the PoR supply token ----
echo "[*] deploying fresh bond token (zkUSD)..."
TOKEN_ID="$(stellar contract deploy --wasm "$TOKEN_WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-bond-token 2>/dev/null | tail -1)"
echo "$TOKEN_ID" > "$HERE/.bond_token_id.$NETWORK"
echo "[ok] bond_token_id=$TOKEN_ID"
stellar contract invoke --id "$TOKEN_ID" --source "$ALIAS" --network "$NETWORK" -- \
  initialize --admin "$ADMIN" --decimals "$DECIMALS" --name "zkorage Bond USD" --symbol "zkUSD" >/dev/null
# mint 1,000 zkUSD to the deployer for the smoke test
stellar contract invoke --id "$TOKEN_ID" --source "$ALIAS" --network "$NETWORK" -- \
  mint --to "$ADMIN" --amount 10000000000 >/dev/null
echo "[ok] minted 1000 zkUSD to deployer"

# ---- 2. escrow (no constructor; first lock is id 1) ----
echo "[*] deploying escrow..."
ESCROW_ID="$(stellar contract deploy --wasm "$ESCROW_WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-escrow 2>/dev/null | tail -1)"
echo "$ESCROW_ID" > "$HERE/.escrow_id.$NETWORK"
echo "[ok] escrow_id=$ESCROW_ID"

# ---- 3. on-chain acceptance smoke test ----
UNLOCK=$(( $(date +%s) + 3600 ))   # locked 1h out; revocable so we can unbond early
echo "[*] acceptance: deposit 100 zkUSD revocable, unlock_time=$UNLOCK ..."
LOCK_ID="$(stellar contract invoke --id "$ESCROW_ID" --source "$ALIAS" --network "$NETWORK" -- \
  deposit --from "$ADMIN" --token "$TOKEN_ID" --amount 1000000000 --unlock_time "$UNLOCK" \
  --claimant "$ADMIN" --commitment "$ZERO32" --revocable true 2>/dev/null | tr -d '"')"
echo "[ok] lock_id=$LOCK_ID"

LOCKED="$(stellar contract invoke --send=no --id "$ESCROW_ID" --source "$ALIAS" --network "$NETWORK" -- is_locked --lock_id "$LOCK_ID" 2>/dev/null | tr -d '"')"
ESC_BAL="$(stellar contract invoke --send=no --id "$TOKEN_ID" --source "$ALIAS" --network "$NETWORK" -- balance --id "$ESCROW_ID" 2>/dev/null | tr -d '"')"
echo "[check] is_locked=$LOCKED (expect true)   escrow_balance=$ESC_BAL (expect 1000000000)"
[ "$LOCKED" = "true" ] || { echo "[FAIL] expected is_locked=true"; exit 1; }
[ "$ESC_BAL" = "1000000000" ] || { echo "[FAIL] expected escrow to hold the deposit"; exit 1; }

echo "[*] acceptance: unbond (early revocable exit)..."
stellar contract invoke --id "$ESCROW_ID" --source "$ALIAS" --network "$NETWORK" -- unbond --lock_id "$LOCK_ID" >/dev/null
LOCKED2="$(stellar contract invoke --send=no --id "$ESCROW_ID" --source "$ALIAS" --network "$NETWORK" -- is_locked --lock_id "$LOCK_ID" 2>/dev/null | tr -d '"')"
ESC_BAL2="$(stellar contract invoke --send=no --id "$TOKEN_ID" --source "$ALIAS" --network "$NETWORK" -- balance --id "$ESCROW_ID" 2>/dev/null | tr -d '"')"
echo "[check] is_locked=$LOCKED2 (expect false)  escrow_balance=$ESC_BAL2 (expect 0)"
[ "$LOCKED2" = "false" ] || { echo "[FAIL] expected is_locked=false after unbond"; exit 1; }
[ "$ESC_BAL2" = "0" ] || { echo "[FAIL] expected escrow drained after unbond"; exit 1; }

echo "[done] escrow_id=$ESCROW_ID  bond_token_id=$TOKEN_ID"
echo "[done] acceptance PASSED: deposit -> is_locked=true -> unbond -> is_locked=false, funds round-tripped"
