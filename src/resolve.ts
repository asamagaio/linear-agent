import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./creds.js";
import { NotFoundError, UsageError } from "./errors.js";
import type { Context } from "./client.js";
import {
  ISSUE_BY_NUMBER,
  ISSUE_BY_UUID,
  ISSUE_REF_BY_NUMBER,
  ISSUE_REF_BY_UUID,
  LABEL_BY_NAME,
  PROJECT_BY_NAME,
  TEAM_BY_KEY,
  type GqlIssueDetail,
  type GqlIssueRef,
  type GqlLabel,
  type GqlTeam,
  type GqlWorkflowState,
} from "./gql.js";

const IDENTIFIER_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ParsedIdentifier {
  teamKey: string;
  number: number;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Accept `ENG-42` (any case). Linear's `issue(id:)` also takes identifiers, but
 * resolving via the team-key + number filter is the shape we verified against
 * the schema and it works uniformly for every command.
 */
export function parseIdentifier(value: string): ParsedIdentifier {
  const match = IDENTIFIER_RE.exec(value.trim());
  if (!match) {
    throw new UsageError(
      `"${value}" is not a Linear issue identifier.`,
      "Expected something like ENG-42 (team key, hyphen, issue number).",
    );
  }
  return { teamKey: (match[1] as string).toUpperCase(), number: Number(match[2]) };
}

/* -------------------------------------------------------------------------- */
/* Identifier -> uuid cache                                                    */
/* -------------------------------------------------------------------------- */

interface CacheShape {
  issues: Record<string, string>;
}

function cachePath(): string {
  return join(configDir(), "id-cache.json");
}

function readCache(): CacheShape {
  const path = cachePath();
  if (!existsSync(path)) return { issues: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheShape>;
    return { issues: parsed.issues ?? {} };
  } catch {
    // A damaged cache is never fatal — it is only ever an optimisation.
    return { issues: {} };
  }
}

function writeCache(cache: CacheShape): void {
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath(), JSON.stringify(cache), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Best effort only.
  }
}

export function cachedIssueId(identifier: string): string | undefined {
  return readCache().issues[identifier.toUpperCase()];
}

export function rememberIssueId(identifier: string, id: string): void {
  const cache = readCache();
  if (cache.issues[identifier.toUpperCase()] === id) return;
  cache.issues[identifier.toUpperCase()] = id;
  writeCache(cache);
}

/* -------------------------------------------------------------------------- */
/* Issue resolution                                                            */
/* -------------------------------------------------------------------------- */

function notFound(ref: string): NotFoundError {
  return new NotFoundError(
    `No issue ${ref} is visible to this app.`,
    "Check the identifier, and make sure the app has been added to the team " +
      "that owns the issue.",
  );
}

/** Full issue including description and comments. One request. */
export async function fetchIssueDetail(
  ctx: Context,
  ref: string,
): Promise<GqlIssueDetail> {
  if (isUuid(ref)) {
    const data = await ctx.raw<{ issue: GqlIssueDetail | null }>(ISSUE_BY_UUID, {
      id: ref,
    });
    if (!data.issue) throw notFound(ref);
    rememberIssueId(data.issue.identifier, data.issue.id);
    return data.issue;
  }

  const { teamKey, number } = parseIdentifier(ref);
  const data = await ctx.raw<{ issues: { nodes: GqlIssueDetail[] } }>(
    ISSUE_BY_NUMBER,
    { teamKey, number },
  );
  const issue =
    data.issues.nodes[0] ?? (await byPreviousIdentifier<GqlIssueDetail>(ctx, ISSUE_BY_UUID, ref));
  if (!issue) throw notFound(`${teamKey}-${number}`);
  rememberIssueId(issue.identifier, issue.id);
  return issue;
}

/**
 * A team re-key changes every identifier in it: OLD-6 becomes NEW-6. Linear
 * still resolves the old one through `previousIdentifiers`, but the team-key +
 * number filter cannot — no team has the old key any more. Falling back to
 * `issue(id:)` keeps stale identifiers working, and keeps `read` consistent
 * with the commands that resolve through the id cache.
 */
async function byPreviousIdentifier<T extends { id: string; identifier: string }>(
  ctx: Context,
  query: string,
  ref: string,
): Promise<T | undefined> {
  try {
    const data = await ctx.raw<{ issue: T | null }>(query, { id: ref });
    return data.issue ?? undefined;
  } catch {
    // Best effort only. `issue(id:)` errors rather than returning null for an
    // identifier that never existed, and that must stay a "not found" (exit 4)
    // rather than surfacing as an API failure (exit 6).
    return undefined;
  }
}

/** Issue uuid, current state, and the team's workflow states. One request. */
export async function fetchIssueRef(
  ctx: Context,
  ref: string,
): Promise<GqlIssueRef> {
  if (isUuid(ref)) {
    const data = await ctx.raw<{ issue: GqlIssueRef | null }>(ISSUE_REF_BY_UUID, {
      id: ref,
    });
    if (!data.issue) throw notFound(ref);
    rememberIssueId(data.issue.identifier, data.issue.id);
    return data.issue;
  }

  const { teamKey, number } = parseIdentifier(ref);
  const data = await ctx.raw<{ issues: { nodes: GqlIssueRef[] } }>(
    ISSUE_REF_BY_NUMBER,
    { teamKey, number },
  );
  const issue =
    data.issues.nodes[0] ??
    (await byPreviousIdentifier<GqlIssueRef>(ctx, ISSUE_REF_BY_UUID, ref));
  if (!issue) throw notFound(`${teamKey}-${number}`);
  rememberIssueId(issue.identifier, issue.id);
  return issue;
}

/**
 * Issue uuid only. Uses the cache when it can, so posting a comment on an issue
 * that has already been read costs a single request.
 */
export async function resolveIssueId(
  ctx: Context,
  ref: string,
): Promise<{ id: string; identifier: string }> {
  if (isUuid(ref)) return { id: ref, identifier: ref };

  const { teamKey, number } = parseIdentifier(ref);
  const identifier = `${teamKey}-${number}`;

  const cached = cachedIssueId(identifier);
  if (cached) return { id: cached, identifier };

  const issue = await fetchIssueRef(ctx, identifier);
  return { id: issue.id, identifier: issue.identifier };
}

/* -------------------------------------------------------------------------- */
/* Teams, workflow states, labels                                              */
/* -------------------------------------------------------------------------- */

export async function fetchTeamByKey(ctx: Context, key: string): Promise<GqlTeam> {
  const data = await ctx.raw<{ teams: { nodes: GqlTeam[] } }>(TEAM_BY_KEY, {
    key: key.toUpperCase(),
  });
  const team = data.teams.nodes[0];
  if (!team) {
    throw new NotFoundError(
      `No team with key "${key}" is visible to this app.`,
      "Team keys are the short prefix in issue identifiers, e.g. ENG in ENG-42.",
    );
  }
  return team;
}

/**
 * Match a workflow state by name, case-insensitively. On a miss, the error
 * lists the states that would have worked.
 */
export function resolveStateByName(
  states: GqlWorkflowState[],
  name: string,
  teamLabel: string,
): GqlWorkflowState {
  const wanted = name.trim().toLowerCase();
  const match = states.find((state) => state.name.trim().toLowerCase() === wanted);
  if (match) return match;

  const available = [...states]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((state) => `  - ${state.name}`)
    .join("\n");

  throw new NotFoundError(
    `Team ${teamLabel} has no workflow state named "${name}".`,
    available === "" ? undefined : `Valid states:\n${available}`,
  );
}

/**
 * Resolve a project by name, case-insensitively. Projects are workspace-level
 * and can span teams, so an ambiguous name is an error rather than a guess.
 */
export async function resolveProject(
  ctx: Context,
  name: string,
): Promise<{ id: string; name: string }> {
  const data = await ctx.raw<{
    projects: { nodes: Array<{ id: string; name: string; teams?: { nodes: Array<{ key: string }> } }> };
  }>(PROJECT_BY_NAME, { name });

  const candidates = data.projects.nodes;
  if (candidates.length === 0) {
    throw new NotFoundError(
      `No project named "${name}" is visible to this app.`,
      "Check the spelling, or run `linear-agent projects` to see what exists.",
    );
  }
  if (candidates.length > 1) {
    const listed = candidates
      .map((p) => `  - ${p.name} (teams: ${(p.teams?.nodes ?? []).map((t) => t.key).join(", ") || "none"})`)
      .join("\n");
    throw new NotFoundError(
      `"${name}" matches more than one project.`,
      `Matches:\n${listed}`,
    );
  }
  return { id: candidates[0]!.id, name: candidates[0]!.name };
}

/** Resolve a label name to an id, preferring the team's own label. */
export async function resolveLabelId(
  ctx: Context,
  name: string,
  teamId: string,
  teamKey: string,
): Promise<string> {
  const data = await ctx.raw<{ issueLabels: { nodes: GqlLabel[] } }>(
    LABEL_BY_NAME,
    { name },
  );
  const candidates = data.issueLabels.nodes;
  if (candidates.length === 0) {
    throw new NotFoundError(
      `No label named "${name}" is visible to this app.`,
      `Create the label in Linear first, or check the spelling.`,
    );
  }

  const teamLabel = candidates.find((label) => label.team?.id === teamId);
  if (teamLabel) return teamLabel.id;

  // Workspace-level labels have no team and apply everywhere.
  const workspaceLabel = candidates.find((label) => !label.team);
  if (workspaceLabel) return workspaceLabel.id;

  throw new NotFoundError(
    `Label "${name}" exists, but only on other teams (not ${teamKey}).`,
    "Use a workspace label, or create the label on this team.",
  );
}
