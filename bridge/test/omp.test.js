'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OmpParser } = require('../harness-bridge.js');

const READY = {
  type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864,
};

function chunkFrames(record, count, byteLength) {
  const bytes = Buffer.from(JSON.stringify(record), 'utf8');
  const size = Math.ceil(bytes.length / count);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const segment = bytes.subarray(i * size, (i + 1) * size);
    parts.push({
      type: 'rpc_chunk', chunkId: 'rpc-1', index: i, count,
      byteLength: byteLength === undefined ? bytes.length : byteLength,
      data: segment.toString('base64'),
    });
  }
  return parts;
}

test('omp parser reads ready, negotiates v2 and reassembles rpc_chunk frames', () => {
  const parser = new OmpParser();
  const ready = parser.push(READY);
  assert.deepEqual(ready, [{ kind: 'ready', protocolVersion: 1, supportV2: true }]);

  const frames = chunkFrames({ id: 'p1', type: 'response', command: 'prompt', success: true, data: {} }, 2);
  assert.deepEqual(parser.push(frames[0]), [], 'incomplete chunk must not emit a record');
  assert.deepEqual(parser.push(frames[1]), [{ kind: 'accepted', disposition: 'started' }]);
});

test('omp parser rejects broken chunk sequences', () => {
  const parser = new OmpParser();
  const frames = chunkFrames({ type: 'session_settled' }, 2, 999);
  assert.deepEqual(parser.push(frames[0]), []);
  assert.deepEqual(parser.push(frames[1]), [], 'byteLength mismatch must be discarded');
});

test('omp parser streams a turn and finishes on session_settled', () => {
  const parser = new OmpParser({ now: () => 1000 });
  const actions = [];
  for (const record of [
    READY,
    { id: 'p2', type: 'response', command: 'prompt', success: true },
    { type: 'message_update', usage: { input: 7, output: 3, totalTokens: 10 }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'OMP ' } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'hmm' } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, id: 'c7', toolName: 'read' } },
    { type: 'tool_execution_start', toolCallId: 'c7', toolName: 'read', args: { path: '/tmp/x' } },
    { type: 'tool_execution_end', toolCallId: 'c7', toolName: 'read', result: { content: [{ type: 'text', text: 'file body' }] }, durationMs: 2500, isError: false },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'reply' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OMP reply' }], usage: { input: 7, output: 3 }, stopReason: 'stop' } },
    { type: 'prompt_result', id: 'p2', agentInvoked: true, status: 'completed', sessionSettled: false },
    { type: 'session_settled' },
  ]) actions.push(...parser.push(record));
  actions.push(...parser.finish());

  const deltas = actions.filter((action) => action.kind === 'message_delta');
  assert.deepEqual(deltas.map((action) => action.text), ['OMP ', 'reply']);
  assert.deepEqual(actions.find((action) => action.kind === 'thinking_delta'), {
    kind: 'thinking_delta', text: 'hmm',
  });
  assert.equal(actions.filter((action) => action.kind === 'tool_start').length, 1);
  assert.deepEqual(actions.find((action) => action.kind === 'tool_start'), {
    kind: 'tool_start', tool_id: 'c7', name: 'read', args: '{"path":"/tmp/x"}',
  });
  assert.deepEqual(actions.find((action) => action.kind === 'tool_complete'), {
    kind: 'tool_complete', tool_id: 'c7', name: 'read', result: 'file body', duration_s: 2.5,
  });
  const complete = actions.filter((action) => action.kind === 'message_complete');
  assert.equal(complete.length, 1);
  assert.deepEqual(complete[0], {
    kind: 'message_complete', text: 'OMP reply', rendered: 'OMP reply',
    usage: { input: 7, output: 3 },
    status: 'completed',
  });
  assert.equal(complete[0].usage.input, 7);
  assert.equal(complete[0].usage.output, 3);
  assert.deepEqual(actions.at(-1), { kind: 'done', status: 'completed' });
});

test('omp parser also tolerates the pi-family agent_settled frame and error results', () => {
  const parser = new OmpParser();
  assert.deepEqual(parser.push({ type: 'prompt_result', status: 'error', error: { message: 'quota' } }), [
    { kind: 'error', message: 'quota' },
  ]);
  const actions = parser.push({ type: 'agent_settled' });
  assert.equal(actions.find((action) => action.kind === 'message_complete').status, 'error');
  assert.deepEqual(actions.at(-1), { kind: 'done', status: 'error' });
});
