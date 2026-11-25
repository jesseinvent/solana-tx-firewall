// Live mainnet smoke test (not part of `npm test`): npm run test:live
// Simulates with sigVerify off, so nothing is signed or sent.
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { AuthorityType, createSetAuthorityInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { scan } from "../src/lib/scanner/scan";

const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const show = (label: string, r: Awaited<ReturnType<typeof scan>>) =>
  console.log(`\n## ${label}\nverdict=${r.verdict} sim=${r.simulation.mode}/${r.simulation.success ? "ok" : r.simulation.error}\n` +
    `flags: ${r.flags.map((f) => `${f.severity}:${f.id}`).join(", ") || "none"}\n` +
    `signer changes: ${r.balanceChanges.filter((b) => b.signerAsset).map((b) => `${b.delta} ${b.asset}`).join(", ") || "none"}\n` +
    `summary (${r.summarySource}): ${r.summary}`);

async function main() {
  // A recent successful Jupiter swap → historical scan + a funded wallet to simulate with.
  const sigs = await connection.getSignaturesForAddress(new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"), { limit: 10 });
  const ok = sigs.find((s) => !s.err)!;
  const hist = await scan(ok.signature, { connection, explainWithAI: false });
  show(`historical swap ${ok.signature.slice(0, 12)}…`, hist);

  const wallet = new PublicKey(hist.feePayer);
  const { blockhash } = await connection.getLatestBlockhash();
  const mk = (ixs: TransactionInstruction[]) =>
    Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()).serialize()).toString("base64");

  show("simulated: send 0.001 SOL", await scan(
    mk([SystemProgram.transfer({ fromPubkey: wallet, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 })]),
    { connection, explainWithAI: false }));

  const tokenAccts = await connection.getTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID });
  if (tokenAccts.value.length) {
    show("simulated DRAINER: SetAuthority(AccountOwner) on a real token account", await scan(
      mk([createSetAuthorityInstruction(tokenAccts.value[0].pubkey, wallet, AuthorityType.AccountOwner, Keypair.generate().publicKey)]),
      { connection, explainWithAI: false }));
  } else console.log("\n(no token accounts on this wallet; skipped drainer simulation)");
}
main().catch((e) => { console.error(e); process.exit(1); });
