# Kiln Agent CLI

A standalone terminal agent for the Kiln peer-to-peer GPU market. It runs on the
GPU owner's machine, manages `llama-server` and GGUF files, keeps the machine
awake during overnight bookings, and holds one outbound WebSocket to the central
server. Buyers never connect to the host directly.

This package is the implementation of `../CLI_PLAN.md`. It is deliberately
separate from the website/server so it can be published to npm and updated on
host machines without redeploying the marketplace.

```text
Browser / buyer
      │  OpenAI-compatible stream
      ▼
Kiln central server  ◄──── outbound WSS tunnel ────  kiln-agent (this package)
      │                                                   │
      │                                                   ├── llama-server on 127.0.0.1
      │                                                   ├── GGUF cache + SHA-256
      │                                                   └── GPU monitor + sleep guard
      ▼
Postgres/SQLite ledger, wallet, reliability, request board
```

## Quick start

```bash
# On the GPU machine
npx kiln-agent login --key kh_... --server https://kiln.run
npx kiln-agent doctor --fix
npx kiln-agent start
```

The host key is issued by the Kiln website. `login` verifies it before saving.
`doctor --fix` scans the GPU and downloads the matching prebuilt `llama-server`
(CUDA for NVIDIA, Vulkan for AMD/Intel, Metal for Apple Silicon, CPU fallback).

For public pay-per-token hosting from the terminal:

```bash
npx kiln-agent host \
  https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf \
  --price 0.25 --ctx 8192 --slots 4
```

For an SSH/mini-datacenter host that wants to see the buyer request board:

```bash
npx kiln-agent jobs
```

`jobs` claims the selected request and, if no agent is already running, starts
the tunnel/model/download/serve loop in the same terminal until the booking
ends or you press Ctrl+C.

## Commands

| Command | Purpose |
| --- | --- |
| `kiln login` | Prompt for a host key (or use `--key`), verify it, save it with mode 0600. |
| `kiln doctor` | Node, server, key, GPU, free VRAM, sleep guard, llama-server and cache checks. `--fix` installs the engine. `--json` for machines. |
| `kiln start` | Main mode: connect, wait for a web claim, download/verify the model, pass the canary, serve. |
| `kiln host <url\|path>` | Public pay-per-token mode with a chosen GGUF and price per 1M tokens. |
| `kiln jobs` | Table of open requests with VRAM fit and payout. Pick one and it claims + serves in this terminal; `--claim <id>` is non-interactive. |
| `kiln status` | Read-only host, reliability, wallet and active-booking summary. |
| `kiln logout` | Remove the saved host key. |

Global flags: `--server`, `--key`, `--ws-path`, `--simulation`, `--gpu`,
`--vram`, `--ctx`, `--slots`, `--price`, `--price-in`, `--price-out`,
`--tok-s`, `--no-install`, `--json`, `--verbose`, `--no-color`, `--once`.

### Test mode

Everything can be exercised without a GPU or a multi-GB download:

```bash
kiln start --simulation --gpu "NVIDIA GeForce RTX 4060" --vram 8188 --tok-s 24
```

Simulation mode still uses the real tunnel, metering, billing, canary, booking
timer, reconnect logic and dashboard. Only the generated words are a stand-in.
The `simulate` flag on the `hello` frame tells the server this is a test node.

## What is in the package

```text
agent-cli/
├── src/
│   ├── index.ts                 CLI entry, parser, exit codes, shebang
│   ├── commands.ts              login / doctor / start / host / jobs / status
│   ├── agent.ts                 orchestration of tunnel, engine and dashboard
│   ├── config.ts                ~/.kiln, URL normalization, key masking
│   ├── logger.ts                human and JSON logs (stderr, never dashboard stdout)
│   ├── hardware/
│   │   ├── gpuMonitor.ts        nvidia-smi / rocm-smi / macOS / Windows fallback
│   │   ├── sleepGuard.ts        SetThreadExecutionState / caffeinate / systemd-inhibit
│   │   └── types.ts
│   ├── engine/
│   │   ├── binaryManager.ts     GitHub release picker, checksum, extraction, manifest
│   │   ├── modelManager.ts      resumable download, streaming SHA-256, GGUF header
│   │   ├── llamaRunner.ts       hidden 127.0.0.1 port, locked flags, crash restart
│   │   └── gguf.ts              header parser + VRAM estimator
│   ├── network/
│   │   ├── tunnelClient.ts      WSS, 1/2/5/10/15/30s backoff, heartbeat, auth fail
│   │   └── streamProxy.ts       SSE parser, stream=true piping, canary logprobs
│   └── ui/
│       ├── terminalDashboard.ts the overnight status box
│       └── progress.ts          download bar with speed and ETA
├── tests/                       36 unit tests, no network or GPU required
├── scripts/e2e.mjs              9-check end-to-end proof against a live Kiln server
├── CLI_PLAN.md                  the build plan (also at repository root)
└── README.md
```

## What a host sees

```
┌──────────────────────────────────────────────────────────────────────┐
│  Kiln GPU TERMINAL AGENT v1.0.0                   STATUS: ● WORKING  │
├──────────────────────────────────────────────────────────────────────┤
│  Host Endpoint : https://alex.kiln.run/api/v1                        │
│  Reliability   : 98.5%  (safe - auto-ban < 90.0%)                    │
│  GPU Detected  : NVIDIA GeForce RTX 3090 (21.2 GB free / 24.0 GB)    │
│  GPU Temp/Power: 61°C · 185W · Wake-Lock: ACTIVE - sleep blocked     │
├──────────────────────────────────────────────────────────────────────┤
│  CURRENT JOB   : Dedicated Buyer Request (#804)                      │
│  Model Loaded  : Llama-3.3-70B-Abliterated-Q4_K_M ✓ verified         │
│  Time Remaining: 06:14:32 / 08:00:00                                 │
│  Live Speed    : 38.4 tok/s (min required: 25.0 tok/s ✓)             │
├──────────────────────────────────────────────────────────────────────┤
│  Session Earn. : $4.68 / $6.00 Guaranteed                            │
│  Total Wallet  : $42.15                                              │
│  Server        : https://kiln.run                                    │
└──────────────────────────────────────────────────────────────────────┘
```

The dashboard redraws in place. Logs go to stderr, so terminal logs never
destroy the box. `--json` switches logs to JSON lines and is suitable for
systemd/journald.

## Data directory

Everything lives under `~/.kiln` (override with `KILN_HOME`):

```text
~/.kiln/config.json        host key + server (0600)
~/.kiln/state.json         active booking recovery snapshot (0600)
~/.kiln/bin/               llama-server builds + manifest.json
~/.kiln/models/            verified .gguf files + .kiln.json sidecars
~/.kiln/cache/             GitHub release metadata, temporary archives
~/.kiln/logs/              llama-server log (prompt logging disabled)
```

Model files are never re-downloaded when the sidecar hash and file size still
match. A resume sends `Range: bytes=N-` and appends only the missing bytes. If a
server ignores Range, the partial file is discarded and the download restarts
from zero rather than corrupting weights.

## Verification and safety

1. **Only GGUF.** Pickle/PyTorch/safetensors files are refused before download.
2. **Streaming SHA-256.** The hash is computed while bytes hit disk. A mismatch
   deletes both the partial and final file. The server's `sha256` is mandatory
   for paid request loads.
3. **GGUF header.** Magic, architecture, layer count, embedding length, context
   and quantization are read from the first few MB. A 28-layer file cannot call
   itself a 70B model.
4. **VRAM fit.** The agent checks free VRAM with a 2% safety margin before it
   claims/loads, so a host does not fail a booking on an OOM.
5. **Locked engine flags.** `--n-gpu-layers 999 --ctx-size <n> --parallel <n>
   --cont-batching --log-disable`, bound to `127.0.0.1`.
6. **Canary.** After load, the central server sends a `temperature=0, seed=42`
   prompt. The timer starts only after the server receives the agent's
   deterministic tokens/logprobs and replies `VERIFIED`.
7. **Sleep guard.** Windows uses a native `SetThreadExecutionState` loop;
   macOS uses `caffeinate -dimsu`; Linux uses `systemd-inhibit`. The lock is
   released when the job ends and on process exit.
8. **Crash recovery.** `llamaRunner` restarts a crashed server after 500ms, up
   to five times in two minutes. A crash loop becomes a fatal state instead of
   spinning forever.
9. **Reconnect grace + crash recovery.** A 10-second Wi-Fi blip reconnects with
   backoff. The agent keeps `llama-server` and the loaded model in VRAM. The
   server preserves claims and the booking clock for 60 seconds. If the agent
   process itself is killed, `~/.kiln/state.json` lets the next `start` reload
   the cached model and reattach to the same booking instead of starting over.
10. **Host key transport.** The tunnel authenticates with an
    `Authorization: Bearer` header so the key is not placed in the WebSocket
    URL or proxy access logs. If an older server rejects header auth, the CLI
    retries once with the legacy query-token form.
11. **HTTPS-only model downloads.** GGUF downloads must be `https://`;
    localhost is allowed only for the test harness.
12. **Dashboard controls.** In an interactive terminal: `W` opens the wallet /
    withdraw page, `C` copies the host endpoint, `L` toggles the llama log tail,
    and `?` shows the key help.

## Server contract

This CLI works with the Kiln server in `../sellingai` and with any server that
implements the same small contract:

| Endpoint / frame | Purpose |
| --- | --- |
| `GET /api/health` | doctor reachability check |
| `GET /api/agent/me` | host key verification, wallet, host, active request |
| `GET /api/agent/requests` | open buyer requests + VRAM fit |
| `POST /api/agent/requests/:id/claim` | claim from the terminal |
| `GET /tunnel?token=...` or `/ws/agent` | persistent outbound WebSocket |
| `hello`, `heartbeat`, `progress`, `loaded`, `load_failed`, `chunk`, `done`, `error` | agent → server |
| `welcome`, `canary`, `infer`, `load`, `cancel`, `verified`, `booking`, `reject` | server → agent |

`loaded` is followed by the server's canary. The server starts the booking
timer only after a passing canary; the CLI displays the timer it receives in
the `booking` frame. The agent never trusts the host for billing: the central
proxy counts the SSE chunks.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/index.js --help

# end-to-end against a running Kiln server
$env:KILN_HOME="$env:TEMP\kiln-agent-e2e"
npm run e2e
```

The e2e script signs up a fresh host, issues a key, drives the real tunnel, does
a billed pay-per-token stream, creates and claims a 30-minute booking, verifies
the timer starts after the canary, verifies booked tokens are not charged,
drops the tunnel, reconnects inside the grace window, verifies the same timer
survives, and cancels the request. It uses simulation mode so it does not need
a real 4GB+ model.

## Publishing

```bash
npm pack --dry-run
npm publish --access public
```

The package exposes both `kiln` and `kiln-agent` binaries. Users can then run:

```bash
npx kiln-agent doctor --fix
npx kiln-agent start
```

## Verification status

This build was verified on a Windows machine with an RTX 4060:

- `npm run typecheck`, `npm test` (40 tests), and `npm run build` pass.
- `npm run e2e` passes ten checks against a live Kiln server: tunnel, billed
  public stream, canary, booking timer, unlimited booked stream, jobs board,
  process-kill crash recovery with the same timer, standalone `jobs` serving,
  and escrow cleanup.
- `kiln doctor --fix` downloaded the official CUDA `llama-server` build
  (b12176), verified its published SHA-256, extracted it, and recorded the
  binary hash in `~/.kiln/bin/manifest.json`.
- A real 637MB TinyLlama 1.1B Q4_K_M GGUF was downloaded, header-checked,
  loaded into `llama-server`, verified with the HF SHA-256, and served a real
  40-token chat through the central tunnel with billing. The same real booking
  was then SIGKILLed and restored from `state.json`; it reloaded the cached
  model and served another chat at 85 tok/s with the original timer.

## Limits

- Real inference requires a `llama-server` build and a machine that can fit the
  requested GGUF. `--simulation` is explicitly a test mode and is labeled as
  such in the dashboard and on the wire.
- The agent downloads official llama.cpp release assets from GitHub. If a
  release has no published digest/sidecar, the agent records the local SHA-256
  and marks the install `verified: false` instead of pretending it was signed.
  Pass `--require-checksum` on `doctor` to make a missing published checksum a
  failure.
- Withdrawals and real card processing live on the server, not in this package.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
The CLI does not bundle model weights; each HuggingFace model keeps its own
license. Security reports: [SECURITY.md](SECURITY.md). Contributions:
[CONTRIBUTING.md](CONTRIBUTING.md).
