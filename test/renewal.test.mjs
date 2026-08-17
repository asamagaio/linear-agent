import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withRetry, renew } from "../dist/client.js";
import { loadCredentials } from "../dist/creds.js";

/* -------------------------------------------------------------------------- */
/* The trigger                                                                 */
/*                                                                             */
/* `withRetry` translates before it rethrows, so what reaches the renewal is a  */
/* CredentialError, never the SDK error with `.status`. A renewal that checked  */
/* the raw status would look wired up and never once fire — and nobody would    */
/* find out for thirty days. These two pin the flag it actually keys off.       */
/* -------------------------------------------------------------------------- */

/** Shaped like the error @linear/sdk throws for an expired token. */
function unauthorized() {
  return Object.assign(new Error("Authentication required"), {
    type: "AuthenticationError",
    status: 401,
  });
}

/** A missing scope. Also a credential problem — but NOT one a new token fixes. */
function forbidden() {
  return Object.assign(new Error("Access denied"), {
    type: "Forbidden",
    status: 403,
  });
}

test("a 401 arrives at the renewal marked expired", async () => {
  await assert.rejects(
    withRetry(async () => {
      throw unauthorized();
    }),
    (error) => {
      assert.equal(error.name, "CredentialError");
      assert.equal(error.code, 3, "a credential problem must exit 3");
      assert.equal(error.expired, true, "a 401 is what renewal keys off");
      return true;
    },
  );
});

test("a 403 is a credential error but is NOT treated as expired", async () => {
  await assert.rejects(
    withRetry(async () => {
      throw forbidden();
    }),
    (error) => {
      assert.equal(error.name, "CredentialError");
      assert.equal(
        error.expired,
        false,
        "a new token with the same scopes would be refused identically",
      );
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* The renewal itself                                                          */
/* -------------------------------------------------------------------------- */

const CREDENTIALS = {
  version: 1,
  access_token: "lin_oauth_old",
  app_user_id: "user-1",
  app_name: "Claude CLI",
  workspace_id: "ws-1",
  workspace_name: "Acme",
  workspace_url_key: "acme",
  app_actor: true,
  scopes: "read,write,app:assignable",
  created_at: "2026-07-14T00:00:00.000Z",
  grant: "client_credentials",
  client_id: "client-abc",
  client_secret: "secret-xyz",
};

/** Isolate the credential store: a temp XDG dir, plain file, no keychain. */
function isolateStore() {
  const home = mkdtempSync(join(tmpdir(), "linear-agent-renewal-"));
  mkdirSync(join(home, "linear-agent"), { recursive: true });
  process.env["XDG_CONFIG_HOME"] = home;
  process.env["LINEAR_AGENT_CREDENTIALS_STORE"] = "file";
  return home;
}

test("a browser-flow credential cannot renew itself, and does not try", async () => {
  const fetched = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetched.push(args);
    throw new Error("a browser-flow credential must not reach the network");
  };
  try {
    const token = await renew({ ...CREDENTIALS, grant: "authorization_code" });
    assert.equal(token, undefined);
    assert.equal(fetched.length, 0);

    // Nor one saved before renewal existed, which has no grant recorded at all.
    const legacy = { ...CREDENTIALS };
    delete legacy.grant;
    assert.equal(await renew(legacy), undefined);
    assert.equal(fetched.length, 0);
  } finally {
    globalThis.fetch = real;
  }
});

test("renewal asks for the SAME scopes and keeps the new token", async () => {
  isolateStore();

  let sent;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), body: new URLSearchParams(init.body) };
    return new Response(
      JSON.stringify({ access_token: "lin_oauth_new", expires_in: 2592000 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  let token;
  try {
    token = await renew(CREDENTIALS);
  } finally {
    globalThis.fetch = real;
  }

  assert.equal(token, "lin_oauth_new");
  assert.equal(sent.url, "https://api.linear.app/oauth/token");
  assert.equal(sent.body.get("grant_type"), "client_credentials");
  assert.equal(sent.body.get("client_id"), "client-abc");
  // Widening this set revokes every existing app-actor token for the app.
  assert.equal(sent.body.get("scope"), CREDENTIALS.scopes);

  // The renewed token is stored, along with everything needed to renew AGAIN —
  // a renewal that dropped the client id would work exactly once.
  const { credentials } = loadCredentials();
  assert.equal(credentials.access_token, "lin_oauth_new");
  assert.equal(credentials.grant, "client_credentials");
  assert.equal(credentials.client_id, "client-abc");
  assert.equal(credentials.client_secret, "secret-xyz");
  assert.equal(credentials.scopes, CREDENTIALS.scopes);
  assert.ok(credentials.expires_at, "an expiry is recorded for `auth --status`");
});

/* -------------------------------------------------------------------------- */
/* Scope drift                                                                 */
/*                                                                             */
/* What gets stored is what renewal resends thirty days later. Linear reads a   */
/* different scope SET as a new authorization and revokes every existing        */
/* app-actor token — so a separator Linear happened to echo back must never be  */
/* able to read as a change.                                                    */
/* -------------------------------------------------------------------------- */

test("scopes are canonicalised, whatever separator Linear echoes", async () => {
  const { canonicalScopes } = await import("../dist/commands/auth.js");
  const expected = "read,write,app:assignable,app:mentionable";

  assert.equal(canonicalScopes("read,write,app:assignable,app:mentionable"), expected);
  assert.equal(canonicalScopes("read write app:assignable app:mentionable"), expected);
  assert.equal(canonicalScopes("read, write,  app:assignable , app:mentionable"), expected);

  // An absent or empty scope falls back to what the CLI asks for, never to "".
  assert.equal(canonicalScopes(undefined), expected);
  assert.equal(canonicalScopes("   "), expected);

  // A genuinely narrower grant is preserved — only the spelling is pinned.
  assert.equal(canonicalScopes("read write"), "read,write");
});
