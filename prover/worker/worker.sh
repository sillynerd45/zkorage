#!/usr/bin/env bash
# zkorage prover worker — outbound-only pull loop. Claims jobs from the VM gateway, proves on this
# machine's CPU, posts the bundle back. No inbound ports, no tunnel here. Routes by job `kind` to the
# matching CANONICAL host binary (each embeds the deterministic guest ELF, so the worker emits the same
# image_id the on-chain contracts pin — required, or proofs are rejected with ImageMismatch).
set -uo pipefail
: "${VM_URL:?set VM_URL (e.g. http://<vm-host>:8080)}"
TOKEN="${WORKER_TOKEN:-}"
HOST_BIN="${HOST_BIN:-/prover/target/release/host}"                       # reserves (PoR)
HOST_IDENTITY_BIN="${HOST_IDENTITY_BIN:-/prover/target/release/host_identity}"     # identity (KYC)
HOST_COMPLIANCE_BIN="${HOST_COMPLIANCE_BIN:-/prover/target/release/host_compliance}" # compliance
HOST_PAYROLL_BIN="${HOST_PAYROLL_BIN:-/prover/target/release/host_payroll}"           # payroll (W7)
HOST_ACCREDITED_BIN="${HOST_ACCREDITED_BIN:-/prover/target/release/host_accredited}"  # accredited (W8)
HOST_DATAROOM_SEAL_BIN="${HOST_DATAROOM_SEAL_BIN:-/prover/target/release/host_dataroom_seal}" # dataroom seal (DR1)
HOST_MEMBERSHIP_BIN="${HOST_MEMBERSHIP_BIN:-/prover/target/release/host_membership}"           # membership (DR2)
HOST_DOCAUTH_BIN="${HOST_DOCAUTH_BIN:-/prover/target/release/host_docauth}"                    # docauth (DR4)
POLL="${POLL_SECONDS:-3}"
AUTH=(); [ -n "$TOKEN" ] && AUTH=(-H "X-Worker-Token: $TOKEN")

echo "zkorage worker -> $VM_URL (poll ${POLL}s, kinds: reserves/identity/compliance/payroll/accredited/dataroom_seal/membership/docauth)"
while true; do
  RESP="$(curl -sf "${AUTH[@]}" "$VM_URL/jobs/next" || true)"
  JID="$(printf '%s' "$RESP" | jq -r '.job_id // empty' 2>/dev/null || true)"
  if [ -z "$JID" ]; then sleep "$POLL"; continue; fi
  KIND="$(printf '%s' "$RESP" | jq -r '.kind // "reserves"')"
  echo "[$(date -u +%H:%M:%S)] claimed $JID ($KIND)"

  # The trailing job lines differ by kind; the first three are common — EXCEPT dataroom_seal, which has
  # no attester envelope (commitment-only) and its own field set.
  COMMON=('.envelope_hex' '.signature_hex' '.issuer_pubkey_hex')
  case "$KIND" in
    payroll)       BIN="$HOST_PAYROLL_BIN";       FIELDS=("${COMMON[@]}" '.accessor_hex' '.auditor_pubkey_hex' '.threshold') ;;
    compliance)    BIN="$HOST_COMPLIANCE_BIN";    FIELDS=("${COMMON[@]}" '.accessor_hex' '.witness_hex') ;;
    identity)      BIN="$HOST_IDENTITY_BIN";      FIELDS=("${COMMON[@]}" '.accessor_hex') ;;
    accredited)    BIN="$HOST_ACCREDITED_BIN";    FIELDS=("${COMMON[@]}" '.accessor_hex') ;;
    dataroom_seal) BIN="$HOST_DATAROOM_SEAL_BIN"; FIELDS=('.doc_key_hex' '.recipient_pubkey_hex' '.content_hash_hex' '.room_id_hex' '.doc_id_hex') ;;
    membership)    BIN="$HOST_MEMBERSHIP_BIN";    FIELDS=('.sig_hex' '.pk_hex' '.accessor_hex' '.recipient_pubkey_hex' '.id_secret_hex' '.id_trapdoor_hex' '.room_id_hex' '.siblings_hex' '.leaf_index') ;;
    docauth)       BIN="$HOST_DOCAUTH_BIN";       FIELDS=('.n_hex' '.sig_hex' '.statement_hex' '.threshold' '.room_id_hex') ;;
    *)             BIN="$HOST_BIN";               FIELDS=("${COMMON[@]}" '.threshold') ;;
  esac
  # Build the job file, FAIL-CLOSED on any missing field: `jq -e` exits non-zero on null, so a field-list
  # drift (gateway REQUIRED vs run_host_local vs this worker getting out of sync) surfaces as a job ERROR
  # instead of silently feeding the host bin the literal string "null" -> a wrong-input proof.
  : > /tmp/zk.job
  JOB_OK=1
  for f in "${FIELDS[@]}"; do
    if V="$(printf '%s' "$RESP" | jq -er "$f" 2>/dev/null)"; then
      printf '%s\n' "$V" >> /tmp/zk.job
    else
      JOB_OK=0; break
    fi
  done
  if [ "$JOB_OK" != 1 ]; then
    curl -sf "${AUTH[@]}" -H 'content-type: application/json' \
      -X POST "$VM_URL/jobs/$JID/result" -d "{\"error\":\"worker: missing job field for kind $KIND\"}" >/dev/null
    echo "[$(date -u +%H:%M:%S)] BAD JOB $JID ($KIND): missing field"
    continue
  fi

  # Prove WITH RETRY: the host bin runs an off-chain receipt.verify self-check and exits non-zero on a bad
  # proof. On the WSL2 paravirtualized GPU (sm_120) ~6% of GPU proves fail that check (a transient MSM
  # glitch — fail-safe: a bad proof is NEVER emitted). Re-prove on failure. A genuinely-bad input (wrong
  # witness) fails every attempt and surfaces as a job error. On the CPU VM there is no flake -> first try.
  PROVE_ATTEMPTS="${PROVE_ATTEMPTS:-4}"
  PROVED=0
  for try in $(seq 1 "$PROVE_ATTEMPTS"); do
    if ZKORAGE_JOB=/tmp/zk.job ZKORAGE_OUT=/tmp/zk.out.json "$BIN" >/tmp/zk.log 2>&1; then PROVED=1; break; fi
    echo "[$(date -u +%H:%M:%S)] prove attempt $try/$PROVE_ATTEMPTS failed for $JID ($KIND); retrying"
  done
  if [ "$PROVED" = 1 ]; then
    BUNDLE="$(cat /tmp/zk.out.json)"
    curl -sf "${AUTH[@]}" -H 'content-type: application/json' \
      -X POST "$VM_URL/jobs/$JID/result" -d "{\"bundle\":$BUNDLE}" >/dev/null \
      && echo "[$(date -u +%H:%M:%S)] done $JID"
  else
    ERR="$(tail -3 /tmp/zk.log | tr '\n' ' ' | tr '"' "'" )"
    curl -sf "${AUTH[@]}" -H 'content-type: application/json' \
      -X POST "$VM_URL/jobs/$JID/result" -d "{\"error\":\"$ERR\"}" >/dev/null
    echo "[$(date -u +%H:%M:%S)] FAILED $JID after $PROVE_ATTEMPTS tries: $ERR"
  fi
done
