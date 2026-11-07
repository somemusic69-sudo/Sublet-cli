# Security

## Reporting

Do not open a public issue for a vulnerability. Email the maintainer with:

- affected version or commit
- operating system and Node version
- reproduction steps or proof of concept
- impact assessment

We will acknowledge the report and coordinate a fix and disclosure date.

## Host key handling

- Host keys are saved in `~/.kiln/config.json` with mode 0600.
- The tunnel prefers `Authorization: Bearer`, keeping the key out of URLs.
  The query-token form exists only as a compatibility fallback for older
  servers.
- Do not paste host keys into screenshots, issues, or logs. The CLI masks keys
  in its own output, but the terminal scrollback is yours.

## Model and binary trust

- Model downloads must use HTTPS (localhost is allowed for tests).
- GGUF files are checked for magic bytes, architecture, layers, and SHA-256
  when HuggingFace publishes an LFS hash.
- llama.cpp release archives are checked against the GitHub asset digest when
  available; `kiln doctor --fix --require-checksum` refuses an unpublished
  release.
- The downloaded llama.cpp binary is hashed and recorded in
  `~/.kiln/bin/manifest.json`, then re-checked on use.
- Only `.gguf` weights are accepted. Pickle, PyTorch, ONNX, and safetensors
  files are refused.
- `llama-server` is bound to `127.0.0.1`, runs with `--log-disable`, and is not
  exposed to the LAN.

## Reporting scope

The marketplace server, wallet, and payout infrastructure are a separate
codebase. This repository covers the terminal agent only.
