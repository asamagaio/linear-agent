import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { waitForPortFree } from "./helpers.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "dist", "index.js");

const FAKE_TOKEN = "lin_oauth_FAKE_TOKEN_THAT_MUST_NEVER_BE_PRINTED_0123456789";

function freshConfig() {
  const dir = mkdtempSync(join(tmpdir(), "linear-agent-test-"));
  return dir;
}

/**
 * Always runs against an isolated config dir with the file store forced, so a
 * test can never read or disturb the operator's real Keychain entry.
 */
function run(argv, { config, env = {}, stdin = "" } = {}) {
  const configHome = config ?? freshConfig();
  const childEnv = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    LINEAR_AGENT_CREDENTIALS_STORE: "file",
  };
  // Drop any real personal credentials inherited from the shell.
  for (const key of [
    "LINEAR_API_KEY",
    "LINEAR_API_TOKEN",
    "LINEAR_ACCESS_TOKEN",
    "LINEAR_PERSONAL_API_KEY",
  ]) {
    delete childEnv[key];
  }
  Object.assign(childEnv, env);

  const result = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8",
    env: childEnv,
    input: stdin,
    timeout: 20_000,
  });
  return { ...result, configHome };
}

function writeCredentials(configHome, overrides = {}) {
  const dir = join(configHome, "linear-agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({
      version: 1,
      access_token: FAKE_TOKEN,
      app_user_id: "app-user-uuid",
      app_name: "Test Agent",
      workspace_id: "workspace-uuid",
      workspace_name: "Test Workspace",
      workspace_url_key: "test",
      app_actor: true,
      scopes: "read,write,app:assignable,app:mentionable",
      created_at: "2026-08-10T12:00:00.000Z",
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return configHome;
}

/* -------------------------------------------------------------------------- */
/* Basics                                                                      */
/* -------------------------------------------------------------------------- */

test("--help exits 0 and documents the commands", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  for (const command of ["whoami", "list", "read", "comment", "status", "create"]) {
    assert.match(r.stdout, new RegExp(`linear-agent ${command}`));
  }
});

test("an unknown command is a usage error (exit 2)", () => {
  const r = run(["frobnicate"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown command "frobnicate"/);
});

test("an unknown flag is a usage error (exit 2)", () => {
  const r = run(["list", "--everything"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown option --everything/);
});

/* -------------------------------------------------------------------------- */
/* The invariant: no app token means loud failure, never a fallback            */
/* -------------------------------------------------------------------------- */

test("with no credentials, every command fails with exit 3", () => {
  for (const argv of [
    ["whoami"],
    ["list"],
    ["list", "--label", "bug"],
    ["read", "ENG-42"],
    ["comment", "ENG-42", "hello"],
    ["status", "ENG-42", "In Progress"],
    ["create", "--team", "ENG", "--title", "T"],
    ["auth", "--status"],
  ]) {
    const r = run(argv);
    assert.equal(r.status, 3, `${argv.join(" ")} -> ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /No Linear app credentials found/);
    assert.equal(r.stdout, "", "nothing should be written to stdout on failure");
  }
});

test("a personal API key in the environment is named and ignored, never used", () => {
  const r = run(["whoami"], { env: { LINEAR_API_KEY: "lin_api_personal_key_value" } });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /LINEAR_API_KEY/);
  assert.match(r.stderr, /ignored on purpose/);
  assert.match(r.stderr, /would make every comment appear as you/);
});

test("corrupt credentials fail explicitly rather than silently", () => {
  const config = freshConfig();
  mkdirSync(join(config, "linear-agent"), { recursive: true });
  writeFileSync(join(config, "linear-agent", "credentials.json"), "{not json");

  const r = run(["whoami"], { config });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /corrupt/);
  assert.match(r.stderr, /linear-agent auth/);
});

test("credentials missing an identity field fail explicitly", () => {
  const config = writeCredentials(freshConfig(), { app_user_id: undefined });
  const r = run(["whoami"], { config });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /incomplete/);
  assert.match(r.stderr, /app_user_id/);
});

test("a removed token fails explicitly, with no fallback", () => {
  // Metadata still describes an authorized app, but the secret is gone —
  // acceptance criterion 6.
  const config = writeCredentials(freshConfig(), { access_token: undefined });
  const r = run(["whoami"], { config });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no access token/);
  assert.match(r.stderr, /linear-agent auth/);
});

test("a non-app-actor token is refused before any request is made", () => {
  const config = writeCredentials(freshConfig(), { app_actor: false });
  const r = run(["comment", "ENG-42", "hello"], { config });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not an app-actor token/);
  assert.match(r.stderr, /never as a person/);
});

/* -------------------------------------------------------------------------- */
/* Token secrecy                                                               */
/* -------------------------------------------------------------------------- */

test("auth --status reports the identity but never the token", () => {
  const config = writeCredentials(freshConfig());

  const human = run(["auth", "--status"], { config });
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Test Agent/);
  assert.match(human.stdout, /app-user-uuid/);
  assert.match(human.stdout, /Test Workspace/);
  assert.ok(!human.stdout.includes(FAKE_TOKEN), "token leaked to stdout");
  assert.ok(!human.stderr.includes(FAKE_TOKEN), "token leaked to stderr");

  const json = run(["auth", "--status", "--json"], { config });
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.actor, "app");
  assert.equal(parsed.app_user_id, "app-user-uuid");
  assert.ok(!json.stdout.includes(FAKE_TOKEN), "token leaked into --json output");
  assert.ok(
    !JSON.stringify(parsed).includes("lin_oauth"),
    "no token-shaped value should appear anywhere in the payload",
  );
});

/* -------------------------------------------------------------------------- */
/* Argument validation happens before any network call                         */
/* -------------------------------------------------------------------------- */

test("a malformed identifier is a usage error, not a request", () => {
  const config = writeCredentials(freshConfig());
  const r = run(["read", "NOT-AN-ID-XX"], { config });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a Linear issue identifier/);
});

test("an empty comment body is rejected without contacting Linear", () => {
  const config = writeCredentials(freshConfig());
  const r = run(["comment", "ENG-42", "-"], { config, stdin: "   \n" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /comment body is empty/);
});

test("create requires --team and --title", () => {
  const config = writeCredentials(freshConfig());
  assert.match(run(["create", "--title", "T"], { config }).stderr, /--team is required/);
  assert.equal(run(["create", "--title", "T"], { config }).status, 2);
  assert.match(run(["create", "--team", "ENG"], { config }).stderr, /--title is required/);
});

test("status requires a target state name", () => {
  const config = writeCredentials(freshConfig());
  const r = run(["status", "ENG-42"], { config });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Missing target workflow state/);
});

/* -------------------------------------------------------------------------- */
/* Nothing is left running                                                     */
/* -------------------------------------------------------------------------- */

test("commands exit promptly and leave no listener on port 8787", async () => {
  const config = writeCredentials(freshConfig());

  const started = Date.now();
  run(["read", "NOT-AN-ID-XX"], { config });
  run(["auth", "--status"], { config });
  run(["--help"]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15_000, `commands took ${elapsed}ms — something is hanging`);

  assert.ok(await waitForPortFree(8787), "something is still listening on 8787");
});

test("auth --logout clears the stored credentials", () => {
  const config = writeCredentials(freshConfig());
  const out = run(["auth", "--logout", "--json"], { config });
  assert.equal(out.status, 0);
  assert.deepEqual(JSON.parse(out.stdout).cleared, ["file"]);

  const after = run(["auth", "--status"], { config });
  assert.equal(after.status, 3, "credentials should be gone after logout");
});

/* -------------------------------------------------------------------------- */
/* Keychain (opt-in: it writes to the real login keychain)                      */
/* -------------------------------------------------------------------------- */

test(
  "keychain round-trips a token without truncating it",
  {
    skip:
      process.env.LINEAR_AGENT_TEST_KEYCHAIN === "1" && process.platform === "darwin"
        ? false
        : "set LINEAR_AGENT_TEST_KEYCHAIN=1 on macOS to run (writes to the login keychain)",
  },
  async () => {
    const creds = await import("../dist/creds.js");
    const existing = spawnSync(
      "security",
      ["find-generic-password", "-s", "linear-agent", "-a", "default", "-w"],
      { encoding: "utf8" },
    );
    assert.notEqual(
      existing.status,
      0,
      "refusing to run: a real linear-agent keychain entry exists",
    );

    // `security` truncates a prompted secret at 128 bytes; both sides of that
    // boundary must survive the round trip.
    for (const length of [80, 400]) {
      const token = `lin_oauth_${"a".repeat(length)}`;
      const where = creds.saveCredentials({
        version: 1,
        access_token: token,
        app_user_id: "kc-user",
        app_name: "KC Probe",
        workspace_id: "kc-ws",
        workspace_name: "KC",
        workspace_url_key: "kc",
        app_actor: true,
        scopes: "read",
        created_at: "2026-08-10T00:00:00.000Z",
      });
      assert.equal(where, "keychain", `token of ${token.length} bytes did not reach the keychain`);

      const loaded = creds.loadCredentials();
      assert.equal(loaded.source, "keychain");
      assert.equal(loaded.credentials.access_token, token, "token was truncated");

      const onDisk = readFileSync(join(creds.configDir(), "credentials.json"), "utf8");
      assert.ok(!onDisk.includes(token), "token must not be written to the config file");

      creds.clearCredentials();
    }
  },
);

test.after(() => {
  // Temp config dirs are created per-run; clean up the ones we can find.
  rmSync(join(tmpdir(), "linear-agent-test-noop"), { recursive: true, force: true });
});
