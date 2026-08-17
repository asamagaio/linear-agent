import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { CredentialError, registerSecret } from "./errors.js";

const KEYCHAIN_SERVICE = "linear-agent";
const KEYCHAIN_ACCOUNT = "default";
/**
 * The client secret lives in its own Keychain item, beside the token.
 *
 * It is here at all because a token that cannot be renewed is a token somebody
 * re-authorizes through a browser every day. `client_credentials` renews with
 * nothing but the app's own id and secret — so the CLI must hold them, or the
 * renewal it is capable of is one it can never perform.
 */
const KEYCHAIN_CLIENT_ACCOUNT = "client-secret";
const KEYCHAIN_LABEL = "linear-agent (Linear app actor token)";
const KEYCHAIN_CLIENT_LABEL = "linear-agent (Linear OAuth client secret)";

/**
 * `security` reads an interactively-prompted password through a 128 byte
 * buffer and silently truncates anything longer. Tokens are well under that,
 * but the limit is why only the token — never the whole credential blob — goes
 * through the stdin path.
 */
const KEYCHAIN_STDIN_LIMIT = 128;

/**
 * Environment variables that hold *personal* Linear credentials. The CLI must
 * never authenticate with one of these: a personal key makes every comment
 * appear as the human operator, which defeats the point of the tool. They are
 * listed here only so the error message can say explicitly that we saw one and
 * deliberately ignored it.
 */
const IGNORED_PERSONAL_CREDENTIAL_ENV = [
  "LINEAR_API_KEY",
  "LINEAR_API_TOKEN",
  "LINEAR_ACCESS_TOKEN",
  "LINEAR_PERSONAL_API_KEY",
] as const;

export interface Credentials {
  version: 1;
  access_token: string;
  /** The app's user id in this workspace — its identity as an actor. */
  app_user_id: string;
  app_name: string;
  workspace_id: string;
  workspace_name: string;
  workspace_url_key: string;
  /**
   * Verified at auth time by checking `viewer.app === true`. Stored so that
   * every later command can enforce the app-actor invariant without spending an
   * extra API round trip.
   */
  app_actor: true;
  scopes: string;
  created_at: string;

  /**
   * How this token was obtained, and — for `client_credentials` — everything
   * needed to obtain the next one without a human.
   *
   * The authorization_code flow gives a token that lasts a day and a refresh
   * token this CLI never stored, so it re-authorized through a browser roughly
   * daily. `client_credentials` gives a 30-day app-actor token that is renewed
   * by asking again with the app's own id and secret. Absent on credentials
   * saved before this existed, which simply cannot self-renew — the same
   * behaviour they had.
   */
  grant?: "authorization_code" | "client_credentials";
  client_id?: string;
  client_secret?: string;
  /** ISO 8601. Advisory: the 401 is what actually triggers a renewal. */
  expires_at?: string;
}

export type CredentialSource = "keychain" | "file";

export interface LoadedCredentials {
  credentials: Credentials;
  /** Where the *token* came from. Metadata always lives in the config file. */
  source: CredentialSource;
}

export function configDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config");
  return join(base, "linear-agent");
}

export function credentialsFilePath(): string {
  return join(configDir(), "credentials.json");
}

/* -------------------------------------------------------------------------- */
/* Keychain                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The Keychain is the primary store for the token on macOS.
 * `LINEAR_AGENT_CREDENTIALS_STORE=file` forces the file fallback — useful on
 * non-macOS hosts and in tests, and safe: the file store enforces exactly the
 * same app-actor invariant.
 */
function keychainAvailable(): boolean {
  if (process.env["LINEAR_AGENT_CREDENTIALS_STORE"] === "file") return false;
  return process.platform === "darwin";
}

function keychainRead(account: string = KEYCHAIN_ACCOUNT): string | undefined {
  if (!keychainAvailable()) return undefined;
  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  const value = (result.stdout ?? "").trim();
  return value === "" ? undefined : value;
}

function keychainDelete(account: string = KEYCHAIN_ACCOUNT): boolean {
  if (!keychainAvailable()) return false;
  const result = spawnSync(
    "security",
    ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

function keychainAdd(
  token: string,
  viaArgv: boolean,
  account: string = KEYCHAIN_ACCOUNT,
  label: string = KEYCHAIN_LABEL,
): boolean {
  const args = [
    "add-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    account,
    "-l",
    label,
    "-D",
    "application password",
    "-w",
  ];
  // Without a value, `-w` prompts and reads the secret from stdin (twice), so
  // the token never appears in the process table. Only fall back to passing it
  // on argv when the token is too long for that path.
  if (viaArgv) args.push(token);

  const result = spawnSync("security", args, {
    input: viaArgv ? undefined : `${token}\n${token}\n`,
    encoding: "utf8",
    stdio: viaArgv ? "ignore" : undefined,
  });
  return result.status === 0;
}

/** Store a secret. Returns false if the Keychain could not take it verbatim. */
function keychainWrite(
  token: string,
  account: string = KEYCHAIN_ACCOUNT,
  label: string = KEYCHAIN_LABEL,
): boolean {
  if (!keychainAvailable()) return false;

  // `add-generic-password` will not overwrite, so clear any previous entry.
  keychainDelete(account);

  const viaArgv = token.length > KEYCHAIN_STDIN_LIMIT;
  if (!keychainAdd(token, viaArgv, account, label)) return false;

  // Trust the round trip, not the exit status: silent truncation is the exact
  // failure mode this guards against.
  if (keychainRead(account) === token) return true;

  keychainDelete(account);
  return false;
}

/* -------------------------------------------------------------------------- */
/* File                                                                        */
/* -------------------------------------------------------------------------- */

interface StoredFile {
  version: 1;
  app_user_id: string;
  app_name: string;
  workspace_id: string;
  workspace_name: string;
  workspace_url_key: string;
  app_actor: true;
  scopes: string;
  created_at: string;
  grant?: "authorization_code" | "client_credentials";
  /** Not a secret — it identifies the app, it does not authenticate it. */
  client_id?: string;
  expires_at?: string;
  /** Present only when the Keychain could not hold the token. */
  access_token?: string;
  /** Likewise — see saveCredentials. */
  client_secret?: string;
}

function fileRead(): string | undefined {
  const path = credentialsFilePath();
  if (!existsSync(path)) return undefined;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? undefined : value;
  } catch (error) {
    throw new CredentialError(
      `Could not read ${path}: ${(error as Error).message}`,
    );
  }
}

function fileWrite(payload: string): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const path = credentialsFilePath();
  writeFileSync(path, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
  // writeFileSync's mode is ignored when the file already exists.
  chmodSync(path, 0o600);
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

function reauthorize(message: string): CredentialError {
  return new CredentialError(
    message,
    "Run `linear-agent auth` to re-authorize the app.",
  );
}

function parseMetadata(raw: string): StoredFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw reauthorize(
      "The stored Linear app credentials are corrupt: not valid JSON.",
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw reauthorize(
      "The stored Linear app credentials are corrupt: expected an object.",
    );
  }

  const record = parsed as Record<string, unknown>;
  const required = ["app_user_id", "workspace_id"] as const;
  const missing = required.filter(
    (key) => typeof record[key] !== "string" || record[key] === "",
  );
  if (missing.length > 0) {
    throw reauthorize(
      `The stored Linear app credentials are incomplete: missing ${missing.join(", ")}.`,
    );
  }

  // The invariant, enforced on every single command.
  if (record["app_actor"] !== true) {
    throw new CredentialError(
      "The stored Linear token is not an app-actor token.",
      "This CLI only ever acts as the Linear app, never as a person. Re-run " +
        "`linear-agent auth` — the authorization must include `actor=app`.",
    );
  }

  const token = record["access_token"];
  const clientSecret = record["client_secret"];
  const grant = record["grant"];
  return {
    version: 1,
    app_user_id: record["app_user_id"] as string,
    app_name: (record["app_name"] as string) ?? "(unknown app)",
    workspace_id: record["workspace_id"] as string,
    workspace_name: (record["workspace_name"] as string) ?? "(unknown)",
    workspace_url_key: (record["workspace_url_key"] as string) ?? "",
    app_actor: true,
    scopes: (record["scopes"] as string) ?? "",
    created_at: (record["created_at"] as string) ?? "",
    ...(grant === "client_credentials" || grant === "authorization_code"
      ? { grant }
      : {}),
    ...(typeof record["client_id"] === "string" && record["client_id"] !== ""
      ? { client_id: record["client_id"] as string }
      : {}),
    ...(typeof record["expires_at"] === "string"
      ? { expires_at: record["expires_at"] as string }
      : {}),
    ...(typeof token === "string" && token !== "" ? { access_token: token } : {}),
    ...(typeof clientSecret === "string" && clientSecret !== ""
      ? { client_secret: clientSecret }
      : {}),
  };
}

function noCredentialsError(): CredentialError {
  const strays = IGNORED_PERSONAL_CREDENTIAL_ENV.filter(
    (name) => (process.env[name] ?? "") !== "",
  );
  const hint =
    strays.length > 0
      ? `Note: ${strays.join(" and ")} is set in the environment and is being ` +
        "ignored on purpose. A personal API key would make every comment appear " +
        "as you rather than as the agent, so this CLI never uses one.\n" +
        "Run `linear-agent auth` to authorize the Linear app."
      : "Run `linear-agent auth` to authorize the Linear app.";
  return new CredentialError(
    "No Linear app credentials found (checked the macOS Keychain and " +
      `${credentialsFilePath()}).`,
    hint,
  );
}

/**
 * Load the app credentials, or throw. There is intentionally no fallback to any
 * other credential: no personal API key, no environment variable, nothing.
 */
export function loadCredentials(): LoadedCredentials {
  const raw = fileRead();
  if (raw === undefined) throw noCredentialsError();

  const metadata = parseMetadata(raw);

  // A token in the file means the Keychain was unavailable when we saved.
  const fileToken = metadata.access_token;
  const token = fileToken ?? keychainRead();
  const source: CredentialSource = fileToken ? "file" : "keychain";

  if (!token) {
    throw reauthorize(
      keychainAvailable()
        ? "The Linear app token is missing from the macOS Keychain, although " +
          `${credentialsFilePath()} still describes an authorized app.`
        : `${credentialsFilePath()} describes an authorized app but contains ` +
          "no access token.",
    );
  }

  registerSecret(token);

  // The client secret follows the token's store: Keychain when the token is
  // there, the file when it is not. Absent is normal — a credential saved
  // before self-renewal existed, or one obtained through the browser flow.
  const clientSecret = metadata.client_secret ?? keychainRead(KEYCHAIN_CLIENT_ACCOUNT);
  if (clientSecret) registerSecret(clientSecret);

  const { access_token: _ignored, client_secret: _alsoIgnored, ...rest } = metadata;
  return {
    credentials: {
      ...rest,
      access_token: token,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    },
    source,
  };
}

/**
 * Persist credentials. The token goes to the Keychain when it can; the
 * remaining fields are not secret and always live in the config file.
 */
export function saveCredentials(credentials: Credentials): CredentialSource {
  registerSecret(credentials.access_token);
  if (credentials.client_secret) registerSecret(credentials.client_secret);

  const metadata: StoredFile = {
    version: 1,
    app_user_id: credentials.app_user_id,
    app_name: credentials.app_name,
    workspace_id: credentials.workspace_id,
    workspace_name: credentials.workspace_name,
    workspace_url_key: credentials.workspace_url_key,
    app_actor: true,
    scopes: credentials.scopes,
    created_at: credentials.created_at,
    ...(credentials.grant ? { grant: credentials.grant } : {}),
    ...(credentials.client_id ? { client_id: credentials.client_id } : {}),
    ...(credentials.expires_at ? { expires_at: credentials.expires_at } : {}),
  };

  // A stale secret from a previous authorization must not survive one that did
  // not supply it — it would renew into an app the operator has moved off.
  keychainDelete(KEYCHAIN_CLIENT_ACCOUNT);

  if (keychainWrite(credentials.access_token)) {
    const secretKept =
      !credentials.client_secret ||
      keychainWrite(
        credentials.client_secret,
        KEYCHAIN_CLIENT_ACCOUNT,
        KEYCHAIN_CLIENT_LABEL,
      );
    fileWrite(
      JSON.stringify(
        // Only if the Keychain refused it. Both secrets share one store, so a
        // reader never has to guess which half is where.
        secretKept ? metadata : { ...metadata, client_secret: credentials.client_secret },
        null,
        2,
      ),
    );
    return "keychain";
  }

  fileWrite(
    JSON.stringify(
      {
        ...metadata,
        access_token: credentials.access_token,
        ...(credentials.client_secret
          ? { client_secret: credentials.client_secret }
          : {}),
      },
      null,
      2,
    ),
  );
  return "file";
}

/** Remove credentials from every store. Returns the stores actually cleared. */
export function clearCredentials(): CredentialSource[] {
  const cleared: CredentialSource[] = [];
  const clientCleared = keychainDelete(KEYCHAIN_CLIENT_ACCOUNT);
  if (keychainDelete() || clientCleared) cleared.push("keychain");
  const path = credentialsFilePath();
  if (existsSync(path)) {
    rmSync(path, { force: true });
    cleared.push("file");
  }
  return cleared;
}
