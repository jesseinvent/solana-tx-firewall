import { NextRequest, NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { scan } from "@/lib/scanner/scan";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const rpcUrl = () => process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

/**
 * POST /api/scan  { "input": "<base64|base58 tx, signature, or explorer URL>", "checkPoisoning": true }
 * Returns a ScanReport. Never needs a private key: transactions are simulated with sigVerify off.
 */
export async function POST(req: NextRequest) {
  let body: { input?: unknown; checkPoisoning?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send JSON: { input: string }" }, { status: 400 });
  }
  if (typeof body.input !== "string" || !body.input.trim())
    return NextResponse.json({ error: "`input` is required." }, { status: 400 });
  if (body.input.length > 20_000) return NextResponse.json({ error: "Input too large." }, { status: 413 });

  try {
    const report = await scan(body.input, {
      connection: new Connection(rpcUrl(), "confirmed"),
      checkPoisoning: body.checkPoisoning !== false,
    });
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 422 });
  }
}
