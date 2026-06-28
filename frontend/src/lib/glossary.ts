// The 8-canonical-glosses for the "what's this?" affordance (UX terminology report §7.3/§7.4):
// plain word on the surface, the exact gloss one focus/hover away. Carried over verbatim from the
// prior UX pass so every use reads identically. Re-skin, don't rewrite this copy.
export const GLOSSARY: Record<string, string> = {
  "prove":
    "Create the math that shows a statement is true without revealing the private details behind it. Runs on a server you control; takes seconds to minutes.",
  "check":
    "Anyone can re-check the proof against the public ledger and get the same answer. No account or permission needed.",
  "private proof": "Math that proves one fact while hiding everything else.",
  "one-time pass": "A stamp that lets your pass work only once per room, so no one enters twice.",
  "fingerprint":
    "A short code made from a file. Change one character and the code changes, which proves the file wasn't altered. It can't be turned back into the file.",
  "stand-in ID":
    "A placeholder shown on the public record instead of your real name. It hides who you are, but actions under it can be linked together.",
  "split key":
    "The document key is split among 3 keepers. No single keeper can open the file; any 2 together can.",
  "public record":
    "The public blockchain (Stellar) where zkorage posts fingerprints and proofs anyone can check.",
  "approved list":
    "The list of who's allowed into a room. A short fingerprint of it is posted so anyone can confirm it wasn't changed.",
  "masked copy": "A copy of a document with private fields blacked out. It is provably the genuine file.",
  "verified preview":
    "A small, publicly checkable claim about a sealed document (e.g. \"revenue ≥ $1M\"), vouched for by a reviewer (not independently audited).",
  "bond":
    "Tokens you lock in public until a time you choose. While they stay locked, you can prove a fact about them, like that you hold one that meets a requirement.",
  "escrow":
    "The contract that holds locked tokens until their unlock time. It can extend the time but never shorten it.",
  "membership ID":
    "A code derived from your wallet that stands in for you in one room. It is not your wallet address, and your IDs in different rooms cannot be linked.",
  "anonymous handle":
    "A steady stand-in name for your wallet when you open rooms with a bond. It hides your wallet, but actions under it can be linked together.",
  "keeper":
    "One of three independent services that each hold a piece of a document's key. No single keeper can open a file. Any two together release the key to a reader who has earned access.",
  "anonymity set":
    "The crowd you hide in. The larger the group who could have made the same proof, the less any one of them stands out. zkorage keeps a minimum crowd before it will help you prove.",
  "qualifying bond":
    "A locked bond that meets a room's requirement: the right token, at least the minimum amount, locked past the deadline, and not revocable.",
};

export type GlossaryTerm = keyof typeof GLOSSARY;
