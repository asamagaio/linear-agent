# linear-agent

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

**A CLI that lets a coding agent read and write Linear issues under its own identity, not yours.**

Comments land in Linear as a distinct non-human actor with its own name and avatar, so the thread
reads as a conversation between two participants — and you can answer from the Linear mobile app.

```console
$ linear-agent read ENG-42
ENG-42  Retry loop drops the last error
https://linear.app/acme/issue/ENG-42/retry-loop-drops-the-last-error

State:     In Progress
Team:      ENG — Engineering
Project:   Platform (In Progress)
Delegate:  claude-agent (app)

Comments (2)
-----------

claude-agent (app) · 2026-08-11 09:14
Reproduced: the final attempt's error is overwritten before it is thrown.

you · 2026-08-11 09:20
Good catch — ship the fix behind the existing flag.
```

Everything above was written by two different actors. That is the whole point.

### Why not just use an API key?

A personal API key makes every comment appear as **you**. The thread stops being a conversation and
the agent's work becomes indistinguishable from your own. This CLI only ever authenticates as a
Linear *application*, and refuses to start if it finds anything else.

### What this is not

No webhook receiver, no HTTP server that outlives a command, no daemon, no session triggering.
You start the agent; the agent calls this CLI.

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
- **Enable the client credentials grant.** This is the one that matters for day-to-day use — see
  below. It is a toggle in *Edit application*.
- Redirect URI: `http://localhost:8787/callback` — only needed for the browser fallback.
- Webhooks: **leave disabled.** They are not used.

Copy the client ID and client secret.

### 2. Authorize

```bash
linear-agent auth --client-id <ID> --client-secret <SECRET>
```

or set `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` and run `linear-agent auth`.

No browser opens. The CLI asks Linear for an app token with the application's own credentials
(`grant_type=client_credentials`), confirms with `viewer.app` that what came back really is an app
actor, and stores it.

**The token lasts 30 days and renews itself.** It carries no refresh token, so the way it renews is
the documented one: the next request that gets a 401 asks for a new token with the same client id
and secret, stores it, and retries once. Nothing expires in your face and nothing asks you to log in
again. `linear-agent auth --status` says `Renewal: automatic` when this is in effect.

If the resulting token turns out to be a *user* token rather than an app one, the CLI refuses to
store it and tells you why — a user token would put your name on every comment the agent writes.

Apps acting as an app cannot also request the `admin` scope, so the CLI does not ask for it.

#### The browser fallback

```bash
linear-agent auth --browser --client-id <ID> --client-secret <SECRET>
```

For an application without the client credentials grant enabled. It starts a throwaway listener on
`127.0.0.1:8787`, opens Linear's authorize URL with `actor=app` and the scopes
`read,write,app:assignable,app:mentionable`, exchanges the code for a token, and shuts the listener
down. Nothing is left running.

**This token lasts about a day and cannot renew itself** — the flow returns a refresh token that
this CLI deliberately does not store, so it comes back asking for a browser roughly daily. That is
what the client credentials grant exists to avoid. `auth --status` marks it `Renewal: MANUAL`.

#### One thing not to do

Never let the requested scopes drift between authorizations. Linear treats a different scope set as
a new authorization and **revokes every existing app-actor token for the application** — including
the ones on your other machines. The CLI stores the granted scopes in one canonical form and resends
exactly that set on renewal, so this cannot happen by accident; it is worth knowing before editing
`SCOPES` by hand.

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
| `linear-agent list [--team KEY] [--state NAME] [--project NAME] [--delegated] [--limit N]` | Lists issues, most recently updated first. `--delegated` filters to issues delegated to this app. |
| `linear-agent projects [--team KEY] [--status NAME] [--limit N]` | Lists projects with status, progress, teams and lead. |
| `linear-agent read <ID>` | Full issue: title, description, state, labels, assignee, delegate, and all comments in order with authors and timestamps. |
| `linear-agent comment <ID> <body>` | Posts a comment as the app. Pass `-` to read the body from stdin. |
| `linear-agent status <ID> <state-name>` | Moves the issue to a workflow state, resolved by name. Reports the previous and new state. |
| `linear-agent create --team KEY --title T [--description D] [--label L] [--project NAME]` | Creates an issue as the app. `--label` is repeatable. |

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

### Projects

Projects are workspace-level and can span teams, so they are matched by name rather than by a key:

```bash
linear-agent projects --team ENG
linear-agent list --project "Platform" --json
linear-agent create --team ENG --title "..." --project "Platform"
```

`read` and `list` both report the issue's project. A name that matches more than one project is an
error listing the matches rather than a silent guess.

When `list` returns nothing *and* a `--project` or `--team` filter was given, the name is verified
before reporting an empty result — a typo would otherwise look like "no work here", which is a wrong
conclusion rather than a missing one. `--state` does not get this treatment, since workflow states
are per-team and there is no team to check against when the filter is used alone.

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
| `4` | issue, team, label, project, or workflow state not found |
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

### Keeping the instructions in sync

`docs/claude-md-section.md` is the single source of truth for what an agent is told about this CLI.
It is the only copy in the repo — a second, drifting copy is worse than none, because whichever an
agent reads first wins.

The installed copy lives outside the repo, so git cannot see edits to it:

```bash
npm run claude-md:check
```

reports any drift, and exits non-zero so it can gate a commit. Fix drift by folding the change into
`docs/claude-md-section.md` and committing, or by re-running `npm run setup`.

### Why the token stays behind

Copying a Keychain entry between machines is possible and a bad habit: it spreads a long-lived
secret with no record of where it ended up. Re-authorizing is cheap and leaves a fresh, revocable
token on each machine.

What you *do* need to carry is the **client id and secret** — keep them in a password manager. They
are also what makes renewal work, so the CLI keeps them beside the token: the client secret goes
into its own Keychain item (never the metadata file), and `auth --logout` clears both. The
Linear application itself is registered against the workspace, not the machine, so it survives the
move; you are only re-issuing a token for it. The app identity (its display name and app user id) is
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

Without instructions, the agent will not reach for this tool unless told to every single time. The
instructions live in [`docs/claude-md-section.md`](docs/claude-md-section.md) and are installed into
`~/.claude/CLAUDE.md` (which applies to every project) by:

```bash
npm run setup
```

That template is generic. Your workspace, teams and example identifiers come from
`claude-md.config`, which is gitignored so your Linear layout never lands in a commit:

```bash
cp claude-md.config.example claude-md.config   # then edit it
```

Editing the installed `~/.claude/CLAUDE.md` by hand is the easy mistake: it works locally, is
invisible to git, and is lost on the next machine. This reports that drift:

```bash
npm run claude-md:check
```
