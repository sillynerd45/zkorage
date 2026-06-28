import { DiagramSvg, lifelineCols, Lifeline, SeqMsg, SeqBox, PhaseBand, type DiagramProps } from "./kit";

// The documentation flowcharts. Each is a sequence diagram (actor lifelines + numbered messages over time)
// because every one of these is a multi-party round-trip between your browser, the backend, the prover, the
// keepers, Cloudflare R2, and the chain. The deeper proof/contract detail still lives in the prose + the "Under
// the hood" expander. Every actor is private (dashed brand) or public (solid neutral); a returned value is a
// dashed arrow; a wallet-signed step carries a key glyph. See ./kit for the primitives.

// The 12 store steps, defined once so the screen-reader <ol> stays in sync with the diagram's 12 badges (the
// badge numerals are literals next to this array; keep the two aligned when editing).
export const STORE_STEPS = [
  "Your browser resolves the room's id from the room name.",
  "Your browser fetches the keeper committee and their three seal keys.",
  "You sign in your wallet to create the room; create_room writes you in as the owner on Soroban.",
  "You sign once more to derive your private room key (an off-chain signature, not a transaction).",
  "The dealer runs entirely in your browser: encrypt the file with AES-256-GCM, split the key two-of-three with Shamir, seal each share to a keeper, and seal an escrow copy of the key for you.",
  "Your browser sends the encrypted file, the three sealed shares, and the escrow copy to the backend.",
  "The backend stores the encrypted file in Cloudflare R2 and gets back a storage pointer.",
  "The backend fans the three sealed shares out to the three keepers, one each.",
  "The backend returns the content hash and the storage pointer to your browser.",
  "You sign in your wallet to anchor the document.",
  "put_committee_document writes the record on Soroban (content hash, key commitment, storage pointer, room id, doc id); no key and no contents go on-chain.",
  "Soroban returns the transaction hash, and the document is stored.",
];

// Storing a document: a sequence diagram. Encrypt + split the key locally, store the locked file off-chain via
// the backend, hand the sealed key shares to the keepers, anchor a short record on-chain. No zero-knowledge
// proof is used to store (the proof is at open time).
export function StoreDiagram({ idPrefix, decorative }: DiagramProps) {
  const x = lifelineCols(6);
  const [BROWSER, WALLET, BACKEND, R2, KEEPERS, SOROBAN] = x;
  const STORE_VB_H = 868;
  const bottomY = STORE_VB_H - 8;
  return (
    <DiagramSvg
      idPrefix={idPrefix}
      decorative={decorative}
      height={STORE_VB_H}
      minWidth={decorative ? undefined : 700}
      title="Storing a document"
      desc="A sequence diagram of storing a document across six actors: your browser, your wallet, the backend, Cloudflare R2, the three keepers, and the Soroban DataRoom contract. Your browser encrypts the file and splits its key locally, the backend stores the encrypted file off the chain and hands the sealed key shares to the keepers, and a short record is anchored on the public chain. Your wallet signs each on-chain write while the backend builds and submits the transaction. No key and no contents ever go on-chain, and no zero-knowledge proof is used to store."
    >
      {/* Phase bands first, behind the lifelines. */}
      <PhaseBand y={60} h={126} label="PREPARE" tint />
      <PhaseBand y={186} h={114} label="CREATE ROOM" tint={false} />
      <PhaseBand y={300} h={60} label="SIGN KEY" tint />
      <PhaseBand y={360} h={140} label="SEAL LOCALLY" tint={false} />
      <PhaseBand y={500} h={132} label="DISTRIBUTE" tint />
      <PhaseBand y={632} h={236} label="ANCHOR" tint={false} />

      {/* The six actor lifelines. Five are off-chain (dashed brand); Soroban is the public chain (solid neutral). */}
      <Lifeline x={BROWSER} kind="private" title="Browser" sub="you" bottomY={bottomY} />
      <Lifeline x={WALLET} kind="private" title="Wallet" sub="Freighter" bottomY={bottomY} />
      <Lifeline x={BACKEND} kind="private" title="Backend" sub="zkorage API" bottomY={bottomY} />
      <Lifeline x={R2} kind="private" title="Storage" sub="Cloudflare R2" bottomY={bottomY} />
      <Lifeline x={KEEPERS} kind="private" title="Keepers" sub="3 of them" bottomY={bottomY} />
      <Lifeline x={SOROBAN} kind="public" title="Soroban" sub="DataRoom" bottomY={bottomY} />

      {/* PREPARE */}
      <SeqMsg idPrefix={idPrefix} n={1} fromX={BROWSER} toX={BACKEND} y={102} label="resolve room id (GET)" />
      <SeqMsg idPrefix={idPrefix} fromX={BACKEND} toX={BROWSER} y={126} label="room id" variant="return" />
      <SeqMsg idPrefix={idPrefix} n={2} fromX={BROWSER} toX={BACKEND} y={154} label="committee + 3 seal keys (GET)" />
      <SeqMsg idPrefix={idPrefix} fromX={BACKEND} toX={BROWSER} y={178} label="keepers online" variant="return" />

      {/* CREATE ROOM (only when the room is new) */}
      <SeqMsg idPrefix={idPrefix} n={3} fromX={BROWSER} toX={WALLET} y={224} label="sign: create room" tone="brand" sign labelAlign="start" />
      <SeqMsg idPrefix={idPrefix} fromX={BROWSER} toX={SOROBAN} y={258} label="create_room, you become owner" tone="brand" />
      <SeqMsg idPrefix={idPrefix} fromX={SOROBAN} toX={BROWSER} y={282} label="owner set" variant="return" />

      {/* SIGN KEY */}
      <SeqMsg idPrefix={idPrefix} n={4} fromX={BROWSER} toX={WALLET} y={336} label="sign: derive room key (off-chain)" tone="brand" sign labelAlign="start" />

      {/* SEAL LOCALLY: the in-browser dealer */}
      <SeqBox
        n={5}
        x={66}
        y={384}
        w={392}
        h={104}
        kind="private"
        title="Seal locally, all in your browser"
        lines={[
          "Encrypt the file (AES-256-GCM)",
          "Split the key 2 of 3 (Shamir)",
          "Seal each share to a keeper",
          "Seal an escrow copy of the key for you",
        ]}
      />

      {/* DISTRIBUTE */}
      <SeqMsg idPrefix={idPrefix} n={6} fromX={BROWSER} toX={BACKEND} y={540} label="deal-sealed: ciphertext + 3 sealed shares + escrow" tone="brand" />
      <SeqMsg idPrefix={idPrefix} n={7} fromX={BACKEND} toX={R2} y={576} label="store the ciphertext" tone="brand" />
      <SeqMsg idPrefix={idPrefix} fromX={R2} toX={BACKEND} y={600} label="r2:// pointer" variant="return" />
      <SeqMsg idPrefix={idPrefix} n={8} fromX={BACKEND} toX={KEEPERS} y={624} label="fan out 3 sealed shares, one each" tone="brand" />

      {/* ANCHOR */}
      <SeqMsg idPrefix={idPrefix} n={9} fromX={BACKEND} toX={BROWSER} y={664} label="content hash + r2 pointer" variant="return" />
      <SeqMsg idPrefix={idPrefix} n={10} fromX={BROWSER} toX={WALLET} y={698} label="sign: anchor" tone="brand" sign labelAlign="start" />
      <SeqMsg idPrefix={idPrefix} n={11} fromX={BROWSER} toX={SOROBAN} y={730} label="put_committee_document" tone="brand" />
      <SeqBox
        x={512}
        y={744}
        w={280}
        h={86}
        kind="public"
        title="DataRoom records the entry"
        lines={[
          "content hash, key commitment",
          "r2 pointer, room id, doc id",
          "No key, no contents on-chain",
        ]}
        emphasizeLast
      />
      <SeqMsg idPrefix={idPrefix} n={12} fromX={SOROBAN} toX={BROWSER} y={850} label="transaction hash, done" variant="return" />
    </DiagramSvg>
  );
}

// ── Joining a room (Membership) ──────────────────────────────────────────────
export const JOIN_STEPS = [
  "In your browser, one wallet signature (a message, not a payment) derives your per-room membership ID, never your wallet address.",
  "You send the ID and an optional nickname to the backend, which holds your request as pending.",
  "Later, the room owner approves you, adding your ID to the room's approved list.",
  "The owner signs one transaction that pins a fingerprint of the approved list on-chain. The member list itself stays off-chain, and no proof is used yet.",
];

export function JoinApproveDiagram({ idPrefix, decorative }: DiagramProps) {
  const [YOU, BACKEND, OWNER, SOROBAN] = lifelineCols(4);
  const H = 472;
  const bottomY = H - 8;
  return (
    <DiagramSvg
      idPrefix={idPrefix}
      decorative={decorative}
      height={H}
      minWidth={decorative ? undefined : 640}
      title="Joining a room"
      desc="A sequence diagram of joining a Membership room across four actors: your browser, the backend, the room owner, and the Soroban contract. One wallet signature derives a per-room membership ID (never your wallet address), you send it to the backend as a pending request, and later the owner approves you and pins a fingerprint of the approved list on the public chain. The member list itself stays off-chain, and no proof is used here. The proof comes later, when you open a document."
    >
      <PhaseBand y={56} h={104} label="MAKE YOUR ID" tint />
      <PhaseBand y={160} h={104} label="ASK TO JOIN" tint={false} />
      <PhaseBand y={264} h={208} label="LATER: THE OWNER" tint />

      <Lifeline x={YOU} kind="private" title="Browser" sub="you" bottomY={bottomY} />
      <Lifeline x={BACKEND} kind="private" title="Backend" sub="zkorage API" bottomY={bottomY} />
      <Lifeline x={OWNER} kind="private" title="Owner" sub="another person" bottomY={bottomY} />
      <Lifeline x={SOROBAN} kind="public" title="Soroban" sub="DataRoom" bottomY={bottomY} />

      <SeqBox
        n={1}
        x={66}
        y={80}
        w={388}
        h={70}
        kind="private"
        title="Make your membership ID"
        lines={["Sign once in your wallet (a message, not a payment)", "It derives a per-room ID, not your wallet address"]}
      />

      <SeqMsg idPrefix={idPrefix} n={2} fromX={YOU} toX={BACKEND} y={196} label="request to join: your ID + an optional nickname" />
      <SeqMsg idPrefix={idPrefix} fromX={BACKEND} toX={YOU} y={234} label="pending" variant="return" />

      <SeqMsg idPrefix={idPrefix} n={3} fromX={OWNER} toX={BACKEND} y={300} label="approve you (add your ID to the list)" />
      <SeqMsg idPrefix={idPrefix} n={4} fromX={OWNER} toX={SOROBAN} y={338} label="sign: pin the approved list" tone="brand" sign />
      <SeqBox
        x={512}
        y={352}
        w={280}
        h={90}
        kind="public"
        title="What the chain stores"
        lines={["A fingerprint of the approved list", "The member list stays off-chain", "No proof yet"]}
        emphasizeLast
      />
    </DiagramSvg>
  );
}

// ── Opening a document (Membership) ──────────────────────────────────────────
export const OPEN_STEPS = [
  "In your browser, derive your identity from one cached wallet signature and make a one-time key for the keepers.",
  "Your browser checks you are on the approved list and the room has at least five members.",
  "Your browser sends a witness to the backend that proves you qualify without showing who you are.",
  "The backend relays the witness to the self-hosted prover, which builds the proof (this can take a few minutes).",
  "Your browser hands the finished proof to the batching relay.",
  "request_access records the grant on the public chain, shuffled in with others at a time window; a one-time pass blocks reuse.",
  "Your browser asks each of the three keepers for its key share.",
  "Each keeper independently checks on-chain that you are admitted.",
  "Two of the three keepers release a key share, each sealed to your one-time key.",
  "Your browser fetches the encrypted file from storage.",
  "Your browser combines two shares into the key, verifies the file, and decrypts it. The keepers never see the key.",
];

export function OpenDiagram({ idPrefix, decorative }: DiagramProps) {
  const [YOU, BACKEND, PROVER, KEEPERS, SOROBAN] = lifelineCols(5);
  const H = 808;
  const bottomY = H - 8;
  return (
    <DiagramSvg
      idPrefix={idPrefix}
      decorative={decorative}
      height={H}
      minWidth={decorative ? undefined : 700}
      title="Opening a document"
      desc="A sequence diagram of opening a document in a Membership room across five actors: your browser, the backend, the self-hosted prover, the three keepers, and the Soroban contract. Your browser proves you are on the approved list without revealing which member you are; the proof runs on the self-hosted prover and can take a few minutes; a grant is recorded on the public chain, shuffled at a time window; the keepers each check the grant and release a key share sealed to your one-time key; and your browser rebuilds the key from two of three shares, verifies the file, and decrypts it. The keepers and the server never see the key, and there is no wallet signature at open time beyond the one cached identity signature."
    >
      <PhaseBand y={56} h={146} label="PREPARE" tint />
      <PhaseBand y={202} h={140} label="PROVE" tint={false} />
      <PhaseBand y={342} h={150} label="GRANT" tint />
      <PhaseBand y={492} h={128} label="RELEASE" tint={false} />
      <PhaseBand y={620} h={188} label="OPEN" tint />

      <Lifeline x={YOU} kind="private" title="Browser" sub="you" bottomY={bottomY} />
      <Lifeline x={BACKEND} kind="private" title="Backend" sub="zkorage API" bottomY={bottomY} />
      <Lifeline x={PROVER} kind="private" title="Prover" sub="self-hosted" bottomY={bottomY} />
      <Lifeline x={KEEPERS} kind="private" title="Keepers" sub="3 of them" bottomY={bottomY} />
      <Lifeline x={SOROBAN} kind="public" title="Soroban" sub="DataRoom" bottomY={bottomY} />

      {/* PREPARE */}
      <SeqBox
        n={1}
        x={66}
        y={80}
        w={400}
        h={70}
        kind="private"
        title="Prepare in your browser"
        lines={["Derive your identity (one wallet signature, cached)", "Make a one-time key for the keepers"]}
      />
      <SeqMsg idPrefix={idPrefix} n={2} fromX={YOU} toX={BACKEND} y={172} label="are you approved? how big is the room?" />
      <SeqMsg idPrefix={idPrefix} fromX={BACKEND} toX={YOU} y={194} label="approved, at least 5 members" variant="return" />

      {/* PROVE */}
      <SeqMsg idPrefix={idPrefix} n={3} fromX={YOU} toX={BACKEND} y={232} label="prove access: a witness, hiding who you are" tone="brand" />
      <SeqMsg idPrefix={idPrefix} n={4} fromX={BACKEND} toX={PROVER} y={266} label="run the membership proof (self-hosted)" tone="brand" />
      <SeqMsg idPrefix={idPrefix} fromX={PROVER} toX={BACKEND} y={300} label="proof bundle (minutes, in the background)" variant="return" />
      <SeqMsg idPrefix={idPrefix} fromX={BACKEND} toX={YOU} y={324} label="proof ready" variant="return" />

      {/* GRANT */}
      <SeqMsg idPrefix={idPrefix} n={5} fromX={YOU} toX={BACKEND} y={368} label="hand the proof to the batching relay" />
      <SeqMsg idPrefix={idPrefix} n={6} fromX={BACKEND} toX={SOROBAN} y={402} label="request_access (shuffled at a time window)" tone="brand" />
      <SeqBox
        x={512}
        y={416}
        w={280}
        h={70}
        kind="public"
        title="Grant recorded"
        lines={["An anonymous accessor + your one-time key", "A one-time pass blocks reuse"]}
      />

      {/* RELEASE */}
      <SeqMsg idPrefix={idPrefix} n={7} fromX={YOU} toX={KEEPERS} y={520} label="ask each keeper for its key share" />
      <SeqMsg idPrefix={idPrefix} n={8} fromX={KEEPERS} toX={SOROBAN} y={554} label="each keeper checks you are admitted (live)" />
      <SeqMsg idPrefix={idPrefix} n={9} fromX={KEEPERS} toX={YOU} y={588} label="a sealed share each, 2 of 3" variant="return" />

      {/* OPEN */}
      <SeqMsg idPrefix={idPrefix} n={10} fromX={YOU} toX={BACKEND} y={648} label="fetch the encrypted file" />
      <SeqMsg idPrefix={idPrefix} fromX={BACKEND} toX={YOU} y={672} label="ciphertext (from Cloudflare R2)" variant="return" />
      <SeqBox
        n={11}
        x={66}
        y={690}
        w={400}
        h={88}
        kind="private"
        title="Open in your browser"
        lines={["Combine 2 of 3 shares into the key, and check it", "Verify the file, then AES-256-GCM decrypt", "The keepers never see the key"]}
        emphasizeLast
      />
    </DiagramSvg>
  );
}

// ── Creating a bond for access ───────────────────────────────────────────────
export const BOND_CREATE_STEPS = [
  "In your browser, pick a token, an amount, and an unlock time, and derive a private tag from a secret only you hold.",
  "Your browser asks the backend to build the lock transaction.",
  "You sign the lock in your wallet.",
  "Your browser submits the signed transaction.",
  "The escrow records the lock in public view (your wallet, token, amount, unlock time, and the private tag) and returns a lock id.",
];

export function BondCreateDiagram({ idPrefix, decorative }: DiagramProps) {
  const [YOU, WALLET, BACKEND, ESCROW] = lifelineCols(4);
  const H = 492;
  const bottomY = H - 8;
  return (
    <DiagramSvg
      idPrefix={idPrefix}
      decorative={decorative}
      height={H}
      minWidth={decorative ? undefined : 640}
      title="Creating a bond for access"
      desc="A sequence diagram of creating a bond across four actors: your browser, your wallet, the backend, and the Soroban escrow contract. You pick a token, amount, and unlock time and derive a private tag from a secret only you hold; the backend builds the lock transaction; you sign it in your wallet; and the escrow records the lock in full public view (your wallet, the token, the amount, the unlock time, and the private tag). The lock is public; only the tag is opaque. The tag lets you prove the bond is yours later without revealing which lock it is, and no proof is used to create the bond."
    >
      <PhaseBand y={56} h={114} label="SET THE TERMS" tint />
      <PhaseBand y={170} h={322} label="LOCK THE TOKENS" tint={false} />

      <Lifeline x={YOU} kind="private" title="Browser" sub="you" bottomY={bottomY} />
      <Lifeline x={WALLET} kind="private" title="Wallet" sub="Freighter" bottomY={bottomY} />
      <Lifeline x={BACKEND} kind="private" title="Backend" sub="zkorage API" bottomY={bottomY} />
      <Lifeline x={ESCROW} kind="public" title="Escrow" sub="Soroban" bottomY={bottomY} />

      <SeqBox
        n={1}
        x={66}
        y={80}
        w={400}
        h={70}
        kind="private"
        title="Set the terms in your browser"
        lines={["Pick a token, an amount, and an unlock time", "Derive a private tag from your secret (a hash)"]}
      />

      <SeqMsg idPrefix={idPrefix} n={2} fromX={YOU} toX={BACKEND} y={200} label="build the lock transaction" />
      <SeqMsg idPrefix={idPrefix} fromX={BACKEND} toX={YOU} y={224} label="unsigned transaction" variant="return" />
      <SeqMsg idPrefix={idPrefix} n={3} fromX={YOU} toX={WALLET} y={262} label="sign: lock the tokens" tone="brand" sign labelAlign="start" />
      <SeqMsg idPrefix={idPrefix} fromX={WALLET} toX={YOU} y={286} label="signed" variant="return" />
      <SeqMsg idPrefix={idPrefix} n={4} fromX={YOU} toX={BACKEND} y={320} label="submit the signed transaction" />
      <SeqMsg idPrefix={idPrefix} n={5} fromX={BACKEND} toX={ESCROW} y={354} label="deposit: token, amount, unlock, tag" tone="brand" />
      <SeqBox
        x={512}
        y={368}
        w={280}
        h={90}
        kind="public"
        title="The lock (public)"
        lines={["Your wallet, token, amount, unlock time", "The private tag, opaque to everyone", "The lock is public, only the tag is hidden"]}
        emphasizeLast
      />
      <SeqMsg idPrefix={idPrefix} fromX={ESCROW} toX={YOU} y={476} label="lock id" variant="return" />
    </DiagramSvg>
  );
}

// ── Opening a room with a bond ───────────────────────────────────────────────
export const BOND_ACCESS_STEPS = [
  "In your browser, load your reusable bond handle and derive your tag and a one-time key. One handle opens every room with the same requirement.",
  "Your browser checks you hold a qualifying bond and that at least three qualifying bonds exist.",
  "Your browser sends a witness that proves the bond is yours while hiding your wallet, your lock, and the amount.",
  "The backend relays the witness to the self-hosted prover, which builds the proof in the background.",
  "The proof is submitted and records a grant on the public chain under an anonymous handle; a one-time pass blocks reuse.",
  "Your browser asks each of the three keepers for its key share.",
  "Each keeper independently checks the bond grant on-chain.",
  "Two of the three keepers release a key share, each sealed to your one-time key.",
  "Your browser fetches the encrypted file from storage.",
  "Your browser combines two shares into the key, verifies the file, and decrypts it. The room opens with no owner approval.",
];

export function BondAccessDiagram({ idPrefix, decorative }: DiagramProps) {
  const [YOU, BACKEND, PROVER, KEEPERS, SOROBAN] = lifelineCols(5);
  const H = 780;
  const bottomY = H - 8;
  return (
    <DiagramSvg
      idPrefix={idPrefix}
      decorative={decorative}
      height={H}
      minWidth={decorative ? undefined : 700}
      title="Opening a room with a bond"
      desc="A sequence diagram of opening a bond-only room across five actors: your browser, the backend, the self-hosted prover, the three keepers, and the Soroban contracts. Your browser uses a reusable bond handle (no wallet signature) to prove you hold a qualifying bond while hiding your wallet, your lock, and the exact amount; the proof runs on the self-hosted prover in the background; a grant is recorded on the public chain under an anonymous handle; the keepers each check the grant and release a key share; and your browser rebuilds the key, verifies the file, and decrypts it. The room opens with no owner approval."
    >
      <PhaseBand y={56} h={150} label="CHECK" tint />
      <PhaseBand y={206} h={128} label="PROVE" tint={false} />
      <PhaseBand y={334} h={146} label="GRANT" tint />
      <PhaseBand y={480} h={120} label="RELEASE" tint={false} />
      <PhaseBand y={600} h={180} label="OPEN" tint />

      <Lifeline x={YOU} kind="private" title="Browser" sub="you" bottomY={bottomY} />
      <Lifeline x={BACKEND} kind="private" title="Backend" sub="zkorage API" bottomY={bottomY} />
      <Lifeline x={PROVER} kind="private" title="Prover" sub="self-hosted" bottomY={bottomY} />
      <Lifeline x={KEEPERS} kind="private" title="Keepers" sub="3 of them" bottomY={bottomY} />
      <Lifeline x={SOROBAN} kind="public" title="Soroban" sub="bond gate" bottomY={bottomY} />

      {/* CHECK */}
      <SeqBox
        n={1}
        x={66}
        y={80}
        w={414}
        h={88}
        kind="private"
        title="Check in your browser, no wallet"
        lines={["Load your reusable bond handle", "Derive your tag and a one-time key", "One handle opens every room with this requirement"]}
      />
      <SeqMsg idPrefix={idPrefix} n={2} fromX={YOU} toX={BACKEND} y={186} label="do I hold a qualifying bond?" />
      <SeqMsg idPrefix={idPrefix} fromX={BACKEND} toX={YOU} y={208} label="yes, at least 3 qualifying bonds" variant="return" />

      {/* PROVE */}
      <SeqMsg idPrefix={idPrefix} n={3} fromX={YOU} toX={BACKEND} y={246} label="prove the bond: hide wallet, lock, and amount" tone="brand" />
      <SeqMsg idPrefix={idPrefix} n={4} fromX={BACKEND} toX={PROVER} y={280} label="run the bond proof (self-hosted, background)" tone="brand" />
      <SeqMsg idPrefix={idPrefix} fromX={PROVER} toX={BACKEND} y={314} label="proof bundle" variant="return" />

      {/* GRANT */}
      <SeqMsg idPrefix={idPrefix} n={5} fromX={BACKEND} toX={SOROBAN} y={360} label="submit the bond proof" tone="brand" />
      <SeqBox
        x={512}
        y={374}
        w={280}
        h={90}
        kind="public"
        title="Grant under a handle"
        lines={["Your one-time key + the requirement", "A one-time pass blocks reuse", "No wallet, no lock id, no amount"]}
        emphasizeLast
      />

      {/* RELEASE */}
      <SeqMsg idPrefix={idPrefix} n={6} fromX={YOU} toX={KEEPERS} y={508} label="ask each keeper for its key share" />
      <SeqMsg idPrefix={idPrefix} n={7} fromX={KEEPERS} toX={SOROBAN} y={542} label="each keeper checks the bond grant (live)" />
      <SeqMsg idPrefix={idPrefix} n={8} fromX={KEEPERS} toX={YOU} y={576} label="a sealed share each, 2 of 3" variant="return" />

      {/* OPEN */}
      <SeqMsg idPrefix={idPrefix} n={9} fromX={YOU} toX={BACKEND} y={628} label="fetch the encrypted file" />
      <SeqMsg idPrefix={idPrefix} fromX={BACKEND} toX={YOU} y={652} label="ciphertext (from Cloudflare R2)" variant="return" />
      <SeqBox
        n={10}
        x={66}
        y={670}
        w={414}
        h={88}
        kind="private"
        title="Open in your browser"
        lines={["Combine 2 of 3 shares into the key", "Verify the file, then AES-256-GCM decrypt", "The room opens, with no owner approval"]}
        emphasizeLast
      />
    </DiagramSvg>
  );
}
