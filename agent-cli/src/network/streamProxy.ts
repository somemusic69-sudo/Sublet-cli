import type { ChatMessage, TokenPosition } from '../types.js';

/**
 * Token probabilities go out with the first positions of every job, so the server can check the model behind any job
 * (its model checks look exactly like normal work). Later tokens are sent without them to keep frames small.
 */
export const PROBED_POSITIONS = 32;
const TOP_ALTERNATIVES = 5;

export type ProxyJob = {
  jobId: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  model?: string;
  seed?: number;
};

export type StreamResult = {
  text: string;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  ttftMs: number | null;
  tokPerSec: number | null;
};

/** `positions` holds the probabilities of the tokens in this chunk, for the first PROBED_POSITIONS tokens only. */
export type ChunkHandler = (text: string, positions: TokenPosition[]) => void;

export type StreamOptions = {
  signal?: AbortSignal;
  onChunk?: ChunkHandler;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventSize = 0;

  push(text: string): string[] {
    this.buffer += text;
    if (this.buffer.length > 2 * 1024 * 1024) throw new Error('llama-server SSE buffer exceeds limit');
    const events: string[] = [];
    while (true) {
      const match = this.buffer.match(/\r?\n/);
      if (!match || match.index == null) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (line === '') {
        if (this.dataLines.length) {
          events.push(this.dataLines.join('\n'));
          this.dataLines = [];
          this.eventSize = 0;
        }
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        this.eventSize += line.length;
        if (this.eventSize > 1024 * 1024) throw new Error('llama-server SSE event exceeds limit');
        this.dataLines.push(line.slice(5).trimStart());
      }
    }
    return events;
  }

  flush(): string[] {
    const events: string[] = [];
    if (this.buffer.startsWith('data:')) this.dataLines.push(this.buffer.slice(5).trimStart());
    this.buffer = '';
    if (this.dataLines.length) {
      events.push(this.dataLines.join('\n'));
      this.dataLines = [];
      this.eventSize = 0;
    }
    return events;
  }
}

function deltaContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') return (part as { text: string }).text;
    return '';
  }).join('');
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value <= 0 && value > -9999 ? value : null;
}

type LogprobEntry = { token?: unknown; logprob?: unknown; top_logprobs?: Array<{ token?: unknown; logprob?: unknown }> };

function toPosition(entry: LogprobEntry): TokenPosition | null {
  if (!entry || typeof entry !== 'object') return null;
  const l = asNumber(entry.logprob);
  if (typeof entry.token !== 'string' || l == null) return null;
  const top: Array<[string, number]> = [];
  for (const alt of Array.isArray(entry.top_logprobs) ? entry.top_logprobs.slice(0, TOP_ALTERNATIVES) : []) {
    if (!alt || typeof alt !== 'object') continue;
    const value = asNumber(alt.logprob);
    if (typeof alt.token === 'string' && value != null) top.push([alt.token, value]);
  }
  return { t: entry.token, l, top };
}

export async function streamChat(llamaUrl: string, job: ProxyJob, options: StreamOptions = {}): Promise<StreamResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Generation timed out')), options.timeoutMs ?? 10 * 60_000);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort);
  if (options.signal?.aborted) onAbort();
  const started = Date.now();
  let firstTokenAt: number | null = null;
  let text = '';
  let finishReason = 'stop';
  let usage: StreamResult['usage'] = null;
  let chunkCount = 0;
  let probed = 0;
  let pending: TokenPosition[] = [];
  let completed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(`${llamaUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        model: job.model || 'local',
        messages: job.messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: job.temperature,
        max_tokens: job.maxTokens,
        logprobs: true,
        top_logprobs: TOP_ALTERNATIVES,
        ...(job.seed != null ? { seed: job.seed } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      throw new Error(`llama-server returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
    const parser = new SseParser();
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const consume = (event: string) => {
        if (completed) return;
        if (event === '[DONE]') { completed = true; return; }
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(event) as Record<string, unknown>;
        } catch {
          throw new Error('Malformed JSON in llama-server stream');
        }
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Invalid llama-server stream event');
        if (json.error) {
          const error = json.error as { message?: string } | string;
          throw new Error(typeof error === 'string' ? error : error.message || 'llama-server stream error');
        }
        const eventUsage = json.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined;
        if (eventUsage) {
          const counts = [eventUsage.prompt_tokens, eventUsage.completion_tokens, eventUsage.total_tokens];
          if (!counts.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid llama-server token usage');
          usage = {
            prompt_tokens: Number(eventUsage.prompt_tokens || 0),
            completion_tokens: Number(eventUsage.completion_tokens || 0),
            total_tokens: Number(eventUsage.total_tokens || 0),
          };
        }
        const choices = Array.isArray(json.choices) ? json.choices as Array<Record<string, unknown>> : [];
        for (const choice of choices) {
          if (!choice || typeof choice !== 'object') throw new Error('Invalid llama-server choice');
          const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta as Record<string, unknown> : {};
          const lp = choice.logprobs && typeof choice.logprobs === 'object' ? choice.logprobs as { content?: LogprobEntry[] } : null;
          for (const entry of Array.isArray(lp?.content) ? lp.content : []) {
            if (probed >= PROBED_POSITIONS) break;
            const position = toPosition(entry);
            if (!position) continue;
            pending.push(position);
            probed++;
          }
          const piece = deltaContent(delta.content);
          if (piece) {
            if (text.length + piece.length > 16 * 1024 * 1024) throw new Error('llama-server output exceeds limit');
            if (firstTokenAt == null) firstTokenAt = Date.now();
            text += piece;
            chunkCount++;
            options.onChunk?.(piece, pending);
            pending = [];
          }
          if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
        }
    };
    while (!completed) {
      controller.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        for (const event of parser.push(decoder.decode())) consume(event);
        for (const event of parser.flush()) consume(event);
        break;
      }
      for (const event of parser.push(decoder.decode(value, { stream: true }))) consume(event);
    }
    controller.signal.throwIfAborted();
    if (!completed) throw new Error('llama-server stream ended before [DONE]');
    const elapsed = Math.max(1, Date.now() - started);
    // Events update usage inside consume(), which TypeScript cannot track here.
    const finalUsage = usage as StreamResult['usage'];
    const completion = finalUsage?.completion_tokens ?? chunkCount;
    return {
      text,
      finishReason,
      promptTokens: finalUsage?.prompt_tokens ?? 0,
      completionTokens: completion,
      usage: finalUsage,
      ttftMs: firstTokenAt ? firstTokenAt - started : null,
      tokPerSec: completion / (elapsed / 1000),
    };
  } finally {
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export function simulateReply(prompt: string, model: string): string {
  const q = prompt.replace(/\s+/g, ' ').trim();
  const short = q.length > 180 ? `${q.slice(0, 180)}.` : q;
  if (!q) return 'Sublet simulator is ready. Send a prompt and every streamed token is metered by the central server.';
  if (/```|function|def |class |sql|python|typescript|javascript|regex/i.test(q)) {
    return [
      'Here is a small, explicit sketch you can replace:',
      '',
      '```ts',
      'export function solve(input: string): string {',
      `  // ${short}`,
      '  return input.trim();',
      '}',
      '```',
      '',
      `Simulated by Sublet on ${model}. A live GPU would run the real GGUF weights.`,
    ].join('\n');
  }
  return [
    `On ${model}, the useful reading of that prompt is: ${short || 'a short request'}.`,
    'This node is in simulation mode: the stream, the meter, and the wallet are real, while the words are a stand-in.',
    'Run sublet doctor, install llama-server, and drop --simulation for real GGUF output.',
  ].join(' ');
}

/** Stand-in probabilities for test nodes: the same shape as llama-server's, so the server's checks run end to end. */
export function simulatedPosition(token: string): TokenPosition {
  return { t: token, l: -0.05, top: [[token, -0.05], [' the', -3.2], [' a', -3.9], ['.', -4.4], [',', -4.8]] };
}

export async function simulateChat(job: ProxyJob, options: { signal?: AbortSignal; tokPerSec?: number; onChunk?: ChunkHandler } = {}): Promise<StreamResult> {
  const prompt = job.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const text = simulateReply(prompt, job.model || 'sublet-simulator');
  const pieces = text.split(/(\s+)/).filter((piece) => piece.length > 0);
  const started = Date.now();
  let sent = '';
  let first: number | null = null;
  const delay = Math.max(5, Math.round(1000 / Math.max(5, options.tokPerSec ?? 24)));
  for (const [index, piece] of pieces.entries()) {
    if (options.signal?.aborted) break;
    if (first == null) first = Date.now();
    await new Promise((r) => setTimeout(r, delay));
    sent += piece;
    options.onChunk?.(piece, index < PROBED_POSITIONS ? [simulatedPosition(piece)] : []);
  }
  const elapsed = Math.max(1, Date.now() - started);
  return {
    text: sent,
    finishReason: 'stop',
    promptTokens: Math.max(1, Math.ceil(prompt.length / 4)),
    completionTokens: pieces.length,
    usage: { prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)), completion_tokens: pieces.length, total_tokens: pieces.length + Math.ceil(prompt.length / 4) },
    ttftMs: first ? first - started : null,
    tokPerSec: pieces.length / (elapsed / 1000),
  };
}
