#!/usr/bin/env bash
# Verify a proof bundle on-chain and report the cost (CPU instructions + fee).
# Usage: contract/scripts/measure.sh <contract_id> <proof_file>
#   proof_file = 3 lines: seal_hex / image_id_hex / journal_digest_hex
#   (defaults to the bundled fixture in contract/proof_fixture.txt)
# Git Bash / POSIX only.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK="${NETWORK:-testnet}"
ALIAS="${ALIAS:-zkorage-deployer}"
CID="${1:-$(cat "$HERE/.contract_id.$NETWORK" 2>/dev/null || echo "")}"
PROOF="${2:-$HERE/proof_fixture.txt}"

[ -z "$CID" ] && { echo "usage: measure.sh <contract_id> [proof_file]"; exit 1; }
SEAL="$(sed -n '1p' "$PROOF")"; IMG="$(sed -n '2p' "$PROOF")"; JD="$(sed -n '3p' "$PROOF")"

echo "[*] verify() on $CID ($NETWORK) — simulate with cost"
stellar contract invoke --send=no --cost \
  --id "$CID" --source "$ALIAS" --network "$NETWORK" \
  -- verify --seal "$SEAL" --image_id "$IMG" --journal "$JD" \
  2>&1 | grep -vE "no longer read|config migrate"
