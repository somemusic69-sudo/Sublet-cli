# Third-Party Notices

Sublet CLI is MIT-licensed. It depends on the following packages; none of their
code is modified in this repository.

## Runtime dependencies

| Package | License | Use |
| --- | --- | --- |
| `adm-zip` | MIT | Extract official llama.cpp Windows ZIP releases |
| `tar` | ISC | Extract official llama.cpp Linux/macOS tarballs |
| `ws` | MIT | Outbound WebSocket tunnel and reconnect handling |

## Development dependencies

| Package | License |
| --- | --- |
| `typescript` | Apache-2.0 |
| `tsx` | MIT |
| `@types/node` | MIT |
| `@types/ws` | MIT |
| `@types/tar` | MIT |
| `@types/adm-zip` | MIT |

## Downloaded at runtime, not bundled

- **llama.cpp / `llama-server`** — MIT. Downloaded from the official
  `ggml-org/llama.cpp` GitHub releases and checked against the published digest
  when available.
- **GGUF model weights** — each HuggingFace model has its own license. The CLI
  does not bundle weights and does not grant rights to any model. Hosts are
  responsible for following the model's license and acceptable-use terms.
- **Node.js** — MIT.

The Sublet marketplace server, wallet, and payment integrations are a separate
codebase and are not covered by this repository's license.
