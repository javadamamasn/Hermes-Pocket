'use strict';

/**
 * Hermes-Pocket multi-harness bridge.
 *
 * Dependency-free (Node built-ins only), loopback-only JSON-RPC/WebSocket
 * gateway that adapts Claude Code, Pi and OMP CLI processes to the Android
 * app's existing Hermes gateway wire protocol.
 *
 * Run:  node bridge/harness-bridge.js       (PORT env overrides 9120)
 * Test: node --test bridge/test
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 9120;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HARNESS_NAMES = ['claude', 'pi', 'omp'];
const BIN_ENV = { claude: 'CLAUDE_BIN', pi: 'PI_BIN', omp: 'OMP_BIN' };
const DEFAULT_BIN = { claude: 'claude', pi: 'pi', omp: 'omp' };
const MAX_WS_FRAME = 8 * 1024 * 1024;
const MAX_WS_MESSAGE = 8 * 1024 * 1024;
const MAX_RPC_CHUNK_FRAME = 64 * 1024 * 1024;
const HELLO_WINDOW_MS = 60_000;
const HELLO_MAX_FAILURES = 5;
const HELLO_BLOCK_MS = 60_000;

// ---------------------------------------------------------------------------
// Small value helpers. asText() mirrors the Android client's JsonElement?.asText():
// null/absent -> null, primitives -> their text, objects/arrays -> compact JSON.
// ---------------------------------------------------------------------------

function asText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function sessionIdOrNull(value) {
  const raw = asText(value);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed && trimmed !== 'null' ? trimmed : null;
}

function parseRecord(input) {
  if (input && typeof input === 'object' && !Buffer.isBuffer(input)) return input;
  if (typeof input !== 'string') return null;
  try {
    const value = JSON.parse(input);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function contentArray(value) {
  if (Array.isArray(value)) return value;
  return [];
}

function textFromBlocks(content) {
  if (typeof content === 'string') return content;
  let out = '';
  for (const block of contentArray(content)) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' || block.type === 'output_text') out += asText(block.text) || '';
    else if (typeof block.content === 'string') out += block.content;
  }
  return out;
}

function thinkingFromBlocks(content) {
  let out = '';
  for (const block of contentArray(content)) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking') out += asText(block.thinking) || asText(block.text) || '';
  }
  return out;
}

function resultText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  // RPC tool results usually wrap their text in {content:[...]}, {text:...}
  // or {output:...}; unwrap before falling back to a JSON dump.
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['content', 'text', 'output']) {
      if (value[key] !== undefined && value[key] !== null) {
        const inner = resultText(value[key]);
        if (inner) return inner;
      }
    }
  }
  const fromBlocks = textFromBlocks(value);
  if (fromBlocks) return fromBlocks;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

function normalizeUsage(usage) {
  const out = {};
  if (!usage || typeof usage !== 'object') return out;
  const aliases = {
    input: 'input', input_tokens: 'input', inputTokens: 'input',
    output: 'output', output_tokens: 'output', outputTokens: 'output',
    cache_read: 'cache_read', cache_read_input_tokens: 'cache_read', cacheRead: 'cache_read',
    cache_write: 'cache_write', cache_write_input_tokens: 'cache_write', cacheWrite: 'cache_write',
    total: 'total', total_tokens: 'total', totalTokens: 'total', tokens: 'total',
  };
  for (const [key, value] of Object.entries(usage)) {
    const target = aliases[key];
    if (!target || target === 'total') continue; // Hermes message.complete uses input/output caches only
    const number = typeof value === 'string' ? Number(value) : value;
    if (typeof number === 'number' && Number.isFinite(number)) out[target] = number;
  }
  return out;
}

function durationSeconds(startMs, now) {
  if (!Number.isFinite(startMs)) return 0;
  return Math.max(0, Math.round(((now() - startMs) / 1000) * 1000) / 1000);
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Parsers. Each parser turns one CLI record into zero or more *actions*;
// adapters translate actions into gateway events. Parsers never log raw data.
// ---------------------------------------------------------------------------

function startAction(out, state) {
  if (state.started) return;
  state.started = true;
  out.push({ kind: 'message_start' });
}

function completeAction(out, state, text, usage, status) {
  if (state.completed) return;
  state.completed = true;
  out.push({
    kind: 'message_complete',
    text: text,
    rendered: text,
    usage: usage || {},
    status: status || 'completed',
  });
}

class ClaudeParser {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.reset();
  }

  reset() {
    this.state = {
      started: false, completed: false, finalText: '', streamedText: false,
      thinking: '', streamedThinking: false, usage: {}, sessionId: null,
      tools: new Map(), blockTools: new Map(), done: false,
    };
  }

  push(input) {
    const record = parseRecord(input);
    if (!record) return [];
    const s = this.state;
    const out = [];

    if (record.type === 'system' && record.subtype === 'init') {
      s.sessionId = sessionIdOrNull(record.session_id);
      const payload = { session_id: s.sessionId || '', harness: 'claude' };
      if (record.cwd) payload.cwd = record.cwd;
      if (record.model) payload.model = asText(record.model);
      out.push({ kind: 'session_info', payload });
      return out;
    }

    if (record.type === 'stream_event') {
      const event = record.event && typeof record.event === 'object' ? record.event : record;
      const type = asText(event.type) || '';
      if (type === 'message_start') startAction(out, s);
      if (type === 'content_block_start') {
        const index = event.index;
        const block = event.content_block || {};
        if (asText(block.type) === 'tool_use') {
          const toolId = asText(block.id) || '';
          s.tools.set(toolId, {
            name: asText(block.name) || 'tool',
            args: asText(block.input) || '{}',
            startMs: this.now(),
          });
          s.blockTools.set(index, toolId);
          out.push({ kind: 'tool_start', tool_id: toolId, name: asText(block.name) || 'tool', args: asText(block.input) || '{}' });
        }
      }
      if (type === 'content_block_delta') {
        const delta = event.delta || {};
        const deltaType = asText(delta.type) || '';
        if (deltaType === 'text_delta') {
          const text = asText(delta.text) || '';
          s.streamedText = true;
          s.finalText += text;
          startAction(out, s);
          out.push({ kind: 'message_delta', text, rendered: text });
        } else if (deltaType === 'thinking_delta') {
          const text = asText(delta.thinking) || asText(delta.text) || '';
          s.streamedThinking = true;
          s.thinking += text;
          out.push({ kind: 'thinking_delta', text });
        } else if (deltaType === 'input_json_delta') {
          const toolId = s.blockTools.get(event.index);
          if (toolId && s.tools.has(toolId)) {
            s.tools.get(toolId).args += asText(delta.partial_json) || '';
          }
        }
      }
      if (type === 'message_delta') Object.assign(s.usage, normalizeUsage(record.usage || event.usage));
      return out;
    }

    if (record.type === 'assistant') {
      const message = record.message && typeof record.message === 'object' ? record.message : record;
      let authoritative = '';
      for (const block of contentArray(message.content)) {
        if (!block || typeof block !== 'object') continue;
        const blockType = asText(block.type) || '';
        if (blockType === 'text') {
          const text = asText(block.text) || '';
          authoritative += text;
          if (!s.streamedText) {
            startAction(out, s);
            out.push({ kind: 'message_delta', text, rendered: text });
          }
        } else if (blockType === 'thinking') {
          const text = asText(block.thinking) || asText(block.text) || '';
          if (!s.streamedThinking && text) out.push({ kind: 'thinking_delta', text });
          s.thinking += text;
        } else if (blockType === 'tool_use') {
          const toolId = asText(block.id) || '';
          const args = asText(block.input) || '{}';
          if (!s.tools.has(toolId)) {
            s.tools.set(toolId, { name: asText(block.name) || 'tool', args, startMs: this.now() });
            out.push({ kind: 'tool_start', tool_id: toolId, name: asText(block.name) || 'tool', args });
          } else {
            s.tools.get(toolId).args = args;
          }
        }
      }
      if (authoritative) s.finalText = authoritative; // assistant message is authoritative over deltas
      else if (typeof message.content === 'string') s.finalText = message.content;
      Object.assign(s.usage, normalizeUsage(message.usage || record.usage));
      return out;
    }

    if (record.type === 'user') {
      const message = record.message && typeof record.message === 'object' ? record.message : record;
      for (const block of contentArray(message.content)) {
        if (!block || asText(block.type) !== 'tool_result') continue;
        const toolId = asText(block.tool_use_id) || '';
        const tool = s.tools.get(toolId) || { name: 'tool', startMs: this.now() };
        const result = resultText(block.content);
        out.push({
          kind: 'tool_complete',
          tool_id: toolId,
          name: tool.name,
          result,
          duration_s: durationSeconds(tool.startMs, this.now),
        });
        if (block.is_error) out.push({ kind: 'error', message: result || 'tool failed' });
        s.tools.delete(toolId);
      }
      return out;
    }

    if (record.type === 'result') {
      const failed = asText(record.subtype) !== 'success';
      Object.assign(s.usage, normalizeUsage(record.usage));
      if (failed) {
        const message = asText(record.error) || asText(record.result) || 'claude turn failed';
        out.push({ kind: 'error', message });
        completeAction(out, s, s.finalText, s.usage, 'error');
      } else {
        const text = s.finalText || resultText(record.result);
        completeAction(out, s, text, s.usage, 'completed');
      }
      out.push({ kind: 'done', status: failed ? 'error' : 'completed' });
      s.done = true;
      return out;
    }

    return out;
  }

  finish() {
    const s = this.state;
    const out = [];
    if (!s.done && !s.completed) completeAction(out, s, s.finalText, s.usage, 'incomplete');
    s.done = true;
    return out;
  }
}

class PiParser {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.reset();
  }

  reset() {
    this.state = {
      started: false, completed: false, finalText: '', usage: {}, done: false,
      tools: new Map(), blocks: new Map(), status: 'completed',
    };
  }

  push(input) {
    const record = parseRecord(input);
    if (!record) return [];
    const s = this.state;
    const out = [];
    const type = asText(record.type) || '';

    if (type === 'response') {
      if (asText(record.command) === 'prompt') {
        if (record.success === false) {
          out.push({ kind: 'error', message: asText(record.error) || 'prompt rejected' });
          out.push({ kind: 'done', status: 'error' });
          s.done = true;
        } else {
          out.push({ kind: 'accepted', disposition: asText(record.data && record.data.disposition) || 'started' });
        }
      } else if (asText(record.command) === 'abort' || asText(record.command) === 'set_session_name') {
        // acknowledgement only
      } else if (record.success === false && asText(record.command) !== 'get_state' && asText(record.command) !== 'switch_session') {
        out.push({ kind: 'error', message: asText(record.error) || 'command failed' });
      }
      Object.assign(s.usage, normalizeUsage(record.usage));
      return out;
    }

    if (type === 'message_start') {
      const message = record.message || {};
      if (asText(message.role) === 'assistant') startAction(out, s);
      return out;
    }

    if (type === 'message_update') {
      const event = record.assistantMessageEvent || {};
      Object.assign(s.usage, normalizeUsage(record.usage));
      const eventType = asText(event.type) || '';
      if (eventType === 'start') startAction(out, s);
      if (eventType === 'text_delta') {
        const text = asText(event.delta) || '';
        startAction(out, s);
        s.finalText += text;
        out.push({ kind: 'message_delta', text, rendered: text });
      } else if (eventType === 'thinking_delta') {
        out.push({ kind: 'thinking_delta', text: asText(event.delta) || '' });
      } else if (eventType === 'toolcall_start') {
        const toolId = asText(event.id) || '';
        const name = asText(event.toolName) || 'tool';
        const action = { kind: 'tool_start', tool_id: toolId, name, args: '{}' };
        s.tools.set(toolId, { name, args: '{}', startMs: this.now(), action });
        s.blocks.set(event.contentIndex, toolId);
        out.push(action);
      } else if (eventType === 'toolcall_delta') {
        const toolId = s.blocks.get(event.contentIndex);
        if (toolId && s.tools.has(toolId)) {
          const tool = s.tools.get(toolId);
          tool.args += asText(event.delta) || '';
          if (tool.action) tool.action.args = tool.args;
        }
      } else if (eventType === 'toolcall_end') {
        const toolCall = event.toolCall || {};
        const toolId = asText(toolCall.id) || s.blocks.get(event.contentIndex) || '';
        const name = asText(toolCall.name) || 'tool';
        const args = asText(toolCall.arguments) || '{}';
        if (!s.tools.has(toolId)) {
          const action = { kind: 'tool_start', tool_id: toolId, name, args };
          s.tools.set(toolId, { name, args, startMs: this.now(), action });
          out.push(action);
        } else {
          const tool = s.tools.get(toolId);
          tool.args = args;
          if (tool.action) tool.action.args = args;
        }
      } else if (eventType === 'error') {
        out.push({ kind: 'error', message: asText(event.error) || 'stream error' });
      }
      return out;
    }

    if (type === 'message_end') {
      const message = record.message || {};
      if (asText(message.role) === 'assistant') {
        const text = textFromBlocks(message.content);
        if (text) s.finalText = text; // authoritative final content
        Object.assign(s.usage, normalizeUsage(message.usage || record.usage));
        completeAction(out, s, s.finalText, s.usage, asText(message.stopReason) === 'error' ? 'error' : 'completed');
      }
      return out;
    }

    if (type === 'tool_execution_start') {
      const toolId = asText(record.toolCallId) || '';
      const name = asText(record.toolName) || 'tool';
      const args = asText(record.args) || '{}';
      const existing = s.tools.get(toolId);
      if (existing) {
        existing.args = args;
        if (existing.action) existing.action.args = args;
      } else {
        const action = { kind: 'tool_start', tool_id: toolId, name, args };
        s.tools.set(toolId, { name, args, startMs: this.now(), action });
        out.push(action);
      }
      return out;
    }

    if (type === 'tool_execution_end') {
      const toolId = asText(record.toolCallId) || '';
      const tool = s.tools.get(toolId) || { name: asText(record.toolName) || 'tool', startMs: this.now() };
      const durationMs = Number(record.durationMs);
      out.push({
        kind: 'tool_complete',
        tool_id: toolId,
        name: tool.name,
        result: resultText(record.result),
        duration_s: Number.isFinite(durationMs) ? Math.round((durationMs / 1000) * 1000) / 1000 : durationSeconds(tool.startMs, this.now),
      });
      if (record.isError) out.push({ kind: 'error', message: resultText(record.result) || 'tool failed' });
      s.tools.delete(toolId);
      return out;
    }

    if (type === 'session_info_changed') {
      const name = asText(record.name);
      out.push({ kind: 'session_info', payload: name ? { title: name } : {} });
      return out;
    }

    if (type === 'extension_error') {
      out.push({ kind: 'error', message: asText(record.error) || 'extension error' });
      return out;
    }

    if (type === 'auto_retry_end' && record.success === false) {
      out.push({ kind: 'error', message: asText(record.finalError) || 'retry failed' });
      return out;
    }

    if (type === 'agent_settled') {
      s.status = record.aborted ? 'interrupted' : 'completed';
      if (!s.completed) completeAction(out, s, s.finalText, s.usage, s.status);
      out.push({ kind: 'done', status: s.status });
      s.done = true;
      return out;
    }

    return out;
  }

  finish() {
    const s = this.state;
    const out = [];
    if (!s.done && !s.completed) completeAction(out, s, s.finalText, s.usage, 'incomplete');
    s.done = true;
    return out;
  }
}

class OmpParser {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.reset();
  }

  reset() {
    this.state = {
      started: false, completed: false, finalText: '', usage: {}, done: false,
      tools: new Map(), blocks: new Map(), status: 'completed',
    };
    this.chunks = new Map();
  }

  push(input) {
    const record = parseRecord(input);
    if (!record) return [];

    if (asText(record.type) === 'rpc_chunk') {
      const chunkId = asText(record.chunkId) || '';
      const index = Number(record.index);
      const count = Number(record.count);
      const byteLength = Number(record.byteLength);
      if (!chunkId || !Number.isInteger(index) || !Number.isInteger(count) || count < 1 ||
          index < 0 || index >= count || !Number.isInteger(byteLength) ||
          byteLength < 0 || byteLength > MAX_RPC_CHUNK_FRAME) return [];
      let entry = this.chunks.get(chunkId);
      if (!entry) {
        for (const key of this.chunks.keys()) this.chunks.delete(key); // reject interleaved sequences
        entry = { count, byteLength, parts: new Map() };
        this.chunks.set(chunkId, entry);
      } else if (entry.count !== count || entry.byteLength !== byteLength || entry.parts.has(index)) {
        this.chunks.delete(chunkId);
        return [];
      }
      let segment;
      try {
        segment = Buffer.from(asText(record.data) || '', 'base64');
      } catch {
        this.chunks.delete(chunkId);
        return [];
      }
      entry.parts.set(index, segment);
      if (entry.parts.size < count) return [];
      this.chunks.delete(chunkId);
      const assembled = Buffer.concat(Array.from({ length: count }, (_, i) => entry.parts.get(i)));
      if (assembled.length !== byteLength) return [];
      const decoded = parseRecord(assembled.toString('utf8'));
      return decoded ? this.push(decoded) : [];
    }

    const s = this.state;
    const out = [];
    const type = asText(record.type) || '';

    if (type === 'ready') {
      const versions = Array.isArray(record.supportedProtocolVersions) ? record.supportedProtocolVersions : [];
      out.push({ kind: 'ready', protocolVersion: Number(record.protocolVersion) || 1, supportV2: versions.map(Number).includes(2) });
      return out;
    }

    if (type === 'response') {
      const command = asText(record.command);
      if (command === 'prompt') {
        if (record.success === false) {
          out.push({ kind: 'error', message: asText(record.error) || 'prompt rejected' });
          out.push({ kind: 'done', status: 'error' });
          s.done = true;
        } else {
          out.push({ kind: 'accepted', disposition: 'started' });
          if (record.data && record.data.agentInvoked === false) {
            out.push({ kind: 'done', status: 'completed' });
            s.done = true;
          }
        }
      } else if (command === 'negotiate_protocol') {
        out.push({ kind: 'negotiated', version: Number(record.data && record.data.protocolVersion) || 2 });
      } else if (command !== 'get_state' && command !== 'open_session' &&
                 command !== 'switch_session' && record.success === false) {
        out.push({ kind: 'error', message: asText(record.error) || 'command failed' });
      }
      return out;
    }

    if (type === 'message_start') {
      if (asText(record.message && record.message.role) === 'assistant') startAction(out, s);
      return out;
    }

    if (type === 'message_update') {
      const event = record.assistantMessageEvent || {};
      Object.assign(s.usage, normalizeUsage(record.usage));
      const eventType = asText(event.type) || '';
      if (eventType === 'start') startAction(out, s);
      if (eventType === 'text_delta') {
        const text = asText(event.delta) || '';
        startAction(out, s);
        s.finalText += text;
        out.push({ kind: 'message_delta', text, rendered: text });
      } else if (eventType === 'thinking_delta') {
        out.push({ kind: 'thinking_delta', text: asText(event.delta) || '' });
      } else if (eventType === 'toolcall_start') {
        const toolId = asText(event.id) || '';
        const name = asText(event.toolName) || 'tool';
        const action = { kind: 'tool_start', tool_id: toolId, name, args: '{}' };
        s.tools.set(toolId, { name, args: '{}', startMs: this.now(), action });
        s.blocks.set(event.contentIndex, toolId);
        out.push(action);
      } else if (eventType === 'toolcall_delta') {
        const toolId = s.blocks.get(event.contentIndex);
        if (toolId && s.tools.has(toolId)) {
          const tool = s.tools.get(toolId);
          tool.args += asText(event.delta) || '';
          if (tool.action) tool.action.args = tool.args;
        }
      } else if (eventType === 'toolcall_end') {
        const toolCall = event.toolCall || {};
        const toolId = asText(toolCall.id) || s.blocks.get(event.contentIndex) || '';
        const name = asText(toolCall.name) || 'tool';
        const args = asText(toolCall.arguments) || '{}';
        if (!s.tools.has(toolId)) {
          const action = { kind: 'tool_start', tool_id: toolId, name, args };
          s.tools.set(toolId, { name, args, startMs: this.now(), action });
          out.push(action);
        } else {
          const tool = s.tools.get(toolId);
          tool.args = args;
          if (tool.action) tool.action.args = args;
        }
      } else if (eventType === 'error') {
        out.push({ kind: 'error', message: asText(event.error) || 'stream error' });
      }
      return out;
    }

    if (type === 'message_end') {
      const message = record.message || {};
      if (asText(message.role) === 'assistant') {
        const text = textFromBlocks(message.content);
        if (text) s.finalText = text;
        Object.assign(s.usage, normalizeUsage(message.usage || record.usage));
        const failed = asText(message.stopReason) === 'error';
        if (failed) s.status = 'error';
        completeAction(out, s, s.finalText, s.usage, s.status);
      }
      return out;
    }

    if (type === 'tool_execution_start') {
      const toolId = asText(record.toolCallId) || '';
      const name = asText(record.toolName) || 'tool';
      const args = asText(record.args) || '{}';
      const existing = s.tools.get(toolId);
      if (existing) {
        existing.args = args;
        if (existing.action) existing.action.args = args;
      } else {
        const action = { kind: 'tool_start', tool_id: toolId, name, args };
        s.tools.set(toolId, { name, args, startMs: this.now(), action });
        out.push(action);
      }
      return out;
    }

    if (type === 'tool_execution_end') {
      const toolId = asText(record.toolCallId) || '';
      const tool = s.tools.get(toolId) || { name: asText(record.toolName) || 'tool', startMs: this.now() };
      const durationMs = Number(record.durationMs);
      out.push({
        kind: 'tool_complete',
        tool_id: toolId,
        name: tool.name,
        result: resultText(record.result),
        duration_s: Number.isFinite(durationMs) ? Math.round((durationMs / 1000) * 1000) / 1000 : durationSeconds(tool.startMs, this.now),
      });
      if (record.isError) out.push({ kind: 'error', message: resultText(record.result) || 'tool failed' });
      s.tools.delete(toolId);
      return out;
    }

    if (type === 'prompt_result') {
      const status = asText(record.status) || 'completed';
      if (status === 'aborted') s.status = 'interrupted';
      else if (status === 'error') s.status = 'error';
      if (status === 'error') {
        out.push({ kind: 'error', message: asText(record.error && record.error.message) || 'turn failed' });
      }
      if (record.sessionSettled === true && !s.done) {
        if (!s.completed) completeAction(out, s, s.finalText, s.usage, s.status);
        out.push({ kind: 'done', status: s.status });
        s.done = true;
      }
      return out;
    }

    // OMP's own quiescence frame is session_settled; pi-family agent_settled is
    // accepted as well so a dialect switch cannot leave a turn open forever.
    if (type === 'session_settled' || type === 'agent_settled') {
      if (!s.completed) completeAction(out, s, s.finalText, s.usage, s.status);
      out.push({ kind: 'done', status: s.status });
      s.done = true;
      return out;
    }

    if (type === 'extension_error') {
      out.push({ kind: 'error', message: asText(record.error) || 'extension error' });
      return out;
    }

    return out;
  }

  finish() {
    const s = this.state;
    const out = [];
    if (!s.done && !s.completed) completeAction(out, s, s.finalText, s.usage, 'incomplete');
    s.done = true;
    return out;
  }
}

const PARSERS = { claude: ClaudeParser, pi: PiParser, omp: OmpParser };

// ---------------------------------------------------------------------------
// CLI discovery. No shell interpolation: PATH is split and each candidate is
// checked with fs.accessSync(X_OK) before spawn(..., { shell: false }).
// ---------------------------------------------------------------------------

function findInPath(name, env) {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes(path.sep)) {
    const candidate = path.resolve(name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile() ? candidate : null;
    } catch {
      return null;
    }
  }
  const pathEnv = env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // try next PATH entry
    }
  }
  return null;
}

// On this phone pi and omp live inside proot-distro ubuntu, not in the Termux
// PATH. Build a tiny shim (no shell interpolation of user input) so the rest
// of the bridge can keep spawning a single executable per harness.
const PROOT_INTERNAL = {
  pi: '/root/.omp/plugins/node_modules/.bin/pi',
  omp: '/root/.bun/bin/omp',
};

function prootWrapper(harness, env) {
  const internal = PROOT_INTERNAL[harness];
  if (!internal || !findInPath('proot-distro', env)) return null;
  const termuxPrefix = path.dirname(os.homedir());
  const rootfs = path.join(termuxPrefix, 'usr', 'var', 'lib', 'proot-distro',
    'containers', 'ubuntu', 'rootfs');
  if (!fs.existsSync(path.join(rootfs, internal.replace(/^\//, '')))) return null;
  const binDir = path.join(pocketDir(env.HOME || os.homedir()), 'bin');
  try {
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const wrapper = path.join(binDir, harness);
    fs.writeFileSync(wrapper,
      '#!/bin/sh\nexec proot-distro login ubuntu -- ' + internal + ' "$@"\n',
      { mode: 0o700 });
    fs.chmodSync(wrapper, 0o700);
    return wrapper;
  } catch {
    return null;
  }
}

function resolveBinary(harness, env = process.env) {
  if (!Object.hasOwn(DEFAULT_BIN, harness)) return null;
  const override = env[BIN_ENV[harness]];
  if (override) return findInPath(override, env);
  return findInPath(DEFAULT_BIN[harness], env) || prootWrapper(harness, env);
}

function probeVersion(binary, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    let output = '';
    let finished = false;
    const timer = setTimeout(() => finish(null), Math.max(100, timeoutMs));
    function finish(value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(value);
    }
    if (child.stdout) child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    if (child.stderr) child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      // A launcher can exit 0 while reporting a missing runtime (e.g. the
      // Claude npm shim on Termux when postinstall was skipped). That is not
      // an installed, runnable harness.
      if (/\b(?:native binary )?not installed\b|\bcommand not found\b/i.test(output)) return finish(null);
      const match = output.match(/\d+\.\d+(?:\.\d+)?/);
      if (match) return finish(match[0]);
      const first = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      finish(first ? first.slice(0, 80) : 'unknown');
    });
  });
}

async function detectHarnesses(options = {}) {
  const env = options.env || process.env;
  // proot-distro login adds ~1-3 s of startup on Termux; the old 2.5 s
  // default made pi/omp look unavailable even though they work.
  const timeoutMs = options.timeoutMs || 15_000;
  return Promise.all(HARNESS_NAMES.map(async (name) => {
    const binary = resolveBinary(name, env);
    if (!binary) {
      return { name, available: false, version: null, path: null, error: 'not found on PATH' };
    }
    const version = await probeVersion(binary, timeoutMs);
    return version === null
      ? { name, available: false, version: null, path: binary, error: 'version probe failed' }
      : { name, available: true, version, path: binary, error: null };
  }));
}

function cliArgs(harness, options = {}) {
  if (harness === 'claude') {
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
    if (options.resuming && options.nativeCliSessionId) args.push('--resume', options.nativeCliSessionId);
    return args;
  }
  if (harness === 'pi') return ['--mode', 'rpc'];
  if (harness === 'omp') return ['--mode', 'rpc', '--no-ui'];
  throw new RpcError(-32602, 'unknown harness');
}

// ---------------------------------------------------------------------------
// Durable token and session files, all under ~/.hermes-pocket.
// ---------------------------------------------------------------------------

function pocketDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.hermes-pocket');
}

function tokenFilePath(homeDir = os.homedir()) {
  return path.join(pocketDir(homeDir), 'bridge-token');
}

function getBridgeToken(homeDir = os.homedir()) {
  const dir = pocketDir(homeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const file = tokenFilePath(homeDir);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, token + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return fs.readFileSync(file, 'utf8').trim();
    throw error;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return token;
}

function safeSegment(value) {
  const cleaned = String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return cleaned || 'unknown';
}

function sessionFilePath(homeDir, harness, id) {
  return path.join(pocketDir(homeDir), 'sessions', safeSegment(harness), safeSegment(id) + '.json');
}

function makeSession(harness, title, cwd) {
  const now = Date.now() / 1000;
  return {
    id: crypto.randomUUID(),
    harness: HARNESS_NAMES.includes(harness) ? harness : 'claude',
    title: asText(title) || '',
    cwd: asText(cwd) || '',
    nativeCliSessionId: null,
    messages: [],
    created_at: now,
    updated_at: now,
  };
}

function saveSession(session, homeDir = os.homedir()) {
  const file = sessionFilePath(homeDir, session.harness, session.id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(temporary, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

function readSessionFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.id) return null;
    if (!Array.isArray(parsed.messages)) parsed.messages = [];
    return parsed;
  } catch {
    return null;
  }
}

function loadSession(homeDir, harness, id) {
  if (!id) return null;
  return readSessionFile(sessionFilePath(homeDir, harness, id));
}

function findSession(homeDir, id) {
  if (!id) return null;
  for (const harness of HARNESS_NAMES) {
    const session = loadSession(homeDir, harness, id);
    if (session) return session;
  }
  return null;
}

function walkFiles(root, predicate, maxDepth = 4) {
  const found = [];
  if (!root || maxDepth < 0) return found;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(full, predicate, maxDepth - 1));
    else if (entry.isFile() && predicate(entry.name)) found.push(full);
  }
  return found;
}

function listSessions(homeDir = os.homedir(), options = {}) {
  const includeNative = options.includeNative !== false;
  const rows = [];
  for (const file of walkFiles(path.join(pocketDir(homeDir), 'sessions'), (name) => name.endsWith('.json'), 3)) {
    const session = readSessionFile(file);
    if (!session) continue;
    const assistant = [...session.messages].reverse().find((message) => message && message.role === 'assistant');
    rows.push({
      id: session.id,
      session_id: session.id,
      stored_session_id: session.id,
      harness: session.harness,
      title: session.title || '',
      cwd: session.cwd || '',
      source: 'chat',
      preview: assistant ? asText(assistant.content) || '' : '',
      message_count: session.messages.length,
      last_active: session.updated_at || session.created_at || 0,
    });
  }
  if (includeNative) {
    for (const harness of HARNESS_NAMES) {
      const nativeDir = harness === 'claude'
        ? path.join(homeDir, '.claude', 'projects')
        : path.join(homeDir, `.${harness}`, 'agent', 'sessions');
      for (const file of walkFiles(nativeDir, (name) => name.endsWith('.jsonl'), 4)) {
        let header = null;
        try {
          const firstLine = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
          header = JSON.parse(firstLine);
        } catch {
          header = null;
        }
        const id = sessionIdOrNull(header && (header.id || header.sessionId)) || path.basename(file, '.jsonl');
        rows.push({
          id,
          session_id: id,
          stored_session_id: id,
          harness,
          title: asText(header && (header.title || header.name)) || '',
          cwd: asText(header && header.cwd) || '',
          source: 'native',
          preview: '',
          message_count: 0,
          last_active: Number(header && header.timestamp ? Date.parse(header.timestamp) / 1000 : 0) || 0,
          native_path: file,
        });
      }
    }
  }
  rows.sort((a, b) => (b.last_active || 0) - (a.last_active || 0));
  return rows;
}

function historyMessages(session) {
  return session.messages.map((message, index) => {
    const row = {
      id: message.id || String(index + 1),
      row_id: Number(message.row_id) || index + 1,
      role: message.role,
      content: asText(message.content) || '',
      text: asText(message.content) || '',
      timestamp: Number(message.timestamp) || session.created_at || Date.now() / 1000,
    };
    if (message.name) row.name = message.name;
    if (message.args) row.args = message.args;
    if (message.result) row.result = message.result;
    if (message.error) row.error = message.error;
    if (message.reasoning) row.reasoning = message.reasoning;
    return row;
  });
}

// ---------------------------------------------------------------------------
// JSONL reader. Splits on LF only (never on U+2028/U+2029), per Pi/OMP docs.
// ---------------------------------------------------------------------------

function createJsonlReader(onRecord) {
  let pending = Buffer.alloc(0);
  return {
    feed(chunk) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      let index;
      while ((index = pending.indexOf(0x0a)) !== -1) {
        let line = pending.subarray(0, index).toString('utf8');
        pending = pending.subarray(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.trim()) onRecord(line);
      }
      if (pending.length > MAX_WS_MESSAGE) pending = Buffer.alloc(0);
    },
  };
}

// ---------------------------------------------------------------------------
// CLI adapter: one child process per turn (fresh resume flags each time).
// ---------------------------------------------------------------------------

function withTimeout(promise, timeoutMs, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(fallback);
    }, Math.max(1, timeoutMs));
    Promise.resolve(promise).then((value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    }, () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

function createTurnAdapter(options) {
  const {
    harness, binary, cwd, nativeCliSessionId = null, resuming = false,
    onAction = () => {}, env = process.env, readyTimeoutMs = 5000,
    promptTimeoutMs = 30_000,
  } = options;

  const ParserClass = PARSERS[harness];
  if (!ParserClass || !binary) throw new RpcError(-32603, 'harness adapter unavailable');

  const parser = new ParserClass();
  const pending = new Map();
  let commandSeq = 0;
  let settled = false;
  let child;
  let resolveFinished;
  let resolveReady;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  const ready = harness === 'omp' ? new Promise((resolve) => { resolveReady = resolve; }) : Promise.resolve(null);

  function emit(action) {
    if (action && action.kind === 'ready' && resolveReady) {
      const resolve = resolveReady;
      resolveReady = null;
      resolve(action);
    }
    try { onAction(action); } catch { /* a broken consumer must not kill the child */ }
    if (action && action.kind === 'done') settle();
  }

  function settle() {
    if (settled) return;
    settled = true;
    try { if (child && child.stdin && !child.stdin.destroyed) child.stdin.end(); } catch { /* gone */ }
    resolveFinished(true);
  }

  function write(record) {
    if (!child || !child.stdin || child.stdin.destroyed) return false;
    try {
      child.stdin.write(JSON.stringify(record) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  function command(type, extra = {}) {
    const id = 'bridge-' + (++commandSeq);
    const answer = new Promise((resolve) => pending.set(id, resolve));
    if (!write({ id, type, ...extra })) {
      pending.delete(id);
      return Promise.resolve({ success: false });
    }
    return answer;
  }

  function handleStateResponse(record) {
    const data = record && record.data;
    if (!record || record.success === false || !data) return;
    const native = sessionIdOrNull(data.sessionFile || data.sessionId || data.session_path || data.session_id);
    if (native) emit({ kind: 'native_session', nativeCliSessionId: native });
  }

  try {
    const args = cliArgs(harness, { nativeCliSessionId, resuming });
    child = spawn(binary, args, {
      cwd: cwd || undefined,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    emit({ kind: 'error', message: 'unable to start ' + harness });
    emit({ kind: 'done', status: 'error' });
    settle();
    return { startTurn: async () => false, interrupt: () => {}, close: () => settle(), finished };
  }

  if (child.stderr) child.stderr.resume(); // never parse or log stderr (may contain secrets)
  child.on('error', () => {
    emit({ kind: 'error', message: harness + ' process failed to start' });
    emit({ kind: 'done', status: 'error' });
    settle();
  });

  const reader = createJsonlReader((line) => {
    if (harness === 'claude') {
      for (const action of parser.push(line)) emit(action);
      return;
    }
    const record = parseRecord(line);
    if (!record) return;
    for (const action of parser.push(record)) emit(action);
    if (record.type === 'response' && record.id && pending.has(record.id)) {
      const resolve = pending.get(record.id);
      pending.delete(record.id);
      resolve(record);
      if (asText(record.command) === 'get_state') handleStateResponse(record);
    }
  });

  if (child.stdout) {
    child.stdout.on('data', (chunk) => reader.feed(chunk));
    child.stdout.on('end', () => {
      for (const action of parser.finish()) emit(action);
      settle();
    });
  }
  child.on('close', () => {
    for (const action of parser.finish()) emit(action);
    settle();
  });

  async function startTurn(text) {
    if (harness === 'claude') {
      if (child && child.stdin && !child.stdin.destroyed) {
        child.stdin.write(String(text) + '\n');
        child.stdin.end();
      }
    } else if (harness === 'pi') {
      if (resuming && nativeCliSessionId) await withTimeout(command('switch_session', { sessionPath: nativeCliSessionId }), promptTimeoutMs, null);
      command('get_state').then(handleStateResponse);
      const reply = await withTimeout(command('prompt', { message: String(text) }), promptTimeoutMs, null);
      if (!reply || reply.success === false) emit({ kind: 'error', message: 'prompt rejected by pi' });
    } else {
      const readyFrame = await withTimeout(ready, readyTimeoutMs, null);
      if (!readyFrame) emit({ kind: 'error', message: 'omp ready frame timeout' });
      if (readyFrame && readyFrame.supportV2) {
        await withTimeout(command('negotiate_protocol', { protocolVersion: 2 }), promptTimeoutMs, null);
      }
      if (resuming && nativeCliSessionId) {
        await withTimeout(command('open_session', { sessionDir: path.dirname(nativeCliSessionId) }), promptTimeoutMs, null);
      }
      command('get_state').then(handleStateResponse);
      const reply = await withTimeout(command('prompt', { message: String(text) }), promptTimeoutMs, null);
      if (!reply || reply.success === false) emit({ kind: 'error', message: 'prompt rejected by omp' });
    }
    return finished;
  }

  function interrupt() {
    if (harness === 'claude') {
      try { child.kill('SIGINT'); } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1000).unref?.();
    } else {
      write({ type: 'abort' });
    }
  }

  function close() {
    settle();
    try { child.kill('SIGTERM'); } catch { /* gone */ }
  }

  return { startTurn, interrupt, close, finished };
}

// ---------------------------------------------------------------------------
// WebSocket framing (RFC 6455), built on raw sockets - no ws dependency.
// ---------------------------------------------------------------------------

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeWsFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

class WsClient {
  constructor(socket, bridge, authenticated) {
    this.socket = socket;
    this.bridge = bridge;
    this.authenticated = Boolean(authenticated);
    this.buffer = Buffer.alloc(0);
    this.fragment = null;
    this.queue = [];
    this.writing = false;
    this.closed = false;
    socket.on('data', (chunk) => {
      try { this.feed(chunk); } catch { this.close(1002); }
    });
    socket.on('close', () => this.destroy());
    socket.on('error', () => this.destroy());
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.bridge.clients.delete(this);
  }

  send(frame) {
    if (this.closed) return;
    this.queue.push(encodeWsFrame(JSON.stringify(frame)));
    this.flush();
  }

  flush() {
    if (this.writing || this.closed) return;
    while (this.queue.length) {
      const frame = this.queue.shift();
      if (!this.socket.write(frame)) {
        this.writing = true;
        this.socket.once('drain', () => { this.writing = false; this.flush(); });
        return;
      }
    }
  }

  close(code = 1000) {
    if (this.closed) return;
    try { this.socket.write(encodeWsFrame(Buffer.from([code >> 8, code & 0xff]).toString('binary'), 0x8)); } catch { /* gone */ }
    this.destroy();
    try { this.socket.destroy(); } catch { /* gone */ }
  }

  feed(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    while (this.buffer.length >= 2 && !this.closed) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_WS_FRAME)) return this.close(1009);
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_WS_FRAME) return this.close(1009);
      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.handleFrame(fin, opcode, payload, masked);
    }
  }

  handleFrame(fin, opcode, payload, masked) {
    if (!masked) return this.close(1002);
    if (opcode === 0x8) return this.close(1000);
    if (opcode === 0x9) return this.sendRaw(encodeWsFrame(payload.toString('utf8'), 0xa));
    if (opcode === 0xa) return;
    if (opcode === 0x2 && !this.fragment) return; // binary frames are not protocol records
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      if (opcode !== 0x0) {
        this.fragment = { opcode, parts: [payload], length: payload.length };
      } else {
        if (!this.fragment) return this.close(1002);
        this.fragment.parts.push(payload);
        this.fragment.length += payload.length;
      }
      if (this.fragment.length > MAX_WS_MESSAGE) return this.close(1009);
      if (!fin) return;
      const message = Buffer.concat(this.fragment.parts).toString('utf8');
      this.fragment = null;
      this.handleMessage(message);
      return;
    }
    this.close(1002);
  }

  sendRaw(frame) {
    if (this.closed) return;
    if (!this.socket.write(frame)) this.socket.once('drain', () => {});
  }

  handleMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;

    if (!this.authenticated) {
      const isHello = asText(frame.type) === 'hello';
      const token = frame.params && typeof frame.params === 'object' ? asText(frame.params.token) : null;
      const id = Number.isSafeInteger(frame.id) ? frame.id : null;
      if (!isHello || !token || !this.bridge.checkToken(token)) {
        const blocked = this.bridge.recordHelloFailure(this.bridge.clientIp(this.socket));
        if (id !== null) this.send({ id, error: { code: -32000, message: 'authentication failed' } });
        this.close(blocked ? 1008 : 1008);
        return;
      }
      this.bridge.clearHelloFailure(this.bridge.clientIp(this.socket));
      this.authenticated = true;
      if (id !== null) this.send({ id, result: { protocol: asText(frame.params.protocol) || 'hermes-gateway-v1', session_id: '' } });
      this.send(this.bridge.eventFrame('gateway.ready', '', {}));
      return;
    }

    const id = Number.isSafeInteger(frame.id) ? frame.id : null;
    const method = asText(frame.method);
    if (!method || method === 'event' || id === null) return; // client-side notifications are ignored
    this.bridge.dispatch(method, frame.params || {}, { client: this }).then(
      (result) => this.send({ id, result: result === undefined ? {} : result }),
      (error) => this.send({ id, error: {
        code: error && Number.isInteger(error.code) ? error.code : -32603,
        message: error && error.message ? String(error.message).slice(0, 200) : 'internal error',
      } }),
    );
  }

  sendReady() {
    this.send(this.bridge.eventFrame('gateway.ready', '', {}));
  }
}

// ---------------------------------------------------------------------------
// Bridge: HTTP /health, authenticated WebSocket /api/ws, method dispatcher.
// ---------------------------------------------------------------------------

function createBridge(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const token = getBridgeToken(homeDir);
  const clients = new Set();
  const helloFailures = new Map();
  const seqBySession = new Map();
  const turnPromises = new Set();
  const runtimes = new Map();
  let detection = null;
  let detectionAt = 0;

  const bridge = {
    token,
    homeDir,
    clients,
    server: null,
    options,
  };

  bridge.clientIp = (socket) => socket && socket.remoteAddress ? socket.remoteAddress : 'unknown';
  bridge.checkToken = (candidate) => {
    if (typeof candidate !== 'string' || !candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  bridge.isIpBlocked = (ip) => {
    const record = helloFailures.get(ip);
    return Boolean(record && record.blockedUntil > Date.now());
  };
  bridge.recordHelloFailure = (ip) => {
    const now = Date.now();
    const record = helloFailures.get(ip) || { times: [], blockedUntil: 0 };
    record.times = record.times.filter((time) => now - time < HELLO_WINDOW_MS);
    record.times.push(now);
    if (record.times.length >= HELLO_MAX_FAILURES) {
      record.blockedUntil = now + HELLO_BLOCK_MS;
      record.times = [];
    }
    helloFailures.set(ip, record);
    return bridge.isIpBlocked(ip);
  };
  bridge.clearHelloFailure = (ip) => { helloFailures.delete(ip); };

  function nextSeq(sessionId) {
    const key = sessionId || '';
    const seq = (seqBySession.get(key) || 0) + 1;
    seqBySession.set(key, seq);
    return seq;
  }

  bridge.eventFrame = (type, sessionId, payload, seq = nextSeq(sessionId)) => ({
    method: 'event',
    params: {
      type,
      session_id: sessionId || '',
      payload: payload || {},
      seq,
    },
  });

  function broadcast(type, sessionId, payload) {
    const frame = bridge.eventFrame(type, sessionId, payload, nextSeq(sessionId));
    if (typeof options.onEvent === 'function') options.onEvent(frame);
    for (const client of clients) if (client.authenticated) client.send(frame);
    return frame;
  }
  bridge.emitEvent = broadcast;

  async function harnessList() {
    const now = Date.now();
    if (!detection || now - detectionAt > 30_000) {
      detectionAt = now;
      const detectFn = options.detect || detectHarnesses;
      detection = Promise.resolve(detectFn({ env, timeoutMs: options.versionTimeoutMs || 2500 }));
    }
    return detection;
  }

  function loadSessionOrThrow(sessionId) {
    const session = findSession(homeDir, sessionId);
    if (!session) throw new RpcError(-32001, 'unknown session');
    return session;
  }

  function startAdapter(session, text, onAction) {
    const factory = options.adapterFactory || createTurnAdapter;
    const binary = resolveBinary(session.harness, env);
    if (!binary && !options.adapterFactory) throw new RpcError(-32000, session.harness + ' CLI is not available');
    return factory({
      harness: session.harness,
      binary,
      cwd: session.cwd || undefined,
      nativeCliSessionId: session.nativeCliSessionId,
      resuming: Boolean(session.nativeCliSessionId),
      onAction,
      env,
    });
  }

  const turnQueues = new Map();
  const draining = new Set();

  function drainTurns(sessionId) {
    if (draining.has(sessionId)) return;
    draining.add(sessionId);
    setImmediate(async () => {
      try {
        while (turnQueues.get(sessionId) && turnQueues.get(sessionId).length) {
          const turn = turnQueues.get(sessionId).shift();
          try {
            await runTurn(turn.session, turn.text);
          } finally {
            turn.resolve();
          }
        }
      } finally {
        draining.delete(sessionId);
        if (turnQueues.get(sessionId) && !turnQueues.get(sessionId).length) turnQueues.delete(sessionId);
      }
    });
  }

  function enqueueTurn(session, text) {
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    if (!turnQueues.has(session.id)) turnQueues.set(session.id, []);
    turnQueues.get(session.id).push({ session, text, resolve });
    drainTurns(session.id);
    return done;
  }

  async function runTurn(session, text) {
    const sid = session.id;
    const runtime = { adapter: null, interrupted: false };
    runtimes.set(sid, runtime);
    const state = {
      started: false, completed: false, finalText: '', usage: {}, status: 'completed', tools: [],
    };

    function handleAction(action) {
      if (!action || !action.kind) return;
      switch (action.kind) {
        case 'session_info': {
          const native = sessionIdOrNull(action.payload && (action.payload.nativeCliSessionId || action.payload.session_id));
          if (native && native !== session.id && !session.nativeCliSessionId) {
            session.nativeCliSessionId = native;
            try { saveSession(session, homeDir); } catch { /* keep going */ }
          }
          broadcast('session.info', sid, { session_id: sid, harness: session.harness, title: session.title, ...(action.payload || {}) });
          break;
        }
        case 'native_session':
          if (action.nativeCliSessionId) {
            session.nativeCliSessionId = action.nativeCliSessionId;
            try { saveSession(session, homeDir); } catch { /* keep going */ }
          }
          break;
        case 'message_start':
          if (!state.started) {
            state.started = true;
            broadcast('message.start', sid, { session_id: sid });
          }
          break;
        case 'message_delta': {
          const delta = asText(action.text) || '';
          state.finalText += delta;
          broadcast('message.delta', sid, { text: delta, rendered: asText(action.rendered) === null ? delta : action.rendered });
          break;
        }
        case 'thinking_delta':
          broadcast('thinking.delta', sid, { text: asText(action.text) || '' });
          break;
        case 'tool_start': {
          const tool = {
            tool_id: asText(action.tool_id) || '', name: asText(action.name) || 'tool',
            args: asText(action.args) || '', start_ms: Date.now(),
          };
          state.tools.push(tool);
          broadcast('tool.start', sid, { tool_id: tool.tool_id, name: tool.name, args: tool.args });
          break;
        }
        case 'tool_complete': {
          const toolId = asText(action.tool_id) || '';
          const tool = state.tools.find((entry) => entry.tool_id === toolId) || { name: asText(action.name) || 'tool' };
          const payload = {
            tool_id: toolId,
            name: tool.name,
            result: resultText(action.result),
            duration_s: Number(action.duration_s) || durationSeconds(tool.start_ms, Date.now),
          };
          session.messages.push({
            id: crypto.randomUUID(), role: 'tool', name: payload.name,
            args: tool.args || '', content: payload.result, timestamp: Date.now() / 1000,
          });
          broadcast('tool.complete', sid, payload);
          break;
        }
        case 'message_complete':
          state.finalText = asText(action.text) === null ? state.finalText : action.text;
          state.usage = action.usage || state.usage;
          state.status = action.status || state.status;
          if (!state.completed) {
            state.completed = true;
            broadcast('message.complete', sid, {
              text: state.finalText,
              rendered: asText(action.rendered) === null ? state.finalText : action.rendered,
              usage: normalizeUsage(state.usage),
              status: state.status,
            });
          }
          break;
        case 'error':
          state.status = 'error';
          broadcast('error', sid, { message: asText(action.message) || 'turn error' });
          break;
        case 'done':
          break;
        default:
          break;
      }
    }

    if (!state.started) {
      state.started = true;
      broadcast('message.start', sid, { session_id: sid });
    }

    session.messages.push({ id: crypto.randomUUID(), role: 'user', content: text, timestamp: Date.now() / 1000 });
    try { saveSession(session, homeDir); } catch { /* keep going */ }

    try {
      runtime.adapter = startAdapter(session, text, handleAction);
      const completedInTime = await withTimeout(
        runtime.adapter.startTurn(text),
        options.turnTimeoutMs || 10 * 60 * 1000,
        false,
      );
      if (completedInTime === false) {
        runtime.interrupted = true;
        try { runtime.adapter.interrupt(); } catch { /* gone */ }
        broadcast('error', sid, { message: 'turn timed out' });
      }
    } catch {
      state.status = 'error';
      broadcast('error', sid, { message: 'harness turn failed' });
    } finally {
      if (runtime.adapter) {
        try { runtime.adapter.close(); } catch { /* gone */ }
      }
      if (runtime.interrupted && state.status !== 'error') state.status = 'interrupted';
      if (!state.completed) {
        state.completed = true;
        broadcast('message.complete', sid, {
          text: state.finalText,
          rendered: state.finalText,
          usage: normalizeUsage(state.usage),
          status: state.status,
        });
      }
      session.messages.push({
        id: crypto.randomUUID(), role: 'assistant', content: state.finalText,
        timestamp: Date.now() / 1000, status: state.status,
      });
      session.updated_at = Date.now() / 1000;
      try { saveSession(session, homeDir); } catch { /* keep going */ }
      broadcast('sessions.changed', '', { session_id: '' });
      runtimes.delete(sid);
    }
  }

  bridge.waitIdle = async () => {
    while (turnPromises.size) await Promise.allSettled([...turnPromises]);
  };

  // Hermes-only RPCs the UI calls on startup. The bridge cannot implement
  // them against a CLI harness, but answering with empty/no-op results keeps
  // the chat screen usable instead of flooding it with -32601 toasts.
  const configValues = new Map();

  const handlers = {
    'harness.list': async () => ({ harnesses: await harnessList() }),

    'session.create': async (params) => {
      const requested = sessionIdOrNull(params.harness);
      let harness = requested;
      if (!harness) {
        const detected = await harnessList();
        const first = detected.find((entry) => entry.available);
        harness = first ? first.name : 'claude';
      }
      if (!HARNESS_NAMES.includes(harness)) throw new RpcError(-32602, 'unknown harness');
      const session = makeSession(harness, params.title, params.cwd);
      saveSession(session, homeDir);
      broadcast('sessions.changed', '', { session_id: '' });
      return {
        session_id: session.id,
        stored_session_id: session.id,
        harness: session.harness,
        title: session.title,
        cwd: session.cwd,
      };
    },

    'session.list': async (params) => {
      let sessions = listSessions(homeDir).filter((row) => row.source === 'chat');
      const limit = Number(params.limit);
      if (Number.isInteger(limit) && limit > 0) sessions = sessions.slice(0, limit);
      return { sessions };
    },

    'session.history': async (params) => {
      const session = loadSessionOrThrow(sessionIdOrNull(params.session_id));
      const messages = historyMessages(session);
      return { session_id: session.id, messages, history: messages, title: session.title };
    },

    'session.resume': async (params) => {
      const session = loadSessionOrThrow(sessionIdOrNull(params.session_id));
      broadcast('session.info', session.id, {
        session_id: session.id, harness: session.harness, title: session.title, cwd: session.cwd,
      });
      return {
        session_id: session.id,
        stored_session_id: session.id,
        harness: session.harness,
        title: session.title,
        cwd: session.cwd,
        native_cli_session_id: session.nativeCliSessionId,
        messages: historyMessages(session),
        running: runtimes.has(session.id),
      };
    },

    'prompt.submit': async (params) => {
      const session = loadSessionOrThrow(sessionIdOrNull(params.session_id));
      const text = asText(params.text) || asText(params.message);
      if (!text) throw new RpcError(-32602, 'text is required');
      const promise = enqueueTurn(session, text);
      turnPromises.add(promise);
      promise.finally(() => turnPromises.delete(promise));
      return { accepted: true };
    },

    'session.interrupt': async (params) => {
      const sid = sessionIdOrNull(params.session_id);
      const runtime = runtimes.get(sid);
      if (!runtime) return { interrupted: false };
      runtime.interrupted = true;
      try { runtime.adapter && runtime.adapter.interrupt(); } catch { /* gone */ }
      return { interrupted: true };
    },

    'session.title': async (params) => {
      const session = loadSessionOrThrow(sessionIdOrNull(params.session_id));
      const title = asText(params.title);
      if (title === null) throw new RpcError(-32602, 'title is required');
      session.title = title;
      session.updated_at = Date.now() / 1000;
      saveSession(session, homeDir);
      broadcast('session.info', session.id, { session_id: session.id, title, harness: session.harness });
      broadcast('sessions.changed', '', { session_id: '' });
      return { session_id: session.id, title };
    },

    // ── Hermes-only compatibility methods (no-ops for CLI harnesses) ────
    'config.get': async (params) => ({
      value: configValues.get(asText(params.key) || '') || '',
    }),
    'config.set': async (params) => {
      const key = asText(params.key) || '';
      const value = asText(params.value) || '';
      if (key) configValues.set(key, value);
      return { ok: true, key, value };
    },
    'session.most_recent': async () => {
      const rows = listSessions(homeDir);
      const last = rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0];
      return last ? { session_id: last.id, id: last.id, harness: last.harness } : { session_id: '', id: '' };
    },
    'session.foreign.list': async () => ({ sessions: [] }),
    'session.usage': async () => ({ usage: {} }),
    'model.options': async () => ({ options: [] }),
    'tools.list': async () => ({ tools: [] }),
    'tools.configure': async () => ({ ok: true }),
    'vault.list': async () => ({ vaults: [], items: [] }),
    'vault.sources': async () => ({ sources: [] }),
    'connectors.list': async () => ({ connectors: [] }),
    'connectors.catalog': async () => ({ catalog: [] }),
    'plugins.list': async () => ({ plugins: [] }),
    'agents.list': async () => ({ agents: [] }),
    'skills.reload': async () => ({ ok: true }),
    'reload.mcp': async () => ({ ok: true }),
    'reload.env': async () => ({ ok: true }),
    'client.capabilities': async () => ({ ok: true }),
    'usage.bars': async () => ({ bars: [] }),
    'billing.state': async () => ({ state: null }),
    'subscription.state': async () => ({ state: null }),
    'free_tier.status': async () => ({ status: null }),
    'insights.get': async () => ({ insights: [] }),
    'mcp.servers.list': async () => ({ servers: [] }),
    'mcp.servers.status': async () => ({ servers: [] }),
    'process.list': async () => ({ processes: [] }),
    'approval.respond': async () => ({ ok: true }),
    'session.compress': async () => ({ ok: true }),
    'session.branch': async () => ({ ok: true }),
    'session.steer': async () => ({ ok: true }),
    'message.react': async () => ({ ok: true }),
    'prompt.btw': async () => ({ accepted: true }),
    'prompt.background': async () => ({ accepted: true }),
  };

  bridge.dispatch = async (method, params = {}, context = {}) => {
    const handler = handlers[asText(method)];
    if (!handler) throw new RpcError(-32601, 'method not found');
    try {
      return await handler(params || {}, context);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(-32603, 'internal error');
    }
  };

  function rejectUpgrade(socket, status, reason) {
    try {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    } catch { /* gone */ }
  }

  bridge.handleUpgrade = (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url || '/', 'http://127.0.0.1');
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    if (url.pathname !== '/api/ws') return rejectUpgrade(socket, 404, 'Not Found');
    const ip = bridge.clientIp(socket);
    if (bridge.isIpBlocked(ip)) return rejectUpgrade(socket, 429, 'Too Many Requests');

    let authenticated = false;
    const urlToken = url.searchParams.get('token');
    if (urlToken !== null) {
      if (!bridge.checkToken(urlToken)) {
        bridge.recordHelloFailure(ip);
        return rejectUpgrade(socket, 401, 'Unauthorized');
      }
      authenticated = true;
      bridge.clearHelloFailure(ip);
    }

    const key = request.headers['sec-websocket-key'];
    if (!key || request.headers.upgrade !== 'websocket' ||
        String(request.headers['sec-websocket-version']) !== '13') {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }

    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n' +
        '\r\n',
      );
    } catch {
      return;
    }
    const client = new WsClient(socket, bridge, authenticated);
    clients.add(client);
    if (head && head.length) client.feed(head);
    if (authenticated) client.sendReady();
  };

  bridge.server = http.createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url || '/', 'http://127.0.0.1');
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify({ ok: true, service: 'hermes-pocket-bridge' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  bridge.server.on('upgrade', bridge.handleUpgrade);

  bridge.close = async () => {
    for (const client of [...clients]) client.close(1001);
    for (const runtime of runtimes.values()) {
      try { runtime.adapter && runtime.adapter.close(); } catch { /* gone */ }
    }
    await new Promise((resolve) => {
      if (!bridge.server.listening) return resolve();
      bridge.server.close(() => resolve());
    });
  };

  return bridge;
}

async function startBridge(options = {}) {
  const bridge = createBridge(options);
  const port = Number(options.port === undefined ? (process.env.PORT || DEFAULT_PORT) : options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid PORT');
  await new Promise((resolve, reject) => {
    bridge.server.once('error', reject);
    bridge.server.listen(port, HOST, resolve);
  });
  return bridge;
}

if (require.main === module) {
  startBridge().then((bridge) => {
    const cleanup = () => { bridge.close().finally(() => { process.exit(0); }); };
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  }).catch((error) => {
    process.stderr.write('bridge failed to start: ' + (error && error.message ? error.message : 'unknown error') + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  HOST, DEFAULT_PORT, HARNESS_NAMES, BIN_ENV,
  RpcError, ClaudeParser, PiParser, OmpParser,
  asText, sessionIdOrNull, parseRecord, resultText, normalizeUsage,
  cliArgs, findInPath, resolveBinary, probeVersion, detectHarnesses,
  getBridgeToken, tokenFilePath, sessionFilePath, makeSession, saveSession,
  loadSession, findSession, listSessions, historyMessages,
  createJsonlReader, createTurnAdapter, encodeWsFrame, wsAccept,
  createBridge, startBridge,
};
