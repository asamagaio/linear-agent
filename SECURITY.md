# Security

This tool asks for OAuth credentials and writes a token to your Keychain. That deserves an explicit
account of what it does with them, so the decision to install it can rest on something checkable
rather than on trust.

## What it asks for, and why

| Secret | Why it is needed | Where it is stored |
|---|---|---|
| Client secret | To obtain and renew the app's access token | macOS Keychain, service `linear-agent`, account `client-secret` |
| Access token | To call the Linear API as the app | macOS Keychain, service `linear-agent`, account `default` |

The client **id** is not a secret — it identifies the application, it does not authenticate it — and
is kept in plain text alongside the other metadata.

Everything that is not a secret (app name, app user id, workspace, scopes, grant type, expiry) lives
in `~/.config/linear-agent/credentials.json`, mode `0600`, inside a `0700` directory. You can read
that file at any time to see exactly what is retained.

If the Keychain is unavailable — a non-macOS host, or `LINEAR_AGENT_CREDENTIALS_STORE=file` — both
secrets fall back into that same `0600` file. Nothing else changes.

## Where secrets go

Only to `https://api.linear.app` and `https://linear.app`. There is no telemetry, no analytics, no
crash reporting, and no other network destination anywhere in the source. `grep -rn "fetch\|http" src/`
is short enough to read in full.

Secrets are never printed. Every value handled as a secret is registered with a redactor, and all
output — including error messages and stack traces — passes through it. `auth --status` deliberately
reports identity, scopes and expiry, and never the token.

The token is written to the Keychain by feeding `security` the value on **stdin**, so it never
appears in the process table. It is read back and compared before the write is accepted, because
`security` silently truncates a prompted secret at 128 bytes.

## Secrets in CI

The [remote implement workflow](docs/remote-implement.md) stores `LINEAR_CLIENT_ID`,
`LINEAR_CLIENT_SECRET` and `CLAUDE_CODE_OAUTH_TOKEN` as GitHub Actions secrets, each scoped to the
individual steps that need it rather than to the job.

On a Linux runner there is no Keychain, so `auth` writes the plaintext file store described above.
That file is deleted before any agent processes ticket text, and again when the job ends — an agent
handling untrusted input must never share a filesystem with a credential it has no reason to read.
Nothing under `~/.config` is ever cached or uploaded as an artifact.

Ticket bodies fetched by that workflow are untrusted input in the sense described below, with the
added weight that the reader is an agent holding write access to the repository. They are passed as
a file rather than interpolated into any GitHub expression, and the prompt frames them as data.

## The invariant

The CLI authenticates only as a Linear *application*. It never falls back to a personal API key or a
user OAuth token — either would attribute every comment to the human operator. `LINEAR_API_KEY` and
similar variables are ignored on purpose, and the error says so rather than quietly using them.

This is enforced twice: on load, from the stored `app_actor` flag, and against the API by `whoami`,
which checks `viewer.app` rather than trusting local state.

## Scopes

`read`, `write`, `app:assignable`, `app:mentionable`. Not `admin` — an app actor cannot request it.

Do not change the requested scope set by hand. Linear treats a different set as a new authorization
and **revokes every existing app token for the application**, including those on your other
machines. The CLI stores the granted scopes in one canonical form and resends exactly that set on
renewal, so this cannot happen by accident.

## Installing without running scripts

Installing from the npm registry runs no lifecycle scripts: the package ships prebuilt and declares
no `preinstall`, `install` or `postinstall`. You can verify that rather than take it on faith:

```bash
npm install -g --ignore-scripts linear-agent
```

CI runs exactly this on every push, including a check that the CLI refuses to do anything without
credentials. Published tarballs carry [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
which attests which commit and workflow produced them.

Installing from a git clone *does* run a build (`prepare` → `tsc`). That is the normal thing for
source checkouts, and it is the reason to prefer the registry if you would rather not run a build
script from a stranger.

## Untrusted input

Issue and comment text is written by anyone with access to the workspace. It is treated as data: the
CLI transports it verbatim and never interpolates it into a shell command. Human-readable output
strips terminal control characters so hostile text cannot repaint your terminal; `--json` output is
byte-exact for programs to parse.

## Dependencies

One runtime dependency: `@linear/sdk`. That is the whole supply chain.

## Reporting a vulnerability

Open a [security advisory](https://github.com/asamagaio/linear-agent/security/advisories/new) rather
than a public issue. This is a personal project with no SLA, but reports will be read.
