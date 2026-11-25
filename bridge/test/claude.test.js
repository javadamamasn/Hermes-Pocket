'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeParser } = require('../harness-bridge.js');

// Recorded shape of `claude -p --output-format stream-json
// --include-partial-messages --verbose` (fields not relevant to the bridge
// omitted). Values are fake fixtures, no real credentials or prompts.
const TURN = [
  { type: 'system', subtype: 'init', session_id: 'native-42', cwd: '/work' },
  { type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant', content: [] } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me think' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } } },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello world' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      ],
      usage: { input_tokens: 10, output_tokens: 4 },
    },
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: '/work' }] }],
    },
  },
  { type: 'result', subtype: 'success', result: 'Hello world', usage: { input_tokens: 10, output_tokens: 4 } },
].map((record) => JSON.stringify(record));

test('claude parser maps stream-json to Hermes turn actions', () => {
  const parser = new ClaudeParser({ now: () => 1000 });
  const actions = [];
  for (const line of TURN) actions.push(...parser.push(line));
  actions.push(...parser.finish());

  const kinds = actions.map((action) => action.kind);
  assert.equal(kinds.filter((kind) => kind === 'message_start').length, 1);
  assert.deepEqual(kinds.filter((kind) => kind === 'message_delta').map((kind) => kind), ['message_delta', 'message_delta']);

  const deltas = actions.filter((action) => action.kind === 'message_delta');
  assert.deepEqual(deltas.map((action) => action.text), ['Hello ', 'world']);
  assert.deepEqual(deltas.map((action) => action.rendered), ['Hello ', 'world']);

  assert.deepEqual(actions.find((action) => action.kind === 'thinking_delta'), {
    kind: 'thinking_delta', text: 'let me think',
  });

  const toolStarts = actions.filter((action) => action.kind === 'tool_start');
  assert.equal(toolStarts.length, 1, 'stream_event and final assistant must not duplicate a tool');
  assert.deepEqual(toolStarts[0], {
    kind: 'tool_start', tool_id: 'tool-1', name: 'Bash', args: '{"command":"pwd"}',
  });
  assert.deepEqual(actions.find((action) => action.kind === 'tool_complete'), {
    kind: 'tool_complete', tool_id: 'tool-1', name: 'Bash', result: '/work', duration_s: 0,
  });

  const init = actions.find((action) => action.kind === 'session_info');
  assert.equal(init.payload.session_id, 'native-42');
  assert.deepEqual(actions.find((action) => action.kind === 'message_complete'), {
    kind: 'message_complete',
    text: 'Hello world',
    rendered: 'Hello world',
    usage: { input: 10, output: 4 },
    status: 'completed',
  });
  assert.equal(kinds.at(-1), 'done');
});

test('claude parser reports a failed result without claiming success', () => {
  const parser = new ClaudeParser({ now: () => 0 });
  const actions = [];
  for (const record of [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } },
    { type: 'result', subtype: 'error_during_execution', error: 'provider unavailable' },
  ]) actions.push(...parser.push(JSON.stringify(record)));

  assert.deepEqual(actions.find((action) => action.kind === 'error'), {
    kind: 'error', message: 'provider unavailable',
  });
  const complete = actions.find((action) => action.kind === 'message_complete');
  assert.equal(complete.status, 'error');
  assert.equal(complete.text, 'partial');
  assert.equal(actions.at(-1).kind, 'done');
});

test('claude parser ignores malformed NDJSON lines', () => {
  const parser = new ClaudeParser();
  assert.deepEqual(parser.push('{not json'), []);
});
