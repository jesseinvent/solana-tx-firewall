// Offline tests: build malicious and benign transactions and check what the rule
// engine flags. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection,
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  AuthorityType,
  createApproveInstruction,
  createCloseAccountInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";
import { decodeInstructions, parseInput, resolveAccounts } from "../src/lib/scanner/decode";
import { effectRules, instructionRules, verdictOf } from "../src/lib/scanner/rules";
import { formatUnits } from "../src/lib/scanner/simulate";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const victim = Keypair.generate().publicKey;
const attacker = Keypair.generate().publicKey;
const victimAta = getAssociatedTokenAddressSync(USDC, victim);
const offline = new Connection("http://127.0.0.1:1"); // never called without lookup tables

function build(ixs: TransactionInstruction[]) {
  const msg = new TransactionMessage({
    payerKey: victim,
    recentBlockhash: bs58.encode(new Uint8Array(32).fill(7)),
    instructions: ixs,
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

async function flagsFor(tx: VersionedTransaction) {
  // Round-trip through the input parser, as the API does.
  const parsed = parseInput(Buffer.from(tx.serialize()).toString("base64"));
  assert.equal(parsed.kind, "transaction");
  const r = await resolveAccounts(offline, parsed.kind === "transaction" ? parsed.tx : tx);
  const ixs = decodeInstructions(r);
  const flags = instructionRules(ixs, { signers: r.signers, usesLookupTables: r.usesLookupTables });
  return { ixs, flags, ids: flags.map((f) => f.id), verdict: verdictOf(flags) };
}

test("token account owner change to attacker → critical / block", async () => {
  const { ids, verdict, ixs } = await flagsFor(
    build([createSetAuthorityInstruction(victimAta, victim, AuthorityType.AccountOwner, attacker)]),
  );
  assert.equal(ixs[0].name, "Token: SetAuthority");
  assert.equal(ixs[0].args.newAuthority, attacker.toBase58());
  assert.ok(ids.includes("token-owner-change"));
  assert.equal(verdict, "block");
});

test("unlimited approve to attacker → critical, says UNLIMITED", async () => {
  const { flags, verdict } = await flagsFor(
    build([createApproveInstruction(victimAta, attacker, victim, BigInt("18446744073709551615"))]),
  );
  const f = flags.find((x) => x.id === "token-approve");
  assert.ok(f);
  assert.match(f!.title, /UNLIMITED/);
  assert.equal(verdict, "block");
});

test("approve to the signer itself is not flagged", async () => {
  const { ids } = await flagsFor(build([createApproveInstruction(victimAta, victim, victim, 5n)]));
  assert.ok(!ids.includes("token-approve"));
});

test("System Assign of the signer's wallet → critical", async () => {
  const { ids, verdict } = await flagsFor(
    build([SystemProgram.assign({ accountPubkey: victim, programId: Keypair.generate().publicKey })]),
  );
  assert.ok(ids.includes("system-assign"));
  assert.ok(ids.includes("unknown-program") === false); // the assigned-to program isn't invoked
  assert.equal(verdict, "block");
});

test("Assign of an account created in the same tx is normal", async () => {
  const fresh = Keypair.generate().publicKey;
  const { ids } = await flagsFor(
    build([
      SystemProgram.createAccount({ fromPubkey: victim, newAccountPubkey: fresh, lamports: 1_000_000, space: NONCE_ACCOUNT_LENGTH, programId: SystemProgram.programId }),
      SystemProgram.assign({ accountPubkey: fresh, programId: SystemProgram.programId }),
    ]),
  );
  assert.ok(!ids.includes("system-assign"));
});

test("durable nonce transaction → warning / review", async () => {
  const nonce = Keypair.generate().publicKey;
  const { ids, verdict } = await flagsFor(
    build([
      SystemProgram.nonceAdvance({ noncePubkey: nonce, authorizedPubkey: victim }),
      SystemProgram.transfer({ fromPubkey: victim, toPubkey: attacker, lamports: 1_000_000 }),
    ]),
  );
  assert.ok(ids.includes("durable-nonce"));
  assert.equal(verdict, "review");
});

test("closing a token account into someone else's wallet → warning", async () => {
  const { ids } = await flagsFor(build([createCloseAccountInstruction(victimAta, attacker, victim)]));
  assert.ok(ids.includes("close-to-other"));
});

test("plain SOL transfer → safe from instruction rules alone", async () => {
  const { verdict, ixs } = await flagsFor(
    build([SystemProgram.transfer({ fromPubkey: victim, toPubkey: attacker, lamports: 5_000_000 })]),
  );
  assert.equal(ixs[0].name, "System: Transfer");
  assert.equal(ixs[0].args.lamports, "5000000");
  assert.equal(verdict, "safe");
});

test("effect rules: sweeping 3 assets → critical drain", () => {
  const mk = (asset: string, delta: string) => ({
    account: asset, owner: victim.toBase58(), asset, before: "1", after: "0", delta, signerAsset: true,
  });
  const flags = effectRules([mk("SOL", "-1.5"), mk("USDC", "-200"), mk("JUP", "-50")], []);
  assert.ok(flags.some((f) => f.id === "multi-asset-drain" && f.severity === "critical"));
});

test("effect rules: swap (out + in) is not 'outflow-only'", () => {
  const mk = (asset: string, delta: string) => ({
    account: asset, owner: victim.toBase58(), asset, before: "1", after: "0", delta, signerAsset: true,
  });
  const flags = effectRules([mk("USDC", "-100"), mk("SOL", "+0.68")], []);
  assert.equal(flags.length, 0);
});

test("parseInput: signature and explorer URLs", () => {
  const sig = bs58.encode(new Uint8Array(64).fill(9));
  assert.deepEqual(parseInput(sig), { kind: "signature", signature: sig });
  assert.deepEqual(parseInput(`https://solscan.io/tx/${sig}`), { kind: "signature", signature: sig });
  assert.throws(() => parseInput("hello world"));
});

test("formatUnits", () => {
  assert.equal(formatUnits(1_500_000n, 6), "1.5");
  assert.equal(formatUnits(-25n, 9), "-0.000000025");
  assert.equal(formatUnits(0n, 6), "0");
});
