# Sublera

This repository contains the standalone GPU host agent for the Sublera
peer-to-peer compute market.

- [`agent-cli/`](agent-cli/) — `sublera-cli`, the terminal worker described in
  [`CLI_PLAN.md`](CLI_PLAN.md).
- `CLI_PLAN.md` — the dedicated architecture and build plan for the CLI.

The central website/server and ledger live in a separate repository that is
not public yet. The CLI is intentionally a separate package so hosts can update it without
redeploying the marketplace. Its npm package is `sublera-cli`, and its default
server is `https://sublera.com`.

## Migration from Sublet

Use `sublera` / `sublera-cli` and `SUBLERA_*` in new commands and configuration.
The old `sublet` / `sublet-cli` aliases and `SUBLET_*` environment variables remain
supported; when both environment names are set, `SUBLERA_*` wins.
The default `~/.sublet` directory is intentionally unchanged so both names share
credentials, cache, and the instance lock. Model `.sublet.json` metadata is also
unchanged. The repository remains `somemusic69-sudo/Sublet-cli`. The default
server moved from `https://sublet.duckdns.org` to `https://sublera.com`.
See the [CLI migration guide](agent-cli/README.md#migration-from-sublet) for details.

## License

MIT. See [`LICENSE`](LICENSE) and
[`agent-cli/THIRD_PARTY_NOTICES.md`](agent-cli/THIRD_PARTY_NOTICES.md).
The CLI does not bundle model weights; each HuggingFace model keeps its own
license.

Quick start:

```bash
cd agent-cli
npm install
npm run build
node dist/index.js --help
```

See [`agent-cli/README.md`](agent-cli/README.md) for the full command reference,
architecture, server contract, and verification steps.
