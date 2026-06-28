import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, X, Anchor, Cpu, BadgeCheck, ArrowRight } from "lucide-react";
import { DATAROOM_TABS, BONDED_TABS, type DataroomTab, type BondedTab } from "@/lib/content";
import { M7ShowcasePanel } from "@/components/app/dataroom/M7ShowcasePanel";
import { GLOSSARY } from "@/lib/glossary";
import { useDeveloperDemo, DEV_CHECKS } from "@/lib/hooks/useDeveloperDemo";
import { CopyButton } from "@/components/Disclosure";
import { VerdictMark } from "@/components/StatusBadge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SectionCard, DataRow } from "@/components/marketing/blocks";
import { DiagramFigure, UnderTheHood } from "./diagrams/DiagramFigure";
import {
  StoreDiagram,
  JoinApproveDiagram,
  OpenDiagram,
  BondCreateDiagram,
  BondAccessDiagram,
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
          zkorage is a zero-knowledge toolkit on Stellar with two parts. A{" "}
          <Link to="/docs/data-room" className="text-brand hover:underline">
            Data Room
          </Link>{" "}
          keeps sensitive files sealed, lets the right people in without revealing who they are, and still lets
          anyone confirm a file was not altered.{" "}
          <Link to="/docs/bonded-proofs" className="text-brand hover:underline">
            Bonded Proofs
          </Link>{" "}
          lets you lock tokens in public, then prove a fact about them, like that you hold a qualifying bond,{" "}
          <b className="text-foreground">without revealing your wallet</b>. In both, a verifier learns one
          fact and nothing else.
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
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          This is a hackathon demo on Stellar testnet. The verifier is the bare Groth16 verifier (no
          governance stack) and is <b className="text-foreground">unaudited</b>, so it is not for production funds.
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
    <h2 id={id} className="scroll-mt-24 text-[17px] font-semibold tracking-tight text-foreground">
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

// A compact in-page jump list for the long pillar pages (the side-rail navigates sections; this navigates
// the scenarios within a section).
function OnThisPage({ items }: { items: { id: string; label: string }[] }) {
  return (
    <nav aria-label="On this page" className="rounded-lg border bg-muted/30 px-4 py-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">On this page</p>
      <ul className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-x-5 sm:gap-y-1.5">
        {items.map((it) => (
          <li key={it.id}>
            <a href={`#${it.id}`} className="text-[13px] text-brand hover:underline">
              {it.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const DR_NAV = [
  { id: "dr-what", label: "What a Data Room is" },
  { id: "dr-store", label: "How a document is stored" },
  { id: "dr-access", label: "Membership and Bonded Access" },
  { id: "dr-join", label: "Joining and approving" },
  { id: "dr-open", label: "How a document is opened" },
  { id: "dr-discover", label: "Private and public rooms" },
  { id: "dr-verify", label: "Checking a Data Room" },
];

const BP_NAV = [
  { id: "bp-what", label: "What a Bonded Proof is" },
  { id: "bp-create", label: "How a bond is created" },
  { id: "bp-link", label: "How it connects to the Data Room" },
  { id: "bp-open", label: "How a bond opens a room" },
  { id: "bp-verify", label: "Checking a Bonded Proof" },
];

export function DocsDataRoom() {
  return (
    <div className="max-w-[42rem] space-y-10">
      <P lead>
        A Data Room is a sealed place for sensitive files. You prove you are allowed in without showing who
        you are, the files stay encrypted the whole time, and the only thing about a file that ever goes public
        is a short tamper-evident fingerprint. Anyone can still confirm a file was not swapped, and the people
        reading it stay anonymous.
      </P>

      <OnThisPage items={DR_NAV} />

      <section aria-labelledby="dr-what" className="space-y-4">
        <DocHeading id="dr-what">What a Data Room is</DocHeading>
        <P>
          Say you need to share a term sheet, a cap table, or a due-diligence folder with a small group. You
          want three things at once: the contents stay private, the readers stay private, and anyone can still
          confirm that the file on record was not altered. A Data Room gives you all three.
        </P>
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
          caption="The file is encrypted and its key split before anything leaves your browser. Only a fingerprint is public."
          steps={[
            "Your browser encrypts the file.",
            "The key is split into three pieces, one for each keeper.",
            "The encrypted file is stored off the chain.",
            "A short fingerprint is written to the public chain.",
          ]}
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
          not your wallet address. You can add a nickname so the owner knows who you are, or stay fully
          anonymous. Your wallet address never leaves your browser.
        </P>
        <P>
          The owner reviews requests and approves the ones they recognize. Approving adds your membership ID to
          the room's approved list. A fingerprint of that list is written to the public chain so anyone can
          confirm the list was not tampered with. Joining and approving use no proof. The proof comes later.
        </P>
        <DiagramFigure
          title="Joining a room"
          caption="You send only a membership ID, never your wallet address. A fingerprint of the approved list is public."
          steps={[
            "You send a membership ID and an optional nickname, not your wallet address.",
            "The owner approves you and signs one transaction.",
            "A fingerprint of the approved list is written to the public chain.",
          ]}
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
          caption="You prove you qualify and nothing else. The keepers release the key, and the file decrypts in your browser."
          steps={[
            "You make a proof that you qualify, which shows nothing else about you.",
            "The grant is recorded on the public chain.",
            "The three keepers each release their key share to you.",
            "Your browser rebuilds the key and the file opens, only for you.",
          ]}
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
        <P>
          A room has three visibility levels. Private is the default: the room can only be found by a link the
          owner shares. Unlisted can be looked up by its exact id. Listed shows up in the public directory.
        </P>
        <P>
          The directory never shows an exact member count or who opened what. It shows only a rough size band,
          like under 5, 5 to 19, 20 to 49, or 50 and up. Listing a room is a convenience for finding it. It is
          not what keeps you private. Your privacy comes from the anonymous open proof, the minimum crowd size,
          and the keepers. Discovery uses no proof. You can browse listed rooms in the{" "}
          <Link to="/explorer" className="text-brand hover:underline">
            Explorer
          </Link>
          .
        </P>
      </section>

      {/* A live, wallet-free demo of the timing defense. It carries its own heading and self-hides if the
          showcase room is not provisioned, so it is rendered bare (no surrounding heading to dangle). */}
      <M7ShowcasePanel />

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

      <OnThisPage items={BP_NAV} />

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
          caption="You lock tokens in the open. The lock carries a private tag that lets you prove it is yours later."
          steps={[
            "You choose a token, an amount, and an unlock time.",
            "You lock the tokens in the escrow, in full public view.",
            "The lock carries a private tag that you can prove later without naming the lock.",
          ]}
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
          requirement, with no re-locking. One honest tradeoff: that handle is a single steady alias for your
          wallet, so our keepers could tell that one alias opened several rooms. Your wallet itself still stays
          hidden.
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
          caption="You prove you hold a qualifying bond, hiding your wallet and amount, and the room opens with no approval."
          steps={[
            "You prove you hold a qualifying bond, hiding your wallet, your lock, and the amount.",
            "A grant is recorded on the public chain under your anonymous handle.",
            "The keepers release the key to you.",
            "The room opens, with no owner approval.",
          ]}
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

      <SectionCard label="From the command line">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Each verify page also prints the exact command to run yourself. You can read the on-chain result,
          list the history, and re-check the proof against the public network, with no zkorage server in the
          trust path.
        </p>
      </SectionCard>
    </div>
  );
}

// ── Developers (live SDK demo + snippets) ─────────────────────────────────────
const SDK_SNIPPET = `import { ZkorageClient } from "zkorage-sdk";

const z = new ZkorageClient();                       // testnet defaults baked in, no keys
const a = await z.isReservesGteSupply();             // on-chain-verified answer + freshness
// { answer: true, boundSupply, liveSupply, fresh, result }

const audit = await z.getAuditBundle();              // proof bundle (via REST)
const v = await z.verifyBundle(audit.proof!);        // full Groth16 re-verify vs the public chain
// v.verdict === true, v.checklist = { ...9 checks }`;

const MCP_SNIPPET = `{
  "mcpServers": {
    "zkorage": {
      "command": "node",
      "args": ["<repo>/mcp/dist/server.js"],
      "env": { "ZKORAGE_API_BASE": "http://localhost:8787" }
    }
  }
}
// then ask: "Using zkorage, is the latest issuer's reserves >= supply?"`;

function Snippet({ title, note, code }: { title: string; note?: string; code: string }) {
  return (
    <SectionCard label={title}>
      {note && <p className="mb-2 text-sm text-muted-foreground">{note}</p>}
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        usage <CopyButton text={code} label="copy" />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-foreground">
        {code}
      </pre>
    </SectionCard>
  );
}

export function DocsDevelopers() {
  const d = useDeveloperDemo();
  return (
    <div className="space-y-5">
      <SectionCard label="Build on zkorage">
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          A read-only TypeScript SDK and an MCP server let any developer (or any AI agent) query and{" "}
          <b className="text-foreground">re-verify</b> a claim straight against the public chain, with no keys
          and no need to trust our server. The demo below runs the SDK <b className="text-foreground">in this
          browser</b>.
        </p>
      </SectionCard>

      <SectionCard
        label="Live SDK demo"
        aside={<span className="text-[11px] uppercase tracking-wide text-muted-foreground">in-browser · public RPC</span>}
      >
        <div data-testid="dev-demo">
          <Button onClick={d.run} disabled={d.state === "running"} data-testid="dev-run">
            {d.state === "running" ? "Running…" : "Run isReservesGteSupply() + verifyBundle()"}
          </Button>
          {d.state === "error" && <p className="mt-3 text-sm text-destructive">{d.err}</p>}
          {d.answer && (
            <div
              data-testid="dev-answer"
              data-answer={d.answer.answer}
              className={cn(
                "mt-4 flex items-center gap-3 rounded-xl border p-3 text-sm font-semibold",
                d.answer.answer ? "border-success/40 bg-success/5 text-success" : "border-destructive/40 bg-destructive/5 text-destructive",
              )}
            >
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full border",
                  d.answer.answer ? "border-success/50 bg-success/10" : "border-destructive/50 bg-destructive/10",
                )}
              >
                <VerdictMark ok={!!d.answer.answer} />
              </span>
              <span>
                reserves ≥ supply: {String(d.answer.answer)}
                {d.answer.fresh ? "" : " (supply stale)"}
              </span>
            </div>
          )}
          {d.answer && (
            <div className="mt-3">
              <DataRow k="bound supply">{d.answer.boundSupply}</DataRow>
              <DataRow k="live supply">{d.answer.liveSupply}</DataRow>
            </div>
          )}
          {d.checklist && (
            <ul className="mt-4 grid gap-1.5 sm:grid-cols-2" data-testid="dev-checklist">
              {DEV_CHECKS.map((c) => {
                const ok = d.checklist![c.key];
                return (
                  <li
                    key={c.key}
                    data-testid={`dev-check-${c.key}`}
                    data-ok={ok}
                    className="flex items-center gap-2 text-sm"
                  >
                    <span className={ok ? "text-success" : "text-destructive"}>
                      {ok ? <Check className="size-4" /> : <X className="size-4" />}
                    </span>
                    <span className={ok ? "" : "text-muted-foreground"}>{c.label}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SectionCard>

      <Snippet
        title="TypeScript SDK · zkorage-sdk"
        note="Trust-minimized reads + full Groth16 re-verify. Node + browser. No keys."
        code={SDK_SNIPPET}
      />
      <Snippet
        title="MCP server · read-only, no key custody"
        note="Wire the read-only MCP server into Claude Desktop / Claude Code (stdio) and ask it to verify a claim."
        code={MCP_SNIPPET}
      />

      <SectionCard label="REST API">
        <DataRow k="OpenAPI spec" mono={false}>
          <a href="/api/openapi.yaml" target="_blank" rel="noreferrer" className="text-brand hover:underline">
            /api/openapi.yaml ↗
          </a>
        </DataRow>
        <DataRow k="Swagger UI" mono={false}>
          served by the backend at <code className="font-mono text-xs">/docs</code>
        </DataRow>
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
