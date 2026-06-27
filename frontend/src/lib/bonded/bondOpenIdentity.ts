// Reusable Bonded Access identity for opening TRUE bond-only Data Room rooms.
//
// A bond-only room recognises "your bond" by the commitment stored in the escrow lock:
//   commitment = sha256(0x03 ‖ id_secret ‖ "escrow")
// The standalone Bonded Access page (Bonded Proofs) already mints ONE per-wallet handle whose id_secret (and
// therefore that commitment) is the SAME regardless of requirement. By opening bond-only rooms with that SAME
// handle, a single locked bond opens EVERY room sharing the requirement, plus the standalone page — no
// per-room re-lock. The previous flow derived a fresh per-room identity, so a bond never carried over.
//
// The handle was built for the standalone bond proof (claim_type 14), which needs no encryption key. A room
// open additionally needs an x25519 recipient keypair (the DR3 keepers seal the document key to it), so we
// derive one DETERMINISTICALLY from the handle's id_secret here. It is stable for the handle (re-deriving on
// another session/device reproduces it) and works for handles minted before this change, since it depends only
// on id_secret, which never changes.
//
// TRADEOFF (intentional): the handle's accessor is one stable pseudonym per wallet for bonded access, shared
// across rooms and the standalone page, so the keeper committee / backend could correlate a wallet's accesses
// across rooms (they could not when each room had its own pseudonym). On-chain still shows only one grant per
// requirement, the wallet is never revealed, and anonymity WITHIN the qualifying-bonder crowd (the >= 3 floor)
// is unchanged.
import {
  recipientPublicKeyFromSecret,
  idCommitment,
  nullifierFor,
  fromHex,
  toHex,
  type DataRoomIdentity,
} from "zkorage-sdk";
import { enrollBond, getBondHandleVault, putBondHandleVault, type BondIdentity } from "@/lib/api";
import { loadIdentityAt, idKey } from "./handle";
import { deriveBondHandleVaultId, decryptBondHandle, encryptBondHandle } from "./handleVault";

const RECIPIENT_DOMAIN = "zkorage-bond-open-recipient-v1";

/** Deterministically derive the handle's x25519 recipient keypair from its id_secret. Domain-separated so it
 *  can never collide with the commitment / nullifier derivations that also take id_secret. */
async function bondOpenRecipient(idSecretHex: string): Promise<{ recipientSecret: string; recipientPub: string }> {
  const idSecret = fromHex(idSecretHex);
  const domain = new TextEncoder().encode(RECIPIENT_DOMAIN);
  const input = new Uint8Array(domain.length + idSecret.length);
  input.set(domain, 0);
  input.set(idSecret, domain.length);
  const ab = new ArrayBuffer(input.length);
  new Uint8Array(ab).set(input);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ab));
  const recipientSecret = toHex(digest);
  return { recipientSecret, recipientPub: recipientPublicKeyFromSecret(recipientSecret) };
}

/** Shape the wallet handle + derived recipient into a DataRoomIdentity the bond-only open flow can use. The
 *  membership-only fields (idCommitment / nullifier) are computed for completeness but are NOT read on the
 *  bond-only path (it has no membership leg). `roomId` records which room this instance is opening. */
async function handleToRoomIdentity(handle: BondIdentity, roomIdHex: string): Promise<DataRoomIdentity> {
  const { recipientSecret, recipientPub } = await bondOpenRecipient(handle.idSecret);
  return {
    roomId: roomIdHex,
    idSecret: handle.idSecret,
    idTrapdoor: handle.idTrapdoor,
    accessorSeed: handle.holderSeed,
    recipientSecret,
    accessor: handle.accessor,
    recipientPub,
    idCommitment: toHex(idCommitment(fromHex(handle.idSecret), fromHex(handle.idTrapdoor))),
    nullifier: toHex(nullifierFor(fromHex(handle.idSecret), fromHex(roomIdHex))),
  };
}

/**
 * Resolve the wallet's reusable Bonded Access identity for opening `roomIdHex`:
 *   1. load the handle from this browser (no prompt — the common case), else
 *   2. restore it from the wallet vault (needs the bond-handle signature, so an existing bond on another
 *      device / from the standalone page is reused, not duplicated), else
 *   3. mint a fresh handle and back it up to the vault (best-effort).
 * Then derive the deterministic recipient keypair. `getSig` returns the cached bond-handle signature (it only
 * actually prompts when there is no local handle).
 */
export async function getBondOpenIdentity(
  address: string,
  getSig: () => Promise<Uint8Array>,
  roomIdHex: string,
): Promise<DataRoomIdentity> {
  if (!address) throw new Error("Connect your wallet to set up bonded access.");
  let handle = loadIdentityAt(address);
  if (!handle) {
    // No handle in this browser. The wallet may already have one in the vault (locked via the standalone page
    // or another device), so we MUST check before minting: forking a new identity here would strand the
    // existing bond and re-ask the user to lock. The signature is needed to read + decrypt the vault. If the
    // user declines, surface it rather than silently minting a divergent identity.
    let sig: Uint8Array;
    try {
      sig = await getSig();
    } catch {
      throw new Error(
        "Sign with your wallet to load your Bonded Access. This carries over a bond you already locked, instead of asking you to lock again.",
      );
    }
    const vaultId = await deriveBondHandleVaultId(sig);
    const res = await getBondHandleVault(vaultId);
    if (res.blob) {
      handle = await decryptBondHandle(sig, res.blob);
    } else {
      // The wallet genuinely has no saved handle -> mint a fresh one and back it up, reusing this signature so
      // there is no second prompt.
      const r = await enrollBond();
      if (!r.minted) throw new Error("could not create a Bonded Access handle");
      handle = r.minted;
      try {
        await putBondHandleVault(vaultId, await encryptBondHandle(sig, handle));
      } catch {
        /* keep the local copy; the standalone page can back it up later */
      }
    }
  }
  try {
    localStorage.setItem(idKey(address), JSON.stringify(handle));
  } catch {
    /* private mode / quota -> the in-memory handle still works for this session */
  }
  return handleToRoomIdentity(handle, roomIdHex);
}
