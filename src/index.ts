#!/usr/bin/env node
import { parseArgs, type FlagSpec, type ParsedArgs } from "./args.js";
import { CliError, EXIT, UsageError, redact, type ExitCode } from "./errors.js";
import { AUTH_FLAGS, authCommand } from "./commands/auth.js";
import { whoamiCommand } from "./commands/whoami.js";
import { LIST_FLAGS, listCommand } from "./commands/list.js";
import { readCommand } from "./commands/read.js";
import { commentCommand } from "./commands/comment.js";
import { statusCommand } from "./commands/status.js";
import { CREATE_FLAGS, createCommand } from "./commands/create.js";
import { PROJECTS_FLAGS, projectsCommand } from "./commands/projects.js";

const VERSION = "1.0.0";

const USAGE = `linear-agent — read and write Linear issues as the agent's own app identity

Usage:
  linear-agent auth [--client-id ID --client-secret SECRET] [--browser]
  linear-agent auth --status
  linear-agent auth --logout
  linear-agent whoami
  linear-agent list [--team KEY] [--state NAME] [--project NAME] [--label NAME] [--delegated] [--limit N]
  linear-agent projects [--team KEY] [--status NAME] [--limit N]
  linear-agent read <ID>
  linear-agent comment <ID> <body|->
  linear-agent status <ID> <state-name>
  linear-agent create --team KEY --title T [--description D|-] [--label L]... [--project NAME]

auth uses the client credentials grant: a 30-day app token that renews itself
on the next 401. --browser is the fallback for an application without that
grant enabled, and produces a token that lasts a day and cannot renew.

Every command accepts --json for machine-readable output.
<ID> is a human identifier such as ENG-42.
A body of "-" is read from stdin, which avoids shell quoting for markdown.

Exit codes:
  0  success
  1  unexpected failure
  2  bad usage
  3  missing, unreadable, or non-app credentials
  4  issue, team, label, project or workflow state not found
  5  rate limited after exhausting retries
  6  the Linear API rejected the request
`;

interface CommandDef {
  flags: FlagSpec;
  run: (args: ParsedArgs, json: boolean) => Promise<void> | void;
}

const COMMANDS: Record<string, CommandDef> = {
  auth: { flags: AUTH_FLAGS, run: authCommand },
  whoami: { flags: {}, run: (_args, json) => whoamiCommand(json) },
  list: { flags: LIST_FLAGS, run: listCommand },
  read: { flags: {}, run: readCommand },
  comment: { flags: {}, run: commentCommand },
  status: { flags: {}, run: statusCommand },
  create: { flags: CREATE_FLAGS, run: createCommand },
  projects: { flags: PROJECTS_FLAGS, run: projectsCommand },
};

function reportFailure(error: unknown): ExitCode {
  if (error instanceof CliError) {
    process.stderr.write(`error: ${redact(error.message)}\n`);
    if (error.hint) process.stderr.write(`${redact(error.hint)}\n`);
    return error.code;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${redact(message)}\n`);
  if (
    process.env["LINEAR_AGENT_DEBUG"] === "1" &&
    error instanceof Error &&
    error.stack
  ) {
    process.stderr.write(`${redact(error.stack)}\n`);
  }
  return EXIT.GENERIC;
}

async function main(): Promise<ExitCode> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }

  if (first === "--version" || first === "-v") {
    process.stdout.write(`linear-agent ${VERSION}\n`);
    return EXIT.OK;
  }

  const command = COMMANDS[first];
  if (!command) {
    throw new UsageError(
      `Unknown command "${first}".`,
      "Run `linear-agent --help` for the list of commands.",
    );
  }

  const args = parseArgs(argv.slice(1), command.flags);

  if (args.booleans.has("help")) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }

  await command.run(args, args.booleans.has("json"));
  return EXIT.OK;
}

/**
 * Setting `exitCode` and letting the loop drain naturally, rather than calling
 * process.exit(), so piped stdout is never truncated mid-write. Nothing in this
 * CLI is supposed to outlive the command: the OAuth listener is closed in a
 * `finally`, and the only ref'd timer is the rate-limit backoff, whose total
 * wait is capped. The watchdog below is a backstop — an unref'd timer only
 * fires if something else is still holding the loop open, in which case exiting
 * loudly beats hanging forever.
 */
const WATCHDOG_MS = 15_000;

function armWatchdog(): void {
  const timer = setTimeout(() => {
    process.stderr.write(
      "error: linear-agent stayed alive after finishing; forcing exit.\n",
    );
    process.exit(EXIT.GENERIC);
  }, WATCHDOG_MS);
  timer.unref();
}

main()
  .then((code) => {
    process.exitCode = code;
    armWatchdog();
  })
  .catch((error: unknown) => {
    process.exitCode = reportFailure(error);
    armWatchdog();
  });
