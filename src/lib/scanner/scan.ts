import { Connection, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { decodeInstructions, parseInput, resolveAccounts } from "./decode";
import { explain } from "./explain";
import { PROGRAMS } from "./programs";
import { effectRules, instructionRules, poisoningRule, verdictOf } from "./rules";
import { historicalEffects, simulateEffects } from "./simulate";
import { Flag, ScanReport } from "./types";

export type ScanOptions = {
  connection: Connection;
  /** Look up the signer's history for address-poisoning lookalikes (extra RPC calls). */
  checkPoisoning?: boolean;
  /** Ask Claude for the summary when ANTHROPIC_API_KEY is set. */
  explainWithAI?: boolean;
};

export async function scan(raw: string, opts: ScanOptions): Promise<ScanReport> {
  const { connection } = opts;
  const parsed = parseInput(raw);

  let resolved;
  let effects;
  if (parsed.kind === "signature") {
    const res = await connection.getTransaction(parsed.signature, {
      maxSupportedTransactionVersion: 1,
      commitment: "confirmed",
    });
    if (!res) throw new Error("Transaction not found on this cluster (it may be too old for this RPC, or not confirmed).");
    const tx = new VersionedTransaction(res.transaction.message, res.transaction.signatures.map((s) => bs58.decode(s)));
    resolved = await resolveAccounts(connection, tx, res.meta?.loadedAddresses);
    effects = historicalEffects(res, resolved);
  } else {
    resolved = await resolveAccounts(connection, parsed.tx);
    try {
      effects = await simulateEffects(connection, resolved);
    } catch (err) {
      effects = {
        simulation: { mode: "unavailable" as const, success: false, error: String(err), logs: [] },
        balanceChanges: [],
        authorityChanges: [],
      };
    }
  }

  const instructions = decodeInstructions(resolved);
  const flags: Flag[] = [
    ...instructionRules(instructions, { signers: resolved.signers, usesLookupTables: resolved.usesLookupTables }),
    ...effectRules(effects.balanceChanges, effects.authorityChanges),
  ];

  if (effects.simulation.mode === "simulated" && !effects.simulation.success)
    flags.push({ id: "simulation-failed", severity: "warning",
      title: "Simulation failed",
      detail: `The transaction errors against current chain state (${effects.simulation.error}). Effects couldn't be verified. Wallet drainers sometimes make simulation fail on purpose.` });
  if (effects.simulation.mode === "unavailable")
    flags.push({ id: "simulation-unavailable", severity: "warning",
      title: "Couldn't simulate",
      detail: `Only the instruction rules were applied. ${effects.simulation.error ?? ""}` });

  if (opts.checkPoisoning && resolved.signers[0]) {
    const destinations = [
      ...instructions.filter((i) => i.name === "System: Transfer").map((i) => String(i.args.to)),
      ...effects.balanceChanges.filter((b) => !b.signerAsset && !b.delta.startsWith("-")).map((b) => b.owner),
    ].filter((d) => d && !resolved.signers.includes(d) && d !== PROGRAMS.SYSTEM);
    try {
      flags.push(...(await poisoningRule(connection, resolved.signers[0], destinations)));
    } catch {
      // History lookups are best-effort (rate limits on public RPCs).
    }
  }

  const order = { critical: 0, warning: 1, info: 2 };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);

  const base = {
    input: parsed.kind === "signature" ? { kind: "signature" as const, signature: parsed.signature } : { kind: "transaction" as const },
    verdict: verdictOf(flags),
    signers: resolved.signers,
    feePayer: resolved.feePayer,
    usesLookupTables: resolved.usesLookupTables,
    instructions,
    flags,
    ...effects,
  };
  const { summary, summarySource } = opts.explainWithAI === false
    ? { summary: (await import("./explain")).rulesSummary(base), summarySource: "rules" as const }
    : await explain(base);
  return { ...base, summary, summarySource };
}
