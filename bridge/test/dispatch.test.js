'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createBridge, detectHarnesses, cliArgs, getBridgeToken, tokenFilePath,
  sessionFilePath,
} = require('../harness-bridge.js');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bridge-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeScript(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

function fakeEnv(home) {
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const pi = writeScript(binDir, 'pi', "if (process.argv.includes('--version')) console.log('1.6.0'); else process.exit(0);");
  const ompTarget = writeScript(binDir, 'omp-real', "if (process.argv.includes('--version')) console.log('omp 19.1.1'); else process.exit(0);");
  // Simulates `proot-distro login ubuntu -- omp "$@"` without needing proot in tests.
  const ompWrapper = writeScript(binDir, 'omp-wrapper', `
    const cp = require('node:child_process');
    const result = cp.spawnSync(process.execPath, [${JSON.stringify(ompTarget)}, ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(result.status === null ? 1 : result.status);
  `);
  const claude = writeScript(binDir, 'claude', "console.log('claude native binary not installed'); process.exit(0);");
  return {
    env: { ...process.env, CLAUDE_BIN: claude, PI_BIN: pi, OMP_BIN: ompWrapper },
    binDir, pi, ompWrapper, claude,
  };
}

test('cliArgs match the adapter command lines and resume contract', () => {
  assert.deepEqual(cliArgs('claude', {}), [
    '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
  ]);
  assert.deepEqual(cliArgs('claude', { resuming: true, nativeCliSessionId: 'native-7' }), [
    '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--resume', 'native-7',
  ]);
  assert.deepEqual(cliArgs('pi', {}), ['--mode', 'rpc']);
  assert.deepEqual(cliArgs('omp', {}), ['--mode', 'rpc', '--no-ui']);
  assert.throws(() => cliArgs('unknown'), /unknown harness/);
});

test('detection runs binaries, accepts wrappers and rejects non-running CLIs', async (t) => {
  const home = tempHome(t);
  const { env } = fakeEnv(home);
  const rows = await detectHarnesses({ env, timeoutMs: 2000 });
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));

  assert.equal(byName.pi.available, true);
  assert.equal(byName.pi.version, '1.6.0');
  assert.equal(byName.omp.available, true, 'a wrapper script must count as an installed harness');
  assert.equal(byName.omp.version, '19.1.1');
  assert.equal(byName.claude.available, false, 'exit 0 with "native binary not installed" is not available');
  assert.equal(byName.claude.version, null);
  assert.match(byName.claude.error, /version probe failed/);
});

test('harness.list and session CRUD dispatch over a durable JSON store', async (t) => {
  const home = tempHome(t);
  const { env } = fakeEnv(home);
  const events = [];
  const bridge = createBridge({ homeDir: home, env, onEvent: (frame) => events.push(frame) });
  t.after(() => bridge.close());

  const listed = await bridge.dispatch('harness.list');
  assert.deepEqual(listed.harnesses.map((row) => row.name), ['claude', 'pi', 'omp']);
  assert.equal(listed.harnesses.find((row) => row.name === 'pi').available, true);
  assert.equal(listed.harnesses.find((row) => row.name === 'claude').available, false);

  const created = await bridge.dispatch('session.create', { harness: 'pi', title: 'Test chat', cwd: '/work' });
  assert.equal(created.title, 'Test chat');
  assert.equal(created.harness, 'pi');
  assert.match(created.session_id, /^[0-9a-f-]{36}$/);
  const file = sessionFilePath(home, 'pi', created.session_id);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(tokenFilePath(home)).mode & 0o777, 0o600);
  assert.equal(getBridgeToken(home).length, 64);

  const listedSessions = await bridge.dispatch('session.list');
  assert.equal(listedSessions.sessions.length, 1);
  assert.equal(listedSessions.sessions[0].id, created.session_id);
  assert.equal(listedSessions.sessions[0].message_count, 0);

  const history = await bridge.dispatch('session.history', { session_id: created.session_id });
  assert.deepEqual(history.messages, []);

  const renamed = await bridge.dispatch('session.title', { session_id: created.session_id, title: 'Renamed' });
  assert.deepEqual(renamed, { session_id: created.session_id, title: 'Renamed' });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.title, 'Renamed');
  assert.equal(stored.cwd, '/work');

  const resumed = await bridge.dispatch('session.resume', { session_id: created.session_id });
  assert.equal(resumed.session_id, created.session_id);
  assert.equal(resumed.title, 'Renamed');
  assert.deepEqual(resumed.messages, []);

  await assert.rejects(
    bridge.dispatch('session.history', { session_id: 'missing' }),
    (error) => error.code === -32001,
  );
  await assert.rejects(
    bridge.dispatch('does.not.exist'),
    (error) => error.code === -32601,
  );
  assert.ok(events.some((frame) => frame.params.type === 'sessions.changed'));
});

test('prompt.submit answers immediately then streams Hermes events', async (t) => {
  const home = tempHome(t);
  let deliver;
  let resolveTurn;
  const emitted = [];
  const bridge = createBridge({
    homeDir: home,
    env: { ...process.env },
    onEvent: (frame) => emitted.push(frame),
    adapterFactory: ({ harness, onAction }) => {
      assert.equal(harness, 'pi');
      deliver = onAction;
      return {
        startTurn: () => new Promise((resolve) => { resolveTurn = resolve; }),
        interrupt: () => {},
        close: () => {},
      };
    },
  });
  t.after(() => bridge.close());

  const created = await bridge.dispatch('session.create', { harness: 'pi', title: 'Streaming' });
  const accepted = await bridge.dispatch('prompt.submit', { session_id: created.session_id, text: 'hello' });
  assert.deepEqual(accepted, { accepted: true });

  await new Promise((resolve) => setImmediate(resolve)); // let the turn pick up the queued prompt
  assert.ok(deliver, 'adapter must be started');
  for (const action of [
    { kind: 'message_start' },
    { kind: 'message_delta', text: 'Hi', rendered: 'Hi' },
    { kind: 'thinking_delta', text: 'thinking' },
    { kind: 'tool_start', tool_id: 't1', name: 'bash', args: '{}' },
    { kind: 'tool_complete', tool_id: 't1', name: 'bash', result: 'done', duration_s: 0.5 },
    { kind: 'message_complete', text: 'Hi', rendered: 'Hi', usage: { output: 2 }, status: 'completed' },
    { kind: 'done', status: 'completed' },
  ]) {
    deliver(action);
    if (action.kind === 'done') resolveTurn(true);
  }

  await bridge.waitIdle();
  const byType = Object.fromEntries(emitted.map((frame) => [frame.params.type, frame]));
  assert.equal(byType['message.start'].method, 'event');
  assert.deepEqual(byType['message.delta'].params.payload, { text: 'Hi', rendered: 'Hi' });
  assert.deepEqual(byType['thinking.delta'].params.payload, { text: 'thinking' });
  assert.deepEqual(byType['tool.start'].params.payload, { tool_id: 't1', name: 'bash', args: '{}' });
  assert.deepEqual(byType['tool.complete'].params.payload, { tool_id: 't1', name: 'bash', result: 'done', duration_s: 0.5 });
  assert.deepEqual(byType['message.complete'].params.payload, {
    text: 'Hi', rendered: 'Hi', usage: { output: 2 }, status: 'completed',
  });
  assert.ok(byType['sessions.changed']);
  assert.equal(byType['message.complete'].params.session_id, created.session_id);
  assert.ok(Number.isInteger(byType['message.complete'].params.seq));

  const history = await bridge.dispatch('session.history', { session_id: created.session_id });
  assert.deepEqual(history.messages.map((message) => message.role), ['user', 'tool', 'assistant']);
  assert.equal(history.messages[2].content, 'Hi');
});
