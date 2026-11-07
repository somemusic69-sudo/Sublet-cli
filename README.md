# KILN

This repository contains the standalone GPU host agent for the Kiln
peer-to-peer compute market.

- [`agent-cli/`](agent-cli/) — `kiln-agent`, the terminal worker described in
  [`CLI_PLAN.md`](CLI_PLAN.md).
- `CLI_PLAN.md` — the dedicated architecture and build plan for the CLI.

The central website/server and ledger live in the companion `sellingai`
repository. The CLI is intentionally a separate npm package so hosts can update
it with `npx kiln-agent` without redeploying the marketplace.

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
