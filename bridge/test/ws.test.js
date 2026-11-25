'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { startBridge } = require('../harness-bridge.js');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bridge-ws-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function openSocket(port, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.setTimeout(3000, () => reject(new Error('socket timeout')));
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const frames = [];
    let closed = false;
    socket.on('close', () => { closed = true; });
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 4);
        if (!head.startsWith('HTTP/1.1 101')) return reject(new Error('upgrade failed: ' + head.split('\r\n')[0]));
        upgraded = true;
        resolve({ socket, frames, isClosed: () => closed });
      }
      while (buffer.length >= 2) {
        const first = buffer[0];
        const opcode = first & 0x0f;
        const second = buffer[1];
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length).toString('utf8');
        buffer = buffer.subarray(offset + length);
        // Control frames (close/ping/pong) are not JSON messages.
        if (opcode === 0x1) frames.push(JSON.parse(payload));
      }
    });
  });
}

function sendText(socket, object) {
  const payload = Buffer.from(JSON.stringify(object), 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    throw new Error('test frame too large');
  }
  header[0] = 0x81;
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  socket.write(Buffer.concat([header, mask, masked]));
}

async function waitFor(client, predicate, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const match = client.frames.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for ' + label);
}

async function getHealth(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/health' }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

test('health is unauthenticated and WebSocket accepts URL-token auth plus RPC', async (t) => {
  const home = tempHome(t);
  const bridge = await startBridge({
    homeDir: home,
    port: 0,
    detect: async () => [
      { name: 'claude', available: false, version: null, path: null, error: 'not found on PATH' },
      { name: 'pi', available: false, version: null, path: null, error: 'not found on PATH' },
      { name: 'omp', available: false, version: null, path: null, error: 'not found on PATH' },
    ],
  });
  t.after(() => bridge.close());
  const port = bridge.server.address().port;

  const health = await getHealth(port);
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true, service: 'hermes-pocket-bridge' });

  const client = await openSocket(port, '/api/ws?token=' + encodeURIComponent(bridge.token));
  t.after(() => client.socket.destroy());
  const ready = await waitFor(client, (frame) => frame.params && frame.params.type === 'gateway.ready', 'gateway.ready');
  assert.equal(ready.method, 'event');
  assert.equal(ready.params.session_id, '');
  assert.ok(Number.isInteger(ready.params.seq));

  sendText(client.socket, { jsonrpc: '2.0', id: 41, method: 'harness.list', params: {} });
  const answer = await waitFor(client, (frame) => frame.id === 41, 'harness.list response');
  assert.equal(answer.result.harnesses.length, 3);
  assert.equal(answer.error, undefined);
});

test('hello auth responds to the handshake and rejects a bad token', async (t) => {
  const home = tempHome(t);
  const bridge = await startBridge({ homeDir: home, port: 0, detect: async () => [] });
  t.after(() => bridge.close());
  const port = bridge.server.address().port;

  const good = await openSocket(port, '/api/ws');
  t.after(() => good.socket.destroy());
  sendText(good.socket, {
    id: 7, type: 'hello', params: { protocol: 'hermes-gateway-v1', token: bridge.token },
  });
  const response = await waitFor(good, (frame) => frame.id === 7, 'hello response');
  assert.equal(response.result.protocol, 'hermes-gateway-v1');
  await waitFor(good, (frame) => frame.params && frame.params.type === 'gateway.ready', 'ready after hello');

  const bad = await openSocket(port, '/api/ws');
  sendText(bad.socket, { id: 9, type: 'hello', params: { protocol: 'v1', token: 'wrong-token' } });
  const error = await waitFor(bad, (frame) => frame.id === 9 && frame.error, 'hello error');
  assert.equal(error.error.code, -32000);
});
