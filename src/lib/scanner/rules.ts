import { Connection, PublicKey } from "@solana/web3.js";
import { AuthorityChange, BalanceChange, DecodedInstruction, Flag, Verdict } from "./types";
import { KNOWN_PROGRAMS, PROGRAMS, PROGRAM_NAMES, short } from "./programs";

const U64_MAX = "18446744073709551615";

type Ctx = { signers: string[]; usesLookupTables: boolean };

/**
 * Rules on the decoded instructions alone. Deterministic: these, not the AI,
 * decide the verdict.
 */
export function instructionRules(ixs: DecodedInstruction[], ctx: Ctx): Flag[] {
  const flags: Flag[] = [];
  const isSigner = (a: unknown) => typeof a === "string" && ctx.signers.includes(a);
  const createdInTx = new Set(
    ixs.filter((i) => i.name === "System: CreateAccount").map((i) => String(i.args.newAccount)),
  );

  for (const ix of ixs) {
    const a = ix.args;
    const at = { instruction: ix.index };

    switch (ix.name.replace(/^Token-2022:/, "Token:")) {
      case "Token: SetAuthority": {
        const to = a.newAuthority ? short(String(a.newAuthority)) : "nobody";
        if (a.authorityType === "AccountOwner" && !isSigner(a.newAuthority))
          flags.push({ id: "token-owner-change", severity: "critical", ...at,
            title: "Gives away ownership of a token account",
            detail: `Token account ${short(String(a.account))} would be owned by ${to}. The new owner can move every token in it. This is the most common wallet-drainer technique.` });
        else if (a.authorityType === "CloseAccount" && !isSigner(a.newAuthority))
          flags.push({ id: "token-close-authority", severity: "warning", ...at,
            title: "Changes who can close a token account",
            detail: `Close authority of ${short(String(a.account))} moves to ${to}.` });
        else if (a.authorityType === "MintTokens" || a.authorityType === "FreezeAccount")
          flags.push({ id: "mint-authority-change", severity: "warning", ...at,
            title: `Changes a mint's ${a.authorityType === "MintTokens" ? "mint" : "freeze"} authority`,
            detail: `Authority of ${short(String(a.account))} moves to ${to}.` });
        break;
      }
      case "Token: Approve":
      case "Token: ApproveChecked": {
        if (isSigner(a.delegate)) break;
        const unlimited = a.amount === U64_MAX;
        flags.push({ id: "token-approve", severity: "critical", ...at,
          title: unlimited ? "Grants UNLIMITED spending of your tokens" : "Lets someone else spend your tokens",
          detail: `${short(String(a.delegate))} could transfer ${unlimited ? "all" : `up to ${a.amount} base units of`} the tokens in ${short(String(a.account))}${a.token ? ` (${a.token})` : ""} at any time, without asking again.` });
        break;
      }
      case "Token: CloseAccount":
        if (!isSigner(a.destination))
          flags.push({ id: "close-to-other", severity: "warning", ...at,
            title: "Closes a token account and sends its rent elsewhere",
            detail: `${short(String(a.account))} is closed and its SOL rent goes to ${short(String(a.destination))}.` });
        break;
      case "System: Assign":
      case "System: AssignWithSeed":
        if (!createdInTx.has(String(a.account)))
          flags.push({ id: "system-assign", severity: "critical", ...at,
            title: "Hands an existing account to another program",
            detail: `${short(String(a.account))} would be owned by ${a.newOwnerProgram ? short(String(a.newOwnerProgram)) : "another program"}. If this is your wallet, that program controls its SOL.` });
        break;
      case "System: AdvanceNonceAccount":
        flags.push({ id: "durable-nonce", severity: "warning", ...at,
          title: "Uses a durable nonce: can be executed much later",
          detail: "This transaction doesn't expire after about a minute like normal ones. Whoever holds the signed copy can submit it hours or weeks later. Attackers use this to collect signatures and drain wallets later." });
        break;
      case "System: AuthorizeNonceAccount":
        flags.push({ id: "nonce-authority", severity: "warning", ...at,
          title: "Changes a durable-nonce authority",
          detail: `Nonce account ${short(String(a.nonceAccount))} would be controlled by ${short(String(a.newAuthority))}.` });
        break;
      case "BPF Loader: Upgrade":
        flags.push({ id: "program-upgrade", severity: "critical", ...at,
          title: "Upgrades a program's code",
          detail: `Replaces the code of program ${short(String(a.program))}. Only sign if you deployed this build yourself.` });
        break;
      case "BPF Loader: SetAuthority":
      case "BPF Loader: SetAuthorityChecked":
        flags.push({ id: "program-authority", severity: "critical", ...at,
          title: "Transfers a program's upgrade authority",
          detail: `Upgrade authority of ${short(String(a.account))} moves to ${a.newAuthority ? short(String(a.newAuthority)) : "nobody (immutable)"}. The new authority can replace the program's code.` });
        break;
      case "BPF Loader: Close":
        flags.push({ id: "program-close", severity: "warning", ...at,
          title: "Closes a program or buffer account",
          detail: `${short(String(a.account))} is closed and its SOL goes to ${short(String(a.recipient))}.` });
        break;
      case "Stake: Authorize":
        if (!isSigner(a.newAuthority))
          flags.push({ id: "stake-authority", severity: "critical", ...at,
            title: `Gives away a stake account's ${a.authorityType} authority`,
            detail: `${short(String(a.newAuthority))} would control stake account ${short(String(a.stakeAccount))}${a.authorityType === "Withdrawer" ? ", including withdrawing all of it" : ""}.` });
        break;
    }

    if (ix.programId === PROGRAMS.SQUADS_V4 && /Config|AddMember|RemoveMember|Threshold|SpendingLimit|TimeLock/.test(ix.name))
      flags.push({ id: "squads-config", severity: "warning", ...at,
        title: "Changes a Squads multisig's configuration",
        detail: `${ix.name.replace("Squads: ", "")}${a.actions ? ` (${a.actions})` : ""} on multisig ${short(String(a.multisig))}. Check members, threshold and spending limits carefully.` });

    if (ix.programName === "Memo" || ix.name === "Memo")
      flags.push({ id: "memo", severity: "info", ...at,
        title: "Contains a memo",
        detail: `Memo text (written by whoever built the transaction): "${String(a.text).slice(0, 140)}"` });
  }

  const unknown = [...new Set(ixs.map((i) => i.programId).filter((p) => !KNOWN_PROGRAMS.has(p)))];
  for (const p of unknown)
    flags.push({ id: "unknown-program", severity: "info",
      title: "Calls a program this scanner doesn't recognize",
      detail: `${p}. Its effects are only visible through simulation below. Make sure you trust the app that built this transaction.` });

  if (ctx.usesLookupTables)
    flags.push({ id: "lookup-tables", severity: "info",
      title: "Uses address lookup tables",
      detail: "Some accounts aren't listed in the transaction itself. They're resolved from on-chain tables (shown in full below). Common for swaps, but also used to hide destinations." });

  return flags;
}

/** Rules on what the simulation (or the historical result) says actually changes. */
export function effectRules(balances: BalanceChange[], authorities: AuthorityChange[]): Flag[] {
  const flags: Flag[] = [];

  for (const c of authorities.filter((c) => c.signerAsset)) {
    if (c.kind === "token-owner")
      flags.push({ id: "sim-token-owner", severity: "critical",
        title: "Simulation: your token account changes owner",
        detail: `${short(c.account)} goes from ${short(c.before ?? "?")} to ${short(c.after ?? "?")}.` });
    if (c.kind === "token-delegate" && c.after)
      flags.push({ id: "sim-delegate", severity: "critical",
        title: "Simulation: a delegate can spend your tokens",
        detail: `${short(c.after)} becomes delegate of ${short(c.account)}.` });
    if (c.kind === "program-owner")
      flags.push({ id: "sim-program-owner", severity: "critical",
        title: "Simulation: your account is handed to another program",
        detail: `${short(c.account)} owner program: ${PROGRAM_NAMES[c.before ?? ""] ?? short(c.before ?? "?")} → ${PROGRAM_NAMES[c.after ?? ""] ?? short(c.after ?? "?")}.` });
    if (c.kind === "closed")
      flags.push({ id: "sim-closed", severity: "warning",
        title: "Simulation: one of your accounts is closed",
        detail: `${short(c.account)} is closed.` });
  }

  const mine = balances.filter((b) => b.signerAsset);
  const out = mine.filter((b) => b.delta.startsWith("-"));
  const inn = mine.filter((b) => !b.delta.startsWith("-") && b.delta !== "0");
  // Ignore SOL-only outflows that are just fees (< 0.01 SOL).
  const meaningfulOut = out.filter((b) => b.asset !== "SOL" || Number(b.delta) <= -0.01);
  const outAssets = new Set(meaningfulOut.map((b) => b.mint ?? b.asset));

  if (outAssets.size >= 3)
    flags.push({ id: "multi-asset-drain", severity: "critical",
      title: `Moves ${outAssets.size} different assets out of your wallet`,
      detail: "Sweeping several assets in one transaction is typical of wallet drainers. " +
        meaningfulOut.map((b) => `${b.delta} ${b.asset}`).join(", ") });
  else if (meaningfulOut.length && !inn.length)
    flags.push({ id: "outflow-only", severity: "warning",
      title: "You send assets and receive nothing back",
      detail: `${meaningfulOut.map((b) => `${b.delta.replace("-", "")} ${b.asset}`).join(", ")} leaves your wallet. Fine for a payment, but check the recipient.` });

  return flags;
}

/**
 * Address poisoning: attackers send dust from an address that looks like one you
 * use (same first/last characters), hoping you copy it from your history.
 */
export async function poisoningRule(
  connection: Connection,
  signer: string,
  destinations: string[],
): Promise<Flag[]> {
  if (!destinations.length) return [];
  const sigs = await connection.getSignaturesForAddress(new PublicKey(signer), { limit: 25 });
  if (!sigs.length) return [];
  const txs = await connection.getTransactions(sigs.map((s) => s.signature), { maxSupportedTransactionVersion: 1 });
  const seen = new Set<string>();
  for (const t of txs) for (const k of t?.transaction.message.staticAccountKeys ?? []) seen.add(k.toBase58());

  const flags: Flag[] = [];
  for (const d of new Set(destinations)) {
    if (seen.has(d)) continue;
    const twin = [...seen].find((s) => s !== d && s.slice(0, 4) === d.slice(0, 4) && s.slice(-4) === d.slice(-4));
    if (twin)
      flags.push({ id: "address-poisoning", severity: "critical",
        title: "Destination looks like an address you've used, but isn't",
        detail: `Sending to ${d}, which mimics ${twin} from your recent history (same first and last 4 characters). This is a classic address-poisoning scam.` });
  }
  return flags;
}

export function verdictOf(flags: Flag[]): Verdict {
  if (flags.some((f) => f.severity === "critical")) return "block";
  if (flags.some((f) => f.severity === "warning")) return "review";
  return "safe";
}
