# Hermes-Pocket multi-harness bridge

Dependency-free Node bridge that lets the Android app chat with **Claude Code**, **pi** and **oh-my-pi (omp)** through the same gateway protocol it already uses for Hermes. It speaks Hermes JSON-RPC + `GatewayEvent` frames, so no chat-screen code is duplicated.

## Run on Termux

```sh
cd ~/Hermes-Pocket
node bridge/harness-bridge.js
```

* Binds **127.0.0.1:9120** only (`PORT=9130` to override).
* `GET /health` → `{"ok":true,"service":"hermes-pocket-bridge"}`.
* WebSocket endpoint: `ws://127.0.0.1:9120/api/ws?token=<TOKEN>`.
* Token is created on first run at `~/.hermes-pocket/bridge-token` (mode 0600). Read it with `cat ~/.hermes-pocket/bridge-token` and paste it into **Settings → Harness** in the app. The token is never logged.

## Harness discovery

`harness.list` probes each CLI with `--version`:

| Harness | Command used on this device | Verified version |
|---|---|---|
| `claude` | `claude` from PATH | currently unavailable: native postinstall binary missing |
| `pi` | `proot-distro login ubuntu -- /root/.omp/plugins/node_modules/.bin/pi` | 1.1.0 |
| `omp` | `proot-distro login ubuntu -- /root/.bun/bin/omp` | 18.10.2 |

pi and omp are installed **inside the Ubuntu proot**, not in the Termux PATH. The bridge detects the rootfs and writes executable shims to `~/.hermes-pocket/bin/{pi,omp}` automatically. Override any command with `PI_BIN` / `OMP_BIN` / `CLAUDE_BIN` (a path or a wrapper script). `proot-distro login` preserves stdin/stdout, so both `--mode rpc` and `--mode json` work. Version probing allows 15 s because proot startup is slow.

The CLI harnesses need their own provider login (`/login` inside pi/omp, or `claude` credentials); the bridge does not share Hermes credentials. Verified end-to-end: `harness.list`, `session.create`, `prompt.submit` and `message.start`/`error` events all flowed through the WebSocket; pi reported `No API key found`, which is a provider-config issue, not a bridge issue.

## Wire protocol (subset used by the app)

Requests are JSON-RPC: `{"jsonrpc":"2.0","id":41,"method":"prompt.submit","params":{...}}`.
Responses: `{"id":41,"result":{...}}` / `{"id":41,"error":{"code":…,"message":…}}`.
Events: `{"method":"event","params":{"type":"message.delta","session_id":"…","payload":{…},"seq":N}}`.

Methods: `harness.list`, `session.create`, `session.list`, `session.history`, `session.resume`, `session.title`, `prompt.submit`, `session.interrupt`.
Events: `gateway.ready`, `session.info`, `message.start`, `message.delta`, `message.complete`, `thinking.delta`, `tool.start`, `tool.complete`, `sessions.changed`, `error`.

Sessions are stored as JSON under `~/.hermes-pocket/sessions/<harness>/<id>.json` (0600) and include the native CLI session id so `--resume` works across turns.

## Tests

```sh
node --test bridge/test
# ℹ tests 16 / ℹ pass 16 / ℹ fail 0
```
