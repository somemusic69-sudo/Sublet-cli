/**
 * A local check of the engine's own answers. The server decides whether a host runs the model it
 * claims (it compares token probabilities across hosts); nothing here replaces that, and a host
 * who edits this program can skip it. This is a limited repeatability check, not proof of model
 * identity or GPU health. Even temperature-0 inference can vary with batching, backend kernels,
 * software, and numerical rounding. A measured change alone does not diagnose its cause.
 */

/** The chosen token and its log probability at each position of one short generation. */
export type EngineFingerprint = { tokens: string[]; logprobs: number[] };

export type FingerprintDiff = {
  /** true = matching measured evidence; false = measured change; null = inconclusive. */
  same: boolean | null;
  /** Positions that were compared before the answers ended or split at a near-tie. */
  compared: number;
  maxDelta: number;
  reason: string | null;
};

// A short repeatable prompt; models are not guaranteed to answer it with confident tokens.
const PROBE_MESSAGES = [{ role: 'user', content: 'Count from one to twelve in English words, separated by commas.' }];
const PROBE_TOKENS = 16;

/**
 * Heuristic log-probability tolerance, not a calibrated health threshold. This has not been
 * validated across backends or GPUs and can produce both false positives and false negatives.
 */
export const FINGERPRINT_TOLERANCE = 0.5;
/** Approximately ln(0.7), used only as a heuristic for distinguishing near-tie divergence. */
const CONFIDENT_LOGPROB = -0.357;

type ProbeOptions = { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch };

/** Runs the probe once. Returns null when it cannot be measured (request failed, cancelled, or no probabilities); that is "unknown", never a failure. */
export async function probeEngine(llamaUrl: string, options: ProbeOptions = {}): Promise<EngineFingerprint | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(`${llamaUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'local',
        messages: PROBE_MESSAGES,
        stream: false,
        temperature: 0,
        seed: 1,
        max_tokens: PROBE_TOKENS,
        logprobs: true,
        top_logprobs: 1,
        // Do not keep this prompt in the slot's cache.
        cache_prompt: false,
      }),
      signal,
    });
    if (!response.ok) return null;
    const json = await response.json() as { choices?: Array<{ logprobs?: { content?: Array<{ token?: unknown; logprob?: unknown }> } | null }> };
    if (!json || !Array.isArray(json.choices)) return null;
    const entries = json.choices?.[0]?.logprobs?.content;
    if (!Array.isArray(entries)) return null;
    const tokens: string[] = [];
    const logprobs: number[] = [];
    if (entries.length > PROBE_TOKENS) return null;
    for (const entry of entries) {
      if (!entry || typeof entry.token !== 'string' || !validLogprob(entry.logprob)) return null;
      tokens.push(entry.token);
      logprobs.push(entry.logprob);
    }
    return tokens.length ? { tokens, logprobs } : null;
  } catch {
    return null;
  }
}

function validLogprob(value: unknown): value is number {
  // OpenAI-compatible APIs use -9999 as an unavailable-logprob sentinel, not a measurement.
  return typeof value === 'number' && Number.isFinite(value) && value <= 0 && value !== -9999;
}

function validFingerprint(value: EngineFingerprint): boolean {
  if (!value || !Array.isArray(value.tokens) || !Array.isArray(value.logprobs)
      || !value.tokens.length || value.tokens.length !== value.logprobs.length) return false;
  // Indexed access also rejects sparse arrays (Array.every would skip their holes).
  for (let i = 0; i < value.tokens.length; i++) {
    if (typeof value.tokens[i] !== 'string' || !validLogprob(value.logprobs[i])) return false;
  }
  return true;
}

export function compareFingerprints(baseline: EngineFingerprint, current: EngineFingerprint, tolerance = FINGERPRINT_TOLERANCE): FingerprintDiff {
  if (!Number.isFinite(tolerance) || tolerance < 0 || !validFingerprint(baseline) || !validFingerprint(current)) {
    return { same: null, compared: 0, maxDelta: 0, reason: 'Missing or invalid fingerprint evidence or tolerance' };
  }
  const length = Math.min(baseline.tokens.length, current.tokens.length);
  let maxDelta = 0;
  for (let i = 0; i < length; i++) {
    const was = baseline.logprobs[i]!;
    const now = current.logprobs[i]!;
    if (baseline.tokens[i] !== current.tokens[i]) {
      if (was > CONFIDENT_LOGPROB || now > CONFIDENT_LOGPROB) {
        return { same: false, compared: i + 1, maxDelta, reason: `token ${i + 1} changed from ${JSON.stringify(baseline.tokens[i])} to ${JSON.stringify(current.tokens[i])}` };
      }
      // A near-tie can fall either way on rounding alone; the texts differ from here, so stop comparing.
      return { same: null, compared: i, maxDelta, reason: `Answers diverged at a low-confidence token ${i + 1}; remaining positions cannot be compared` };
    }
    const delta = Math.abs(was - now);
    if (delta > maxDelta) maxDelta = delta;
    if (delta > tolerance) {
      return { same: false, compared: i + 1, maxDelta, reason: `the log probability of token ${i + 1} (${JSON.stringify(baseline.tokens[i])}) moved by ${delta.toFixed(2)}` };
    }
  }
  if (baseline.tokens.length !== current.tokens.length) {
    return { same: null, compared: length, maxDelta, reason: 'Answers have different lengths; only their shared prefix was compared' };
  }
  return { same: true, compared: length, maxDelta, reason: null };
}
