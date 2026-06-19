// Auditor selective-disclosure opener (Week 7, payroll Option B — in-guest ECIES).
//
// The payroll guest encrypts the SIGNED salary to the auditor's x25519 key and commits (eph_pub, ct, tag)
// in the PUBLIC journal/record. This is the AUDITOR side: given the disclosure + the auditor's VIEW KEY
// secret, decrypt the salary and verify the integrity tag. Pure + key-free at the SDK level — the caller
// supplies their own view key; the SDK NEVER custodies it. MUST agree with the guest byte-for-byte:
//   guest:    prover/methods/guest-payroll/src/main.rs
//   backend:  backend/src/disclosure.ts
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { fromHex, toHex } from "./journal.js";

const DOMAIN_KS = new TextEncoder().encode("zkorage-payroll-ecies-v1/ks");
const DOMAIN_TAG = new TextEncoder().encode("zkorage-payroll-ecies-v1/tag");
const PT_LEN = 40; // salary_be8 ‖ blinding32

function u64be(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, false);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function keystream(shared: Uint8Array, ephPub: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let produced = 0;
  let ctr = 0;
  while (produced < len) {
    const ctrb = new Uint8Array(4);
    new DataView(ctrb.buffer).setUint32(0, ctr, false);
    const block = sha256(concat(DOMAIN_KS, shared, ephPub, ctrb));
    const take = Math.min(32, len - produced);
    for (let i = 0; i < take; i++) out[produced + i] = block[i];
    produced += take;
    ctr++;
  }
  return out;
}

function disclosureTag(salary: bigint, blinding: Uint8Array): Uint8Array {
  return sha256(concat(DOMAIN_TAG, u64be(salary), blinding));
}

export interface OpenedDisclosure {
  /** The exact (previously private) salary, as a string. Only meaningful when `faithful` is true. */
  salary: string;
  /** True iff the recomputed tag matched — i.e. the correct view key AND the proof-bound signed salary. */
  faithful: boolean;
}

/**
 * AUDITOR OPENER: decrypt a payroll disclosure `(ephPub, ct)` with the auditor's view-key secret and
 * verify against the committed `tag`. All inputs are hex. `faithful` is true iff the decrypt is correct
 * (right key + untampered) — and, because the proof bound `(ct, tag)` to the attester-signed salary, a
 * faithful decrypt is mathematically certain to be that signed salary.
 */
export function openDisclosure(
  d: { ephPub: string; ct: string; tag: string },
  viewKeyHex: string,
): OpenedDisclosure {
  const ephPub = fromHex(d.ephPub);
  const ct = fromHex(d.ct);
  const tag = fromHex(d.tag);
  if (ct.length !== PT_LEN) throw new Error(`ct must be ${PT_LEN} bytes`);
  const viewSecret = fromHex(viewKeyHex);
  const shared = x25519.getSharedSecret(viewSecret, ephPub);
  const ks = keystream(shared, ephPub, PT_LEN);
  const pt = new Uint8Array(PT_LEN);
  for (let i = 0; i < PT_LEN; i++) pt[i] = ct[i] ^ ks[i];
  const salary = new DataView(pt.buffer, pt.byteOffset, pt.byteLength).getBigUint64(0, false);
  const blinding = pt.slice(8, 40);
  const recomputed = disclosureTag(salary, blinding);
  let faithful = recomputed.length === tag.length;
  for (let i = 0; i < tag.length && faithful; i++) if (recomputed[i] !== tag[i]) faithful = false;
  return { salary: salary.toString(), faithful };
}

/** Derive the auditor's x25519 public key from a view-key secret (hex) — for allowlist/targeting. */
export function auditorPublicKeyFromSecret(viewKeyHex: string): string {
  return toHex(x25519.getPublicKey(fromHex(viewKeyHex)));
}
