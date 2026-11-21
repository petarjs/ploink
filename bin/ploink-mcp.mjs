#!/usr/bin/env node
// stdio <-> HTTP bridge for MCP clients that only speak stdio.
// Usage in a client config:
//   { "command": "node", "args": ["/path/to/ploink/bin/ploink-mcp.mjs"], "env": { "PLOINK_TOKEN": "plk_..." } }
// The token comes from Ploink > Settings > Agents.
import readline from 'node:readline';

const port = Number(process.env.PLOINK_PORT) || 47321;
const tokenArg = process.argv.indexOf('--token');
const token = process.env.PLOINK_TOKEN || (tokenArg > 0 ? process.argv[tokenArg + 1] : '');
const endpoint = `http://127.0.0.1:${port}/mcp`;
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const rl = readline.createInterface({ input: process.stdin });
const inflight = new Set();
let closing = false;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const job = forward(msg).finally(() => {
    inflight.delete(job);
    if (closing && !inflight.size) process.exit(0);
  });
  inflight.add(job);
});
rl.on('close', () => {
  closing = true;
  if (!inflight.size) process.exit(0);
});

async function forward(msg) {
  const ids = (Array.isArray(msg) ? msg : [msg]).filter((m) => m && m.method && m.id != null).map((m) => m.id);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(msg),
    });
    if (res.status === 202) return;
    const body = await res.json();
    if (res.status === 401) {
      for (const id of ids) write({ jsonrpc: '2.0', id, error: body.error || { code: -32001, message: 'Ploink needs a client token (PLOINK_TOKEN).' } });
      return;
    }
    for (const m of Array.isArray(body) ? body : [body]) write(m);
  } catch {
    for (const id of ids) {
      write({ jsonrpc: '2.0', id, error: { code: -32000, message: `Ploink is not running (nothing listening on ${endpoint}). Open the Ploink app and try again.` } });
    }
  }
}
