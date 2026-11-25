import {
  AccountInfo,
  Connection,
  ParsedTransactionMeta,
  PublicKey,
  TransactionResponse,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { AccountLayout, ACCOUNT_SIZE, MintLayout } from "@solana/spl-token";
import { ResolvedTx } from "./decode";
import { KNOWN_MINTS, TOKEN_PROGRAMS } from "./programs";
import { AuthorityChange, BalanceChange, ScanReport } from "./types";

type Effects = {
  simulation: ScanReport["simulation"];
  balanceChanges: BalanceChange[];
  authorityChanges: AuthorityChange[];
};

export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

const signed = (raw: bigint, decimals: number) => (raw > 0n ? "+" : "") + formatUnits(raw, decimals);
const symbol = (mint: string) => KNOWN_MINTS[mint] ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;

type TokenState = { mint: string; owner: string; amount: bigint; delegate: string | null; closeAuthority: string | null };

function decodeToken(owner: string, data: Buffer): TokenState | null {
  if (!TOKEN_PROGRAMS.has(owner) || data.length < ACCOUNT_SIZE) return null;
  try {
    const a = AccountLayout.decode(data.subarray(0, ACCOUNT_SIZE));
    return {
      mint: a.mint.toBase58(),
      owner: a.owner.toBase58(),
      amount: a.amount,
      delegate: a.delegateOption ? a.delegate.toBase58() : null,
      closeAuthority: a.closeAuthorityOption ? a.closeAuthority.toBase58() : null,
    };
  } catch {
    return null;
  }
}

async function mintDecimals(connection: Connection, mints: string[]): Promise<Record<string, number>> {
  const unique = [...new Set(mints)];
  if (!unique.length) return {};
  const infos = await connection.getMultipleAccountsInfo(unique.map((m) => new PublicKey(m)));
  const out: Record<string, number> = {};
  unique.forEach((m, i) => {
    const d = infos[i]?.data;
    if (d && d.length >= MintLayout.span) out[m] = MintLayout.decode(d.subarray(0, MintLayout.span)).decimals;
  });
  return out;
}

/** Simulate an unsigned/unsent transaction and diff every writable account. */
export async function simulateEffects(connection: Connection, r: ResolvedTx): Promise<Effects> {
  const writable = [...new Set(r.writable)].slice(0, 100);
  const writableKeys = writable.map((a) => new PublicKey(a));

  const [pre, sim] = await Promise.all([
    connection.getMultipleAccountsInfo(writableKeys),
    connection.simulateTransaction(r.tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: writable },
    }),
  ]);

  const simulation: ScanReport["simulation"] = {
    mode: "simulated",
    success: !sim.value.err,
    error: sim.value.err ? JSON.stringify(sim.value.err) : undefined,
    logs: sim.value.logs ?? [],
    unitsConsumed: sim.value.unitsConsumed,
  };
  // A failed simulation changes nothing on-chain; the instruction rules still apply.
  if (sim.value.err || !sim.value.accounts) return { simulation, balanceChanges: [], authorityChanges: [] };

  const post = sim.value.accounts.map((a) =>
    a ? { lamports: a.lamports, owner: a.owner, data: Buffer.from(a.data[0], "base64") } : null,
  );

  const preTok = writable.map((_, i) => (pre[i] ? decodeToken(pre[i]!.owner.toBase58(), pre[i]!.data) : null));
  const postTok = writable.map((_, i) => (post[i] ? decodeToken(post[i]!.owner, post[i]!.data) : null));
  const decimals = await mintDecimals(
    connection,
    [...preTok, ...postTok].filter((t): t is TokenState => !!t).map((t) => t.mint),
  );

  const isSigner = (a: string | null | undefined) => !!a && r.signers.includes(a);
  const balanceChanges: BalanceChange[] = [];
  const authorityChanges: AuthorityChange[] = [];

  writable.forEach((account, i) => {
    const before = pre[i] as AccountInfo<Buffer> | null;
    const after = post[i];
    const bt = preTok[i];
    const at = postTok[i];
    const tokenOwner = bt?.owner ?? at?.owner;

    if (bt || at) {
      const mint = (bt ?? at)!.mint;
      const dec = decimals[mint] ?? 0;
      const delta = (at?.amount ?? 0n) - (bt?.amount ?? 0n);
      if (delta !== 0n)
        balanceChanges.push({
          account, owner: tokenOwner!, asset: symbol(mint), mint,
          before: formatUnits(bt?.amount ?? 0n, dec), after: formatUnits(at?.amount ?? 0n, dec),
          delta: signed(delta, dec), signerAsset: isSigner(bt?.owner) || isSigner(at?.owner),
        });
      const mine = isSigner(bt?.owner);
      if (bt && at && bt.owner !== at.owner)
        authorityChanges.push({ account, kind: "token-owner", before: bt.owner, after: at.owner, signerAsset: mine });
      if (bt && at && bt.delegate !== at.delegate)
        authorityChanges.push({ account, kind: "token-delegate", before: bt.delegate, after: at.delegate, signerAsset: mine });
      if (bt && at && bt.closeAuthority !== at.closeAuthority)
        authorityChanges.push({ account, kind: "token-close-authority", before: bt.closeAuthority, after: at.closeAuthority, signerAsset: mine });
      if (bt && (!after || after.lamports === 0))
        authorityChanges.push({ account, kind: "closed", before: bt.owner, after: null, signerAsset: mine });
      return;
    }

    const lamBefore = BigInt(before?.lamports ?? 0);
    const lamAfter = BigInt(after?.lamports ?? 0);
    if (lamBefore !== lamAfter)
      balanceChanges.push({
        account, owner: account, asset: "SOL",
        before: formatUnits(lamBefore, 9), after: formatUnits(lamAfter, 9),
        delta: signed(lamAfter - lamBefore, 9), signerAsset: isSigner(account),
      });
    if (before && after && before.owner.toBase58() !== after.owner)
      authorityChanges.push({ account, kind: "program-owner", before: before.owner.toBase58(), after: after.owner, signerAsset: isSigner(account) });
    if (before && !after && before.lamports > 0)
      authorityChanges.push({ account, kind: "closed", before: before.owner.toBase58(), after: null, signerAsset: isSigner(account) });
  });

  return { simulation, balanceChanges, authorityChanges };
}

/** For an already-executed transaction: effects come from the RPC's recorded balances. */
export function historicalEffects(
  res: VersionedTransactionResponse | TransactionResponse,
  r: ResolvedTx,
): Effects {
  const meta = res.meta as ParsedTransactionMeta | null;
  const simulation: ScanReport["simulation"] = {
    mode: "historical",
    success: !meta?.err,
    error: meta?.err ? JSON.stringify(meta.err) : undefined,
    logs: meta?.logMessages ?? [],
    unitsConsumed: meta?.computeUnitsConsumed,
  };
  if (!meta) return { simulation, balanceChanges: [], authorityChanges: [] };

  const isSigner = (a?: string) => !!a && r.signers.includes(a);
  const balanceChanges: BalanceChange[] = [];
  const authorityChanges: AuthorityChange[] = [];
  const tokenIdx = new Set([...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])].map((b) => b.accountIndex));

  r.keys.forEach((k, i) => {
    if (tokenIdx.has(i)) return;
    const b = BigInt(meta.preBalances[i] ?? 0);
    const a = BigInt(meta.postBalances[i] ?? 0);
    if (a !== b) {
      const account = k.toBase58();
      balanceChanges.push({
        account, owner: account, asset: "SOL",
        before: formatUnits(b, 9), after: formatUnits(a, 9), delta: signed(a - b, 9), signerAsset: isSigner(account),
      });
    }
  });

  for (const idx of tokenIdx) {
    const b = meta.preTokenBalances?.find((x) => x.accountIndex === idx);
    const a = meta.postTokenBalances?.find((x) => x.accountIndex === idx);
    const mint = (a ?? b)!.mint;
    const dec = (a ?? b)!.uiTokenAmount.decimals;
    const before = BigInt(b?.uiTokenAmount.amount ?? "0");
    const after = BigInt(a?.uiTokenAmount.amount ?? "0");
    const account = r.keys[idx]?.toBase58() ?? `#${idx}`;
    if (before !== after)
      balanceChanges.push({
        account, owner: (b?.owner ?? a?.owner) ?? "?", asset: symbol(mint), mint,
        before: formatUnits(before, dec), after: formatUnits(after, dec),
        delta: signed(after - before, dec), signerAsset: isSigner(b?.owner) || isSigner(a?.owner),
      });
    if (b?.owner && a?.owner && b.owner !== a.owner)
      authorityChanges.push({ account, kind: "token-owner", before: b.owner, after: a.owner, signerAsset: isSigner(b.owner) });
  }
  return { simulation, balanceChanges, authorityChanges };
}
