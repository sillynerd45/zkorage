import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Anchor, Cpu, BadgeCheck, ArrowRight } from "lucide-react";
import { DATAROOM_TABS, BONDED_TABS, type DataroomTab, type BondedTab } from "@/lib/content";
import { GLOSSARY } from "@/lib/glossary";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SectionCard } from "@/components/marketing/blocks";
import { DiagramFigure, UnderTheHood } from "./diagrams/DiagramFigure";
import { SeqLegend } from "./diagrams/kit";
import {
  StoreDiagram,
  STORE_STEPS,
  JoinApproveDiagram,
  JOIN_STEPS,
  OpenDiagram,
  OPEN_STEPS,
  BondCreateDiagram,
  BOND_CREATE_STEPS,
  BondAccessDiagram,
  BOND_ACCESS_STEPS,
} from "./diagrams/flows";

// ── Overview / concepts ───────────────────────────────────────────────────────
const ENGINE = [
  { icon: Anchor, t: "Anchor", d: "Tie the fact to something real and public. A locked bond, the fingerprint of a room's approved list, or a stored file's fingerprint already lives on the public chain, so a proof has something solid to stand on." },
  { icon: Cpu, t: "Prove (on a server we host)", d: "A zero-knowledge proof checks the fact and reveals only the answer. The proving runs on a server we host, never in your browser and never on a shared market, and it discards your private inputs once the proof is built." },
  { icon: BadgeCheck, t: "Verify (on the public chain)", d: "A small contract on Stellar checks the proof, and the result is public. Anyone can re-check it with no account and no need to trust our server." },
];

export function DocsOverview() {
  return (
    <div className="space-y-5">
      <SectionCard label="What zkorage is">
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          zkorage is a zero-knowledge toolkit on Stellar with two parts:
        </p>
        <BulletList
          className="mt-3"
          items={[
            <>
              <Link to="/docs/data-room" className="font-semibold text-foreground hover:text-brand hover:underline">
                Data Room
              </Link>{" "}
              keeps sensitive files sealed, lets the right people in without revealing who they are, and still
              lets anyone confirm a file was not altered.
            </>,
            <>
              <Link
                to="/docs/bonded-proofs"
                className="font-semibold text-foreground hover:text-brand hover:underline"
              >
                Bonded Proofs
              </Link>{" "}
              lets you lock tokens in public, then prove a fact about them, like that you hold a qualifying bond,{" "}
              <b className="text-foreground">without revealing your wallet</b>.
            </>,
          ]}
        />
        <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
          In both, a verifier learns one fact and nothing else.
        </p>
      </SectionCard>

      <SectionCard label="How it works">
        <ol className="space-y-4">
          {ENGINE.map((s, i) => (
            <li key={s.t} className="flex gap-3.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
                <s.icon className="size-5" />
              </span>
              <div>
                <p className="text-sm font-semibold">
                  {i + 1}. {s.t}
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard label="ZK is load-bearing">
        <p className="text-sm leading-relaxed text-muted-foreground">
          The zero-knowledge proof is the only thing that lets a verifier be certain of a fact without seeing
          the data or trusting our server. If an access list plus encryption (or just reading the public
          chain) would do the same job, ZK would be theatre. Here it isn't: the verifier learns one fact and
          nothing else, and re-checks it independently.
        </p>
      </SectionCard>
    </div>
  );
}

// ── Pillar explainers (Data Room + Bonded Proofs) ─────────────────────────────
// Long-form, layered: a plain story up top, the proof names and on-chain checks tucked into "Under the
// hood". Plain <section>/<p> for prose (Card is only the diagram plate); the whole pillar shares one column
// width so prose, figures, and rules line up. h2 per scenario. No em-dashes anywhere in this copy.

function DocHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-[168px] text-[17px] font-semibold tracking-tight text-foreground lg:scroll-mt-24">
      {children}
    </h2>
  );
}

function P({ children, lead = false }: { children: ReactNode; lead?: boolean }) {
  return (
    <p className={cn("text-[15px] leading-relaxed", lead ? "text-foreground" : "text-muted-foreground")}>
      {children}
    </p>
  );
}

// A bulleted note inside an "Under the hood" block.
function HoodList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

// A bullet list for the plain-story layer (distinct from HoodList, which lives inside "Under the hood"). Items
// are ReactNode, so a bold or linked lead label can front each one. Matches the prose size (text-[15px]).
function BulletList({ items, className }: { items: ReactNode[]; className?: string }) {
  return (
    <ul className={cn("space-y-2", className)}>
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5 text-[15px] leading-relaxed text-muted-foreground">
          <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand/60" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

// The "In the app" footer: links to the real flows for this pillar.
function InApp({ base, tabs }: { base: string; tabs: (DataroomTab | BondedTab)[] }) {
  return (
    <section aria-labelledby="docs-in-app" className="space-y-2">
      <DocHeading id="docs-in-app">In the app</DocHeading>
      <ul className="divide-y divide-border/70">
        {tabs
          .filter((t) => t.slug)
          .map((t) => (
            <li key={t.slug} className="py-2.5 first:pt-0 last:pb-0">
              <Link to={`${base}/${t.slug}`} className="text-sm font-medium hover:text-brand">
                {t.label}
              </Link>
              <p className="max-w-[68ch] text-sm leading-relaxed text-muted-foreground">{t.blurb}</p>
            </li>
          ))}
      </ul>
    </section>
  );
}

// The in-page jump list (DOCS_SUBNAV) now lives in the docs side-rail (nested under the active pillar on
// desktop) + a sticky "On this page" bar on mobile, so it stays reachable while scrolling. See Docs.tsx.

export function DocsDataRoom() {
  return (
    <div className="max-w-[42rem] space-y-10">
      <P lead>
        A Data Room is a sealed place for sensitive files. You prove you are allowed in without showing who
        you are, the files stay encrypted the whole time, and the only thing about a file that ever goes public
        is a short tamper-evident fingerprint. Anyone can still confirm a file was not swapped, and the people
        reading it stay anonymous.
      </P>

      <section aria-labelledby="dr-what" className="space-y-4">
        <DocHeading id="dr-what">What a Data Room is</DocHeading>
        <P>
          Say you need to share a term sheet, a cap table, or a due-diligence folder with a small group. You
          want three things at once:
        </P>
        <BulletList
          items={[
            "the contents stay private",
            "the readers stay private",
            "anyone can still confirm that the file on record was not altered",
          ]}
        />
        <P>A Data Room gives you all three.</P>
        <P>
          A room holds documents and a list of who may read them. The owner decides how readers get in.
          Getting in, and reading, never reveals which person you are.
        </P>
      </section>

      <section aria-labelledby="dr-store" className="space-y-5">
        <DocHeading id="dr-store">How a document is stored</DocHeading>
        <P>
          When you store a document, your browser does the sealing before anything leaves your computer. It
          encrypts the file, then splits the key that unlocks it into three pieces held by three separate
          keepers. No single keeper can open the file. Any two of them together can help a reader who has
          earned access.
        </P>
        <P>
          The encrypted file is kept off the chain. What goes on the public chain is a short fingerprint of it
          and a pointer to where it is stored, never the contents and never the key. That fingerprint cannot be
          turned back into the file, but it does let anyone confirm the file was not changed. Storing a document
          uses no zero-knowledge proof.
        </P>
        <DiagramFigure
          title="Storing a document"
          caption="The full path of a stored document across your browser, the backend, Cloudflare R2, the three keepers, and the chain. The file is encrypted and its key split before anything leaves your browser; the backend keeps the encrypted file off the chain and hands the sealed key shares to the keepers; only a short record is public. Click to enlarge."
          steps={STORE_STEPS}
          legend={<SeqLegend />}
          render={(p) => <StoreDiagram {...p} />}
        />
        <UnderTheHood>
          <HoodList
            items={[
              "The file is encrypted in your browser with AES-256-GCM under a fresh random key.",
              "That key is split with Shamir secret sharing into a 2-of-3 set, and each share is sealed to one keeper's public key. No keeper ever holds the whole key, and our server never sees it either.",
              "The encrypted file is stored off-chain in object storage. The on-chain record holds a fingerprint of the encrypted file, a commitment to the key, a pointer to the stored file, and the room and document ids. No key, no contents, and no readable text go on-chain.",
              "Storing takes up to three wallet approvals: create the room, sign once to derive your room key, and write the on-chain record. There is no prover and no proof in this step.",
            ]}
          />
        </UnderTheHood>
      </section>

      <section aria-labelledby="dr-access" className="space-y-4">
        <DocHeading id="dr-access">Membership and Bonded Access</DocHeading>
        <P>Every room uses one of two ways to decide who gets in. A room is one or the other.</P>
        <P>
          <b className="text-foreground">Membership.</b> The owner approves readers one by one. You ask to
          join, the owner adds you to the room's approved list, and from then on you can open documents without
          revealing which approved member you are.
        </P>
        <P>
          <b className="text-foreground">Bonded Access.</b> There is no approval step. The owner sets a
          requirement: lock a certain bond. Anyone who has locked a bond that meets it can open the room.
          Bonded Access is part of Bonded Proofs, covered in its{" "}
          <Link to="/docs/bonded-proofs" className="text-brand hover:underline">
            own section
          </Link>
          .
        </P>
        <P>
          In both, the zero-knowledge proof happens when you open a document, not when you join. Membership
          rooms use a membership proof. Bonded rooms use a bond proof. Either way, the proof shows only that
          you are allowed in.
        </P>
      </section>

      <section aria-labelledby="dr-join" className="space-y-5">
        <DocHeading id="dr-join">Joining and approving</DocHeading>
        <P>
          To ask to join a Membership room, you send a membership ID. It is a code derived from your wallet,
          not your wallet address. You can add a nickname so the owner can recognize your request, or leave it
          off and the owner just sees an opaque ID. Your wallet address never leaves your browser.
        </P>
        <P>
          The owner reviews requests and approves the ones they recognize. Approving adds your membership ID to
          the room's approved list. A fingerprint of that list is written to the public chain so anyone can
          confirm the list was not tampered with. Joining and approving use no proof. The proof comes later.
        </P>
        <DiagramFigure
          title="Joining a room"
          caption="One wallet signature derives a per-room ID (never your wallet address); the owner approves you later and pins a fingerprint of the approved list on-chain. No proof is used to join. Click to enlarge."
          steps={JOIN_STEPS}
          legend={<SeqLegend />}
          render={(p) => <JoinApproveDiagram {...p} />}
        />
        <UnderTheHood>
          <HoodList
            items={[
              "Your membership ID is a commitment derived from a one-time wallet signature, unique per room, so your IDs in different rooms cannot be linked.",
              "The pending request list is held off-chain. When the owner approves, the membership ID is added to the room's list, and the owner signs one transaction that pins the new list fingerprint (a Merkle root) on-chain. The list itself stays off-chain; only its root is public.",
              "Approving several people at once shuffles the new entries before adding them, so the on-chain order does not reveal who asked first.",
              "Re-pinning a new list fingerprint cancels older access that was proven against the old one.",
            ]}
          />
        </UnderTheHood>
      </section>

      <section aria-labelledby="dr-open" className="space-y-5">
        <DocHeading id="dr-open">How a document is opened</DocHeading>
        <P>
          To open a document, you make a proof that you are allowed in. In a Membership room you prove you are
          on the approved list, without showing which member you are. In a Bonded room you prove you hold a
          qualifying bond, without showing your wallet or the amount. The proof reveals only that you qualify,
          nothing else.
        </P>
        <P>
          A one-time pass is recorded so the same credential cannot open twice. The keepers check that your
          proof landed on the chain, then hand you their pieces of the key. Your browser only needs two of the
          three to rebuild the key and decrypt the file. The proving runs on a server we host, never in your
          browser, and that server never receives the file.
        </P>
        <DiagramFigure
          title="Opening a document"
          caption="The full open path across your browser, the backend, the self-hosted prover, the three keepers, and the chain. You prove you qualify and nothing else; a grant lands on the public chain; the keepers release the key; and the file decrypts in your browser. Click to enlarge."
          steps={OPEN_STEPS}
          legend={<SeqLegend />}
          render={(p) => <OpenDiagram {...p} />}
        />
        <UnderTheHood>
          <HoodList
            items={[
              "Membership rooms use the membership guest (claim type 9). It proves your membership ID is on the room's approved-list tree, records a one-time nullifier so the same identity cannot be granted twice in that room, and keeps the crowd at five or more readers.",
              "Bonded rooms use the bond-open guest (claim type 15). It proves you hold a qualifying bond and carries the key it should be sealed to, with no approved list involved, and keeps the crowd at three or more.",
              "The proof commits the public key the keepers should seal to, signed by you, so it cannot be swapped for someone else's. Each keeper independently re-checks the on-chain grant on its own node, then seals one key share to that key. Your browser rebuilds the key only if at least two shares agree with the on-chain key commitment, and checks the file's fingerprint before decrypting.",
              "The proving server discards your private inputs as soon as the proof is built. It runs on hardware we control, never a shared proving market.",
            ]}
          />
        </UnderTheHood>
      </section>

      <section aria-labelledby="dr-discover" className="space-y-4">
        <DocHeading id="dr-discover">Private and public rooms</DocHeading>
        <P>A room has three visibility levels:</P>
        <BulletList
          items={[
            <>
              <b className="text-foreground">Private</b> is the default. The room can only be found by a link
              the owner shares.
            </>,
            <>
              <b className="text-foreground">Unlisted</b> can be looked up by its exact id.
            </>,
            <>
              <b className="text-foreground">Listed</b> shows up in the public directory.
            </>,
          ]}
        />
        <P>
          The directory never shows an exact member count or who opened what. It shows only a rough size band,
          like under 5, 5 to 19, 20 to 49, or 50 and up.
        </P>
        <P>
          Listing a room is a convenience for finding it, not what keeps you private. Your privacy comes from
          the anonymous open proof, the minimum crowd size, and the keepers.
        </P>
        <P>
          Discovery uses no proof. You can browse listed rooms in the{" "}
          <Link to="/explorer" className="text-brand hover:underline">
            Explorer
          </Link>
          .
        </P>
      </section>

      <section aria-labelledby="dr-verify" className="space-y-4">
        <DocHeading id="dr-verify">Checking a Data Room</DocHeading>
        <P>
          Anyone can check a room with no account and no wallet. Open <code className="font-mono text-xs">/verify/room/&lt;id&gt;</code>.
          It reads the public contract to confirm the room exists and whether it uses Membership or Bonded
          Access, and for a bonded room it shows the bond the room asks for. It also prints a command you can
          run yourself to read the same facts straight from the network. The reader's identity is never shown.
        </P>
        <Link to="/verify" className={cn(buttonVariants({ variant: "outline" }), "mt-1")}>
          Open the verify page <ArrowRight className="size-4" />
        </Link>
      </section>

      <InApp base="/app/dataroom" tabs={DATAROOM_TABS} />
    </div>
  );
}

export function DocsBondedProofs() {
  return (
    <div className="max-w-[42rem] space-y-10">
      <P lead>
        A bond is tokens you lock in public until a time you choose. Locking is open for anyone to see. The
        private part comes after: you can prove you hold a qualifying bond without showing your wallet or the
        amount, and use that to open a room with no approval.
      </P>

      <section aria-labelledby="bp-what" className="space-y-4">
        <DocHeading id="bp-what">What a Bonded Proof is</DocHeading>
        <P>
          Bonded Proofs is a simple escrow plus the proofs built on it. You lock a token until an unlock time.
          You can lock a bond to yourself and take it back after it unlocks, or send it one way to someone
          else.
        </P>
        <P>
          A bond is a stake you post to back a claim. The proof counts only while the tokens stay locked, so
          the lock is what makes the claim worth trusting, not our word for it.
        </P>
      </section>

      <section aria-labelledby="bp-create" className="space-y-5">
        <DocHeading id="bp-create">How a bond is created</DocHeading>
        <P>
          You pick a token, an amount, and an unlock time, then lock it. The lock is fully public: the chain
          shows your wallet, the token, the amount, and the unlock time. Creating a bond uses no proof.
        </P>
        <P>
          When you lock a bond for access, the lock also carries a private tag. The tag is derived from a
          secret only you hold. Later it lets you prove the bond is yours without pointing to which lock it is.
        </P>
        <DiagramFigure
          title="Creating a bond for access"
          caption="You set the terms and derive a private tag, the backend builds the lock transaction, you sign it, and the escrow records the lock in full public view. The lock is public; only the tag is opaque. Click to enlarge."
          steps={BOND_CREATE_STEPS}
          legend={<SeqLegend />}
          render={(p) => <BondCreateDiagram {...p} />}
        />
        <UnderTheHood>
          <HoodList
            items={[
              "The escrow is a Soroban contract. A deposit pulls the token in and records the depositor, the token, the measured amount, the unlock time, and a tag. The unlock time can be extended but never shortened.",
              "The private tag is a commitment derived from your secret. A plain deposit carries no tag. A bond locked from the Bonded Access page carries your handle's tag, which is what makes it provable later.",
              "Every lock is readable from the public chain, so anyone can audit the set of bonds for themselves.",
            ]}
          />
        </UnderTheHood>
      </section>

      <section aria-labelledby="bp-link" className="space-y-4">
        <DocHeading id="bp-link">How it connects to the Data Room</DocHeading>
        <P>
          A Data Room owner can require a qualifying bond instead of approving readers one by one. Anyone who
          locked a bond that meets the requirement can open the room, with no approval and no waiting.
        </P>
        <P>
          Your bond ties to a per-wallet handle, so one qualifying bond opens every room that shares the same
          requirement, with no re-locking.
        </P>
      </section>

      <section aria-labelledby="bp-open" className="space-y-5">
        <DocHeading id="bp-open">How a bond opens a room</DocHeading>
        <P>
          You prove you hold a qualifying bond. The proof hides your wallet, which lock you used, and the exact
          amount. It records a grant on the public chain under your anonymous handle. From there the room opens
          the same way as any other: the keepers release the key and the file decrypts in your browser.
        </P>
        <DiagramFigure
          title="Opening a room with a bond"
          caption="With no wallet signature, you prove you hold a qualifying bond (hiding your wallet, your lock, and the amount); a grant lands under an anonymous handle; the keepers release the key; and the room opens with no owner approval. Click to enlarge."
          steps={BOND_ACCESS_STEPS}
          legend={<SeqLegend />}
          render={(p) => <BondAccessDiagram {...p} />}
        />
        <UnderTheHood>
          <HoodList
            items={[
              "A requirement is identified by a hash of the token, the minimum amount, and the deadline. The standalone grant uses the bond guest (claim type 14); opening a bond-only room uses the bond-open guest (claim type 15).",
              "The proof shows that your private tag is in the qualifying set for that requirement. The qualifying set is rebuilt from the public escrow: locks of the right token, with enough amount, locked past the deadline, that cannot be revoked. Because qualifying locks cannot be revoked, the deadline check is sound.",
              "The minimum crowd size is three. It is enforced by our service rather than the contract, and it counts distinct tags rather than distinct wallets.",
            ]}
          />
        </UnderTheHood>
      </section>

      <section aria-labelledby="bp-verify" className="space-y-4">
        <DocHeading id="bp-verify">Checking a Bonded Proof</DocHeading>
        <P>
          Anyone can re-check a grant with no account. Open <code className="font-mono text-xs">/verify/bond</code>{" "}
          and it reads the public bond gate to confirm the grant is live, then prints a command you can run
          yourself. Anyone can also rebuild the qualifying set from the public escrow with the SDK to confirm
          the anonymity crowd is real. The wallet behind a grant is never shown.
        </P>
      </section>

      <InApp base="/app/bonded" tabs={BONDED_TABS} />
    </div>
  );
}

// ── Verify it yourself ────────────────────────────────────────────────────────
export function DocsVerify() {
  return (
    <div className="space-y-5">
      <SectionCard label="Don't trust. Verify.">
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          Everything zkorage publishes is checkable by anyone, straight on the public ledger. There is no
          wallet, no account, and no need to trust our server. A check recomputes the proof's fingerprint,
          confirms the proving program is the pinned one, and asks the{" "}
          <b className="text-foreground">public</b> Stellar contracts to confirm the proof and the on-chain
          record. Private inputs are never revealed in any of it.
        </p>
        <Link to="/verify" className={cn(buttonVariants(), "mt-4")}>
          Open the verify page <ArrowRight className="size-4" />
        </Link>
      </SectionCard>

      <SectionCard label="What you can check">
        <ul className="divide-y divide-border/70 text-sm leading-relaxed text-muted-foreground">
          <li className="py-2.5 first:pt-0">
            <b className="text-foreground">A proof.</b> Paste a link or an id at{" "}
            <code className="font-mono text-xs">/verify</code> and it routes to the right check. Browse them all
            in the <Link to="/explorer" className="text-brand hover:underline">Explorer</Link>.
          </li>
          <li className="py-2.5">
            <b className="text-foreground">A Data Room.</b> Open{" "}
            <code className="font-mono text-xs">/verify/room/&lt;id&gt;</code> to confirm a room exists and
            whether it uses Membership or Bonded Access. The reader's identity is never shown.
          </li>
          <li className="py-2.5 last:pb-0">
            <b className="text-foreground">A bond.</b> Open <code className="font-mono text-xs">/verify/bond</code>{" "}
            to confirm a bond grant is live. The wallet behind it is never shown.
          </li>
        </ul>
      </SectionCard>
    </div>
  );
}

// ── Glossary ──────────────────────────────────────────────────────────────────
export function DocsGlossary() {
  const terms = Object.entries(GLOSSARY);
  return (
    <SectionCard label="Plain-language glossary">
      <dl className="divide-y divide-border/70">
        {terms.map(([term, def]) => (
          <div key={term} className="py-3 first:pt-0 last:pb-0">
            <dt className="text-sm font-semibold capitalize">{term}</dt>
            <dd className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{def}</dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}
