import { LinearClient } from "@linear/sdk";
import {
  ApiError,
  CredentialError,
  RateLimitError,
  redact,
} from "./errors.js";
import { loadCredentials, saveCredentials, type Credentials } from "./creds.js";

const MAX_ATTEMPTS = 5;
const MAX_TOTAL_WAIT_MS = 60_000;
const MAX_SINGLE_WAIT_MS = 30_000;

export interface Context {
  credentials: Credentials;
  /** Run a GraphQL document, with rate-limit backoff. Returns the `data` field. */
  raw<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

/** Shape of the errors `@linear/sdk` throws, accessed defensively. */
interface LinearErrorish {
  type?: string;
  status?: number;
  retryAfter?: number;
  requestsResetAt?: Date | number;
  message?: string;
  errors?: Array<{ message?: string }>;
}

function asLinearError(error: unknown): LinearErrorish {
  return (typeof error === "object" && error !== null ? error : {}) as LinearErrorish;
}

function isRateLimited(error: unknown): boolean {
  const e = asLinearError(error);
  // Linear documents HTTP 400 for complexity/request limits, and 429 is also
  // used; the SDK normalises both to the Ratelimited type.
  return e.type === "Ratelimited" || e.status === 429;
}

function isTransientNetwork(error: unknown): boolean {
  const e = asLinearError(error);
  if (e.type === "NetworkError") return true;
  return typeof e.status === "number" && e.status >= 500 && e.status < 600;
}

/**
 * Deliberately a ref'd timer. An unref'd one would let the process exit during
 * a backoff when nothing else holds the event loop — the retry would never run
 * and the command would exit 0 having done nothing. The retry budget below caps
 * the total wait, so this cannot hang.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function backoffMs(error: unknown, attempt: number): number {
  const e = asLinearError(error);

  let base: number | undefined;
  if (typeof e.retryAfter === "number" && Number.isFinite(e.retryAfter)) {
    base = e.retryAfter * 1000;
  } else if (e.requestsResetAt !== undefined) {
    const resetAt =
      e.requestsResetAt instanceof Date
        ? e.requestsResetAt.getTime()
        : Number(e.requestsResetAt);
    if (Number.isFinite(resetAt)) base = resetAt - Date.now();
  }

  if (base === undefined || base <= 0) {
    base = 2 ** (attempt - 1) * 1000;
  }

  const jitter = Math.floor(Math.random() * 250);
  return Math.min(Math.max(base + jitter, 500), MAX_SINGLE_WAIT_MS);
}

function graphqlMessages(error: unknown): string {
  const e = asLinearError(error);
  const fromErrors = (e.errors ?? [])
    .map((entry) => entry?.message)
    .filter((message): message is string => typeof message === "string" && message !== "");
  if (fromErrors.length > 0) return fromErrors.join("; ");
  return e.message ?? String(error);
}

/** Turn an SDK error into a CliError carrying the right exit code. */
function translate(error: unknown): Error {
  const e = asLinearError(error);
  const message = redact(graphqlMessages(error));

  if (isRateLimited(error)) {
    return new RateLimitError(
      `Linear rate limit hit and the retry budget was exhausted: ${message}`,
      "Linear allows 5,000 requests per hour per app. Wait for the window to " +
        "reset and try again.",
    );
  }

  if (e.type === "AuthenticationError" || e.status === 401) {
    return new CredentialError(
      `Linear rejected the app credentials: ${message}`,
      "The stored app token is invalid, expired or revoked. Run " +
        "`linear-agent auth` to re-authorize the app.",
      true,
    );
  }

  if (e.type === "Forbidden" || e.status === 403) {
    return new CredentialError(
      `Linear refused the request: ${message}`,
      "The app token may be missing a scope. It needs read, write, " +
        "app:assignable and app:mentionable — re-run `linear-agent auth`.",
    );
  }

  return new ApiError(`Linear API error: ${message}`);
}

/** Exported so the backoff behaviour can be tested without a live API. */
export async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  let totalWaited = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const retryable = isRateLimited(error) || isTransientNetwork(error);
      if (!retryable || attempt >= MAX_ATTEMPTS) throw translate(error);

      const delay = backoffMs(error, attempt);
      if (totalWaited + delay > MAX_TOTAL_WAIT_MS) throw translate(error);

      await sleep(delay);
      totalWaited += delay;
    }
  }
}

function makeRaw(accessToken: string) {
  const client = new LinearClient({ accessToken });
  return async function raw<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await withRetry(() =>
      client.client.rawRequest<T, Record<string, unknown>>(query, variables),
    );
    const data = (response as { data?: T }).data;
    if (data === undefined || data === null) {
      throw new ApiError("Linear returned an empty response.");
    }
    return data;
  };
}

/**
 * Run a query with a token that is not stored yet. Used only by `auth`, to
 * establish the app's identity before deciding whether the token is worth
 * keeping.
 */
export async function rawWithToken<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  return makeRaw(accessToken)<T>(query, variables);
}

/**
 * Build the authenticated context. Throws if there is no app-actor token —
 * there is deliberately no fallback to any other credential.
 */
/**
 * Did Linear reject this because the token is no longer good?
 *
 * The error has ALREADY been through `translate` by the time it gets here —
 * `withRetry` translates before rethrowing — so this reads the translated flag,
 * not `status === 401`. Reading the raw status here would silently never match,
 * and the renewal below would look wired up while never firing.
 */
function isExpired(error: unknown): boolean {
  return error instanceof CredentialError && error.expired;
}

/**
 * Trade the app's own credentials for a fresh token, and keep it. Exported so
 * the renewal can be tested without waiting thirty days for a real expiry.
 *
 * A client-credentials token carries no refresh token, so the 401 IS the expiry
 * notice — that is the flow Linear documents, not a workaround. Returns
 * undefined when this credential cannot renew (the browser flow, or one saved
 * before renewal existed); the caller then reports the 401 as it always did.
 */
export async function renew(credentials: Credentials): Promise<string | undefined> {
  if (
    credentials.grant !== "client_credentials" ||
    !credentials.client_id ||
    !credentials.client_secret
  ) {
    return undefined;
  }
  // Imported here rather than at module scope: `auth.ts` pulls in the callback
  // listener and the browser opener, and a `list` command has no business
  // loading either.
  const { fetchAppToken } = await import("./commands/auth.js");

  // The SAME scopes it already holds. Asking for a different set revokes every
  // existing app-actor token for the app, so a renewal must never widen them.
  const token = await fetchAppToken(
    credentials.client_id,
    credentials.client_secret,
    credentials.scopes || undefined,
  );

  saveCredentials({
    ...credentials,
    access_token: token.access_token,
    created_at: new Date().toISOString(),
    ...(token.expires_in
      ? { expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString() }
      : {}),
  });
  return token.access_token;
}

/**
 * Build the authenticated context. Throws if there is no app-actor token —
 * there is deliberately no fallback to any other credential.
 */
export function getContext(): Context {
  const { credentials } = loadCredentials();
  let send = makeRaw(credentials.access_token);

  // One renewal shared by every in-flight query. A command that fans out issues
  // several queries at once, and they would all 401 together; without this they
  // would each mint a token, and only the last one written would be the one
  // kept.
  let renewing: Promise<string | undefined> | undefined;

  return {
    credentials,
    async raw<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      try {
        return await send<T>(query, variables);
      } catch (error) {
        // ONE retry, and only for an expired token. A 401 that survives a fresh
        // token is a real credential problem — a revoked app, a rotated secret —
        // and looping on it would turn a clear message into a hang.
        if (!isExpired(error)) throw error;
        renewing ??= renew(credentials);
        const renewed = await renewing;
        if (!renewed) throw error;
        send = makeRaw(renewed);
        return await send<T>(query, variables);
      }
    },
  };
}
