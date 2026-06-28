import {
  DiagramSvg,
  Node,
  Edge,
  colsLeft,
  lifelineCols,
  Lifeline,
  SeqMsg,
  SeqBox,
  PhaseBand,
  type DiagramProps,
} from "./kit";

// The documentation flowcharts. The store flow is a full sequence diagram (six actor lifelines + numbered
// messages) because storing is genuinely a multi-party round-trip between your browser, the backend, Cloudflare
// R2, the keepers, and the chain. The other four flows stay single left-to-right rows (the branch detail lives
// in the prose + the "Under the hood" expander). Every actor/node is private (dashed brand) or public (solid
// neutral); a returned value is a dashed arrow; a wallet-signed step carries a key glyph. See ./kit.

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

// Joining a room: send an ID (no wallet address), the owner approves, a list fingerprint goes public.
export function JoinApproveDiagram({ idPrefix, decorative }: DiagramProps) {
  const c = colsLeft(3);
  return (
    <DiagramSvg
      idPrefix={idPrefix}
      decorative={decorative}
      title="Joining a room"
      desc="You send only a membership ID and an optional nickname, never your wallet address. The owner approves you, and a fingerprint of the approved list is written to the public chain. No proof is used here. The proof comes later, when you open a document."
    >
      <Node left={c[0]} kind="private" title={["Send a", "membership ID"]} sub="no wallet address" />
      <Node left={c[1]} kind="public" title={["Owner", "approves you"]} sub="signs a transaction" />
      <Node left={c[2]} kind="public" title={["Approved-list", "fingerprint"]} sub="on the chain" />
      <Edge idPrefix={idPrefix} from={c[0]} to={c[1]} />
      <Edge idPrefix={idPrefix} from={c[1]} to={c[2]} />
    </DiagramSvg>
  );
}

// Opening a document: prove you qualify, the grant lands on-chain, keepers release the key, the file opens.
export function OpenDiagram({ idPrefix, decorative }: DiagramProps) {
  const c = colsLeft(4);
  return (
    <DiagramSvg
      idPrefix={idPrefix}
      decorative={decorative}
      title="Opening a document"
      desc="You make a proof that you qualify, which shows nothing else about you. The grant is recorded on the public chain. The three keepers each release their key share to you, and the file decrypts in your browser."
    >
      <Node left={c[0]} kind="private" title={["You prove", "you qualify"]} sub="nothing else shown" />
      <Node left={c[1]} kind="public" title={["Access", "granted"]} sub="on the chain" />
      <Node left={c[2]} kind="private" title={["Keepers", "release the key"]} sub="2 of 3" />
      <Node left={c[3]} kind="private" title={["The file", "opens"]} sub="only for you" />
      <Edge idPrefix={idPrefix} from={c[0]} to={c[1]} />
      <Edge idPrefix={idPrefix} from={c[1]} to={c[2]} />
      <Edge idPrefix={idPrefix} from={c[2]} to={c[3]} />
    </DiagramSvg>
  );
}

// Creating a bond for access: pick the terms, lock the tokens in public, the lock carries a private tag.
export function BondCreateDiagram({ idPrefix, decorative }: DiagramProps) {
  const c = colsLeft(3);
  return (
    <DiagramSvg
      idPrefix={idPrefix}
      decorative={decorative}
      title="Creating a bond for access"
      desc="You choose a token, an amount, and an unlock time, then lock the tokens in the escrow. The lock is public: the chain shows your wallet, the token, the amount, and the unlock time. The lock also carries a private tag that lets you prove the bond is yours later, without revealing which lock it is."
    >
      <Node left={c[0]} kind="private" title={["Pick token,", "amount, time"]} sub="your choice" />
      <Node left={c[1]} kind="public" title={["Lock the", "tokens"]} sub="public on the chain" />
      <Node left={c[2]} kind="private" title={["A private tag", "links it to you"]} sub="used to prove later" />
      <Edge idPrefix={idPrefix} from={c[0]} to={c[1]} />
      <Edge idPrefix={idPrefix} from={c[1]} to={c[2]} />
    </DiagramSvg>
  );
}

// Opening a room with a bond: prove you hold one, a grant lands under a handle, keepers release the key.
export function BondAccessDiagram({ idPrefix, decorative }: DiagramProps) {
  const c = colsLeft(4);
  return (
    <DiagramSvg
      idPrefix={idPrefix}
      decorative={decorative}
      title="Opening a room with a bond"
      desc="You prove you hold a qualifying bond, which hides your wallet, your lock, and the exact amount. A grant is recorded on the public chain under an anonymous handle. The keepers release the key, and the room opens with no owner approval."
    >
      <Node left={c[0]} kind="private" title={["Prove you", "hold a bond"]} sub="wallet stays hidden" />
      <Node left={c[1]} kind="public" title={["Grant", "recorded"]} sub="anonymous handle" />
      <Node left={c[2]} kind="private" title={["Keepers", "release the key"]} sub="2 of 3" />
      <Node left={c[3]} kind="private" title={["The room", "opens"]} sub="no approval" />
      <Edge idPrefix={idPrefix} from={c[0]} to={c[1]} />
      <Edge idPrefix={idPrefix} from={c[1]} to={c[2]} />
      <Edge idPrefix={idPrefix} from={c[2]} to={c[3]} />
    </DiagramSvg>
  );
}
