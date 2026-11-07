import type { ChatMessage } from '../types.js';

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
  tokens: string[];
  logprobs: number[];
  ttftMs: number | null;
  tokPerSec: number | null;
};

export type StreamOptions = {
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];

  push(text: string): string[] {
    this.buffer += text;
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
        }
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('data:')) this.dataLines.push(line.slice(5).trimStart());
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
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function streamChat(llamaUrl: string, job: ProxyJob, options: StreamOptions = {}): Promise<StreamResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Generation timed out')), options.timeoutMs ?? 10 * 60_000);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort);
  const started = Date.now();
  let firstTokenAt: number | null = null;
  let text = '';
  let finishReason = 'stop';
  let usage: StreamResult['usage'] = null;
  const tokens: string[] = [];
  const logprobs: number[] = [];
  let chunkCount = 0;

  try {
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
        ...(job.seed != null ? { seed: job.seed } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      throw new Error(`llama-server returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
    const parser = new SseParser();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const events = parser.push(decoder.decode(value, { stream: true }));
      for (const event of events) {
        if (event === '[DONE]') continue;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(event) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (json.error) {
          const error = json.error as { message?: string } | string;
          throw new Error(typeof error === 'string' ? error : error.message || 'llama-server stream error');
        }
        const eventUsage = json.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined;
        if (eventUsage) {
          usage = {
            prompt_tokens: Number(eventUsage.prompt_tokens || 0),
            completion_tokens: Number(eventUsage.completion_tokens || 0),
            total_tokens: Number(eventUsage.total_tokens || 0),
          };
        }
        const choices = Array.isArray(json.choices) ? json.choices as Array<Record<string, unknown>> : [];
        for (const choice of choices) {
          const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta as Record<string, unknown> : {};
          const piece = deltaContent(delta.content);
          if (piece) {
            if (firstTokenAt == null) firstTokenAt = Date.now();
            text += piece;
            tokens.push(piece);
            chunkCount++;
            options.onChunk?.(piece);
          }
          const lp = choice.logprobs && typeof choice.logprobs === 'object' ? choice.logprobs as { content?: Array<{ token?: string; logprob?: number }> } : null;
          if (lp?.content) {
            for (const entry of lp.content) {
              if (typeof entry.token === 'string') tokens.push(entry.token);
              const value = asNumber(entry.logprob);
              if (value != null) logprobs.push(value);
            }
          }
          if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
    }
    for (const event of parser.flush()) {
      if (event === '[DONE]') continue;
      try {
        const json = JSON.parse(event) as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
        if (json.usage) usage = {
          prompt_tokens: Number(json.usage.prompt_tokens || 0),
          completion_tokens: Number(json.usage.completion_tokens || 0),
          total_tokens: Number(json.usage.total_tokens || 0),
        };
      } catch {
        /* ignored */
      }
    }
    const elapsed = Math.max(1, Date.now() - started);
    const completion = usage?.completion_tokens || chunkCount;
    return {
      text,
      finishReason,
      promptTokens: usage?.prompt_tokens || 0,
      completionTokens: completion,
      usage,
      tokens,
      logprobs,
      ttftMs: firstTokenAt ? firstTokenAt - started : null,
      tokPerSec: completion / (elapsed / 1000),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function runCanary(llamaUrl: string, prompt: string, options: StreamOptions = {}): Promise<{ tokens: string[]; logprobs: number[]; text: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${llamaUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      model: 'local',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      temperature: 0,
      seed: 42,
      max_tokens: 8,
      logprobs: true,
      top_logprobs: 1,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Canary request failed with ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const json = await response.json() as {
    choices?: Array<{
      message?: { content?: unknown };
      logprobs?: { content?: Array<{ token?: string; logprob?: number }> };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = json.choices?.[0];
  const text = deltaContent(choice?.message?.content);
  const content = choice?.logprobs?.content || [];
  const tokens = content.map((entry) => entry.token).filter((token): token is string => typeof token === 'string' && token.length > 0);
  const logprobs = content.map((entry) => asNumber(entry.logprob)).filter((value): value is number => value != null);
  if (!tokens.length && text) tokens.push(...text.split(/(\s+)/).filter((part) => part.trim().length > 0));
  return { tokens, logprobs, text };
}

export function simulateReply(prompt: string, model: string): string {
  const q = prompt.replace(/\s+/g, ' ').trim();
  const short = q.length > 180 ? `${q.slice(0, 180)}.` : q;
  if (!q) return 'Kiln simulator is ready. Send a prompt and every streamed token is metered by the central server.';
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
      `Simulated by Kiln on ${model}. A live GPU would run the real GGUF weights.`,
    ].join('\n');
  }
  return [
    `On ${model}, the useful reading of that prompt is: ${short || 'a short request'}.`,
    'This node is in simulation mode: the stream, the meter, and the wallet are real, while the words are a stand-in.',
    'Run kiln doctor, install llama-server, and drop --simulation for real GGUF output.',
  ].join(' ');
}

export async function simulateChat(job: ProxyJob, options: { signal?: AbortSignal; tokPerSec?: number; onChunk?: (text: string) => void } = {}): Promise<StreamResult> {
  const prompt = job.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const text = simulateReply(prompt, job.model || 'kiln-simulator');
  const pieces = text.split(/(\s+)/).filter((piece) => piece.length > 0);
  const started = Date.now();
  let sent = '';
  let first: number | null = null;
  const delay = Math.max(5, Math.round(1000 / Math.max(5, options.tokPerSec ?? 24)));
  for (const piece of pieces) {
    if (options.signal?.aborted) break;
    if (first == null) first = Date.now();
    await new Promise((r) => setTimeout(r, delay));
    sent += piece;
    options.onChunk?.(piece);
  }
  const elapsed = Math.max(1, Date.now() - started);
  return {
    text: sent,
    finishReason: 'stop',
    promptTokens: Math.max(1, Math.ceil(prompt.length / 4)),
    completionTokens: pieces.length,
    usage: { prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)), completion_tokens: pieces.length, total_tokens: pieces.length + Math.ceil(prompt.length / 4) },
    tokens: pieces,
    logprobs: [],
    ttftMs: first ? first - started : null,
    tokPerSec: pieces.length / (elapsed / 1000),
  };
}

export function canarySimulation(): { tokens: string[]; logprobs: number[] } {
  return { tokens: ['Paris'], logprobs: [-0.01] };
}
