"use client";

import { useState } from "react";
import type { Flag, ScanReport, Severity, Verdict } from "@/lib/scanner/types";

const VERDICT: Record<Verdict, { label: string; icon: string; cls: string; text: string }> = {
  block: { label: "Do not sign", icon: "⛔", cls: "border-red-500/60 bg-red-500/10", text: "text-red-300" },
  review: { label: "Review carefully", icon: "⚠️", cls: "border-amber-500/60 bg-amber-500/10", text: "text-amber-300" },
  safe: { label: "No dangerous patterns found", icon: "✅", cls: "border-emerald-500/60 bg-emerald-500/10", text: "text-emerald-300" },
};
const SEV: Record<Severity, string> = {
  critical: "bg-red-500/20 text-red-300",
  warning: "bg-amber-500/20 text-amber-300",
  info: "bg-zinc-700/60 text-zinc-300",
};

export function Scanner() {
  const [input, setInput] = useState("");
  const [poisoning, setPoisoning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<ScanReport | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setReport(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, checkPoisoning: poisoning }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setReport(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Solana Transaction Firewall</h1>
        <p className="text-sm text-zinc-400">
          See what a transaction really does before you sign it. It&apos;s simulated against mainnet; nothing is signed or sent.
        </p>
      </header>

      <form onSubmit={run} className="space-y-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={5}
          placeholder="Paste a serialized transaction (base64 or base58), a transaction signature, or a Solscan / Explorer link"
          className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs"
        />
        <div className="flex items-center justify-between gap-4">
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <input type="checkbox" checked={poisoning} onChange={(e) => setPoisoning(e.target.checked)} />
            Check for address-poisoning lookalikes (looks up the signer&apos;s recent history)
          </label>
          <button
            disabled={busy || !input.trim()}
            className="rounded-lg bg-violet-600 px-5 py-2 font-medium hover:bg-violet-500 disabled:opacity-50"
          >
            {busy ? "Scanning…" : "Scan"}
          </button>
        </div>
      </form>

      {error && <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
      {report && <Report r={report} />}
    </main>
  );
}

function Report({ r }: { r: ScanReport }) {
  const v = VERDICT[r.verdict];
  const mine = r.balanceChanges.filter((b) => b.signerAsset);
  const others = r.balanceChanges.filter((b) => !b.signerAsset);

  return (
    <div className="space-y-5">
      <section className={`rounded-xl border p-5 ${v.cls}`}>
        <p className={`text-xl font-semibold ${v.text}`}>
          {v.icon} {v.label}
        </p>
        <p className="mt-2 leading-relaxed">{r.summary}</p>
        <p className="mt-2 text-xs text-zinc-500">
          Summary by {r.summarySource === "claude" ? "Claude (explains the rules; doesn't set the verdict)" : "rule engine"} ·{" "}
          {r.input.kind === "signature" ? "already executed on-chain" : `simulation: ${r.simulation.mode}`}
          {r.simulation.unitsConsumed ? ` · ${r.simulation.unitsConsumed.toLocaleString()} CU` : ""}
        </p>
      </section>

      {r.flags.length > 0 && (
        <Card title={`Findings (${r.flags.length})`}>
          <ul className="space-y-3">
            {r.flags.map((f, i) => (
              <FlagRow key={i} f={f} />
            ))}
          </ul>
        </Card>
      )}

      <Card title="Your balance changes">
        {mine.length ? <Changes rows={mine} /> : <p className="text-sm text-zinc-500">None for the signer.</p>}
        {others.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-zinc-400">Other accounts ({others.length})</summary>
            <Changes rows={others} />
          </details>
        )}
      </Card>

      {r.authorityChanges.length > 0 && (
        <Card title="Ownership & permission changes">
          <ul className="space-y-1 font-mono text-xs">
            {r.authorityChanges.map((c, i) => (
              <li key={i} className={`break-all ${c.signerAsset ? "text-red-300" : "text-zinc-400"}`}>
                {c.kind} · {c.account}: {c.before ?? "∅"} → {c.after ?? "∅"}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={`Instructions (${r.instructions.length})`}>
        <ol className="space-y-2">
          {r.instructions.map((ix) => (
            <li key={ix.index} className="rounded-lg border border-zinc-800 p-3">
              <p className="text-sm font-medium">
                #{ix.index} {ix.name}
              </p>
              <p className="font-mono text-xs text-zinc-500 break-all">{ix.programId}</p>
              {Object.keys(ix.args).length > 0 && (
                <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
                  {Object.entries(ix.args).map(([k, val]) => (
                    <div key={k} className="contents">
                      <dt className="text-zinc-500">{k}</dt>
                      <dd className="break-all">{String(val)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-zinc-500">
          Signers: {r.signers.join(", ")}
          {r.usesLookupTables ? " · uses address lookup tables" : ""}
        </p>
      </Card>

      {r.simulation.logs.length > 0 && (
        <Card title="Program logs">
          <details>
            <summary className="cursor-pointer text-sm text-zinc-400">
              {r.simulation.success ? "Succeeded" : `Failed: ${r.simulation.error}`}: show {r.simulation.logs.length} lines
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs text-zinc-400">
              {r.simulation.logs.join("\n")}
            </pre>
          </details>
        </Card>
      )}
    </div>
  );
}

function FlagRow({ f }: { f: Flag }) {
  return (
    <li className="flex gap-3">
      <span className={`h-fit shrink-0 rounded px-2 py-0.5 text-xs font-medium uppercase ${SEV[f.severity]}`}>{f.severity}</span>
      <div>
        <p className="font-medium">
          {f.title}
          {f.instruction !== undefined && <span className="ml-2 text-xs text-zinc-500">ix #{f.instruction}</span>}
        </p>
        <p className="text-sm text-zinc-400 break-words">{f.detail}</p>
      </div>
    </li>
  );
}

function Changes({ rows }: { rows: ScanReport["balanceChanges"] }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map((b, i) => (
          <tr key={i} className="border-t border-zinc-800">
            <td className="py-1.5 pr-3">{b.asset}</td>
            <td className={`pr-3 text-right font-mono tabular-nums ${b.delta.startsWith("-") ? "text-red-300" : "text-emerald-300"}`}>
              {b.delta}
            </td>
            <td className="text-right font-mono text-xs text-zinc-500" title={b.account}>
              {b.owner.slice(0, 4)}…{b.owner.slice(-4)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">{title}</h2>
      {children}
    </section>
  );
}
