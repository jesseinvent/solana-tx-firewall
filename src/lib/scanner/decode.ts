import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import * as multisig from "@sqds/multisig";
import { DecodedInstruction } from "./types";
import { KNOWN_MINTS, PROGRAMS, PROGRAM_NAMES, TOKEN_PROGRAMS } from "./programs";

// ---------------- input ----------------

export type ParsedInput =
  | { kind: "transaction"; tx: VersionedTransaction }
  | { kind: "signature"; signature: string };

/**
 * Accepts a base64 or base58 serialized transaction (legacy or v0), a transaction
 * signature, or an explorer URL (Solscan, Solana Explorer, SolanaFM).
 */
export function parseInput(raw: string): ParsedInput {
  const input = raw.trim();
  if (!input) throw new Error("Paste a transaction or a signature.");

  const fromUrl = input.match(/\/tx\/([1-9A-HJ-NP-Za-km-z]{64,90})/);
  if (fromUrl) return { kind: "signature", signature: fromUrl[1] };

  // base58: either a 64-byte signature or a serialized transaction
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(input)) {
    try {
      const bytes = bs58.decode(input);
      if (bytes.length === 64) return { kind: "signature", signature: input };
      return { kind: "transaction", tx: VersionedTransaction.deserialize(bytes) };
    } catch {
      // fall through: may be base64 that happens to use only base58 characters
    }
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    try {
      return { kind: "transaction", tx: VersionedTransaction.deserialize(Buffer.from(input, "base64")) };
    } catch {
      /* not a transaction */
    }
  }
  throw new Error("Couldn't read that. Expected a base64/base58 transaction, a signature, or an explorer link.");
}

// ---------------- account resolution ----------------

export type ResolvedTx = {
  tx: VersionedTransaction;
  /** All account keys in order (static keys, then lookup-table writable, then readonly). */
  keys: PublicKey[];
  signers: string[];
  feePayer: string;
  writable: string[];
  usesLookupTables: boolean;
};

export async function resolveAccounts(
  connection: Connection,
  tx: VersionedTransaction,
  /** For historical transactions the RPC already returns the loaded addresses. */
  loaded?: { writable: PublicKey[]; readonly: PublicKey[] },
): Promise<ResolvedTx> {
  const msg = tx.message;
  const lookups = msg.addressTableLookups ?? [];

  let keys: PublicKey[];
  if (loaded) {
    keys = [...msg.staticAccountKeys, ...loaded.writable, ...loaded.readonly];
  } else if (lookups.length) {
    const tables = await Promise.all(
      lookups.map((l) => connection.getAddressLookupTable(l.accountKey).then((r) => r.value)),
    );
    const missing = lookups.filter((_, i) => !tables[i]).map((l) => l.accountKey.toBase58());
    if (missing.length) throw new Error(`Address lookup table not found: ${missing.join(", ")}`);
    const accountKeys = msg.getAccountKeys({ addressLookupTableAccounts: tables as AddressLookupTableAccount[] });
    keys = [
      ...accountKeys.staticAccountKeys,
      ...(accountKeys.accountKeysFromLookups?.writable ?? []),
      ...(accountKeys.accountKeysFromLookups?.readonly ?? []),
    ];
  } else {
    keys = [...msg.staticAccountKeys];
  }

  const numSigners = msg.header.numRequiredSignatures;
  const signers = msg.staticAccountKeys.slice(0, numSigners).map((k) => k.toBase58());
  const writable = keys.filter((_, i) => msg.isAccountWritable(i)).map((k) => k.toBase58());

  return { tx, keys, signers, feePayer: signers[0], writable, usesLookupTables: lookups.length > 0 };
}

// ---------------- instruction decoding ----------------

const u64 = (b: Buffer, o: number) => (b.length >= o + 8 ? b.readBigUInt64LE(o).toString() : null);
const pk = (b: Buffer, o: number) => (b.length >= o + 32 ? new PublicKey(b.subarray(o, o + 32)).toBase58() : null);
const disc = (b: Buffer, d: number[]) => b.length >= 8 && d.every((x, i) => b[i] === x);

const TOKEN_IX: Record<number, string> = {
  0: "InitializeMint", 1: "InitializeAccount", 3: "Transfer", 4: "Approve", 5: "Revoke",
  6: "SetAuthority", 7: "MintTo", 8: "Burn", 9: "CloseAccount", 10: "FreezeAccount",
  11: "ThawAccount", 12: "TransferChecked", 13: "ApproveChecked", 14: "MintToChecked",
  15: "BurnChecked", 16: "InitializeAccount2", 17: "SyncNative", 18: "InitializeAccount3",
};
const AUTHORITY_TYPES = ["MintTokens", "FreezeAccount", "AccountOwner", "CloseAccount"];
const SYSTEM_IX: Record<number, string> = {
  0: "CreateAccount", 1: "Assign", 2: "Transfer", 3: "CreateAccountWithSeed",
  4: "AdvanceNonceAccount", 5: "WithdrawNonceAccount", 6: "InitializeNonceAccount",
  7: "AuthorizeNonceAccount", 8: "Allocate", 9: "AllocateWithSeed", 10: "AssignWithSeed",
  11: "TransferWithSeed", 12: "UpgradeNonceAccount",
};
const LOADER_IX: Record<number, string> = {
  0: "InitializeBuffer", 1: "Write", 2: "DeployWithMaxDataLen", 3: "Upgrade",
  4: "SetAuthority", 5: "Close", 6: "ExtendProgram", 7: "SetAuthorityChecked",
};
const STAKE_IX: Record<number, string> = {
  0: "Initialize", 1: "Authorize", 2: "DelegateStake", 3: "Split", 4: "Withdraw",
  5: "Deactivate", 7: "Merge", 8: "AuthorizeWithSeed", 10: "AuthorizeChecked",
};
const SQUADS_IX: [number[], string][] = [
  [multisig.generated.configTransactionCreateInstructionDiscriminator, "ConfigTransactionCreate"],
  [multisig.generated.configTransactionExecuteInstructionDiscriminator, "ConfigTransactionExecute"],
  [multisig.generated.multisigAddMemberInstructionDiscriminator, "MultisigAddMember"],
  [multisig.generated.multisigRemoveMemberInstructionDiscriminator, "MultisigRemoveMember"],
  [multisig.generated.multisigChangeThresholdInstructionDiscriminator, "MultisigChangeThreshold"],
  [multisig.generated.multisigSetConfigAuthorityInstructionDiscriminator, "MultisigSetConfigAuthority"],
  [multisig.generated.multisigAddSpendingLimitInstructionDiscriminator, "MultisigAddSpendingLimit"],
  [multisig.generated.multisigSetTimeLockInstructionDiscriminator, "MultisigSetTimeLock"],
];

export function decodeInstructions(r: ResolvedTx): DecodedInstruction[] {
  const msg = r.tx.message;
  return msg.compiledInstructions.map((ix, index) => {
    const programId = r.keys[ix.programIdIndex].toBase58();
    const data = Buffer.from(ix.data);
    const accounts = ix.accountKeyIndexes.map((i) => ({
      pubkey: r.keys[i]?.toBase58() ?? `#${i}`,
      isSigner: msg.isAccountSigner(i),
      isWritable: msg.isAccountWritable(i),
    }));
    const acct = (n: number) => accounts[n]?.pubkey ?? null;
    const programName = PROGRAM_NAMES[programId] ?? "Unknown program";
    const out: DecodedInstruction = {
      index, programId, programName, name: `${programName}: unknown`, accounts, args: {},
      dataBase64: data.toString("base64"),
    };

    if (TOKEN_PROGRAMS.has(programId)) {
      const t = data[0];
      out.name = `${programName}: ${TOKEN_IX[t] ?? `instruction ${t}`}`;
      if (t === 3) out.args = { source: acct(0), destination: acct(1), authority: acct(2), amount: u64(data, 1) };
      if (t === 12) out.args = { source: acct(0), mint: acct(1), destination: acct(2), authority: acct(3), amount: u64(data, 1), decimals: data[9] ?? null };
      if (t === 4) out.args = { account: acct(0), delegate: acct(1), owner: acct(2), amount: u64(data, 1) };
      if (t === 13) out.args = { account: acct(0), mint: acct(1), delegate: acct(2), owner: acct(3), amount: u64(data, 1), decimals: data[9] ?? null };
      if (t === 6) out.args = {
        account: acct(0), currentAuthority: acct(1),
        authorityType: AUTHORITY_TYPES[data[1]] ?? `type ${data[1]}`,
        newAuthority: data[2] === 1 ? pk(data, 3) : null,
      };
      if (t === 9) out.args = { account: acct(0), destination: acct(1), owner: acct(2) };
      if (t === 8 || t === 15) out.args = { account: acct(0), mint: acct(1), owner: acct(2), amount: u64(data, 1) };
      if (typeof out.args.mint === "string" && KNOWN_MINTS[out.args.mint]) out.args.token = KNOWN_MINTS[out.args.mint];
    } else if (programId === PROGRAMS.SYSTEM && data.length >= 4) {
      const t = data.readUInt32LE(0);
      out.name = `System: ${SYSTEM_IX[t] ?? `instruction ${t}`}`;
      if (t === 2) out.args = { from: acct(0), to: acct(1), lamports: u64(data, 4) };
      if (t === 11) out.args = { from: acct(0), to: acct(2), lamports: u64(data, 4) };
      if (t === 1) out.args = { account: acct(0), newOwnerProgram: pk(data, 4) };
      if (t === 10) out.args = { account: acct(0), base: acct(1) };
      if (t === 4) out.args = { nonceAccount: acct(0), nonceAuthority: acct(2) };
      if (t === 7) out.args = { nonceAccount: acct(0), newAuthority: pk(data, 4) };
      if (t === 0) out.args = { from: acct(0), newAccount: acct(1), lamports: u64(data, 4), owner: pk(data, 20) };
    } else if (programId === PROGRAMS.BPF_UPGRADEABLE_LOADER && data.length >= 4) {
      const t = data.readUInt32LE(0);
      out.name = `BPF Loader: ${LOADER_IX[t] ?? `instruction ${t}`}`;
      if (t === 3) out.args = { programData: acct(0), program: acct(1), buffer: acct(2), authority: acct(6) };
      if (t === 4) out.args = { account: acct(0), currentAuthority: acct(1), newAuthority: acct(2) };
      if (t === 7) out.args = { account: acct(0), currentAuthority: acct(1), newAuthority: acct(2) };
      if (t === 5) out.args = { account: acct(0), recipient: acct(1), authority: acct(2) };
    } else if (programId === PROGRAMS.STAKE && data.length >= 4) {
      const t = data.readUInt32LE(0);
      out.name = `Stake: ${STAKE_IX[t] ?? `instruction ${t}`}`;
      if (t === 1) out.args = { stakeAccount: acct(0), newAuthority: pk(data, 4), authorityType: data.readUInt32LE(36) === 0 ? "Staker" : "Withdrawer" };
      if (t === 4) out.args = { stakeAccount: acct(0), to: acct(1), lamports: u64(data, 4) };
    } else if (programId === PROGRAMS.SQUADS_V4) {
      const hit = SQUADS_IX.find(([d]) => disc(data, d));
      out.name = `Squads: ${hit ? hit[1] : "instruction"}`;
      if (hit?.[1] === "ConfigTransactionCreate") {
        try {
          const [args] = multisig.generated.configTransactionCreateStruct.deserialize(data);
          out.args = { multisig: acct(0), actions: args.args.actions.map((a) => a.__kind).join(", ") };
        } catch {
          out.args = { multisig: acct(0) };
        }
      } else if (hit) out.args = { multisig: acct(0) };
    } else if (programId === PROGRAMS.MEMO || programId === PROGRAMS.MEMO_V1) {
      out.name = "Memo";
      // Memo text is attacker-controlled: shown as data, never as instructions.
      out.args = { text: data.toString("utf8").slice(0, 500) };
    } else if (programId === PROGRAMS.COMPUTE_BUDGET) {
      out.name = `Compute Budget: ${["RequestUnits", "RequestHeapFrame", "SetComputeUnitLimit", "SetComputeUnitPrice", "SetLoadedAccountsDataSizeLimit"][data[0]] ?? "instruction"}`;
    } else if (programId === PROGRAMS.ASSOCIATED_TOKEN) {
      out.name = `Associated Token: ${data.length === 0 || data[0] === 0 ? "Create" : data[0] === 1 ? "CreateIdempotent" : "RecoverNested"}`;
      out.args = { payer: acct(0), account: acct(1), owner: acct(2), mint: acct(3) };
    } else if (programId === PROGRAMS.JUPITER_V6) {
      out.name = "Jupiter v6: swap/route";
    }
    return out;
  });
}
