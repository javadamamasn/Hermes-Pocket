'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PiParser } = require('../harness-bridge.js');

// Records matching `pi --mode rpc` JSONL (docs: rpc.md, rpc-commands.md,
// json.md). Fixture text is synthetic.
const RECORDS = [
  { id: 'r1', type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } },
  { type: 'agent_start' },
  { type: 'message_start', message: { role: 'user', content: 'hello' } },
  { type: 'message_start', message: { role: 'assistant', content: [] } },
  { type: 'message_update', usage: { input: 5, output: 1, totalTokens: 6 }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hi ' } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'reason' } },
  { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, id: 'call-1', toolName: 'bash' } },
  { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } },
  { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, durationMs: 1200, isError: false },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'there' } },
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }], usage: { input: 5, output: 2 }, stopReason: 'stop' } },
  { type: 'agent_end', messages: [], willRetry: false },
  { type: 'agent_settled', aborted: false },
];

test('pi parser handles prompt ack, text/thinking/tool events and settlement', () => {
  const parser = new PiParser({ now: () => 5000 });
  const actions = [];
  for (const record of RECORDS) actions.push(...parser.push(record));
  actions.push(...parser.finish());

  assert.deepEqual(actions.find((action) => action.kind === 'accepted'), {
    kind: 'accepted', disposition: 'started',
  });
  const deltas = actions.filter((action) => action.kind === 'message_delta');
  assert.deepEqual(deltas.map((action) => action.text), ['Hi ', 'there']);
  assert.deepEqual(actions.find((action) => action.kind === 'thinking_delta'), {
    kind: 'thinking_delta', text: 'reason',
  });

  const toolStart = actions.find((action) => action.kind === 'tool_start');
  assert.deepEqual(toolStart, {
    kind: 'tool_start', tool_id: 'call-1', name: 'bash', args: '{"command":"ls"}',
  });
  assert.equal(actions.filter((action) => action.kind === 'tool_start').length, 1);
  assert.deepEqual(actions.find((action) => action.kind === 'tool_complete'), {
    kind: 'tool_complete', tool_id: 'call-1', name: 'bash', result: 'ok', duration_s: 1.2,
  });

  const complete = actions.filter((action) => action.kind === 'message_complete');
  assert.equal(complete.length, 1, 'message_end is authoritative, agent_settled must not repeat it');
  assert.deepEqual(complete[0], {
    kind: 'message_complete',
    text: 'Hi there',
    rendered: 'Hi there',
    usage: { input: 5, output: 2 },
    status: 'completed',
  });
  assert.equal(complete[0].usage.input, 5);
  assert.equal(complete[0].usage.output, 2);
  assert.deepEqual(actions.at(-1), { kind: 'done', status: 'completed' });
});

test('pi parser accepts JSONL strings and marks an aborted settlement', () => {
  const parser = new PiParser();
  const actions = [
    ...parser.push(JSON.stringify({ type: 'agent_settled', aborted: true })),
    ...parser.finish(),
  ];
  const complete = actions.find((action) => action.kind === 'message_complete');
  assert.equal(complete.status, 'interrupted');
  assert.deepEqual(actions.at(-1), { kind: 'done', status: 'interrupted' });
});

test('pi parser turns a rejected prompt into an error and a done action', () => {
  const parser = new PiParser();
  const actions = parser.push({ id: 'r2', type: 'response', command: 'prompt', success: false, error: 'busy' });
  assert.deepEqual(actions, [
    { kind: 'error', message: 'busy' },
    { kind: 'done', status: 'error' },
  ]);
});
