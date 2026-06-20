#!/usr/bin/env bash
# Build + deploy the zkorage solvency-gate (BP3) to testnet and initialize it against the live BP1 escrow,
# the W2 zUSD supply token, and the BP1 zkUSD bond token. The gate verifies the bonded-solvency Groth16
# proof (image d0a2f137...), binds the proven supply to zUSD.total_supply(), and reads the escrow lock
# LIVE so the grant self-voids on unbond.
#
# Usage: contract/scripts/deploy_solvency_gate.sh [identity-alias]
# Requires: stellar CLI 26.x, wasm32v1-none target. Git Bash / POSIX only.
set -euo pipefail

ALIAS="${1:-zkorage-deployer}"
NETWORK="${NETWORK:-testnet}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # contract/
GATE_WASM="$HERE/target/wasm32v1-none/release/solvency_gate.wasm"

# ---- pinned config (testnet) ----
VERIFIER="CBAPC663PTWIWDLYNCG5WAD5MIZF4SKY43U6L2NM5ZUU5XFOS4JDYAFW"            # bare Groth16 verifier (risc0 5)
ESCROW="CAMQKJKAJTOMT66N5N3E3VIRTN5ACDKV6P3Z2HLYVJHLAVRGJKHZFOXC"             # BP1 escrow
ESCROW_ID="190525404cdcc9fbcdeb764dd5119b7a010d55f3f79d1d78aa4eb056264a8f92" # = StrKey.decodeContract(ESCROW)
SUPPLY_TOKEN="CC3JKNC4EKALMT7WALUMCTVBSH73ZZSP3AC4B7IQUAZ7UYYZCEIISQLA"      # W2 zUSD (supply-tracking)
SUPPLY_TOKEN_ID="b695345c2280b64ff602e8c14ea191ffbce64fd805c0fd10a033fa6319111089"
BOND_TOKEN="CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5"        # BP1 zkUSD bond token
BOND_TOKEN_ID="8a78e40ff9b140b53c8b7ed0e57d34bf0de8bc122e39da73419f820ed144b53a"
IMAGE_ID="d0a2f137812e05084aa79d0f7353d3fb7785da25facadd140494b94bed10e267"  # solvency guest (risc0 5)
CLAIM_TYPE=12
# bonded reserve auditor pubkey (mock; ed25519 seed [19;32]) — the only allow-listed reserve attester
AUDITOR="66cd608b928b88e50e0efeaa33faf1c43cefe07294b0b87e9fe0aba6a3cf7633"

ADMIN="$(stellar keys address "$ALIAS")"
echo "[*] deployer/admin = $ADMIN  network = $NETWORK"

echo "[*] building solvency-gate wasm..."
stellar contract build --manifest-path "$HERE/Cargo.toml" --package solvency-gate >/dev/null
ls -la "$GATE_WASM" | awk '{print "[ok] wasm bytes:", $5}'

echo "[*] deploying solvency-gate..."
GATE_ID="$(stellar contract deploy --wasm "$GATE_WASM" --source "$ALIAS" --network "$NETWORK" --alias zkorage-solvency-gate 2>/dev/null | tail -1)"
echo "$GATE_ID" > "$HERE/.solvency_gate_id.$NETWORK"
echo "[ok] solvency_gate_id=$GATE_ID"

echo "[*] initializing..."
stellar contract invoke --id "$GATE_ID" --source "$ALIAS" --network "$NETWORK" -- initialize \
  --admin "$ADMIN" \
  --verifier "$VERIFIER" \
  --escrow "$ESCROW" \
  --escrow_id "$ESCROW_ID" \
  --supply_token "$SUPPLY_TOKEN" \
  --supply_token_id "$SUPPLY_TOKEN_ID" \
  --bond_token "$BOND_TOKEN" \
  --bond_token_id "$BOND_TOKEN_ID" \
  --image_id "$IMAGE_ID" \
  --claim_type "$CLAIM_TYPE" \
  --issuers "[\"$AUDITOR\"]" >/dev/null
echo "[ok] initialized"

echo "[*] read-back get_config + is_issuer_allowed:"
stellar contract invoke --send=no --id "$GATE_ID" --source "$ALIAS" --network "$NETWORK" -- get_config 2>/dev/null
ALLOWED="$(stellar contract invoke --send=no --id "$GATE_ID" --source "$ALIAS" --network "$NETWORK" -- is_issuer_allowed --issuer_id "$AUDITOR" 2>/dev/null | tr -d '"')"
echo "[check] is_issuer_allowed(auditor)=$ALLOWED (expect true)"
[ "$ALLOWED" = "true" ] || { echo "[FAIL] auditor not allow-listed"; exit 1; }

echo "[done] solvency_gate_id=$GATE_ID"
