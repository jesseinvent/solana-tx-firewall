# Solana Transaction Firewall

See what a Solana transaction **really** does before you sign it.

Paste a transaction (or a signature / explorer link). The scanner decodes every instruction,
**simulates it against mainnet** (no signature needed, nothing is sent), diffs every account it
touches, and runs a security rule engine. You get a verdict, **⛔ block / ⚠️ review / ✅ safe**,
and a plain-English explanation.

Most Solana thefts don't break cryptography. They trick you into signing. This catches the tricks.

## What it detects

| Rule | Severity | Why it matters |
|---|---|---|
| Token `SetAuthority(AccountOwner)` to someone else | critical | The #1 drainer technique: the new owner can move every token in the account |
| Token `Approve` / `ApproveChecked` to someone else | critical | A delegate can spend your tokens later without asking. Unlimited approvals are called out |
| System `Assign` of an existing account | critical | Hands your wallet's SOL to another program |
| BPF Loader `Upgrade` / `SetAuthority` | critical | Replaces a program's code or gives away its upgrade authority |
| Stake `Authorize` to someone else | critical | Gives away control or withdrawal of a stake account |
| Address poisoning (lookalike destination) | critical | Destination matches the first and last 4 characters of an address in your recent history, but isn't it |
| Simulation: your token account changes owner / gets a delegate / is reassigned | critical | Confirms the effect, even when hidden behind an unknown program |
| Simulation: 3+ assets leave your wallet | critical | Typical "sweep everything" drainer |
| Durable nonce (`AdvanceNonceAccount`) | warning | The signed transaction never expires and can be executed weeks later |
| `CloseAccount` with rent sent to someone else | warning | Closes your token account |
| Mint / freeze / close authority changes | warning | |
| Squads multisig config changes | warning | Members, threshold, spending limits, time lock |
| You send assets and receive nothing | warning | Fine for payments, so check the recipient |
| Simulation failed or unavailable | warning | Drainers sometimes make simulation fail on purpose |
| Unknown programs, lookup tables, memos | info | Context for the review |

Supports legacy, v0 (with address lookup tables) and v1 transactions, plus Token and Token-2022.
Already-executed transactions (by signature or link) are analyzed from their recorded on-chain
balance changes instead of simulation.

## How it works

```
input ─► parse (base64 / base58 tx, signature, explorer URL)
      ─► resolve accounts (incl. lookup tables)
      ─► decode instructions  ─► instruction rules ─┐
      ─► simulate + diff accounts ─► effect rules ──┼─► verdict (rules only)
      ─► signer history ─► address-poisoning rule ──┘
      ─► summary: Claude if ANTHROPIC_API_KEY is set, otherwise template
```

**The AI never decides.** The verdict comes only from deterministic rules
([`src/lib/scanner/rules.ts`](src/lib/scanner/rules.ts)). Claude only explains the report in plain
English and is told that memo text, logs and addresses are untrusted data, not instructions.
Without a key, the rule engine writes the summary.

## Run it

Requires Node ≥ 20.19 (`nvm use` reads `.nvmrc`).

```bash
npm install
cp .env.example .env.local   # optional: SOLANA_RPC_URL, ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```

## API

```bash
curl -s localhost:3000/api/scan -H 'content-type: application/json' \
  -d '{"input": "<base64 tx | signature | solscan link>", "checkPoisoning": true}'
```

Returns a `ScanReport` ([`src/lib/scanner/types.ts`](src/lib/scanner/types.ts)) with `verdict`, `summary`,
`flags`, `balanceChanges`, `authorityChanges`, decoded `instructions`, and the simulation result and logs.
dApps and wallets can call this before asking a user to sign. The scanner is also a plain
library: `scan(input, { connection })` from [`src/lib/scanner/scan.ts`](src/lib/scanner/scan.ts).

## Tests

```bash
npm test            # offline: builds real drainer transactions, checks each rule (12 tests)
npm run test:live   # mainnet: a real past swap, a simulated payment, and a simulated drainer
```

## Code map

| File | What |
|---|---|
| `src/lib/scanner/decode.ts` | Input parsing, account and lookup-table resolution, instruction decoders (System, Token/Token-2022, BPF Loader, Stake, Squads, Memo, …) |
| `src/lib/scanner/rules.ts` | Instruction rules, effect rules, address-poisoning check, verdict |
| `src/lib/scanner/simulate.ts` | `simulateTransaction` + account diffs; historical diffs from tx metadata |
| `src/lib/scanner/explain.ts` | Claude summary with a template fallback |
| `src/lib/scanner/scan.ts` | Orchestration |
| `src/app/api/scan/route.ts` | HTTP API |
| `src/components/Scanner.tsx` | UI |

## Limits and next steps

- **Simulation reflects current state.** A malicious program can behave differently later (time
  bombs, state checks). That's why the instruction rules run even when simulation looks clean.
- Unknown programs are only checked through their effects. Add decoders for the programs you care about.
- **Next ideas:**
  - a browser extension that wraps `signTransaction`;
  - a Telegram bot;
  - known-scam address lists;
  - scanning Squads *vault transaction* contents before you approve them, which would protect the
    AI treasury agent;
  - rate limiting and caching on `/api/scan` before exposing it publicly.
