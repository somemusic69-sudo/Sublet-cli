# Security

## Reporting

Do not open a public issue for a vulnerability. Email the maintainer with:

- affected version or commit
- operating system and Node version
- reproduction steps or proof of concept
- impact assessment

We will acknowledge the report and coordinate a fix and disclosure date.

## Host key handling

- Host keys are saved in `~/.sublet/config.json` with mode 0600.
- The tunnel prefers `Authorization: Bearer`, keeping the key out of URLs.
  The query-token form exists only as a compatibility fallback for older
  servers.
- Do not paste host keys into screenshots, issues, or logs. The CLI masks keys
  in its own output, but the terminal scrollback is yours.
- Every log line, on screen and in `~/.sublet/logs/agent.log`, is filtered:
  `sh_`/`sk-` keys, `Bearer` values, and `token=` parameters are replaced with
  `***`. The agent log file is created with mode 0600. Prompts and model
  output are never logged.
- `SUBLERA_KEY` is supported for fleets and containers; legacy `SUBLET_KEY`
  remains supported, with `SUBLERA_KEY` winning when both are set. The default
  `~/.sublet` intentionally shares credentials, cache, and the instance lock
  across old and new command aliases. Prefer a secret store
  (systemd `LoadCredential`, Docker secrets, a CI secret) over a plain shell
  profile. `sublera config` always shows the key masked.

## Network

- The agent only makes outbound connections: the Sublera server (HTTPS and one
  WebSocket), `huggingface.co`/`hf.co` and its CDN for models,
  `api.github.com`/`github.com` for llama.cpp releases, and
  `registry.npmjs.org` for the version check. The engine opens a loopback-only
  HTTP port; the agent does not expose a public listening port by default.
- With `HTTPS_PROXY` set, the tunnel uses HTTP CONNECT, so TLS runs end to end
  between the agent and the Sublera server for HTTPS/WSS destinations. A normal
  forwarding proxy sees destination and traffic metadata, not encrypted content.
  An authorized TLS-inspecting proxy with a trusted root CA can read host keys
  and content. HTTP/WS destinations are not end-to-end encrypted. Corporate roots
  can be configured with `NODE_EXTRA_CA_CERTS`; certificate checks stay enabled.
- Proxy credentials in `HTTPS_PROXY` are hidden in all output.

## Model and binary trust

- Model downloads must use HTTPS (localhost is allowed for tests).
- GGUF files are checked for magic bytes, architecture, layers, and SHA-256
  when HuggingFace publishes an LFS hash.
- A cached model is hashed again before it is served (once per agent run); the
  sidecar file next to it is not accepted as the hash of a model being served.
  The list of cached models that marks a request "ready now" on the market
  still comes from sidecars; it is a hint, and the file is hashed when taken.
- The agent's reports about itself (model hash, engine, self-check) are not a
  security boundary: the host controls the machine and can change this
  program. Authenticity requires independent server-side verification. This
  repository cannot establish the coverage or effectiveness of the server's
  hidden model checks. Local repeatability is diagnostic, not attestation.
- llama.cpp environment settings (`LLAMA_ARG_*`, `LLAMA_LOG_*`,
  `LLAMA_API_KEY`) are not passed to the engine.
- llama.cpp release archives are checked against the GitHub asset digest when
  available; `--require-checksum` refuses engines without verified archive
  checksums, including custom PATH/environment engines. This is integrity
  checking, not an independently signed authenticity guarantee.
- The downloaded llama.cpp binary is hashed and recorded in
  `~/.sublet/bin/manifest.json`, then re-checked on use.
- Only `.gguf` weights are accepted. Pickle, PyTorch, ONNX, and safetensors
  files are refused.
- `llama-server` is bound to `127.0.0.1`, runs with `--log-disable`, and is not
  exposed to the LAN.

## Reporting scope

The marketplace server, wallet, and payout infrastructure are a separate
codebase. This repository covers the terminal agent only.
