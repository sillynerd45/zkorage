// DR2 — build a membership (anonymous eligibility) prover job + cross-check the JS crypto against the
// guest/host byte-exact. Emits the gateway JSON for POST /prove {kind:"membership"}. Pure Node (no deps).
//
// Scheme (must match guest-membership/src/main.rs + host_membership.rs):
//   leaf = sha256(0x00 ‖ id_secret ‖ id_trapdoor)                       [LEAF_TAG]
//   node = sha256(0x01 ‖ left ‖ right)                                  [NODE_TAG]
//   nullifier = sha256(0x02 ‖ id_secret ‖ room_id)                      [NULLIFIER_TAG]
//   holder sig (ed25519, pk == accessor) over "zkorage-dataroom-access-v1" ‖ room_id ‖ accessor ‖ recipient_pub
//   demo eligible set = zero-subtree tree, member at index 0 (leaf_index 0), all other slots the empty leaf.
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const TREE_DEPTH = 20;
const LEAF_TAG = 0x00, NODE_TAG = 0x01, NULLIFIER_TAG = 0x02;
const SIG_DOMAIN = Buffer.from("zkorage-dataroom-access-v1");

const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const leafOf = (idSecret, idTrapdoor) => sha(Buffer.from([LEAF_TAG]), idSecret, idTrapdoor);
const nodeOf = (a, b) => sha(Buffer.from([NODE_TAG]), a, b);
const nullifierOf = (idSecret, roomId) => sha(Buffer.from([NULLIFIER_TAG]), idSecret, roomId);

// ed25519 from a raw 32-byte seed via PKCS8 wrapping (pure Node crypto; no external libs).
function ed25519FromSeed(seed) {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const pub = spki.subarray(spki.length - 32); // raw 32-byte ed25519 public key
  return { priv, pub };
}

/// Build the depth-20 zero-subtree witness for a member at index 0. Returns {siblings, root, leafIndex}.
function demoWitness(memberLeaf) {
  let z = leafOf(Buffer.alloc(32), Buffer.alloc(32)); // empty leaf = sha256(0x00 ‖ 0^32 ‖ 0^32)
  const siblings = [];
  let cur = memberLeaf;
  for (let i = 0; i < TREE_DEPTH; i++) {
    siblings.push(Buffer.from(z));
    cur = nodeOf(cur, z); // member is the left child (leaf_index 0)
    z = nodeOf(z, z);
  }
  return { siblings: Buffer.concat(siblings), root: cur, leafIndex: 0 };
}

export function buildMembershipJob({ idSecret, idTrapdoor, roomId, holderSeed, recipientPub }) {
  const { priv, pub: accessor } = ed25519FromSeed(holderSeed);
  const signed = Buffer.concat([SIG_DOMAIN, roomId, accessor, recipientPub]);
  const sig = edSign(null, signed, priv); // ed25519 over the domain-bound message
  const memberLeaf = leafOf(idSecret, idTrapdoor);
  const { siblings, root, leafIndex } = demoWitness(memberLeaf);
  const nf = nullifierOf(idSecret, roomId);
  const hx = (b) => Buffer.from(b).toString("hex");
  return {
    job: {
      kind: "membership",
      sig_hex: hx(sig), pk_hex: hx(accessor), accessor_hex: hx(accessor),
      recipient_pubkey_hex: hx(recipientPub), id_secret_hex: hx(idSecret),
      id_trapdoor_hex: hx(idTrapdoor), room_id_hex: hx(roomId),
      siblings_hex: hx(siblings), leaf_index: leafIndex,
    },
    eligible_root: hx(root), nullifier: hx(nf), accessor: hx(accessor),
  };
}

// CLI: print the gateway job JSON for the demo defaults (overridable via hex argv: idSecret idTrapdoor room holderSeed recipient).
// Robust main-module check (works on Windows + tsx, unlike a string-compare on import.meta.url — DR1 Ch3 gotcha).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const fill = (b, n) => { const x = Buffer.alloc(n); x.fill(b); return x; };
  const arg = (i, def) => (process.argv[i + 2] ? Buffer.from(process.argv[i + 2], "hex") : def);
  const out = buildMembershipJob({
    idSecret: arg(0, fill(0x11, 32)),
    idTrapdoor: arg(1, fill(0x22, 32)),
    roomId: arg(2, fill(0x01, 32)),
    holderSeed: arg(3, fill(0x03, 32)),
    recipientPub: arg(4, fill(0xad, 32)),
  });
  console.error(`[dr2] eligible_root = ${out.eligible_root}`);
  console.error(`[dr2] nullifier     = ${out.nullifier}`);
  console.error(`[dr2] accessor      = ${out.accessor}`);
  process.stdout.write(JSON.stringify(out.job));
}
