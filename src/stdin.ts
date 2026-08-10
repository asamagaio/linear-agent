import { UsageError } from "./errors.js";

/** The sentinel that means "read this argument from stdin". */
export const STDIN_SENTINEL = "-";

export async function readStdin(what: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError(
      `Asked to read the ${what} from stdin, but stdin is a terminal.`,
      `Pipe the text in, e.g.:\n  echo "..." | linear-agent comment ENG-42 -`,
    );
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolve a positional that may be the stdin sentinel. Markdown bodies are
 * frequently multi-line, and piping avoids fighting shell quoting.
 */
export async function resolveTextArg(
  value: string | undefined,
  what: string,
): Promise<string> {
  if (value === undefined) {
    throw new UsageError(`Missing ${what}.`);
  }
  const text = value === STDIN_SENTINEL ? await readStdin(what) : value;
  if (text.trim() === "") {
    throw new UsageError(`The ${what} is empty.`);
  }
  return text;
}
