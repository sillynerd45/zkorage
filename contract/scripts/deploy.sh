#!/usr/bin/env bash
# Build + deploy the bare RISC Zero Groth16 verifier to Stellar testnet.
# Usage: contract/scripts/deploy.sh [identity-alias]
# Requires: stellar CLI 26.x, rust + wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # contract/
WASM="$HERE/target/wasm32v1-none/release/groth16_verifier.wasm"

echo "[*] ensuring wasm target..."
rustup target add wasm32v1-none >/dev/null 2>&1 || true

echo "[*] funding identity '$ALIAS' on $NETWORK (idempotent)..."
stellar keys generate "$ALIAS" --network "$NETWORK" --fund >/dev/null 2>&1 || \
  stellar keys fund "$ALIAS" --network "$NETWORK" >/dev/null 2>&1 || true

echo "[*] building verifier wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package groth16-verifier

echo "[*] deploying to $NETWORK..."
CID="$(stellar contract deploy --wasm "$WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-verifier 2>/dev/null | tail -1)"
echo "[ok] contract_id=$CID"
echo "$CID" > "$HERE/.contract_id.$NETWORK"
echo "[*] selector: $(stellar contract invoke --send=no --id "$CID" --source "$ALIAS" --network "$NETWORK" -- selector 2>/dev/null | tr -d '"')"
echo "[*] version : $(stellar contract invoke --send=no --id "$CID" --source "$ALIAS" --network "$NETWORK" -- version 2>/dev/null | tr -d '"')"
echo "[done] wrote $HERE/.contract_id.$NETWORK"
