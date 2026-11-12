# 90-hour GPU acceptance test

This is a proposed operator-run test, not a completed test or a scheduled job.
Use a staging marketplace or explicitly authorized test bookings. Do not inject
failures into a paying customer's booking. Record the exact uncommitted diff or
commit, package version, Node version, OS, GPU/driver, engine archive digest,
model reference digest, settings and server build. Never record credentials.

## Entry gates

- Run `npm ci` and `npm run check` in the CLI directory on the target host.
- Run `sublet doctor --fix --require-checksum` with the intended proxy/CA path.
- Authenticate in advance. Use `--non-interactive` under the intended service
  account; verify missing credentials fail rather than starting a login flow.
- Load the real GGUF and confirm its independently obtained reference digest.
- Verify the server actually checks model evidence before starting billing.
  Establish server-side booking, inference, cancellation and billing assertions.
- Collect baseline GPU temperature, VRAM, throughput, process memory, handles,
  disk space and log growth. Set host-specific safe temperature/power limits.

## Timeline (90 elapsed hours)

| Hours | Exercise |
| --- | --- |
| 0–6 | Real single-slot bookings: load, verification, streaming, cancel, completion. Compare text, usage and booking state with server records. |
| 6–24 | Sustained representative workload and authorized multi-slot bookings within VRAM limits; include long prompts and model switches. |
| 24–36 | Controlled network loss, proxy restart/auth failure, server restart and reconnect. Include a dropped stream and ensure partial output is not successful completion. |
| 36–48 | Kill the engine during test inference; verify bounded restart, model reload, repeatability diagnostics and subsequent successful jobs. Exercise exhausted restart policy. |
| 48–60 | Graceful CLI/service restart and forced process termination; reconcile persisted booking with the server and confirm no duplicate billing or orphan work. |
| 60–72 | Recovery drills: invalid credentials, malformed settings, unwritable/full log volume and safe cache-corruption fixture. Restore configuration; prove errors preserve unrelated files. |
| 72–90 | Uninterrupted representative real workload. No fault injection; measure stability and reconcile every booking. |

## Evidence and acceptance

- Sample resource metrics at least once per minute and retain timestamped,
  redacted CLI logs plus corresponding server job/booking events.
- Reconcile all submitted, cancelled, failed and completed jobs. Truncation,
  engine errors and timeouts must never be silently billed as completed work.
- Require correct server-authorized booking recovery and no duplicate payouts.
- Confirm log rotation remains bounded, secrets are absent from collected
  artifacts, and no unexpected public engine port is listening.
- Define throughput/latency and restart/reconnect budgets before starting;
  report p50/p95/p99 and worst observed recovery against those budgets.
- Reject unexplained monotonic memory/handle growth, unrecovered disconnects,
  unhandled rejections, destructive cache recovery or model-check false passes.
- Use independent server-side negative tests for substituted model evidence.
  Local hashing and repeatability cannot attest an adversarial host.

Record failures with timestamps and reproducible steps. After any behavioral
fix, rerun its regression test and restart the relevant acceptance window;
do not describe a patched or interrupted run as 90 hours uninterrupted.