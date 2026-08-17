/**
 * Exit codes. Claude Code branches on these, so they are part of the contract:
 * keep the meanings stable.
 */
export const EXIT = {
  OK: 0,
  /** Catch-all failure. */
  GENERIC: 1,
  /** Bad invocation: unknown command, missing or invalid flags. */
  USAGE: 2,
  /** No app credentials, unreadable credentials, or credentials that are not an app actor. */
  CREDENTIALS: 3,
  /** Issue, team, label or workflow state could not be resolved. */
  NOT_FOUND: 4,
  /** Rate limited, and the retry budget was exhausted. */
  RATE_LIMITED: 5,
  /** The API rejected the request. */
  API: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly code: ExitCode;
  /** Optional second paragraph shown under the message, e.g. how to fix it. */
  readonly hint: string | undefined;

  constructor(message: string, code: ExitCode = EXIT.GENERIC, hint?: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = hint;
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.USAGE, hint);
    this.name = "UsageError";
  }
}

export class CredentialError extends CliError {
  /**
   * True only for a 401 — Linear understood the token and it is no longer
   * valid, which is exactly the case a fresh one fixes.
   *
   * A 403 is also a CredentialError and is deliberately NOT marked: it means a
   * missing scope, and a new token carrying the SAME scopes would be refused
   * identically. Retrying that would spend a round trip to reprint the same
   * message.
   */
  readonly expired: boolean;

  constructor(message: string, hint?: string, expired = false) {
    super(message, EXIT.CREDENTIALS, hint);
    this.name = "CredentialError";
    this.expired = expired;
  }
}

export class NotFoundError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.NOT_FOUND, hint);
    this.name = "NotFoundError";
  }
}

export class RateLimitError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.RATE_LIMITED, hint);
    this.name = "RateLimitError";
  }
}

export class ApiError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.API, hint);
    this.name = "ApiError";
  }
}

/* -------------------------------------------------------------------------- */
/* Secret redaction                                                            */
/* -------------------------------------------------------------------------- */

const secrets = new Set<string>();

/**
 * Register a value that must never reach stdout, stderr or a log. Every string
 * we print goes through `redact()`, so registering the token once at load time
 * is enough to keep it out of stack traces and API error payloads.
 */
export function registerSecret(value: string | undefined | null): void {
  // Very short values would redact half the output; a real token is long.
  if (value && value.length >= 8) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}
