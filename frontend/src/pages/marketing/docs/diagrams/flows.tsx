import { DiagramSvg, Node, Edge, colsLeft, type DiagramProps } from "./kit";

// The five documentation flowcharts. Each is a single left-to-right row so it stays scannable. The branch
// detail (membership vs bonded, plain bond vs qualifying bond) lives in the prose and the "Under the hood"
// expander, not in the drawing. Every node is private (dashed brand), public (solid neutral), or verified
// (emerald). See ./kit for the shared primitives.

// Storing a document: encrypt, split the key, store off-chain, anchor a fingerprint. No proof.
export function StoreDiagram({ idPrefix, decorative }: DiagramProps) {
  const c = colsLeft(4);
  return (
    <DiagramSvg
      idPrefix={idPrefix}
      decorative={decorative}
      title="Storing a document"
      desc="Your browser encrypts the file, splits its key across three keepers, stores the locked file off the chain, and writes only a short fingerprint to the public chain. No proof is used to store."
    >
      <Node left={c[0]} kind="private" title={["Encrypt", "the file"]} sub="in your browser" />
      <Node left={c[1]} kind="private" title={["Split the", "key"]} sub="across 3 keepers" />
      <Node left={c[2]} kind="private" title={["Store the", "locked file"]} sub="off the chain" />
      <Node left={c[3]} kind="public" title={["Anchor a", "fingerprint"]} sub="on the chain" />
      <Edge idPrefix={idPrefix} from={c[0]} to={c[1]} />
      <Edge idPrefix={idPrefix} from={c[1]} to={c[2]} />
      <Edge idPrefix={idPrefix} from={c[2]} to={c[3]} />
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
      <Node left={c[3]} kind="verified" title={["The file", "opens"]} sub="only for you" />
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
      <Node left={c[3]} kind="verified" title={["The room", "opens"]} sub="no approval" />
      <Edge idPrefix={idPrefix} from={c[0]} to={c[1]} />
      <Edge idPrefix={idPrefix} from={c[1]} to={c[2]} />
      <Edge idPrefix={idPrefix} from={c[2]} to={c[3]} />
    </DiagramSvg>
  );
}
