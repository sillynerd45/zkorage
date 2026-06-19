// Client-side helpers (pure JS, no Buffer) for the 61-byte public journal + hex tampering.
export interface DecodedJournal {
  result: boolean;
  claimType: number;
  issuerId: string;
  threshold: string;
  nonce: string;
  expiry: string;
}

export function fromHex(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Flip one bit of one byte. Drives the on-chain rejection (✗) demo cases. */
export function flipByte(hex: string, idx: number): string {
  const b = fromHex(hex);
  b[idx] ^= 1;
  return toHex(b);
}

export function decodeJournal(hex: string): DecodedJournal | null {
  const b = fromHex(hex);
  if (b.length !== 61) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    result: b[0] === 1,
    claimType: dv.getUint32(1, false),
    issuerId: toHex(b.slice(5, 37)),
    threshold: dv.getBigUint64(37, false).toString(),
    nonce: dv.getBigUint64(45, false).toString(),
    expiry: dv.getBigUint64(53, false).toString(),
  };
}

export interface DecodedIdentityJournal {
  result: boolean;
  claimType: number;
  issuerId: string;
  accessor: string;
  nonce: string;
  expiry: string;
}

/** Decode the 85-byte identity journal. subject_id is ABSENT, so identity stays hidden. */
export function decodeIdentityJournal(hex: string): DecodedIdentityJournal | null {
  const b = fromHex(hex);
  if (b.length !== 85) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    result: b[0] === 1,
    claimType: dv.getUint32(1, false),
    issuerId: toHex(b.slice(5, 37)),
    accessor: toHex(b.slice(37, 69)),
    nonce: dv.getBigUint64(69, false).toString(),
    expiry: dv.getBigUint64(77, false).toString(),
  };
}

export interface DecodedComplianceJournal {
  result: boolean;
  claimType: number;
  issuerId: string;
  denyRoot: string;
  accessor: string;
  nonce: string;
  expiry: string;
}

/** Decode the 117-byte compliance journal. subject_id is ABSENT, so identity stays hidden. */
export function decodeComplianceJournal(hex: string): DecodedComplianceJournal | null {
  const b = fromHex(hex);
  if (b.length !== 117) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    result: b[0] === 1,
    claimType: dv.getUint32(1, false),
    issuerId: toHex(b.slice(5, 37)),
    denyRoot: toHex(b.slice(37, 69)),
    accessor: toHex(b.slice(69, 101)),
    nonce: dv.getBigUint64(101, false).toString(),
    expiry: dv.getBigUint64(109, false).toString(),
  };
}

export interface DecodedPayrollJournal {
  result: boolean;
  claimType: number;
  issuerId: string;
  threshold: string;
  accessor: string;
  auditorPub: string;
  ephPub: string;
  ct: string;
  tag: string;
  nonce: string;
  expiry: string;
}

/** Decode the 229-byte payroll journal. The salary is ABSENT, encrypted to the auditor's view key. */
export function decodePayrollJournal(hex: string): DecodedPayrollJournal | null {
  const b = fromHex(hex);
  if (b.length !== 229) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    result: b[0] === 1,
    claimType: dv.getUint32(1, false),
    issuerId: toHex(b.slice(5, 37)),
    threshold: dv.getBigUint64(37, false).toString(),
    accessor: toHex(b.slice(45, 77)),
    auditorPub: toHex(b.slice(77, 109)),
    ephPub: toHex(b.slice(109, 141)),
    ct: toHex(b.slice(141, 181)),
    tag: toHex(b.slice(181, 213)),
    nonce: dv.getBigUint64(213, false).toString(),
    expiry: dv.getBigUint64(221, false).toString(),
  };
}
