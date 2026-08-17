import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "dist", "index.js");
const CALLBACK = "http://127.0.0.1:8787/callback";

function startAuth() {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "linear-agent-auth-")),
    LINEAR_AGENT_CREDENTIALS_STORE: "file",
    // Keep the flow from opening a real browser window during the test.
    PATH: "/nonexistent",
  };
  // --browser explicitly: the default is now the client-credentials grant,
  // which needs no browser at all. Everything below is about the fallback that
  // still exists for an app without that grant enabled.
  const child = spawn(process.execPath, [CLI, "auth", "--browser", "--client-id", "cid", "--client-secret", "csecret"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const exited = new Promise((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );

  return {
    child,
    exited,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

/** Wait for the authorize URL to be printed, and pull the state out of it. */
async function waitForAuthorizeUrl(session, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = /https:\/\/linear\.app\/oauth\/authorize\?[^\s]+/.exec(session.stdout);
    if (match) return new URL(match[0]);
    await delay(50);
  }
  throw new Error(`authorize URL never appeared. stdout:\n${session.stdout}`);
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.text() };
}

function portIsFree() {
  const lsof = spawnSync("lsof", ["-nP", "-iTCP:8787"], { encoding: "utf8" });
  return (lsof.stdout ?? "").trim() === "";
}

test("the authorize URL carries actor=app and the agent scopes", async () => {
  const session = startAuth();
  try {
    const url = await waitForAuthorizeUrl(session);

    assert.equal(url.searchParams.get("actor"), "app", "actor=app is the whole point");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), "cid");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "http://localhost:8787/callback",
    );

    const scopes = (url.searchParams.get("scope") ?? "").split(",");
    for (const scope of ["read", "write", "app:assignable", "app:mentionable"]) {
      assert.ok(scopes.includes(scope), `missing scope ${scope}`);
    }
    assert.ok(!scopes.includes("admin"), "apps using actor=app cannot request admin");

    const state = url.searchParams.get("state") ?? "";
    assert.ok(state.length >= 32, "state should be long and random");

    // The client secret must never be printed.
    assert.ok(!session.stdout.includes("csecret"));
    assert.ok(!session.stderr.includes("csecret"));
  } finally {
    session.child.kill("SIGKILL");
    await session.exited;
  }
});

test("the callback listener rejects a mismatched state and keeps waiting", async () => {
  const session = startAuth();
  try {
    await waitForAuthorizeUrl(session);

    const wrong = await get(`${CALLBACK}?code=abc&state=not-the-right-state`);
    assert.equal(wrong.status, 400);
    assert.match(wrong.body, /State parameter did not match/);

    // A forged callback must not end the flow.
    await delay(200);
    assert.equal(session.child.exitCode, null, "process exited on a bad state");

    const notFound = await get("http://127.0.0.1:8787/somewhere-else");
    assert.equal(notFound.status, 404);
  } finally {
    session.child.kill("SIGKILL");
    await session.exited;
  }
});

test("a denied authorization exits non-zero and frees the port", async () => {
  const session = startAuth();
  const url = await waitForAuthorizeUrl(session);
  const state = url.searchParams.get("state");

  const denied = await get(
    `${CALLBACK}?error=access_denied&error_description=The+user+said+no&state=${encodeURIComponent(state)}`,
  );
  assert.equal(denied.status, 400);
  assert.match(denied.body, /The user said no/);

  const code = await session.exited;
  assert.notEqual(code, 0, "a denied authorization must not exit 0");
  assert.match(session.stderr, /OAuth error/);
  assert.match(session.stderr, /The user said no/);

  // Acceptance criterion 7: nothing left running, no open port.
  await delay(250);
  assert.ok(portIsFree(), "port 8787 is still held after the command exited");
});

test("nothing stores credentials when authorization does not complete", async () => {
  const session = startAuth();
  const url = await waitForAuthorizeUrl(session);
  const state = url.searchParams.get("state");
  await get(`${CALLBACK}?error=access_denied&state=${encodeURIComponent(state)}`);
  await session.exited;

  assert.ok(!session.stdout.includes("Authorized"), "must not claim success");
  assert.ok(portIsFree());
});
