export type Severity = "critical" | "warning" | "info";
export type Verdict = "block" | "review" | "safe";

export type Flag = {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Index of the instruction that triggered it, if any. */
  instruction?: number;
};

export type DecodedInstruction = {
  index: number;
  programId: string;
  programName: string;
  /** Human-readable instruction name, e.g. "Token: SetAuthority". */
  name: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  /** Parsed arguments we understand (amounts, new authorities, ...). */
  args: Record<string, string | number | boolean | null>;
  dataBase64: string;
};

export type BalanceChange = {
  account: string;
  /** Wallet that owns the asset: the account itself for SOL, the token account owner for tokens. */
  owner: string;
  asset: string; // "SOL" or a token symbol / mint
  mint?: string;
  before: string;
  after: string;
  delta: string;
  /** True if this asset belongs to one of the transaction's signers. */
  signerAsset: boolean;
};

export type AuthorityChange = {
  account: string;
  kind: "token-owner" | "token-delegate" | "token-close-authority" | "program-owner" | "closed";
  before: string | null;
  after: string | null;
  signerAsset: boolean;
};

export type ScanReport = {
  input: { kind: "transaction" | "signature"; signature?: string };
  verdict: Verdict;
  summary: string;
  summarySource: "claude" | "rules";
  signers: string[];
  feePayer: string;
  usesLookupTables: boolean;
  instructions: DecodedInstruction[];
  flags: Flag[];
  simulation: {
    mode: "simulated" | "historical" | "unavailable";
    success: boolean;
    error?: string;
    logs: string[];
    unitsConsumed?: number;
  };
  balanceChanges: BalanceChange[];
  authorityChanges: AuthorityChange[];
};
