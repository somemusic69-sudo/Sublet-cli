#!/usr/bin/env node
import http from 'node:http';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const port = Number(arg('--port', '0'));
const context = Number(process.env.FAKE_CTX || '8192');
const slots = Number(arg('--parallel', '1'));
const modelPath = arg('-m', 'fake.gguf');
let chatCount = 0;

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.url === '/props') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ n_ctx: context, default_generation_settings: { n_ctx: context }, total_slots: slots, model_path: modelPath }));
    return;
  }
  if (req.url === '/crash') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    setTimeout(() => process.exit(7), 30);
    return;
  }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || '{}');
    const stream = parsed.stream !== false;
    chatCount++;
    if (!stream) {
      const text = 'Paris';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'fake', object: 'chat.completion', model: 'fake',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop', logprobs: { content: [{ token: 'Paris', logprob: -0.01 }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunks = ['Hello', ' from', ' the', ' fake', ' GPU'];
    for (const [index, text] of chunks.entries()) {
      const frame = {
        id: 'fake', object: 'chat.completion.chunk', model: 'fake',
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
      await new Promise((r) => setTimeout(r, 5));
      if (index === chunks.length - 1) {
        res.write(`data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
    }
    res.end();
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`fake llama on ${typeof address === 'object' && address ? address.port : port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
