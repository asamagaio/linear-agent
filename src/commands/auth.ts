import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { rawWithToken } from "../client.js";
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from "../creds.js";
import {
  ApiError,
  CliError,
  CredentialError,
  EXIT,
  UsageError,
  registerSecret,
} from "../errors.js";
import { WHOAMI, type GqlOrganization, type GqlViewer } from "../gql.js";
import { emitJson, line } from "../output.js";
import { getValue, type ParsedArgs } from "../args.js";

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const REDIRECT_URI = "http://localhost:8787/callback";
const CALLBACK_PATH = "/callback";
const PORT = 8787;
const LOOPBACK_V4 = "127.0.0.1";
const LOOPBACK_V6 = "::1";

/**
 * `actor=app` is the whole point: it installs the integration as its own app
 * user, so everything the CLI writes is attributed to the app rather than to
 * the human who authorized it.
 */
const SCOPES = ["read", "write", "app:assignable", "app:mentionable"] as const;

const WAIT_TIMEOUT_MS = 5 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Ask Linear for an app-actor token with nothing but the app's own credentials.
 *
 * This is the flow the CLI wants and did not use. The browser flow issues a
 * token that lasts a day, paired with a refresh token this CLI never stored —
 * so it asked a person to re-authorize roughly daily. `client_credentials`
 * needs no browser and no person, and the token lasts 30 days.
 *
 * SCOPES MUST NOT DRIFT: Linear revokes every existing app-actor token for the
 * app when one is requested with a different scope set. A renewal that quietly
 * asked for one extra scope would log the app out of itself.
 *
 * Exported because renewal happens in `client.ts`, on a 401 — the documented
 * way to notice this token has expired, since it carries no refresh token.
 */
/**
 * Store scopes in ONE canonical form, whatever Linear echoed back.
 *
 * Renewal resends this string, and Linear treats a different scope set as a
 * new authorization — it revokes every existing app-actor token for the app.
 * Linear's authorize URL is comma-separated, but nothing promises the token
 * response uses the same separator, and "read write" vs "read,write" must not
 * be allowed to read as a change. The SET is preserved exactly; only the
 * spelling is pinned.
 */
export function canonicalScopes(scope: string | undefined): string {
  const parts = (scope ?? "").split(/[\s,]+/).filter((part) => part !== "");
  return parts.length > 0 ? parts.join(",") : SCOPES.join(",");
}

export async function fetchAppToken(
  clientId: string,
  clientSecret: string,
  scope: string = SCOPES.join(","),
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(
      `Client-credentials token request failed (HTTP ${response.status}): ${text.slice(0, 500)}`,
      "The most likely cause is that the client credentials grant is not " +
        "enabled on the Linear application. Turn it on in Edit application at " +
        "https://linear.app/settings/api/applications, or authorize through " +
        "the browser instead with `linear-agent auth --browser`.",
    );
  }

  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new ApiError(
      "Linear returned a token response that is not JSON.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Callback listener                                                           */
/* -------------------------------------------------------------------------- */

interface CallbackResult {
  code: string;
}

function htmlPage(title: string, detail: string): string {
  const escape = (text: string) =>
    text.replace(/[&<>"]/g, (ch) =>
      ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;",
    );
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:34rem;margin:6rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">${escape(title)}</h1>
<p>${escape(detail)}</p>
</body>`;
}

/**
 * Listen for exactly one OAuth redirect, then stop. Binds 127.0.0.1 (required)
 * and additionally ::1 when available, because a browser resolving `localhost`
 * may pick either loopback address.
 */
function waitForCallback(expectedState: string): {
  result: Promise<CallbackResult>;
  shutdown: () => Promise<void>;
} {
  const servers: Server[] = [];
  let settled = false;
  let resolveResult!: (value: CallbackResult) => void;
  let rejectResult!: (error: Error) => void;

  const result = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectResult(
      new CliError(
        "Timed out waiting for the Linear authorization redirect (5 minutes).",
        EXIT.GENERIC,
        "Re-run `linear-agent auth` and complete the approval in the browser.",
      ),
    );
  }, WAIT_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found\n");
      return;
    }

    const finish = (status: number, title: string, detail: string): void => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(htmlPage(title, detail));
    };

    if (settled) {
      finish(200, "Already handled", "You can close this tab.");
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      settled = true;
      clearTimeout(timer);
      const description = url.searchParams.get("error_description") ?? error;
      finish(400, "Authorization failed", description);
      rejectResult(new CliError(`Linear returned an OAuth error: ${description}`));
      return;
    }

    const state = url.searchParams.get("state") ?? "";
    if (!safeEqual(state, expectedState)) {
      // Do not settle: a mismatched state is someone else's request, not ours.
      finish(400, "Authorization failed", "State parameter did not match.");
      return;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      settled = true;
      clearTimeout(timer);
      finish(400, "Authorization failed", "No authorization code was returned.");
      rejectResult(new CliError("Linear did not return an authorization code."));
      return;
    }

    settled = true;
    clearTimeout(timer);
    finish(
      200,
      "linear-agent is authorized",
      "The agent identity is set up. You can close this tab and return to the terminal.",
    );
    resolveResult({ code });
  };

  const listen = (host: string, required: boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      const server = createServer(handler);
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (!required) {
          resolve();
          return;
        }
        if (err.code === "EADDRINUSE") {
          reject(
            new CliError(
              `Port ${PORT} on ${host} is already in use.`,
              EXIT.GENERIC,
              "Another linear-agent auth run may still be open, or another " +
                "process holds the port. Close it and try again.",
            ),
          );
          return;
        }
        reject(err);
      });
      server.listen(PORT, host, () => {
        servers.push(server);
        resolve();
      });
    });

  const shutdown = async (): Promise<void> => {
    clearTimeout(timer);
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            // Drop keep-alive sockets so nothing holds the port or the process.
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      ),
    );
    servers.length = 0;
  };

  const ready = listen(LOOPBACK_V4, true).then(() => listen(LOOPBACK_V6, false));

  return {
    result: ready.then(() => result),
    shutdown,
  };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* -------------------------------------------------------------------------- */
/* Browser                                                                     */
/* -------------------------------------------------------------------------- */

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {
      /* The URL is always printed too, so a failure here is not fatal. */
    });
    child.unref();
  } catch {
    /* Ignore — the operator can open the printed URL manually. */
  }
}

/* -------------------------------------------------------------------------- */
/* Token exchange                                                              */
/* -------------------------------------------------------------------------- */

async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(
      `Token exchange failed (HTTP ${response.status}): ${text.slice(0, 500)}`,
      "Check that the client id and secret match the Linear application, and " +
        `that its redirect URI is exactly ${REDIRECT_URI}.`,
    );
  }

  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new ApiError("Token exchange returned a response that was not JSON.");
  }

  if (!parsed.access_token) {
    throw new ApiError("Token exchange succeeded but returned no access token.");
  }

  registerSecret(parsed.access_token);
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

function credentialSummary(credentials: Credentials, source: string) {
  return {
    app_name: credentials.app_name,
    app_user_id: credentials.app_user_id,
    workspace: credentials.workspace_name,
    workspace_id: credentials.workspace_id,
    workspace_url_key: credentials.workspace_url_key,
    scopes: credentials.scopes,
    authorized_at: credentials.created_at,
    actor: "app" as const,
    credential_store: source,
    // The question `auth --status` exists to answer is "will this ask me to log
    // in again?". A client-credentials token renews itself on the 401; anything
    // else needs a person and a browser, and should say so BEFORE it expires.
    grant: credentials.grant ?? "authorization_code",
    renews: credentials.grant === "client_credentials",
    expires_at: credentials.expires_at,
  };
}

function printStatus(summary: ReturnType<typeof credentialSummary>): void {
  line(`App name:      ${summary.app_name}`);
  line(`App user ID:   ${summary.app_user_id}`);
  line(`Workspace:     ${summary.workspace} (${summary.workspace_id})`);
  if (summary.scopes) line(`Scopes:        ${summary.scopes}`);
  if (summary.authorized_at) line(`Authorized:    ${summary.authorized_at}`);
  line(`Actor type:    app`);
  if (summary.renews) {
    const until = summary.expires_at ? ` (this one until ${summary.expires_at})` : "";
    line(`Renewal:       automatic${until}`);
  } else {
    line(`Renewal:       MANUAL — this token came from the browser flow, lasts`);
    line(`               about a day, and cannot renew itself. Re-run`);
    line(`               \`linear-agent auth\` with the client id and secret to`);
    line(`               switch to the self-renewing grant.`);
  }
  line(`Stored in:     ${summary.credential_store}`);
  line();
  line("The access token is never printed.");
}

async function authStatus(json: boolean): Promise<void> {
  const { credentials, source } = loadCredentials();
  const summary = credentialSummary(credentials, source);
  if (json) emitJson(summary);
  else printStatus(summary);
}

function authLogout(json: boolean): void {
  const cleared = clearCredentials();
  if (json) {
    emitJson({ cleared });
    return;
  }
  if (cleared.length === 0) line("No stored credentials to remove.");
  else line(`Removed stored credentials from: ${cleared.join(", ")}`);
}

async function runClientCredentials(
  clientId: string,
  clientSecret: string,
  json: boolean,
): Promise<void> {
  if (!json) line("Requesting an app token (no browser needed)...");

  const token = await fetchAppToken(clientId, clientSecret);

  // The SAME invariant the browser flow enforces, for the same reason: a token
  // that authenticates as a person would put that person's name on every
  // comment the agent writes.
  const identity = await rawWithToken<{
    viewer: GqlViewer;
    organization: GqlOrganization;
  }>(token.access_token, WHOAMI);

  if (identity.viewer.app !== true) {
    throw new CredentialError(
      `The client credentials grant produced a token for "${identity.viewer.name}", not an app token.`,
      "Nothing was stored. Check that the Linear application is a workspace " +
        "application rather than a personal integration.",
    );
  }

  const credentials: Credentials = {
    version: 1,
    access_token: token.access_token,
    app_user_id: identity.viewer.id,
    app_name: identity.viewer.displayName || identity.viewer.name,
    workspace_id: identity.organization.id,
    workspace_name: identity.organization.name,
    workspace_url_key: identity.organization.urlKey,
    app_actor: true,
    scopes: canonicalScopes(token.scope),
    created_at: new Date().toISOString(),
    grant: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    ...(token.expires_in
      ? { expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString() }
      : {}),
  };

  const source = saveCredentials(credentials);
  const summary = credentialSummary(credentials, source);

  if (json) {
    emitJson({ authorized: true, ...summary });
    return;
  }
  line(`Authorized as ${credentials.app_name} in ${credentials.workspace_name}.`);
  line(`Token stored in the ${source}.`);
  if (credentials.expires_at) {
    line(`It expires ${credentials.expires_at.slice(0, 10)} — and renews itself.`);
  }
}

async function runOAuth(args: ParsedArgs, json: boolean): Promise<void> {
  const clientId =
    getValue(args, "client-id") ?? process.env["LINEAR_CLIENT_ID"] ?? "";
  const clientSecret =
    getValue(args, "client-secret") ?? process.env["LINEAR_CLIENT_SECRET"] ?? "";

  if (!clientId || !clientSecret) {
    throw new UsageError(
      "Both a client id and a client secret are required.",
      "Pass --client-id and --client-secret, or set LINEAR_CLIENT_ID and " +
        "LINEAR_CLIENT_SECRET. Create the application at " +
        "https://linear.app/settings/api/applications/new with redirect URI " +
        `${REDIRECT_URI} and webhooks left disabled.`,
    );
  }
  registerSecret(clientSecret);

  // The default, because it is the one that does not come back tomorrow.
  // `--browser` is the old authorization_code flow, kept for an app that has
  // not enabled the grant — and named in the error when the grant is refused,
  // so the way out is in the message rather than in somebody's memory.
  if (!args.booleans.has("browser")) {
    await runClientCredentials(clientId, clientSecret, json);
    return;
  }

  const state = randomBytes(32).toString("base64url");
  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", SCOPES.join(","));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("actor", "app");
  authorizeUrl.searchParams.set("prompt", "consent");

  const listener = waitForCallback(state);

  let token: TokenResponse;
  try {
    if (!json) {
      line("Opening Linear to authorize the app...");
      line();
      line(authorizeUrl.toString());
      line();
      line("Waiting for the redirect (Ctrl-C to abort).");
    }
    openBrowser(authorizeUrl.toString());

    const { code } = await listener.result;
    token = await exchangeCode(code, clientId, clientSecret);
  } finally {
    await listener.shutdown();
  }

  // Establish who the token belongs to, and refuse to store it unless it is
  // genuinely an app actor.
  const identity = await rawWithToken<{
    viewer: GqlViewer;
    organization: GqlOrganization;
  }>(token.access_token, WHOAMI);

  if (identity.viewer.app !== true) {
    throw new CredentialError(
      `Authorization produced a user token for "${identity.viewer.name}", not an app token.`,
      "Nothing was stored. Comments from a user token would appear as you " +
        "rather than as the agent. Make sure the authorize URL carries " +
        "actor=app, and that the Linear application is not installed as a " +
        "personal integration.",
    );
  }

  const credentials: Credentials = {
    version: 1,
    access_token: token.access_token,
    app_user_id: identity.viewer.id,
    app_name: identity.viewer.displayName || identity.viewer.name,
    workspace_id: identity.organization.id,
    workspace_name: identity.organization.name,
    workspace_url_key: identity.organization.urlKey,
    app_actor: true,
    scopes: canonicalScopes(token.scope),
    created_at: new Date().toISOString(),
  };

  const source = saveCredentials(credentials);
  const summary = credentialSummary(credentials, source);

  if (json) {
    emitJson({ authorized: true, ...summary });
    return;
  }

  line();
  line("Authorized.");
  line();
  printStatus(summary);
}

export async function authCommand(args: ParsedArgs, json: boolean): Promise<void> {
  if (args.booleans.has("status")) {
    await authStatus(json);
    return;
  }
  if (args.booleans.has("logout")) {
    authLogout(json);
    return;
  }
  await runOAuth(args, json);
}

export const AUTH_FLAGS = {
  value: ["client-id", "client-secret"],
  boolean: ["status", "logout", "browser"],
} as const;
