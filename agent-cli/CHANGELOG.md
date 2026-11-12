# Changelog

All notable changes to `sublet-cli` are listed here. The project follows
[Semantic Versioning](https://semver.org/). The stable surface is: command
names, flags, `SUBLET_*` variables, `agent.json` keys, exit codes, the
`--json` output of `doctor` and `config` (versioned by `schemaVersion`), and
the files under `~/.sublet`. A change to any of these needs a major version.

## [Unreleased]

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
