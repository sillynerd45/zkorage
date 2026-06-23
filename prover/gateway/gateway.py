#!/usr/bin/env python3
"""zkorage prover gateway — runs on the VM, behind the Cloudflare tunnel (prover.wazowsky.id).

Public  : POST /prove {kind?, envelope_hex, signature_hex, issuer_pubkey_hex, threshold|accessor_hex|witness_hex}
                       kind = "reserves" (default; needs threshold) | "identity" (needs accessor_hex) |
                              "compliance" (needs accessor_hex + witness_hex) | "payroll" (accessor +
                              auditor_pubkey + threshold) | "accredited" (W8; needs accessor_hex) |
                              "dataroom_seal" (DR1; doc_key + recipient_pubkey + content_hash + room_id + doc_id) |
                              "membership" (DR2; anonymous eligibility: holder sig + Merkle witness + nullifier) |
                              "docauth" (DR4; doc-authenticity/zkPDF: RSA-2048 signed-statement verify + value>=threshold) |
                              "solvency" (BP3; PoR predicate reserves>=supply BOUND to a bonded escrow lock) |
                              "tier" (BP5; anonymous bonded tier: member ∧ qualifying-lock Merkle membership + nullifier) |
                              "bond" (BA1; anonymous Bonded Access: tier generalized to a per-requirement token+min_amount+deadline)
                       -> {job_id}
          GET  /prove/<id> -> {status, by, bundle?, error?}
          GET  /health
Worker  : GET  /jobs/next -> {job_id, kind, ...inputs} | 204   (X-Worker-Token if WORKER_TOKEN set)
                             (ANY kind is offered — the worker runs all ELEVEN canonical host bins, so it
                              emits the pinned image_ids; it routes by `kind`. Worker-first, VM-fallback.)
          POST /jobs/<id>/result {bundle|error}
Fallback: if a job is not claimed by a worker within FALLBACK_SECS, prove on the VM's OWN CPU,
          so the service keeps working when the worker is offline. => always use the faster worker when
          available; otherwise the VM. (The worker MUST be canonical for every kind it is offered.)
"""
import json, os, re, subprocess, tempfile, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_HEX32 = re.compile(r"^[0-9a-fA-F]{64}$")  # a 32-byte value as 64 hex chars
_HEX64 = re.compile(r"^[0-9a-fA-F]{128}$")  # a 64-byte value (an ed25519 signature) as 128 hex chars
_HEX_SIBLINGS = re.compile(r"^[0-9a-fA-F]{1280}$")  # depth-20 Merkle path = 640 bytes as 1280 hex chars
_HEX256 = re.compile(r"^[0-9a-fA-F]{512}$")  # a 256-byte value (RSA-2048 modulus / signature) as 512 hex
_HEX_STATEMENT = re.compile(r"^[0-9a-fA-F]{176}$")  # the fixed 88-byte signed bank statement as 176 hex

PROVER_DIR = os.environ.get("PROVER_DIR", "/home/<user>/Project/Stellar/zkorage/prover")
HOST_BIN = os.environ.get("HOST_BIN", os.path.join(PROVER_DIR, "target/release/host"))
HOST_IDENTITY_BIN = os.environ.get("HOST_IDENTITY_BIN", os.path.join(PROVER_DIR, "target/release/host_identity"))
HOST_COMPLIANCE_BIN = os.environ.get("HOST_COMPLIANCE_BIN", os.path.join(PROVER_DIR, "target/release/host_compliance"))
HOST_PAYROLL_BIN = os.environ.get("HOST_PAYROLL_BIN", os.path.join(PROVER_DIR, "target/release/host_payroll"))
HOST_ACCREDITED_BIN = os.environ.get("HOST_ACCREDITED_BIN", os.path.join(PROVER_DIR, "target/release/host_accredited"))
HOST_DATAROOM_SEAL_BIN = os.environ.get("HOST_DATAROOM_SEAL_BIN", os.path.join(PROVER_DIR, "target/release/host_dataroom_seal"))
HOST_MEMBERSHIP_BIN = os.environ.get("HOST_MEMBERSHIP_BIN", os.path.join(PROVER_DIR, "target/release/host_membership"))
HOST_DOCAUTH_BIN = os.environ.get("HOST_DOCAUTH_BIN", os.path.join(PROVER_DIR, "target/release/host_docauth"))
HOST_SOLVENCY_BIN = os.environ.get("HOST_SOLVENCY_BIN", os.path.join(PROVER_DIR, "target/release/host_solvency"))
HOST_TIER_BIN = os.environ.get("HOST_TIER_BIN", os.path.join(PROVER_DIR, "target/release/host_tier"))
HOST_BOND_BIN = os.environ.get("HOST_BOND_BIN", os.path.join(PROVER_DIR, "target/release/host_bond"))
PORT = int(os.environ.get("PORT", "8080"))
FALLBACK_SECS = int(os.environ.get("FALLBACK_SECS", "30"))
CLAIM_TIMEOUT = int(os.environ.get("CLAIM_TIMEOUT", "1800"))  # worker claimed but never returned
WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "")
JOB_TTL = int(os.environ.get("JOB_TTL", "900"))  # purge a finished job this many seconds after it completes
# Witness hygiene: keep the per-proof job file (the PRIVATE witness, for a VM-CPU fallback prove) in RAM
# (tmpfs) when available, so the witness never lands on disk; fall back to the default temp dir otherwise.
_WORK_DIR = "/dev/shm" if os.path.isdir("/dev/shm") and os.access("/dev/shm", os.W_OK) else None
# Required input fields per claim kind. Reserves binds a supply threshold; identity binds a public
# accessor; compliance binds an accessor PLUS a sanctions non-membership witness.
REQUIRED = {
    "reserves": ["envelope_hex", "signature_hex", "issuer_pubkey_hex", "threshold"],
    "identity": ["envelope_hex", "signature_hex", "issuer_pubkey_hex", "accessor_hex"],
    "compliance": ["envelope_hex", "signature_hex", "issuer_pubkey_hex", "accessor_hex", "witness_hex"],
    # payroll (W7): binds an accessor + the auditor's x25519 disclosure target + a public income
    # threshold. The host generates the ephemeral ECIES randomness itself (not through the gateway).
    "payroll": ["envelope_hex", "signature_hex", "issuer_pubkey_hex", "accessor_hex", "auditor_pubkey_hex", "threshold"],
    # accredited (W8): same shape as identity — binds a public accessor. The signature is over the
    # domain-separated message DOMAIN ‖ envelope (the backend attester applies the NEW-2 prefix).
    "accredited": ["envelope_hex", "signature_hex", "issuer_pubkey_hex", "accessor_hex"],
    # dataroom_seal (DR1): NO attester — commitment-only. Seals the PRIVATE document key to a recipient's
    # x25519 key in-guest, bound to content_hash/room_id/doc_id. The host generates the ECIES ephemeral
    # secret itself. (The prover is self-hosted/trusted and already sees plaintext per the project rule.)
    "dataroom_seal": ["doc_key_hex", "recipient_pubkey_hex", "content_hash_hex", "room_id_hex", "doc_id_hex"],
    # membership (DR2): anonymous eligibility. NEW-5 holder sig (pk == accessor) + a depth-20 sha256-Merkle
    # membership witness + per-room nullifier. id_secret/id_trapdoor are PRIVATE witness — they reach the
    # self-hosted prover (which already sees plaintext per the project rule); anonymity is vs the on-chain
    # verifier + the public, not vs the trusted prover. leaf_index is the (private) low-leaf position.
    "membership": ["sig_hex", "pk_hex", "accessor_hex", "recipient_pubkey_hex", "id_secret_hex",
                   "id_trapdoor_hex", "room_id_hex", "siblings_hex", "leaf_index"],
    # docauth (DR4): document-authenticity / zkPDF in-engine. Verifies a REAL third-party RSA-2048 PKCS#1
    # v1.5 (SHA-256) signature over an 88-byte signed statement IN-GUEST + value >= threshold, bound to a
    # room. statement_hex is the PRIVATE signed blob — it reaches the self-hosted prover (which already sees
    # plaintext per the project rule); confidentiality is vs the on-chain verifier + public, not the prover.
    "docauth": ["n_hex", "sig_hex", "statement_hex", "threshold", "room_id_hex"],
    # solvency (BP3): a Proof-of-Reserves predicate (reserves>=supply, reserves PRIVATE) BOUND to a bonded
    # escrow lock. Same first four fields as reserves (the reserve attestation, signed by the bonded reserve
    # auditor over DOMAIN ‖ envelope), plus the five public escrow-binding values the solvency gate enforces
    # on-chain (escrow id, lock_id, min_amount, bond token id, supply token id). threshold = the supply.
    "solvency": ["envelope_hex", "signature_hex", "issuer_pubkey_hex", "threshold",
                 "escrow_hex", "lock_id", "min_amount", "bond_token_hex", "supply_token_hex"],
    # tier (BP5): anonymous bonded tier. NEW-5 holder sig (pk == accessor) + a depth-20 sha256-Merkle
    # ENROLLED-member witness AND a second depth-20 QUALIFYING-lock witness (over c = sha256(0x03 ‖ id_secret
    # ‖ "escrow"), the commitment the depositor stored in the escrow lock) + per-context nullifier.
    # id_secret/id_trapdoor/both leaf indices are PRIVATE — they reach the self-hosted prover (which already
    # sees plaintext per the project rule); anonymity is vs the on-chain verifier + the public, not the prover.
    "tier": ["sig_hex", "pk_hex", "accessor_hex", "id_secret_hex", "id_trapdoor_hex", "context_hex",
             "threshold", "unlock_after", "member_siblings_hex", "member_leaf_index",
             "qual_siblings_hex", "qual_leaf_index"],
    # bond (BA1): anonymous Bonded Access — the generalized per-requirement successor to tier. Same dual
    # depth-20 Merkle (enrolled member ∧ qualifying lock) + NEW-5 holder sig, but binds the requirement
    # (token + min_amount i128 + deadline) so each room/doc requires its OWN bond. context == req_id =
    # sha256(token ‖ min_amount ‖ deadline) (the gate enforces it). id_secret/id_trapdoor/both leaf indices
    # are PRIVATE — they reach the self-hosted prover (which already sees plaintext per the project rule);
    # anonymity is vs the on-chain verifier + the public, not the prover.
    "bond": ["sig_hex", "pk_hex", "accessor_hex", "id_secret_hex", "id_trapdoor_hex", "context_hex",
             "token_hex", "min_amount", "deadline", "member_siblings_hex", "member_leaf_index",
             "qual_siblings_hex", "qual_leaf_index"],
}

jobs = {}            # id -> dict
lock = threading.Lock()


def run_host_local(inputs, kind):
    """VM-CPU fallback: write the job file and run the matching host bin in job mode. Line count differs
    by kind (reserves/identity/accredited = 4 lines; compliance = 5; payroll = 6; dataroom_seal = 5;
    membership = 9 incl. the holder sig + Merkle witness; docauth = 5: n/sig/statement/threshold/room_id;
    solvency = 9; tier = 12: holder sig + TWO Merkle witnesses [member + qualifying] + context/threshold/X;
    bond = 13: like tier but token_hex + min_amount(i128) + deadline instead of threshold/unlock_after)."""
    if kind == "payroll":
        bin_path = HOST_PAYROLL_BIN
        lines = [inputs["envelope_hex"], inputs["signature_hex"], inputs["issuer_pubkey_hex"],
                 inputs["accessor_hex"], inputs["auditor_pubkey_hex"], str(int(inputs["threshold"]))]
    elif kind == "compliance":
        bin_path = HOST_COMPLIANCE_BIN
        lines = [inputs["envelope_hex"], inputs["signature_hex"], inputs["issuer_pubkey_hex"],
                 inputs["accessor_hex"], inputs["witness_hex"]]
    elif kind == "identity":
        bin_path = HOST_IDENTITY_BIN
        lines = [inputs["envelope_hex"], inputs["signature_hex"], inputs["issuer_pubkey_hex"],
                 inputs["accessor_hex"]]
    elif kind == "accredited":
        bin_path = HOST_ACCREDITED_BIN
        lines = [inputs["envelope_hex"], inputs["signature_hex"], inputs["issuer_pubkey_hex"],
                 inputs["accessor_hex"]]
    elif kind == "dataroom_seal":
        bin_path = HOST_DATAROOM_SEAL_BIN
        lines = [inputs["doc_key_hex"], inputs["recipient_pubkey_hex"], inputs["content_hash_hex"],
                 inputs["room_id_hex"], inputs["doc_id_hex"]]
    elif kind == "membership":
        bin_path = HOST_MEMBERSHIP_BIN
        lines = [inputs["sig_hex"], inputs["pk_hex"], inputs["accessor_hex"], inputs["recipient_pubkey_hex"],
                 inputs["id_secret_hex"], inputs["id_trapdoor_hex"], inputs["room_id_hex"],
                 inputs["siblings_hex"], str(int(inputs["leaf_index"]))]
    elif kind == "docauth":
        bin_path = HOST_DOCAUTH_BIN
        lines = [inputs["n_hex"], inputs["sig_hex"], inputs["statement_hex"],
                 str(int(inputs["threshold"])), inputs["room_id_hex"]]
    elif kind == "solvency":
        bin_path = HOST_SOLVENCY_BIN
        lines = [inputs["envelope_hex"], inputs["signature_hex"], inputs["issuer_pubkey_hex"],
                 str(int(inputs["threshold"])), inputs["escrow_hex"], str(int(inputs["lock_id"])),
                 str(int(inputs["min_amount"])), inputs["bond_token_hex"], inputs["supply_token_hex"]]
    elif kind == "tier":
        bin_path = HOST_TIER_BIN
        lines = [inputs["sig_hex"], inputs["pk_hex"], inputs["accessor_hex"], inputs["id_secret_hex"],
                 inputs["id_trapdoor_hex"], inputs["context_hex"], str(int(inputs["threshold"])),
                 str(int(inputs["unlock_after"])), inputs["member_siblings_hex"],
                 str(int(inputs["member_leaf_index"])), inputs["qual_siblings_hex"],
                 str(int(inputs["qual_leaf_index"]))]
    elif kind == "bond":
        bin_path = HOST_BOND_BIN
        lines = [inputs["sig_hex"], inputs["pk_hex"], inputs["accessor_hex"], inputs["id_secret_hex"],
                 inputs["id_trapdoor_hex"], inputs["context_hex"], inputs["token_hex"],
                 str(int(inputs["min_amount"])), str(int(inputs["deadline"])), inputs["member_siblings_hex"],
                 str(int(inputs["member_leaf_index"])), inputs["qual_siblings_hex"],
                 str(int(inputs["qual_leaf_index"]))]
    else:
        bin_path = HOST_BIN
        lines = [inputs["envelope_hex"], inputs["signature_hex"], inputs["issuer_pubkey_hex"],
                 str(int(inputs["threshold"]))]
    jf = tempfile.NamedTemporaryFile("w", suffix=".job", delete=False, dir=_WORK_DIR)
    jf.write("\n".join(lines) + "\n")
    jf.close()
    out = jf.name + ".out.json"
    env = dict(os.environ)
    env["PATH"] = os.path.expanduser("~/.cargo/bin") + ":" + env.get("PATH", "")
    env["ZKORAGE_JOB"] = jf.name
    env["ZKORAGE_OUT"] = out
    try:
        subprocess.run([bin_path], cwd=PROVER_DIR, env=env, check=True, timeout=3600,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(out) as f:
            return json.load(f)
    finally:
        for p in (jf.name, out):
            try: os.unlink(p)
            except OSError: pass


def fallback_loop():
    while True:
        time.sleep(5)
        # Purge finished jobs JOB_TTL seconds after they complete (the witness was already scrubbed on
        # completion); bounds memory and removes the residual result + status.
        now = time.time()
        with lock:
            for jid in [k for k, j in jobs.items()
                        if j["status"] in ("done", "error") and j.get("done_at") and now - j["done_at"] > JOB_TTL]:
                del jobs[jid]
        cand = None
        with lock:
            for j in sorted(jobs.values(), key=lambda x: x["created"]):
                age_q = time.time() - j["created"]
                stale_claim = j["status"] == "claimed" and j["claimed"] and time.time() - j["claimed"] > CLAIM_TIMEOUT
                if (j["status"] == "queued" and age_q > FALLBACK_SECS) or stale_claim:
                    j["status"] = "proving_local"; j["by"] = "vm-cpu-fallback"; cand = j; break
        if cand:
            try:
                b = run_host_local(cand["inputs"], cand.get("kind", "reserves"))
                # Scrub the witness the moment the proof is done: a finished job keeps only its public result.
                with lock: cand["status"] = "done"; cand["bundle"] = b; cand["inputs"] = None; cand["done_at"] = time.time()
            except Exception as e:  # noqa
                with lock: cand["status"] = "error"; cand["error"] = str(e); cand["inputs"] = None; cand["done_at"] = time.time()


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        return not WORKER_TOKEN or self.headers.get("X-Worker-Token") == WORKER_TOKEN

    def do_GET(self):
        if self.path == "/health":
            with lock:
                stats = {s: sum(1 for j in jobs.values() if j["status"] == s)
                         for s in ("queued", "claimed", "proving_local", "done", "error")}
            return self._send(200, {"ok": True, "jobs": stats})
        if self.path == "/jobs/next":
            if not self._auth_ok():
                return self._send(401, {"error": "bad worker token"})
            with lock:
                for j in sorted(jobs.values(), key=lambda x: x["created"]):
                    # Offer ANY queued job to the worker — it runs all eleven CANONICAL host bins and
                    # routes by `kind`, so it emits the pinned image_ids. If no worker claims within
                    # FALLBACK_SECS the VM proves it locally (worker-first, VM-fallback).
                    if j["status"] == "queued":
                        j["status"] = "claimed"; j["claimed"] = time.time(); j["by"] = "worker"
                        return self._send(200, {"job_id": j["id"], "kind": j.get("kind", "reserves"), **j["inputs"]})
            return self._send(204, {})
        if self.path.startswith("/prove/"):
            jid = self.path.split("/", 2)[2]
            with lock:
                j = jobs.get(jid)
                if not j:
                    return self._send(404, {"error": "unknown job"})
                return self._send(200, {"status": j["status"], "by": j.get("by"),
                                        "bundle": j.get("bundle"), "error": j.get("error")})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "bad json"})
        if self.path == "/prove":
            kind = data.get("kind", "reserves")
            req = REQUIRED.get(kind)
            if req is None:
                return self._send(400, {"error": "unknown kind", "kinds": list(REQUIRED)})
            if not all(k in data for k in req):
                return self._send(400, {"error": "missing fields", "kind": kind, "required": req})
            inputs = {k: data[k] for k in req}
            # Validate + normalize the threshold (reserves/payroll) to a canonical u64 decimal string, so
            # the worker path (jq -r, verbatim) and the VM fallback (str(int)) receive identical input and
            # a crafted/non-numeric value is rejected here at the PUBLIC endpoint rather than panicking the
            # host or (worse) being mis-parsed downstream.
            if "threshold" in inputs:
                try:
                    t = int(str(inputs["threshold"]).strip())
                except (ValueError, TypeError):
                    return self._send(400, {"error": "threshold must be an integer", "kind": kind})
                if t < 0 or t > 0xFFFFFFFFFFFFFFFF:
                    return self._send(400, {"error": "threshold out of u64 range", "kind": kind})
                inputs["threshold"] = str(t)
            # dataroom_seal: every field is a 32-byte value. Validate 64-hex at the PUBLIC boundary so a
            # malformed direct request is rejected here rather than panicking the host bin downstream
            # (mirrors the threshold-validation discipline above). The backend always sends well-formed hex.
            if kind == "dataroom_seal":
                for f in ("doc_key_hex", "recipient_pubkey_hex", "content_hash_hex", "room_id_hex", "doc_id_hex"):
                    if not _HEX32.match(str(inputs.get(f, ""))):
                        return self._send(400, {"error": f"{f} must be 32-byte hex (64 hex chars)", "kind": kind})
            # membership (DR2): validate the witness shapes at the PUBLIC boundary so a malformed direct
            # request is rejected here rather than panicking the host bin downstream. sig = 64 bytes;
            # the seven keyed fields = 32 bytes each; siblings = depth-20 path (640 bytes); leaf_index a u32.
            if kind == "membership":
                for f in ("pk_hex", "accessor_hex", "recipient_pubkey_hex", "id_secret_hex",
                          "id_trapdoor_hex", "room_id_hex"):
                    if not _HEX32.match(str(inputs.get(f, ""))):
                        return self._send(400, {"error": f"{f} must be 32-byte hex (64 hex chars)", "kind": kind})
                if not _HEX64.match(str(inputs.get("sig_hex", ""))):
                    return self._send(400, {"error": "sig_hex must be 64-byte hex (128 hex chars)", "kind": kind})
                if not _HEX_SIBLINGS.match(str(inputs.get("siblings_hex", ""))):
                    return self._send(400, {"error": "siblings_hex must be depth-20 (1280 hex chars)", "kind": kind})
                try:
                    li = int(str(inputs["leaf_index"]).strip())
                except (ValueError, TypeError):
                    return self._send(400, {"error": "leaf_index must be an integer", "kind": kind})
                # Bound to the depth-20 tree capacity (NOT just the u32 range): only the low 20 bits drive the
                # guest's path direction, so reject anything >= 2^20 at the public boundary to forbid the
                # high-bit aliasing the in-guest fold would otherwise ignore (audit M-1).
                if li < 0 or li >= (1 << 20):
                    return self._send(400, {"error": "leaf_index out of range (must be < 2^20, the depth-20 tree capacity)", "kind": kind})
                inputs["leaf_index"] = str(li)
            # docauth (DR4): validate the RSA-2048 widths at the PUBLIC boundary so a malformed direct
            # request is rejected here rather than panicking the host bin downstream. n/sig = 256 bytes
            # (512 hex); statement = the fixed 88 bytes (176 hex); room_id = 32 bytes. threshold is already
            # validated + normalized by the shared threshold block above.
            if kind == "docauth":
                for f in ("n_hex", "sig_hex"):
                    if not _HEX256.match(str(inputs.get(f, ""))):
                        return self._send(400, {"error": f"{f} must be 256-byte hex (512 hex chars)", "kind": kind})
                if not _HEX_STATEMENT.match(str(inputs.get("statement_hex", ""))):
                    return self._send(400, {"error": "statement_hex must be 88-byte hex (176 hex chars)", "kind": kind})
                if not _HEX32.match(str(inputs.get("room_id_hex", ""))):
                    return self._send(400, {"error": "room_id_hex must be 32-byte hex (64 hex chars)", "kind": kind})
            # solvency (BP3): validate the escrow-binding shapes at the PUBLIC boundary. escrow/bond_token/
            # supply_token = 32-byte contract ids (64 hex); lock_id/min_amount are u64 (threshold already
            # validated + normalized by the shared block above). The backend always sends well-formed values.
            if kind == "solvency":
                for f in ("escrow_hex", "bond_token_hex", "supply_token_hex"):
                    if not _HEX32.match(str(inputs.get(f, ""))):
                        return self._send(400, {"error": f"{f} must be 32-byte hex (64 hex chars)", "kind": kind})
                for f in ("lock_id", "min_amount"):
                    try:
                        v = int(str(inputs[f]).strip())
                    except (ValueError, TypeError):
                        return self._send(400, {"error": f"{f} must be an integer", "kind": kind})
                    if v < 0 or v > 0xFFFFFFFFFFFFFFFF:
                        return self._send(400, {"error": f"{f} out of u64 range", "kind": kind})
                    inputs[f] = str(v)
            # tier (BP5): validate the witness shapes at the PUBLIC boundary so a malformed direct request is
            # rejected here rather than panicking the host bin downstream. sig = 64 bytes; the four keyed
            # 32-byte fields; member_siblings + qual_siblings = depth-20 paths (640 bytes); the two leaf
            # indices < 2^20 (depth-20 tree capacity; only the low 20 bits drive the fold); unlock_after a u64.
            # threshold is already validated + normalized by the shared threshold block above.
            if kind == "tier":
                for f in ("pk_hex", "accessor_hex", "id_secret_hex", "id_trapdoor_hex", "context_hex"):
                    if not _HEX32.match(str(inputs.get(f, ""))):
                        return self._send(400, {"error": f"{f} must be 32-byte hex (64 hex chars)", "kind": kind})
                if not _HEX64.match(str(inputs.get("sig_hex", ""))):
                    return self._send(400, {"error": "sig_hex must be 64-byte hex (128 hex chars)", "kind": kind})
                for f in ("member_siblings_hex", "qual_siblings_hex"):
                    if not _HEX_SIBLINGS.match(str(inputs.get(f, ""))):
                        return self._send(400, {"error": f"{f} must be depth-20 (1280 hex chars)", "kind": kind})
                try:
                    ua = int(str(inputs["unlock_after"]).strip())
                except (ValueError, TypeError):
                    return self._send(400, {"error": "unlock_after must be an integer", "kind": kind})
                if ua < 0 or ua > 0xFFFFFFFFFFFFFFFF:
                    return self._send(400, {"error": "unlock_after out of u64 range", "kind": kind})
                inputs["unlock_after"] = str(ua)
                for f in ("member_leaf_index", "qual_leaf_index"):
                    try:
                        li = int(str(inputs[f]).strip())
                    except (ValueError, TypeError):
                        return self._send(400, {"error": f"{f} must be an integer", "kind": kind})
                    if li < 0 or li >= (1 << 20):
                        return self._send(400, {"error": f"{f} out of range (must be < 2^20, the depth-20 tree capacity)", "kind": kind})
                    inputs[f] = str(li)
            # bond (BA1): validate the witness shapes at the PUBLIC boundary. sig = 64 bytes; the five keyed
            # 32-byte fields (incl. token_hex + context_hex); member_siblings + qual_siblings = depth-20 paths
            # (640 bytes); the two leaf indices < 2^20; deadline a u64; min_amount a POSITIVE i128 (the gate
            # rejects <= 0). The backend always sends well-formed values.
            if kind == "bond":
                for f in ("pk_hex", "accessor_hex", "id_secret_hex", "id_trapdoor_hex", "context_hex", "token_hex"):
                    if not _HEX32.match(str(inputs.get(f, ""))):
                        return self._send(400, {"error": f"{f} must be 32-byte hex (64 hex chars)", "kind": kind})
                if not _HEX64.match(str(inputs.get("sig_hex", ""))):
                    return self._send(400, {"error": "sig_hex must be 64-byte hex (128 hex chars)", "kind": kind})
                for f in ("member_siblings_hex", "qual_siblings_hex"):
                    if not _HEX_SIBLINGS.match(str(inputs.get(f, ""))):
                        return self._send(400, {"error": f"{f} must be depth-20 (1280 hex chars)", "kind": kind})
                try:
                    dl = int(str(inputs["deadline"]).strip())
                except (ValueError, TypeError):
                    return self._send(400, {"error": "deadline must be an integer", "kind": kind})
                if dl < 0 or dl > 0xFFFFFFFFFFFFFFFF:
                    return self._send(400, {"error": "deadline out of u64 range", "kind": kind})
                inputs["deadline"] = str(dl)
                try:
                    ma = int(str(inputs["min_amount"]).strip())
                except (ValueError, TypeError):
                    return self._send(400, {"error": "min_amount must be an integer", "kind": kind})
                # i128 range; the gate also rejects <= 0, so a non-positive floor is never a valid bond.
                if ma <= 0 or ma >= (1 << 127):
                    return self._send(400, {"error": "min_amount must be a positive i128", "kind": kind})
                inputs["min_amount"] = str(ma)
                for f in ("member_leaf_index", "qual_leaf_index"):
                    try:
                        li = int(str(inputs[f]).strip())
                    except (ValueError, TypeError):
                        return self._send(400, {"error": f"{f} must be an integer", "kind": kind})
                    if li < 0 or li >= (1 << 20):
                        return self._send(400, {"error": f"{f} out of range (must be < 2^20, the depth-20 tree capacity)", "kind": kind})
                    inputs[f] = str(li)
            jid = uuid.uuid4().hex[:12]
            with lock:
                jobs[jid] = {"id": jid, "kind": kind, "inputs": inputs,
                             "status": "queued", "created": time.time(), "claimed": None,
                             "bundle": None, "error": None, "by": None}
            return self._send(200, {"job_id": jid})
        if self.path.startswith("/jobs/") and self.path.endswith("/result"):
            if not self._auth_ok():
                return self._send(401, {"error": "bad worker token"})
            jid = self.path.split("/")[2]
            with lock:
                j = jobs.get(jid)
                if not j:
                    return self._send(404, {"error": "unknown job"})
                if data.get("bundle"):
                    j["bundle"] = data["bundle"]; j["status"] = "done"
                else:
                    j["status"] = "error"; j["error"] = data.get("error", "worker error")
                # Scrub the witness once the proof is finished; keep only the public result + status.
                j["inputs"] = None; j["done_at"] = time.time()
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    threading.Thread(target=fallback_loop, daemon=True).start()
    print(f"zkorage gateway :{PORT} | fallback {FALLBACK_SECS}s | host {HOST_BIN} | "
          f"token {'on' if WORKER_TOKEN else 'off'}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
