# linear-agent

A small CLI that lets a coding agent (Claude Code) read and write Linear issues **under its own
identity**, not the human operator's. Comments appear in Linear as a distinct non-human actor with
its own name and avatar, so a thread reads as a conversation between two participants.

There is no webhook receiver, no HTTP server that outlives a command, no daemon, and no session
triggering. The human starts Claude Code; Claude Code calls this CLI.

## The invariant

The CLI authenticates **only** with an `actor=app` OAuth token. It never uses a personal API key or
a user OAuth token — either would make every comment appear as the human. If no app token is
present, every command fails loudly (exit code `3`) and never falls back to another credential.
`LINEAR_API_KEY` and friends are ignored on purpose, and the error says so explicitly.

## Requirements

- macOS (the Keychain is the primary credential store; there is a `0600` file fallback)
- Node.js 20+
- A Linear workspace where you have **admin** rights — required to install an app actor

## Install

```bash
npm install && npm run build && npm link
```

`npm link` puts `linear-agent` on your `PATH`. Without it, use `node dist/index.js …`.

## Setup

### 1. Register the application

Create an application at <https://linear.app/settings/api/applications/new>.

- The **name and icon become how the agent appears** in Linear — in mention menus, filters, and
  comment bylines. Pick something short and recognisable.
- Redirect URI: `http://localhost:8787/callback`
- Webhooks: **leave disabled.** They are not used.

Copy the client ID and client secret.

### 2. Authorize

```bash
linear-agent auth --client-id <ID> --client-secret <SECRET>
```

or set `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` and run `linear-agent auth`.

This starts a throwaway listener on `127.0.0.1:8787`, opens the browser at Linear's authorize URL
with `actor=app` and the scopes `read,write,app:assignable,app:mentionable`, exchanges the code for
a token, records the app's user id, and shuts the listener down. Nothing is left running.

`actor=app` is what installs the integration as its own app user. If the resulting token turns out
to be a *user* token, the CLI refuses to store it and tells you why.

Apps using `actor=app` cannot also request the `admin` scope, so the CLI does not ask for it.

### 3. Confirm

```bash
linear-agent whoami
```

This checks with Linear — not just the local store — that the token acts as an app.

## Credential storage

- **Token:** macOS Keychain, service `linear-agent`, account `default`. It is written by feeding
  `security` the secret on stdin, so the token never appears in the process table. (`security`
  truncates a prompted secret at 128 bytes; a longer token falls back to `-w <value>`, and either
  way the stored value is read back and compared before the write is accepted.)
- **Everything else** (app name, app user id, workspace, scopes) is not secret and lives in
  `~/.config/linear-agent/credentials.json`, mode `0600`.
- If the Keychain is unavailable, the token goes into that same file instead.
- The token is never printed, never logged, and is redacted from any error output.
- `LINEAR_AGENT_CREDENTIALS_STORE=file` forces the file store (non-macOS hosts, tests).

```bash
linear-agent auth --status    # identity, workspace, scopes — never the token
linear-agent auth --logout    # remove credentials from both stores
```

## Commands

| Command | Behaviour |
|---|---|
| `linear-agent whoami` | Prints the app user identity and confirms the token is an app actor, not a user actor. |
| `linear-agent list [--team KEY] [--state NAME] [--delegated] [--limit N]` | Lists issues, most recently updated first. `--delegated` filters to issues delegated to this app. |
| `linear-agent read <ID>` | Full issue: title, description, state, labels, assignee, delegate, and all comments in order with authors and timestamps. |
| `linear-agent comment <ID> <body>` | Posts a comment as the app. Pass `-` to read the body from stdin. |
| `linear-agent status <ID> <state-name>` | Moves the issue to a workflow state, resolved by name. Reports the previous and new state. |
| `linear-agent create --team KEY --title T [--description D] [--label L]` | Creates an issue as the app. `--label` is repeatable. |

Every command accepts `--json`.

### Identifiers

`<ID>` is always the human identifier — `ENG-42`, any case. UUIDs are accepted but never required.
Resolution is by team key plus issue number, and the mapping is cached in
`~/.config/linear-agent/id-cache.json`, so commenting on an already-read issue costs one request.

### State names

```bash
linear-agent status ENG-42 "In Progress"
```

Matched case-insensitively against the team's workflow states. On a miss, the error lists the states
that would have worked.

### Markdown bodies

Comment bodies are markdown and frequently multi-line, so `-` reads from stdin:

```bash
printf '%s\n' "## Findings" "" "- the retry loop drops the last error" | linear-agent comment ENG-42 -
```

`--description -` does the same for `create`.

## Exit codes

Claude Code branches on these, so they are part of the contract.

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | unexpected failure |
| `2` | bad usage |
| `3` | missing, unreadable, or non-app credentials |
| `4` | issue, team, label, or workflow state not found |
| `5` | rate limited after exhausting retries |
| `6` | the Linear API rejected the request |

## Rate limiting

Linear allows 5,000 requests per hour for an OAuth app and normalises limit breaches to HTTP 400 as
well as 429. The CLI retries with backoff — honouring the reset hint Linear returns when there is
one — for at most 5 attempts or 60 seconds total, then fails with exit code `5` rather than hanging.

Reads are single round trips: `read` fetches the issue, its relations, and its comments in one
request rather than lazily walking relations.

## Untrusted input

Issue and comment text is written by anyone with workspace access. The CLI transports it verbatim
and never interpolates it into a shell command. Human-readable output strips terminal control
characters so hostile text cannot repaint your terminal; `--json` output is byte-exact.

## Moving to another machine

Three things have to travel, and only two of them can be copied.

| Part | How it moves |
|---|---|
| Code | git clone, or an `npm pack` tarball |
| Instructions for Claude Code | `docs/claude-md-section.md`, installed by the bootstrap script |
| The token | **does not move** — mint a new one with `linear-agent auth` |

On the new machine:

```bash
git clone <your-remote> linear-agent && cd linear-agent && npm run setup
```

`npm run setup` installs, builds, links the binary onto `PATH`, and appends the Linear section to
`~/.claude/CLAUDE.md` (idempotent — re-running it will not duplicate anything). It then prints the
one step it cannot do for you:

```bash
linear-agent auth --client-id=<ID> --client-secret=<SECRET>
```

### Why the token stays behind

Copying a Keychain entry between machines is possible and a bad habit: it spreads a long-lived
secret with no record of where it ended up. Re-authorizing is cheap and leaves a fresh, revocable
token on each machine.

What you *do* need to carry is the **client id and secret** — keep them in a password manager. The
Linear application itself is registered against the workspace, not the machine, so it survives the
move; you are only re-issuing a token for it. The app identity (`claude-agent`, and its app user id) is
also workspace-scoped, so comments from the new machine are attributed to exactly the same actor.

### Without git

`npm pack` produces a `linear-agent-1.0.0.tgz` carrying the built `dist/`, installable anywhere with
`npm install -g ./linear-agent-1.0.0.tgz`. It is enough to *run* the CLI, but it contains no source,
so use it for a throwaway machine rather than as the way you keep the project.

## Development

```bash
npm run build      # tsc -> dist/
npm test           # build, then node --test (serial: two files bind port 8787)
npm run typecheck
```

Tests never touch the real Keychain or your real config: they use an isolated `XDG_CONFIG_HOME` and
force the file store. The one Keychain test is opt-in:

```bash
LINEAR_AGENT_TEST_KEYCHAIN=1 npm test
```

It refuses to run if a real `linear-agent` Keychain entry already exists.

Set `LINEAR_AGENT_DEBUG=1` to include stack traces on unexpected errors (still redacted).

## Wiring it up for Claude Code

See the `## Linear` section of [CLAUDE.md](CLAUDE.md) — copy it into the `CLAUDE.md` of whichever
repo the agent works in. Without it, Claude Code will not reach for the tool unless told to every
time.
