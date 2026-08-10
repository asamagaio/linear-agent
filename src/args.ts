import { UsageError } from "./errors.js";

export interface ParsedArgs {
  positionals: string[];
  /** Flags that take a value. Repeatable flags collect into the array form. */
  values: Map<string, string[]>;
  booleans: Set<string>;
}

export interface FlagSpec {
  /** Flags that consume the following argument (or use --flag=value). */
  value?: readonly string[];
  /** Flags that stand alone. */
  boolean?: readonly string[];
}

/** Flags accepted by every command. */
const GLOBAL_BOOLEANS = ["json", "help"] as const;

/**
 * Minimal argv parser. Deliberately hand-rolled: the surface is small, and this
 * keeps full control over `--` and the bare `-` stdin sentinel, which is a
 * positional rather than a flag.
 */
export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const valueFlags = new Set([...(spec.value ?? [])]);
  const booleanFlags = new Set([...(spec.boolean ?? []), ...GLOBAL_BOOLEANS]);

  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();

  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;

    if (onlyPositionals) {
      positionals.push(arg);
      continue;
    }

    if (arg === "--") {
      onlyPositionals = true;
      continue;
    }

    // A bare "-" means "read from stdin" and is a positional, not a flag.
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

    if (booleanFlags.has(name)) {
      if (inlineValue !== undefined) {
        throw new UsageError(`--${name} does not take a value.`);
      }
      booleans.add(name);
      continue;
    }

    if (valueFlags.has(name)) {
      let value: string;
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new UsageError(`--${name} requires a value.`);
        }
        value = next;
        i++;
      }
      const existing = values.get(name);
      if (existing) existing.push(value);
      else values.set(name, [value]);
      continue;
    }

    throw new UsageError(
      `Unknown option --${name}.`,
      "Run `linear-agent --help` to see the supported commands and options.",
    );
  }

  return { positionals, values, booleans };
}

/** Last occurrence wins, matching normal CLI expectations. */
export function getValue(args: ParsedArgs, name: string): string | undefined {
  const list = args.values.get(name);
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

export function getAll(args: ParsedArgs, name: string): string[] {
  return args.values.get(name) ?? [];
}

export function requireValue(args: ParsedArgs, name: string): string {
  const value = getValue(args, name);
  if (value === undefined || value === "") {
    throw new UsageError(`--${name} is required.`);
  }
  return value;
}

export function getPositiveInt(
  args: ParsedArgs,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = getValue(args, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`--${name} must be a positive integer, got "${raw}".`);
  }
  return Math.min(parsed, max);
}
