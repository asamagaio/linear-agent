import { redact } from "./errors.js";

/**
 * C0 controls except tab (09) and newline (0A), plus DEL (7F). Built from an
 * escaped string so the source file stays free of literal control bytes.
 */
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]",
  "g",
);

/**
 * Issue and comment text is untrusted: it comes from anyone with access to the
 * workspace. Escape sequences in it could otherwise repaint or hijack the
 * operator's terminal. `--json` output is left byte-exact, since it is consumed
 * by a program rather than rendered by a terminal.
 */
export function sanitizeForTerminal(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

export function emitJson(value: unknown): void {
  process.stdout.write(`${redact(JSON.stringify(value, null, 2))}\n`);
}

export function line(text = ""): void {
  process.stdout.write(`${redact(sanitizeForTerminal(text))}\n`);
}

/** Multi-line untrusted content, optionally indented. */
export function block(text: string, indent = ""): void {
  const body = sanitizeForTerminal(text).replace(/\r\n/g, "\n");
  for (const row of body.split("\n")) {
    process.stdout.write(`${redact(indent + row)}\n`);
  }
}

/** Local time, stable and sortable: 2026-08-10 14:32. */
export function formatTimestamp(iso: string | undefined | null): string {
  if (!iso) return "unknown time";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** How an actor should be shown in a byline. */
export function actorLabel(
  user: { name?: string; displayName?: string; app?: boolean } | null | undefined,
  externalUser?: { name?: string } | null,
): string {
  if (user) {
    const name = user.displayName || user.name || "unknown";
    return user.app ? `${name} (app)` : name;
  }
  if (externalUser) return `${externalUser.name ?? "external user"} (external)`;
  return "unknown";
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}
