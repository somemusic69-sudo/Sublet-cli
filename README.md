# Sublet

This repository contains the standalone GPU host agent for the Sublet
peer-to-peer compute market.

- [`agent-cli/`](agent-cli/) — `sublet-cli`, the terminal worker described in
  [`CLI_PLAN.md`](CLI_PLAN.md).
- `CLI_PLAN.md` — the dedicated architecture and build plan for the CLI.

The central website/server and ledger live in a separate repository that is
not public yet. The CLI is intentionally a separate npm package so hosts can update
it with `npx sublet-cli` without redeploying the marketplace.

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
