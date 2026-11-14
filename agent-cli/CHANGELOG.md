# Changelog

All notable changes to `sublet-cli` are listed here. The project follows
[Semantic Versioning](https://semver.org/). The stable surface is: command
names, flags, `SUBLET_*` variables, `agent.json` keys, exit codes, the
`--json` output of `doctor` and `config` (versioned by `schemaVersion`), and
the files under `~/.sublet`. A change to any of these needs a major version.

## [Unreleased]

### Changed
- The default server is now `https://sublera.com` (was `https://sublet.duckdns.org`).
  `--server`, `SUBLERA_SERVER` and saved configs still choose another one.

### Security
- The device-login link from the server is opened only when it is on the
  server's own origin. On Windows it is opened through `rundll32.exe` by full
  path instead of `cmd /c start`, so a link can no longer run commands.
- Plain-http servers are refused unless they are on this machine, because the
  host key travels in every request. `SUBLERA_ALLOW_HTTP=1` allows a test server
  on a trusted network.
- Server text in the login prompt is printed without control characters.

### Fixed
- `start <code>` and `jobs` no longer exit when a different booking appears. They
  exit when their own booking has ended and no other booking uses the GPU.
- A booking that ended is no longer added back (and its earnings counted twice)
  by a status answer from before the end. The server's clock decides whether a
  listed booking is over.
- A load for another request is refused with "Host is busy" while a loaded request
  is still in its model check or a benchmark runs, instead of restarting
  llama-server or replacing that request.
- `start <code>` and `jobs` also keep running while another request on this host
  is claimed, loading or in its model check.
- A booking the agent learns about from the status poll now keeps the machine awake.
- A booking frame no longer clears the busy flag of a model load in progress.
- llama-server is restarted when the slot count changes, but only when no job or
  other booking uses it; otherwise the agent keeps it and logs a warning.
- A load for the file that is already running with the same settings reuses
  llama-server and skips the VRAM check, which counted the loaded model twice.
  A load that would replace the model under other bookings or public buyers is refused.
- The saved booking keeps the slot count of its load instead of 1.
- Per-token earnings are no longer overwritten on the dashboard when a booking starts.
- `--help` named `~/.sublera` for logs and `agent.json`; the files are in `~/.sublet`.
- Update the CI packed-package smoke test to install `sublera-cli` and exercise
  both the new `sublera` executable and the legacy `sublet` alias.
- Refuse linked model roots before pruning; concurrent instance-lock release
  shares one operation and cannot unlink a later owner's lock.
- Correct download budgets when an obsolete partial must be restarted.
- Serialize engine installation per home, protect `doctor --fix` with instance
  ownership, use unique staging directories and atomic manifest writes, and
  attempt rollback when replacement installation fails.
- Keep instance ownership until pending message handlers settle; clean up jobs
  after wake-lock acquisition failures and suppress work/output after stop or
  cancellation. Reject contradictory or malformed readiness snapshots.
- Attempt all shutdown cleanup steps even if one fails, retaining ownership
  through pending handlers and final state/health writes before reporting errors.

### Added
- Sublera branding, local package name `sublera-cli`, and `sublera` executable
  aliases. Legacy executables and `SUBLET_*` environment names remain supported;
  `SUBLERA_*` names take precedence. The default `.sublet` data directory and
  repository identity are unchanged.
- Several bookings at once on one loaded model: speed seats (a reserved tok/s)
  side by side, a full-GPU rental, and per-token buyers in public mode. Each
  booking has its own end timer, and a `reject` ends only its own request.
  Bookings on the loaded model are accepted without a `load` frame.
- `--price-hour <usd>` (`SUBLERA_PRICE_HOUR`, legacy `SUBLET_PRICE_HOUR`,
  `agent.json` key `priceHour`, 0 to 50): the price per hour for the full GPU in
  `sublera host`. It is sent as `priceHourUsd` in `hello` (default 0.50; `start`
  and `jobs` send 0). The server sets seat prices from it.
- The dashboard shows every rental and its reserved speed, the one that ends
  first, and the hourly price in public mode. Earnings are per-token earnings
  plus the time share of every booking. `sublera status` lists every booking.
- `state.json` saves every booking in a `bookings` list, and a restart restores
  all of them with their slot count. Files with the old single `booking` field
  are still read.
- The agent reads `activeRequests` from `/api/agent/me` and falls back to
  `activeRequest` on older servers. Bookings the server no longer lists are dropped.
- Exclusive `SUBLET_HOME` ownership for serving agents and storage maintenance.
  A lock left by a process that is no longer running is taken over, so an agent
  restarted after a crash restores its booking; a live or unreadable owner's lock
  is refused with recovery instructions.
- Local `health [live|ready]` snapshots, bounded SIGTERM inference drain, and
  `storage status|prune` with dry-run-by-default pruning of old partial files.
- Operational regression tests for cross-process ownership, cancellation,
  reconnect readiness and safe maintenance. Async server message errors are
  caught; busy hosts refuse conflicting model loads/new inference.
- Storage guards: model-cache downloads default to a 20 GiB budget and preserve
  5 GiB disk headroom, configurable through `SUBLET_MODEL_CACHE_GB` and
  `SUBLET_MIN_FREE_DISK_GB`. Partial files count; existing data is not evicted.
- Engine archive/cache limits, bounded tar extraction/link materialization,
  and staging-space preflight checks. Model downloads serialize within one
  process to avoid spending the same budget concurrently.

## [1.3.0] - 2026-11-12

### Added
- **Corporate proxy support.** `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`
  (upper or lower case) now apply to every outbound connection: API calls,
  model and engine downloads, and the WebSocket tunnel (HTTP CONNECT, with
  `user:password@` proxy login). `127.0.0.1`/`localhost` (llama-server) is
  never proxied. `NODE_EXTRA_CA_CERTS` adds a corporate root CA. Proxy
  passwords are never printed.
- **Configuration without flags.** Supported settings can come from a `SUBLET_*`
  environment variable or `~/.sublet/agent.json` (override the path with
  `SUBLET_CONFIG`). Precedence: flag > environment > file > default. Unknown
  keys and bad values are errors, not silently ignored.
- **`sublet config`** shows the settings in use and where each one came from;
  `sublet config path` prints the settings file path. `--json` supported.
- **Agent log file.** `start`, `host`, and `jobs` write JSON lines to
  `~/.sublet/logs/agent.log`, rotated at 10 MB with 5 old files kept.
  `--log-file <path|off>`, `--log-level <level>`.
- **Documented exit codes:** 0 ok, 1 runtime error, 2 usage or settings error,
  130 Ctrl+C, 143 SIGTERM.
- `doctor` reports the network path (direct or proxy) and the extra CA file;
  `doctor --json` now includes `schemaVersion` and `agentVersion`.
- Release gate (`npm run check`, `scripts/check-package.mjs`), a tag-driven
  release workflow with npm provenance, and Dependabot.
- **Engine self-check.** After every model load the agent asks the engine one
  fixed question twice at temperature 0 and compares the token probabilities;
  after a crash restart it compares against the load-time answer. A difference
  is logged as a diagnostic warning, not a hardware diagnosis or attestation.
  Incomplete or invalid evidence is inconclusive. It never stops a booking,
  and a buyer's job cancels it.

### Changed
- A model already on disk is hashed again before it is served (once per agent
  run). Before, a booking trusted the sidecar file and reported "hash-checked"
  without hashing. A measured expected-hash mismatch triggers a replacement
  download without first deleting the old model; IO errors preserve the file.
- Model `verified` means a valid reference hash matched, not just that hashing
  completed. Local checks do not authenticate a hostile host.
- Streaming requires an explicit `[DONE]` marker, rejects malformed JSON and
  token counts, bounds buffers/output, and releases the response reader.
- Added unattended `--non-interactive` operation, server-scoped saved keys,
  nested secret redaction, and serialized atomic state/config writes.
- llama.cpp's environment settings (`LLAMA_ARG_*`, `LLAMA_LOG_*`,
  `LLAMA_API_KEY`) no longer reach `llama-server`.
- `start` and `doctor` say so when the engine is the host's own build
  (`LLAMA_SERVER` or `PATH`) instead of the one Sublet installs.
- Host keys, API keys, bearer tokens, and `token=` parameters are redacted from
  every log line, on screen and on disk.
- `status` shows HELD only when the server marks the host as held (with the
  server's reason), never from the reliability number alone.
- The tunnel refuses server frames over 16 MB.
- Minimum Node.js is now 20.18.1 (needed by `undici`, used for proxies).
- The npm package no longer ships source maps.

## [1.2.2] - 2026-11-09

### Added
- Shared bookings: llama-server starts with the slot count the server sends.

### Fixed
- A benchmark load is shown as a benchmark, not as a buyer request.
- `--gpu`/`--vram` apply to `jobs` and `doctor`; an unknown VRAM size is shown as unknown.

## [1.2.1] - 2026-11-09

### Changed
- HELD is shown only when the server holds the host.

## [1.2.0] - 2026-11-09

- First public beta on npm.

[Unreleased]: https://github.com/somemusic69-sudo/Sublet-cli/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/somemusic69-sudo/Sublet-cli/releases/tag/v1.3.0
