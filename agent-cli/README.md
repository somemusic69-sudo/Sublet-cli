# Sublera CLI

A standalone terminal agent for the Sublera peer-to-peer GPU market. It runs on the
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
Sublera central server  ◄──── outbound WSS tunnel ────  sublera-cli (this package)
      │                                                   │
      │                                                   ├── llama-server on 127.0.0.1
      │                                                   ├── GGUF cache + SHA-256
      │                                                   └── GPU monitor + sleep guard
      ▼
Postgres/SQLite ledger, wallet, reliability, request board
```

## Migration from Sublet

- The local package name is `sublera-cli`, with `sublera` and `sublera-cli`
  command names. The old `sublet` and `sublet-cli` command aliases remain supported.
- Use `SUBLERA_*` environment variables in new examples. Legacy `SUBLET_*`
  variables remain supported. If both names for a setting are set, `SUBLERA_*`
  wins; command-line flags still take precedence over environment settings.
- The default data directory is intentionally still `~/.sublet`, not a new
  `~/.sublera`: old and new names share credentials, model/engine cache, recovery
  state, and the instance lock. Do not move it merely for the rebrand. Existing
  model `.sublet.json` metadata filenames are unchanged.
- The repository remains `somemusic69-sudo/Sublet-cli`. The default server is
  `https://sublera.com` (it was `https://sublet.duckdns.org` before 1.3.0).
- The npm package is `sublera-cli`, published only by the Release workflow
  (`.github/workflows/release.yml`) with npm provenance.

## Quick start

You need Node.js 20.18.1 or newer (the LTS version from nodejs.org).
From a local checkout on the GPU machine, run:

```bash
cd agent-cli
npm install
npm run build
node dist/index.js start
```

For subsequent examples, use `node dist/index.js` in place of `sublera` or
`npx sublera-cli` when running from this local build.

On the first run, `start` opens the Sublera website so you can connect this
computer (click **Connect**), installs the matching `llama-server` build (CUDA
for NVIDIA, Vulkan for AMD/Intel, Metal for Apple Silicon, CPU fallback), and
then waits for work. The default server is `https://sublera.com`;
`--server <url>` uses another Sublera server. Servers must use https, except on
this machine (`localhost`, `127.0.0.1`); `SUBLERA_ALLOW_HTTP=1` allows plain http
for a test server on a trusted network.

`sublera doctor` checks the machine (`--fix` installs the engine ahead of time).
`sublera login` connects the computer again; on a machine without a browser,
open the printed link on any phone or laptop, or use `login --key sh_...`.

To serve one buyer request, pick it on the website's market. The board shows
which requests fit your GPU and which models are already on your disk. Click
**Take**, so no other host can claim it, then run the command that the website
shows:

```bash
npx sublera-cli start r_abc123
```

The agent downloads and verifies the model, passes the model check, serves the
booking, and exits when the booking ends. If you do not start within 15 minutes,
the request goes back to the board. With `sublera start` already running, a Take
on the website starts the download at once.

For public pay-per-token hosting from the terminal:

```bash
npx sublera-cli host \
  https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf \
  --price 0.25 --ctx 8192 --slots 4
```

For an SSH/mini-datacenter host that wants to see the buyer request board:

```bash
npx sublera-cli jobs
```

`jobs` claims the selected request and, if no agent is already running, starts
the tunnel/model/download/serve loop in the same terminal until the booking
ends or you press Ctrl+C.

## Commands

| Command | Purpose |
| --- | --- |
| `sublera login` | Link this computer to your account: show a code, open the website, receive a host key when you click Connect. `--key` saves a key directly; `--no-browser` only prints the link. The key is saved with mode 0600. |
| `sublera doctor` | Agent version, Node, server, key, download speed, GPU, free VRAM, sleep guard, llama-server and cache checks. `--fix` installs the engine. `--json` for machines. |
| `sublera start [code]` | Main mode: connect, download/verify the model of a request taken on the website, pass the model check, serve. With a code, serve that request and exit when it ends. |
| `sublera host <url\|path>` | Public pay-per-token mode with a chosen GGUF and price per 1M tokens. |
| `sublera jobs` | Table of open requests with VRAM fit and payout. Pick one and it claims + serves in this terminal; `--claim <id>` is non-interactive. |
| `sublera status` | Read-only host, reliability, wallet and active-booking summary. |
| `sublera config [show\|path]` | The settings in use and where each one came from (flag, env, `agent.json`, login, default). Keys are masked. |
| `sublera logout` | Remove the saved host key. |

Global flags: `--server`, `--key`, `--ws-path`, `--simulation`, `--gpu`,
`--vram`, `--ctx`, `--slots`, `--price`, `--price-in`, `--price-out`,
`--tok-s`, `--no-install`, `--no-browser`, `--json`, `--verbose`, `--log-level`,
`--log-file`, `--no-color`, `--once`. Each can also be set with a `SUBLERA_*`
environment variable or in `~/.sublet/agent.json` (see [Configuration](#configuration)).
`--gpu` and `--vram` also correct a wrongly detected GPU name or VRAM size on a real host.

### Test mode

Everything can be exercised without a GPU or a multi-GB download:

```bash
sublera start --simulation --gpu "NVIDIA GeForce RTX 4060" --vram 8188 --tok-s 24
```

Simulation mode still uses the real tunnel, metering, billing, model checks, booking
timer, reconnect logic and dashboard. Only the generated words are a stand-in.
The `simulate` flag on the `hello` frame tells the server this is a test node.

## What is in the package

```text
agent-cli/
├── src/
│   ├── index.ts                 CLI entry, parser, exit codes, shebang
│   ├── commands.ts              login / doctor / start / host / jobs / status
│   ├── agent.ts                 orchestration of tunnel, engine and dashboard
│   ├── config.ts                ~/.sublet, URL normalization, key masking
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
│   │   ├── tunnelClient.ts      WSS, 1/2/5/10/15/30s backoff, heartbeat, dead-link detection, auth fail, version gate
│   │   └── streamProxy.ts       SSE parser, stream=true piping, token probabilities
│   └── ui/
│       ├── terminalDashboard.ts the overnight status box
│       └── progress.ts          download bar with speed and ETA
├── tests/                       unit tests, no network or GPU required
├── scripts/e2e.mjs              9-check end-to-end proof against a live Sublera server
└── README.md
```

## What a host sees

```
┌──────────────────────────────────────────────────────────────────────┐
│  Sublera GPU TERMINAL AGENT v1.0.0                   STATUS: ● WORKING  │
├──────────────────────────────────────────────────────────────────────┤
│  Host Endpoint : https://host.example.com/api/v1                        │
│  Reliability   : 98.5%  (OK - held only after repeated failures)     │
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
│  Server        : https://sublera.example.com                                    │
└──────────────────────────────────────────────────────────────────────┘
```

The dashboard redraws in place. Logs go to stderr, so terminal logs never
destroy the box. `--json` switches logs to JSON lines and is suitable for
systemd/journald.

## Data directory

Everything lives under `~/.sublet` (override with `SUBLERA_HOME`):

```text
~/.sublet/config.json        host key + server, written by sublera login (0600)
~/.sublet/agent.json         optional settings file you write (see Configuration)
~/.sublet/state.json         active booking recovery snapshot (0600)
~/.sublet/bin/               llama-server builds + manifest.json
~/.sublet/models/            verified .gguf files + .sublet.json sidecars
~/.sublet/cache/             GitHub release metadata, temporary archives
~/.sublet/logs/agent.log     agent log, JSON lines, rotated (0600)
~/.sublet/logs/llama-server.log  engine log (prompt logging disabled)
```

A model that is already on disk is not downloaded again, but it is hashed again
before it is served (once per agent run), so the SHA-256 sent to the server is
of the bytes on disk and not of the sidecar note beside them. A file that fails
is deleted and downloaded again. A resume sends `Range: bytes=N-` and appends
only the missing bytes. If a server ignores Range, the partial file is discarded
and the download restarts from zero rather than corrupting weights.

## Configuration

### Production operations

`start`, `host`, and a serving `jobs` agent exclusively own `SUBLERA_HOME` via
`agent.lock`. A second process refuses to start. Storage maintenance acquires
the same lock, as does engine installation by `doctor --fix`. After an abrupt crash
the next agent takes the lock over only when the process that wrote it is no
longer running, so a service manager can restart the agent and it restores its
booking. A lock held by a running process, or one that cannot be read, is
refused: check every agent using that directory, then remove only `agent.lock`.
Never remove `state.json` just to unlock the directory.

- `sublera health live --json`: local process liveness.
- `sublera health ready --json`: local readiness (default health mode). Requires
  a fresh snapshot, connected tunnel, loaded ready engine (or simulation), and
  no drain/model load. Exit 0 means the requested check passed; exit 1 means
  failed/unknown. Snapshots update every 5 seconds and expire after 15 seconds.
  Simulation is explicitly labeled; these checks are not model attestation,
  server-side billing approval, or proof of GPU performance/capacity.
- SIGTERM enters drain: refuse new inference/model loads, allow active inference
  up to 30 seconds, then cancel leftovers, stop the engine, and preserve booking
  state. Configure `--drain-timeout <ms>` / `SUBLERA_DRAIN_TIMEOUT_MS` /
  `agent.json` `drainTimeoutMs` (0–300000). Ctrl+C remains immediate stop.
  Drain is local admission control; it does not implement a server scheduling
  handshake. Use server-side maintenance controls for long booked windows.
- `sublera storage status --json`: reports model, engine, cache and log sizes.
- `sublera storage prune --json`: **preview only**, for regular model `.part`
  and `.part.json` files older than seven days. Add `--force` to apply. Stop
  serving first. Complete models, engine versions, keys and booking state are
  never pruned by this command; recent partial downloads remain resumable.

Use fixed CLI/engine versions, a dedicated non-admin service account and a
dedicated local `SUBLERA_HOME` (not a shared network filesystem). Configure your
service supervisor with bounded restart/backoff, log rotation and enough stop
grace for drain plus engine teardown. Health snapshots include no prompts/keys,
but are local diagnostics, not tamper-proof attestation. Service installation,
fleet metrics/alerts, server billing/idempotency validation, real GPU soak and
rollback acceptance remain operator/release gates; see `SOAK_TEST.md`.

Engine replacement validates the staged binary's presence and hash before
promotion and attempts rollback on ordinary errors. Promotion and manifest
updates are not one crash-atomic transaction: abrupt termination can leave
uniquely named `.tmp`/`.bak` directories requiring operator inspection. Disk
headroom checks cannot reserve space against other applications. During shutdown,
ownership remains held until pending message handlers settle; a stuck handler
may therefore require supervisor intervention rather than unsafe lock takeover.

### Storage safety

The CLI does not create screenshot browser profiles. Its application data lives
under `~/.sublet`, or `SUBLERA_HOME` on a drive you choose.

- Model downloads share a **20 GiB cache budget**, including completed models,
  resumable `.part` files, sidecars and nested files. A full cache refuses new
  downloads; it never automatically deletes a model or booking recovery data.
- Downloads retain **5 GiB free disk headroom**. Unknown-length model streams
  are bounded too; free space is checked periodically during large transfers.
- Set `SUBLERA_MODEL_CACHE_GB=40` for a larger model cache, and
  `SUBLERA_MIN_FREE_DISK_GB=10` for more headroom. Values are positive GiB and
  these are environment-only controls, not `agent.json` keys.
- New engine installs refuse a `bin` directory above **10 GiB** and archive
  downloads above **2 GiB each**. Extraction is bounded; the installer requires
  additional temporary disk space and removes its work/staging on normal exit.
- Default agent logs rotate at **10 MiB**, with **5 previous files** (about
  **60 MiB** total). External stdout/service-manager logs need their own rotation.

Existing oversized caches are not erased or shrunk automatically. Stop the
agent before manually removing unused cached models/partials or old engine
versions. Interrupted downloads remain resumable and count toward the budget;
forced termination can leave installer work directories. Limits apply to new
writes, not an absolute filesystem quota: other processes, simultaneous CLI
instances, npm caches and external engine writes can still consume disk space.

The settings listed below work three ways. The first one found wins:

1. a command-line flag (`--ctx 16384`)
2. a `SUBLERA_*` environment variable (`SUBLERA_CTX=16384`)
3. the corresponding legacy `SUBLET_*` environment variable (`SUBLET_CTX=16384`)
4. `~/.sublet/agent.json` (path override: `SUBLERA_CONFIG`, legacy `SUBLET_CONFIG`)

When both environment names are set, `SUBLERA_*` wins. This also applies to
`SUBLERA_HOME` / `SUBLET_HOME`; without an override the home remains `~/.sublet`.

```json
{
  "server": "https://sublera.com",
  "context": 8192,
  "slots": 4,
  "price": 0.25,
  "noBrowser": true,
  "logLevel": "info"
}
```

| `agent.json` key | Environment variable | Flag |
| --- | --- | --- |
| `server` | `SUBLERA_SERVER` | `--server` |
| `token` | `SUBLERA_KEY` | `--key` |
| `wsPath` | `SUBLERA_WS_PATH` | `--ws-path` |
| `context` | `SUBLERA_CTX` | `--ctx` |
| `slots` | `SUBLERA_SLOTS` | `--slots` |
| `price` / `priceIn` / `priceOut` | `SUBLERA_PRICE` / `SUBLERA_PRICE_IN` / `SUBLERA_PRICE_OUT` | `--price` / `--price-in` / `--price-out` |
| `gpu` / `vram` | `SUBLERA_GPU` / `SUBLERA_VRAM` | `--gpu` / `--vram` |
| `tokPerSec` | `SUBLERA_TOK_S` | `--tok-s` |
| `noInstall` | `SUBLERA_NO_INSTALL` | `--no-install` |
| `noBrowser` | `SUBLERA_NO_BROWSER` | `--no-browser` |
| `requireChecksum` | `SUBLERA_REQUIRE_CHECKSUM` | `--require-checksum` |
| `logLevel` | `SUBLERA_LOG_LEVEL` | `--log-level` |
| `logFile` | `SUBLERA_LOG_FILE` | `--log-file` |

An unknown key or a bad value in `agent.json` stops the agent with exit code 2
and names the problem; a typo is never ignored silently. `sublera config` prints
the value in use for every setting and where it came from (keys masked);
`sublera config --json` gives the same for tooling.

## Corporate networks

The agent only connects outward: the Sublera server (HTTPS + one WebSocket),
HuggingFace for models, GitHub for llama.cpp releases, and npm for the version
check. Nothing listens on the network; `llama-server` binds to `127.0.0.1`.

```bash
export HTTPS_PROXY=http://user:password@proxy.corp.example:3128
export NO_PROXY=.corp.example,10.0.0.5
export NODE_EXTRA_CA_CERTS=/etc/ssl/corp-root.pem   # TLS-inspecting proxies
sublera doctor        # "Network: via proxy http://***@proxy.corp.example:3128"
```

- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` are read in upper or lower case.
  `NO_PROXY` takes host names, `.domain` suffixes, exact IP addresses,
  `host:port`, or `*` (CIDR ranges are not supported).
- The tunnel and downloads use HTTP CONNECT, so TLS runs end to end and the
  host key is never visible to the proxy. Proxy passwords are never printed.
- Only `http://` and `https://` proxies are supported (no SOCKS); anything else
  stops the agent with a clear message and exit code 2.
- Loopback (`localhost`, `127.*`) is never proxied.

## Logs

`start`, `host`, and `jobs` write every record, debug included, to
`~/.sublet/logs/agent.log` as JSON lines (`ts`, `level`, `message`, fields).
The file rotates at 10 MB and keeps 5 old files (`agent.log.1` ... `.5`). Use
`--log-file <path>` to move it or `--log-file off` to disable it. The
terminal shows `info` and above (`--log-level`, `--verbose`). Host keys, API
keys, bearer tokens, and `token=` URL parameters are replaced with `***`
everywhere. Prompts and model output are never logged.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success, or a booking that ended normally |
| `1` | Runtime error: server unreachable, host key rejected, request refused, crash loop |
| `2` | Usage or settings error: unknown command or flag, invalid value, bad `agent.json`, bad proxy |
| `130` | Stopped with Ctrl+C; saved booking state is cleared |
| `143` | Stopped by SIGTERM (shutdown, `systemctl stop`); saved booking state is kept so the next start reattaches |

## Running unattended

A service manager should restart the agent and send SIGTERM to stop it. A
systemd example (Linux):

```ini
# /etc/systemd/system/sublera.service
[Unit]
Description=Sublera GPU host agent
Wants=network-online.target
After=network-online.target

[Service]
User=sublera
Environment=SUBLERA_NO_BROWSER=true
# Run "sublera login --key sh_..." once as this user, or provide SUBLERA_KEY from a secret store.
ExecStart=/usr/bin/env npx --yes sublera-cli@1 start --no-color
Restart=always
RestartSec=10
# Exit code 2 is a configuration mistake: do not restart in a loop.
RestartPreventExitStatus=2
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Pin a major version (`sublera-cli@1`) so an unattended machine never jumps to
a release with breaking changes. On Windows, Task Scheduler ("At startup",
"Restart on failure") or a service wrapper such as NSSM running
`npx --yes sublera-cli@1 start` does the same.

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
   --cont-batching --log-disable`, bound to `127.0.0.1`. llama.cpp's own
   environment settings (`LLAMA_ARG_*`, `LLAMA_LOG_*`, `LLAMA_API_KEY`) are
   removed from the engine's environment, so a host's private llama.cpp setup
   cannot change the engine. A `llama-server` from `LLAMA_SERVER` or `PATH` is
   used as it is, with a warning that another build can fail model checks.
6. **Model checks.** Every job asks `llama-server` for token probabilities
   (`logprobs`, top 5), and the first 32 tokens of every job carry them to the
   server. The server sends hidden check prompts as normal `infer` jobs (a host
   cannot tell them apart) and compares the probabilities with other hosts that
   run the same file, or with a trusted reference host. The booking timer starts
   only after the first check, and checks continue at random times. Asking for
   probabilities costs `llama-server` a little extra work on every token.
   **The server is what catches a fake model.** This program runs on the host's
   machine and is open source, so nothing it reports about itself is proof.
   What it does locally is for the honest host: after every model load it asks
   the engine one fixed question twice at temperature 0 and compares the token
   probabilities, and after a crash restart it compares against the load-time
   answer. A measured difference is a diagnostic warning, not a diagnosis of
   faulty hardware or proof of model identity. Missing, malformed, incomplete,
   or ambiguous evidence is inconclusive, never a pass. The self-check never
   stops a booking, and a buyer's job cancels it. Server-side authenticity and
   billing behavior require separate end-to-end validation.
7. **Sleep guard.** Windows uses a native `SetThreadExecutionState` loop;
   macOS uses `caffeinate -dimsu`; Linux uses `systemd-inhibit`. The lock is
   released when the job ends and on process exit.
8. **Crash recovery.** `llamaRunner` restarts a crashed server after 500ms, up
   to five times in two minutes. A crash loop becomes a fatal state instead of
   spinning forever.
9. **Reconnect grace + crash recovery.** A 10-second Wi-Fi blip reconnects with
   backoff. A tunnel that stops answering pings for 45 seconds (a half-open TCP
   connection after a router reset) is torn down and reconnected. The agent
   keeps `llama-server` and the loaded model in VRAM. The server preserves
   claims and the booking clock for 60 seconds. If the agent process itself is
   killed, `~/.sublet/state.json` lets the next `start` reload the cached model
   and reattach to the same booking instead of starting over. `SIGTERM`
   (shutdown, `systemctl stop`) keeps that file; Ctrl+C clears it.
10. **Host key transport.** The tunnel authenticates with an
    `Authorization: Bearer` header so the key is not placed in the WebSocket
    URL or proxy access logs. If an older server rejects header auth, the CLI
    retries once with the legacy query-token form.
11. **HuggingFace-only model downloads.** A model URL must be an `https://`
    link to a `.gguf` file on `huggingface.co` or `hf.co`. The agent follows
    redirects itself, and every redirect must also stay on HuggingFace over
    `https://`, so a model link can never reach the host's own machine or local
    network. A server `load` must be such a URL, never a local path. A download
    stops at its announced size (at most 64 GB) and does not start without
    enough free disk space. Only the unit tests can opt into localhost.
12. **Dashboard controls.** In an interactive terminal: `W` opens your host
    page on the website, `C` copies the host endpoint, `L` toggles the llama log tail,
    and `?` shows the key help.

## Server contract

This CLI works with the Sublera server (separate, not public yet) and with any
server that implements the same small contract:

| Endpoint / frame | Purpose |
| --- | --- |
| `GET /api/health` | doctor reachability check |
| `GET /api/agent/me` | host key verification, wallet, host, active request |
| `POST /api/cli/login`, `POST /api/cli/login/poll` | device login: a user code for the website, then the host key once it is approved |
| `GET /api/agent/requests` | open buyer requests + VRAM fit + `cached` (the model is already on this host's disk) |
| `POST /api/agent/requests/:id/claim` | claim from the terminal |
| `GET /tunnel?token=...` or `/ws/agent` | persistent outbound WebSocket |
| `hello`, `heartbeat`, `progress`, `loaded`, `load_failed`, `models`, `chunk`, `done`, `error` | agent → server. `hello` carries `requestId` (from `sublera start <code>`) and `cachedModels` (SHA-256 of each verified GGUF on disk); `models` updates that list after a download. The first 32 tokens of every job send `chunk.lp`: `[{ t, l, top: [[token, logprob], ...] }]`. |
| HTTP `426` (JSON `minVersion` optional) or WebSocket close `4426` (reason `<min version>` optional) | server refuses an agent that is too old; the CLI stops and tells the host to run `npx sublera-cli@latest` |
| `welcome`, `infer`, `load`, `cancel`, `verified`, `booking`, `reject` | server → agent. Model checks arrive as normal `infer` jobs. |

The agent sends its version as `user-agent: sublera-cli/<version>` on every
request and as `agentVersion` in `hello`, so the server can refuse old agents
before a protocol change. A handshake refused with HTTP `401`/`403` is treated
like a rejected host key.

`loaded` is followed by the server's first model check. The server starts the
booking timer only after that check, then sends `verified`; the CLI displays the
timer it receives in the `booking` frame. The agent never trusts the host for billing: the central
proxy counts the SSE chunks.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/index.js --help

# end-to-end against a running Sublera server
$env:SUBLERA_HOME="$env:TEMP\sublera-cli-e2e"
npm run e2e
```

The e2e script signs up a fresh host, issues a key, drives the real tunnel, does
a billed pay-per-token stream, creates and claims a 30-minute booking, verifies
the timer starts after the model check, verifies booked tokens are not charged,
drops the tunnel, reconnects inside the grace window, verifies the same timer
survives, and cancels the request. It uses simulation mode so it does not need
a real 4GB+ model.

## Packaging and publication status

The local package name is `sublera-cli`. Its primary binaries are `sublera` and
`sublera-cli`; `sublet` and `sublet-cli` remain compatibility aliases.
For local package inspection only:

```bash
npm pack --dry-run
```

Releases are published to npm as `sublera-cli` by the Release workflow, never
from a laptop. Check a release's provenance on its npm page.

## Verification status

This build was verified on a Windows machine with an RTX 4060:

- `npm run typecheck`, `npm test`, and `npm run build` pass.
- `npm run e2e` passes against a live Sublera server: tunnel, billed public
  stream, model check, booking timer, unlimited booked stream, jobs board,
  process-kill crash recovery with the same timer, standalone `jobs` serving,
  escrow cleanup, device login, and take + `start <code>`.
- On Linux x64 (CPU), `sublera doctor --fix` installed the official llama.cpp
  b12202 build, including its library link chains, and served SmolLM2 GGUFs.
  Those runs measured the model-check thresholds.
- `sublera doctor --fix` downloaded the official CUDA `llama-server` build
  (b12176), verified its published SHA-256, extracted it, and recorded the
  binary hash in `~/.sublet/bin/manifest.json`.
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
