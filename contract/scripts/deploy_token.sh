#!/usr/bin/env bash
# Build + deploy the zkorage demo SEP-41 supply-tracking token (zUSD) to testnet, initialize it,
# and mint an initial circulating supply. The PoR policy binds to this token's total_supply().
# Usage: contract/scripts/deploy_token.sh [identity-alias] [whole-tokens]
# Requires: stellar CLI 26.x, wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
WHOLE="${2:-1000000}"          # initial supply in whole tokens (7 dp applied below)
NETWORK="${NETWORK:-testnet}"
DECIMALS=7
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # contract/
WASM="$HERE/target/wasm32v1-none/release/token.wasm"

# 10^7 base units per whole token.
AMOUNT="${WHOLE}0000000"

echo "[*] building token wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package token >/dev/null

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] admin = $ADMIN"

echo "[*] deploying token to $NETWORK..."
CID="$(stellar contract deploy --wasm "$WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-token 2>/dev/null | tail -1)"
echo "[ok] token_id=$CID"
echo "$CID" > "$HERE/.token_id.$NETWORK"

echo "[*] initialize(decimals=$DECIMALS, name='zkorage USD', symbol='zUSD')..."
stellar contract invoke --id "$CID" --source "$ALIAS" --network "$NETWORK" -- \
  initialize --admin "$ADMIN" --decimals "$DECIMALS" --name "zkorage USD" --symbol "zUSD" >/dev/null

echo "[*] mint $WHOLE zUSD ($AMOUNT base units) to admin..."
stellar contract invoke --id "$CID" --source "$ALIAS" --network "$NETWORK" -- \
  mint --to "$ADMIN" --amount "$AMOUNT" >/dev/null

SUPPLY="$(stellar contract invoke --send=no --id "$CID" --source "$ALIAS" --network "$NETWORK" -- total_supply 2>/dev/null)"
echo "[ok] total_supply = $SUPPLY (base units)"
echo "[done] token_id=$CID -> $HERE/.token_id.$NETWORK"
