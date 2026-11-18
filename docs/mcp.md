# MCP servers

Moros connects to [Model Context Protocol](https://modelcontextprotocol.io) servers and exposes their
tools to the model. The client is built in: no official SDK, no extra runtime.

## Configure

MCP servers live in the **user-level** `~/.moros/config.toml`. A project `project.toml` cannot add or
replace them — MCP decides which local process starts, so the same rule as Reins applies: only the
user config may define servers.

```toml
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
timeout = 60
disabled = false

[mcp_servers.docs]
url = "https://example.com/mcp"
headers = { Authorization = "Bearer ${DOCS_TOKEN}" }
```

| Field      | Required | Meaning                                                                                                            |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `type`     | no       | `stdio`, `http`, or `sse`. Inferred from `command` (stdio) or `url` (http). `sse` is parsed but not connected yet. |
| `command`  | stdio    | One executable, not a shell command string.                                                                        |
| `args`     | no       | Arguments passed to `command`.                                                                                     |
| `url`      | http/sse | Streamable HTTP endpoint.                                                                                          |
| `headers`  | no       | HTTP headers; values support `${ENV}` and `!command`.                                                              |
| `env`      | no       | Extra environment for the stdio server; values support `${ENV}` and `!command`.                                    |
| `timeout`  | no       | Per-`tools/call` timeout in seconds; default 60. Control requests use a fixed short timeout.                       |
| `disabled` | no       | Keep the entry but do not connect.                                                                                 |

Invalid entries are skipped one by one and reported; they do not prevent other servers from loading.

### Environment values

`${NAME}` is expanded anywhere in an `env` or `headers` value, so
`Authorization = "Bearer ${DOCS_TOKEN}"` works. `!command` must occupy the whole value and is resolved
through the same helper as provider API keys. A missing variable marks that server unavailable instead
of connecting with half the credentials.

By default the stdio server inherits the host environment plus `env`; this is what makes `npx`/`uvx`
and credential-aware servers work. A server can therefore read every secret in the host environment;
only configure servers you trust.

## Tools and approval

Tools are named `mcp__<server>__<tool>`; characters outside `[A-Za-z0-9_]` become `_`, names are
limited to 64 characters, and colliding or overlong names get an 8-character hash suffix.

Every MCP tool passes through the same Harness pipeline as built-in tools:

- `resource: "shell"` — plan/standard modes refuse it.
- `risk: high` — `ask` always shows the approval card, `auto` sends it to the review model, `yolo`
  allows it. Server-declared read-only hints are not trusted.
- The approval card's "allow for this session" scope is the tool name.
- Tool results are spilled to a temporary file when they exceed the configured threshold.

MCP servers are **not** inside the workspace path sandbox. The approval gate is the boundary; the
`/mcps` page says so explicitly.

## Lifecycle

- Enabled servers connect in the background when the TUI starts. The first prompt waits at most three
  seconds for handshakes; late tools join the next turn.
- `/mcps` lists each server with its state and tool count. `r` reconnects the selected server, `h`
  checks every connection.
- A dropped connection is retried with a bounded backoff (2/4/8/16/30 seconds); after that it stays
  `unreachable` until `r`. Tool calls against an unavailable server return a clear error.
- `notifications/tools/list_changed` refreshes the tool list.
- Closing a stdio server closes stdin, sends SIGTERM, then SIGKILL, and terminates its whole process
  group so `npx`/`uvx` wrappers do not leave orphans.

## Diagnostics

`moros doctor` reports configured MCP servers and configuration errors without starting them. The TUI
shows connection failures in the startup warning area and in `/mcps`, including the tail of the
server's stderr.

## Current limits

- Legacy SSE is not supported; use a server that offers Streamable HTTP.
- Streamable HTTP supports JSON and SSE responses, session IDs, and a server-to-client GET stream; OAuth
  is not implemented yet.
- OAuth and MCP resources/prompts are not implemented yet.
- MCP tools are available to the main session only; subagents keep their restricted tool set.
