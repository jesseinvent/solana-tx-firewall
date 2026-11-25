// Well-known program IDs and token mints.

export const PROGRAMS = {
  SYSTEM: "11111111111111111111111111111111",
  TOKEN: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ASSOCIATED_TOKEN: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  COMPUTE_BUDGET: "ComputeBudget111111111111111111111111111111",
  MEMO: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  MEMO_V1: "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  BPF_UPGRADEABLE_LOADER: "BPFLoaderUpgradeab1e11111111111111111111111",
  STAKE: "Stake11111111111111111111111111111111111111",
  ADDRESS_LOOKUP_TABLE: "AddressLookupTab1e1111111111111111111111111",
  SQUADS_V4: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
  JUPITER_V6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
} as const;

export const PROGRAM_NAMES: Record<string, string> = {
  [PROGRAMS.SYSTEM]: "System",
  [PROGRAMS.TOKEN]: "Token",
  [PROGRAMS.TOKEN_2022]: "Token-2022",
  [PROGRAMS.ASSOCIATED_TOKEN]: "Associated Token",
  [PROGRAMS.COMPUTE_BUDGET]: "Compute Budget",
  [PROGRAMS.MEMO]: "Memo",
  [PROGRAMS.MEMO_V1]: "Memo (v1)",
  [PROGRAMS.BPF_UPGRADEABLE_LOADER]: "BPF Upgradeable Loader",
  [PROGRAMS.STAKE]: "Stake",
  [PROGRAMS.ADDRESS_LOOKUP_TABLE]: "Address Lookup Table",
  [PROGRAMS.SQUADS_V4]: "Squads v4",
  [PROGRAMS.JUPITER_V6]: "Jupiter v6",
};

/** Programs whose instructions we either decode or consider routine. */
export const KNOWN_PROGRAMS = new Set(Object.keys(PROGRAM_NAMES));

export const TOKEN_PROGRAMS = new Set<string>([PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022]);

export const KNOWN_MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: "wSOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
};

export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
