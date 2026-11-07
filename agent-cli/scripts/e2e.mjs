#!/usr/bin/env node
/**
 * End-to-end proof for the terminal agent against a running Kiln server.
 *
 * It uses simulation mode so no GPU or multi-GB GGUF is required. The tunnel,
 * canary, billing, streaming, booking timer, reconnect grace, and CLI commands
 * are all the real production paths.
 *
 * Run: npm run build && npm run e2e
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = (process.env.KILN_E2E_SERVER || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CLI = join(process.cwd(), 'dist', 'index.js');
const HOME = await mkdtemp(join(tmpdir(), 'kiln-e2e-'));
let buyerKey = process.env.KILN_E2E_BUYER_KEY || '';
const results = [];

function log(name, detail) {
  results.push({ name, detail });
  console.log(`ok - ${name}: ${detail}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

async function login(who) {
  const response = await fetch(`${SERVER}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: who, password: 'kiln-demo' }),
  });
  const text = await response.text();
  assert(response.ok, `login ${who} failed: ${response.status} ${text}`);
  const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
  const cookie = cookies.map((value) => value.split(';')[0]).filter(Boolean).join('; ');
  const body = JSON.parse(text);
  return { cookie, user: body.user };
}

async function signup(username) {
  const response = await fetch(`${SERVER}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@kiln-e2e.test`, password: 'kiln-demo' }),
  });
  const text = await response.text();
  assert(response.ok, `signup ${username} failed: ${response.status} ${text}`);
  const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
  const cookie = cookies.map((value) => value.split(';')[0]).filter(Boolean).join('; ');
  const body = JSON.parse(text);
  return { cookie, user: body.user };
}

async function api(path, options = {}, cookie = '') {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${SERVER}${path}`, { ...options, headers });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: response.status, ok: response.ok, body, text };
}

async function createRequest(cookie, tag) {
  const result = await api('/api/board', {
    method: 'POST',
    body: JSON.stringify({
      hfUrl: `https://huggingface.co/kiln-e2e/${tag}-0.5b-gguf/resolve/main/${tag}-0.5b-q4_k_m.gguf`,
      hours: 0.5,
      pricePerHourUsd: 0.2,
      minContext: 2048,
      minTokS: 3,
      startMode: 'immediate',
    }),
  }, cookie);
  assert(result.ok, `create request failed: ${result.status} ${result.text}`);
  return result.body.request;
}

async function sseChat(path, maxTokens = 32) {
  const response = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${buyerKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hello in one sentence.' }], stream: true, max_tokens: maxTokens }),
  });
  assert(response.ok && response.body, `chat ${path} failed: ${response.status}`);
  const text = await response.text();
  const data = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
  const chunks = data.filter((value) => value !== '[DONE]').map((value) => { try { return JSON.parse(value); } catch { return {}; } });
  const failure = chunks.find((entry) => entry.error);
  assert(!failure, `chat ${path} returned an error: ${failure?.error?.message || 'unknown'}`);
  const content = chunks.map((entry) => entry.choices?.[0]?.delta?.content || '').join('');
  const final = [...chunks].reverse().find((entry) => entry.usage) || null;
  return { text, content, chunks, final };
}

async function startAgent(token) {
  return spawnCli([
    'start', '--simulation', '--no-color', '--tok-s', '40',
    '--gpu', 'NVIDIA GeForce RTX 4060', '--vram', '8188',
    '--server', SERVER, '--key', token,
  ]);
}

async function startJobs(token, requestId) {
  return spawnCli([
    'jobs', '--claim', requestId, '--simulation', '--no-color', '--tok-s', '40',
    '--gpu', 'NVIDIA GeForce RTX 4060', '--vram', '8188',
    '--server', SERVER, '--key', token,
  ]);
}

function spawnCli(args) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, KILN_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  child.once('exit', (code) => { if (code && code !== 0) console.error(`agent exited ${code}\n${output.slice(-2000)}`); });
  return { child, output: () => output };
}

async function stopAgent(agent) {
  if (agent.child.exitCode != null) return;
  agent.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { try { agent.child.kill('SIGKILL'); } catch { /* */ } resolve(); }, 6_000);
    agent.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function crashAgent(agent) {
  if (agent.child.exitCode != null) return;
  agent.child.kill('SIGKILL');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    agent.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

let agent;
try {
  const health = await api('/api/health');
  assert(health.ok, `server is not up at ${SERVER}`);

  const hostname = `e2e${String(Date.now()).slice(-8)}`;
  const host = await signup(hostname);
  const ava = await login('ava');
  if (!buyerKey) {
    const key = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'e2e' }) }, ava.cookie);
    assert(key.ok && typeof key.body.key === 'string', `buyer key failed: ${key.status} ${key.text}`);
    buyerKey = key.body.key;
  }
  const tokenResponse = await api('/api/host/token', { method: 'POST', body: '{}' }, host.cookie);
  assert(tokenResponse.ok, `host token failed: ${tokenResponse.status}`);
  const token = tokenResponse.body.token;
  assert(token?.startsWith('kh_'), 'host token format is wrong');
  log('host key', `issued for @${host.user.username} (${token.slice(0, 10)}...)`);

  const loginProc = spawn(process.execPath, [CLI, 'login', '--key', token, '--server', SERVER, '--json'], {
    env: { ...process.env, KILN_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let loginOutput = '';
  loginProc.stdout.on('data', (chunk) => { loginOutput += chunk.toString(); });
  loginProc.stderr.on('data', (chunk) => { loginOutput += chunk.toString(); });
  const loginCode = await new Promise((resolve) => loginProc.once('exit', resolve));
  assert(loginCode === 0 && loginOutput.includes('"ok":true'), `login failed: ${loginOutput}`);
  log('login', 'host key saved to the isolated Kiln home');

  agent = await startAgent(token);
  const me = await waitFor(async () => {
    const result = await api('/api/agent/me', { headers: { authorization: `Bearer ${token}` } });
    if (result.ok && result.body.host?.status === 'online' && result.body.host?.kind === 'live') return result.body;
    return null;
  }, 20_000, `the agent to connect (${agent.output().slice(-400)})`);
  log('tunnel', `${me.host.gpuName} is ${me.host.status} as a ${me.host.kind} node`);

  const publicChat = await sseChat(`/h/${host.user.username}/v1/chat/completions`, 32);
  assert(publicChat.chunks.length > 3, 'expected streamed token chunks');
  assert(publicChat.text.includes('data: [DONE]'), 'missing [DONE]');
  assert(publicChat.final?.usage?.completion_tokens > 0, 'missing usage in final chunk');
  assert(publicChat.final?.kiln?.charged === true, 'public chat was not billed');
  log('pay-per-token', `${publicChat.final.usage.completion_tokens} tokens billed through the tunnel`);

  const request = await createRequest(ava.cookie, `e2e${Date.now()}`);
  const claim2 = await fetch(`${SERVER}/api/agent/requests/${request.id}/claim`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert(claim2.ok, `claim failed: ${claim2.status} ${await claim2.text()}`);
  const active = await waitFor(async () => {
    const result = await api('/api/agent/me', { headers: { authorization: `Bearer ${token}` } });
    return result.body.activeRequest?.id === request.id && result.body.activeRequest.timerStartedAt ? result.body.activeRequest : null;
  }, 20_000, 'the canary and booking timer');
  assert(active.status === 'active', `booking did not become active: ${active.status}`);
  const startedAt = active.timerStartedAt;
  assert(startedAt > 0 && active.timerEndsAt > startedAt, 'timer window is invalid');
  log('canary + timer', `request ${request.id} timer started after verification`);

  const bookedChat = await sseChat(`/r/${request.id}/v1/chat/completions`, 24);
  assert(bookedChat.final?.kiln?.charged === false, 'booked tokens were charged');
  assert(bookedChat.chunks.length > 2, 'booked chat did not stream');
  log('unlimited booking', `${bookedChat.final.usage.completion_tokens} tokens during the paid window, charged $0`);

  const board = await api('/api/agent/requests', { headers: { authorization: `Bearer ${token}` } });
  assert(board.ok, 'agent request board failed');
  assert(!board.body.requests.some((row) => row.id === request.id), 'active booking is still advertised as open');
  log('jobs board', `${board.body.requests.length} open request(s), active booking excluded`);

  // Crash the process (no graceful stop) and prove the persisted booking is
  // restored from ~/.kiln/state.json, not just kept alive in memory.
  await waitFor(async () => {
    try {
      const raw = await readFile(join(HOME, 'state.json'), 'utf8');
      const state = JSON.parse(raw);
      return state.booking?.requestId === request.id && state.booking?.timerEndsAt === active.timerEndsAt ? state : null;
    } catch {
      return null;
    }
  }, 10_000, 'the booking state to hit disk');
  await crashAgent(agent);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const persisted = await waitFor(async () => {
    try {
      const raw = await readFile(join(HOME, 'state.json'), 'utf8');
      const state = JSON.parse(raw);
      return state.booking?.requestId === request.id && state.booking?.timerEndsAt === active.timerEndsAt ? state : null;
    } catch {
      return null;
    }
  }, 10_000, 'the booking state to survive the crash');
  assert(persisted.booking.timerStartedAt === startedAt, 'persisted timer changed');
  agent = await startAgent(token);
  const restored = await waitFor(async () => {
    const result = await api('/api/agent/me', { headers: { authorization: `Bearer ${token}` } });
    return result.ok && result.body.host?.status === 'online' && result.body.activeRequest?.timerStartedAt === startedAt ? result.body : null;
  }, 20_000, 'the crashed agent to restore the booking');
  const restoredChat = await sseChat(`/r/${request.id}/v1/chat/completions`, 16);
  assert(restoredChat.final?.kiln?.charged === false, 'restored booking charged tokens');
  log('60s grace + overnight recovery', `process restart reattached ${restored.activeRequest.id} with the same timer`);

  const cancel = await api(`/api/board/${request.id}/cancel`, { method: 'POST', body: '{}' }, ava.cookie);
  assert(cancel.ok, 'buyer could not cancel the request');
  log('cleanup', 'request cancelled and unused escrow returned');

  // The jobs command must be able to claim and serve without a second start
  // process. Stop the main agent first, then let `jobs` own the tunnel.
  await stopAgent(agent);
  agent = null;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const jobsRequest = await createRequest(ava.cookie, `job${Date.now()}`);
  const jobsAgent = await startJobs(token, jobsRequest.id);
  try {
    const jobsActive = await waitFor(async () => {
      const result = await api('/api/agent/me', { headers: { authorization: `Bearer ${token}` } });
      return result.ok && result.body.host?.status === 'online' && result.body.activeRequest?.id === jobsRequest.id && result.body.activeRequest.timerStartedAt
        ? result.body.activeRequest
        : null;
    }, 25_000, 'kiln jobs to claim and start serving');
    const jobsChat = await sseChat(`/r/${jobsRequest.id}/v1/chat/completions`, 16);
    assert(jobsChat.final?.kiln?.charged === false, 'standalone jobs chat was charged');
    log('standalone jobs', `claimed ${jobsActive.id} and served it in one process`);
    await api(`/api/board/${jobsRequest.id}/cancel`, { method: 'POST', body: '{}' }, ava.cookie);
    await waitFor(async () => jobsAgent.child.exitCode != null, 20_000, 'kiln jobs to exit after cancellation');
  } finally {
    if (jobsAgent.child.exitCode == null) await stopAgent(jobsAgent);
  }

  console.log(`\n${results.length} end-to-end checks passed against ${SERVER}.`);
} finally {
  if (agent) await stopAgent(agent);
  await rm(HOME, { recursive: true, force: true }).catch(() => undefined);
}
