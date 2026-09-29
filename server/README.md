# SpendProof local API

Run `npm run dev:api` from the project root. Express binds only to `127.0.0.1:8787`; the Vite proxy runs on port 5173. Host and Origin validation reject other browser origins. Do not expose this prototype through a public tunnel.

Copy `.env.example` to `.env` only if enabling an integration. No external wallet or credential files are read. The default `fixture` mode requires no key, uses two deterministic merchant quotes, and has zero model/payment calls. `kiln` mode requires `KILN_API_KEY`, calls the OpenAI-compatible endpoint at `KILN_BASE_URL` (default `https://api.bricksum.com/v1`) with the configurable `KILN_MODEL`, and uses `tool_choice: auto`. `KILN_MAX_TOKENS` defaults to 4096 and accepts 256–8192; reasoning tokens consume the same limit. The event's organizers may provide a different exact model ID, so configure the model actually enabled for the account. Model output must call `get_quotes`, receive a test quote, and then call `propose_purchase` with its exact ID. The runner allows at most four model calls per research step and eight for the full two-step run. There is no manufactured fallback or token count if the provider does not return one.

## Endpoints

- `GET /api/health`: integration configuration flags, model ID, payment simulation label.
- `GET /api/sessions`, `POST /api/sessions {policy, scenario, agentMode}`.
- `GET /api/sessions/:id`.
- `POST /api/sessions/:id/run`: starts the one allowed run, returns 202; poll the session.
- `POST /api/sessions/:id/stop`: aborts pending model calls and prevents new simulated spending.
- `POST /api/sessions/:id/replay {budgetMicros, allowedMerchants?, expiresAt?}`: no model or payment calls. Counterfactual balances accumulate from counterfactual decisions, not original spending. The replay only evaluates recorded proposals; it does not predict a new agent plan.
- `GET /api/sessions/:id/evidence`: stable JSON export, independently verifiable locally.
- `POST /api/verify`: verify the complete Evidence object.
- `GET /api/sessions/:id/regression`: standalone `.test.mjs`; run with `node --test downloaded.test.mjs`.
- `POST /api/sessions/:id/anchor`: optional Base Sepolia digest anchoring of a terminal session, disabled by default.

Monetary amounts are safe integers in micro-USDC. Policies use `{budgetMicros, allowedMerchants:['atlas','orbit'], expiresAt:ISO8601, task}`. Scenarios are `normal`, `fees`, `merchant`, `duplicate`. Default test quotes total 1.6 and 2.1 USDC; `fees` changes the second quote total to 5 USDC. `merchant` changes the second recipient while retaining a known merchant ID; `duplicate` reuses the first business ID. Registered merchant addresses are demonstrative identities, not actual merchants or live destinations.

## Storage and execution boundaries

Session snapshots are atomically written in enqueue order under `.data/sessions.json`. Per-session execution locks prevent double runs. Each session has its own budget; this is not an aggregate wallet limit. The stop check and simulated ledger mutation are synchronous, with no asynchronous operation between them. On server restart, interrupted runs become errors and cannot silently resume. There are no real USDC payments, blockchain payment receipts, automatic retries, or fabricated transaction hashes.

Evidence exports are stored as `.data/evidence-ID.json`; repeated exports of the same snapshot use the same timestamp and digest. Hashes establish content integrity only; an unanchored export is not independent proof of when events happened or who produced them.

## Optional testnet digest transaction

Set `ENABLE_TESTNET_ANCHOR=true`, `BASE_SEPOLIA_RPC_URL`, and a disposable `TESTNET_PRIVATE_KEY` with test ETH. The RPC chain ID must be 84532. The server creates a zero-value self transaction with `spendproof:v1:DIGEST` calldata; test ETH gas is spent. It does not transfer USDC, call a payment contract, or pay a merchant. The signed transaction hash and exact evidence bundle are persisted before broadcast. An ambiguous broadcast is labeled `broadcast_unknown`; the server will return the existing hash instead of creating another transaction. The result lives separately in `.data/anchor-ID.json`, preserving the anchored session snapshot. Mainnet is rejected.

The current anchor endpoint reports prepared/submitted/unknown broadcast status, not final chain confirmation. Follow the supplied Base Sepolia explorer link and verify inclusion independently. A configured key never triggers an anchor automatically: an explicit POST is required.

Sources: [Kiln documentation](https://kiln.bricksum.com/docs/en), [Furiosa tool calling](https://developer.furiosa.ai/latest/en/furiosa_llm/toolcalling.html).
