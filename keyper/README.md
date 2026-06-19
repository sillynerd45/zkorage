# zkorage DR3 — threshold-ECIES keyper committee

The **key-release layer** of the Confidential Data Room. A document's key `K` is Shamir-split (t=2 / n=3) and
one share handed to each keyper. A requester gets `K` **only after winning the on-chain DR2 anonymous-
eligibility grant** — and only via the threshold, so **no single server ever holds `K`**.

Each keyper is a tiny, independent service that:
- holds **one** Shamir share of each document's `K` (information-theoretically blind to `K` on its own);
- on `/share`, **independently reads the DR2 grant from its own Soroban RPC** (`is_granted` + `get_grant`),
  and only if the requester holds a live grant does it **ECIES-seal its share to the proof-bound
  `recipient_pub`** (read from chain, never from the request) and return it.

A non-granted caller gets nothing (403); a released share is decryptable only by the holder of the recipient
secret the eligibility proof bound; fewer than `t` keypers cannot reconstruct `K`.

## Crypto (byte-exact with the rest of the engine)
- **Shamir:** GF(2⁸) AES-field (0x11b), byte-wise, t=2/n=3 — canonical impl `backend/src/shamir.ts`.
- **Share-seal ECIES:** reuses the DR1 seal keystream byte-for-byte
  (`sha256("zkorage-dataroom-ecies-v1/ks" ‖ shared ‖ eph_pub ‖ 0x00000000)`, single block); the tag domain
  is DR3-specific (off-chain only): `tag = sha256("zkorage-dataroom-share-v1/tag" ‖ keyper_index(1) ‖
  share_y ‖ room_id ‖ doc_id ‖ recipient_pub)`. `src/share-ecies.ts` is pinned to the backend's frozen
  vector (`assertFrozenVector()`).

## HTTP API
- `GET /health` → `{ ok, keyper_index, rpc, contract, shares }`
- `POST /deal` (dealer-only, `Authorization: Bearer $DEAL_TOKEN`) `{ room_id, doc_id, keyper_index, share_y }`
  → stores this keyper's share. 401 without the token; 400 if `keyper_index` ≠ this keyper.
- `POST /share` (public) `{ room_id, doc_id, accessor }` → `{ keyper_index, eph_pub, ct, tag, recipient_pub }`
  iff `is_granted` is true; 403 if not granted; 404 if no share held; 400 on malformed hex.

## Run the 3-keyper committee (demo: 3 local processes)
```bash
cd keyper && npm install
# one process per committee member; same contract, its own RPC + share store + port
KEYPER_INDEX=1 KEYPER_PORT=8801 DEAL_TOKEN=dr3-demo-deal-token \
  DATAROOM_CONTRACT_ID=CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN \
  SHARE_STORE_PATH=./data/keyper-1.json npx tsx src/keyper.ts
# …repeat for KEYPER_INDEX=2 PORT=8802, KEYPER_INDEX=3 PORT=8803
```
Each keyper may run on a different machine / operator and point at its **own** `STELLAR_RPC_URL` — that is
the trust-clean property (no shared oracle hop). The demo runs three local processes.

## Self-test
```bash
npx tsx scripts/dr3-committee-selftest.ts   # drives the 3 live keypers against the real DataRoom contract
```

## Honest failure modes (documented, not hidden)
- **Keyper liveness:** with t=2/n=3, up to 1 keyper may be offline and the document still opens; if ≥ 2 are
  down, no release (mitigate in production with n > t margin across independent operators).
- **Trusted dealer at split:** the dealer (the upload service) briefly holds `K` before deleting it. A full
  DKG removes even that — the documented hardening path.
- **1 malicious keyper:** a corrupted share yields a wrong `K` → AES-GCM rejects; the recipient tries the
  other 2-of-3 pairs and the all-honest pair recovers `K` (the on-chain `sha256(K)` commitment selects it).
- **`/share` is a public oracle (by design):** it is unauthenticated and confirms grant-existence + the
  proof-bound `recipient_pub` for any `accessor` — but that is *already public on-chain* (`get_grant`), and a
  released share is decryptable only by the holder of the recipient secret. It reveals **no identity** (DR2
  anonymity holds). **Hardening (env-gated, both off by default so the local demo + selftest are unchanged):**
  `SHARE_RATE_PER_MIN` caps `/share` per IP (it triggers two RPC simulates per call → a spray costs the
  keyper's RPC quota) and `KEYPER_ALLOWED_ORIGINS` restricts browser CORS to a known origin allowlist
  (server-to-server calls have no `Origin`, so the backend aggregator is unaffected). `GET /health` echoes
  `share_rate_per_min` + `cors` so an operator can confirm they are on. The production committee on the VM
  sets both (see `deploy/README.md`).
- **`/deal` is fail-closed:** with no `DEAL_TOKEN` set, every `/deal` returns 503 (never silently
  unauthenticated). Use a distinct token per keyper in production (the demo shares one).
- **Partial deal is inert, not a leak:** if the dealer reaches only some keypers, it does **not** anchor the
  document, so `get_committee_document` returns null and a reader's opener short-circuits — any shares that
  did land are dead weight (< t reveal nothing about `K`). A retry with the same `(room, doc)` re-deals a
  fresh `K`, overwriting the orphans. The dealer logs the orphaned keyper indices for reconciliation.
