// Shared formatting + small pure helpers used across both variants' pages.

/** Truncate a long hex/id for display: keep first+last n chars. */
export const short = (h: string, n = 6) => (h && h.length > 2 * n ? `${h.slice(0, n)}…${h.slice(-n)}` : h);

/** A 32-byte (64 hex char) value check. */
export const isHex32 = (s: string) => /^[0-9a-fA-F]{64}$/.test(s.trim());

/** stellar.expert deep link for a contract or transaction. */
export const explorer = (kind: "contract" | "tx", id: string, network = "testnet") =>
  `https://stellar.expert/explorer/${network}/${kind}/${id}`;

/** Whole token amount → base units (7 dp by default). */
export const toBase = (whole: string, decimals = 7) =>
  (BigInt(whole || "0") * 10n ** BigInt(decimals)).toString();

export { fmtAmount } from "./api";
