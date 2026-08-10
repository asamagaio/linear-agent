import { getContext } from "../client.js";
import { LIST_ISSUES, type GqlIssueSummary } from "../gql.js";
import { actorLabel, emitJson, line, truncate } from "../output.js";
import { getPositiveInt, getValue, type ParsedArgs } from "../args.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 250;

export const LIST_FLAGS = {
  value: ["team", "state", "limit"],
  boolean: ["delegated"],
} as const;

function summaryToJson(issue: GqlIssueSummary) {
  return {
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state?.name ?? null,
    state_type: issue.state?.type ?? null,
    team: issue.team ? { key: issue.team.key, name: issue.team.name } : null,
    priority: issue.priorityLabel,
    assignee: issue.assignee
      ? { id: issue.assignee.id, name: issue.assignee.displayName || issue.assignee.name }
      : null,
    delegate: issue.delegate
      ? { id: issue.delegate.id, name: issue.delegate.displayName || issue.delegate.name }
      : null,
    labels: (issue.labels?.nodes ?? []).map((label) => label.name),
    updated_at: issue.updatedAt,
    id: issue.id,
  };
}

export async function listCommand(args: ParsedArgs, json: boolean): Promise<void> {
  const ctx = getContext();

  const team = getValue(args, "team");
  const state = getValue(args, "state");
  const delegated = args.booleans.has("delegated");
  const limit = getPositiveInt(args, "limit", DEFAULT_LIMIT, MAX_LIMIT);

  const filter: Record<string, unknown> = {};
  if (team) filter["team"] = { key: { eqIgnoreCase: team } };
  if (state) filter["state"] = { name: { eqIgnoreCase: state } };
  if (delegated) filter["delegate"] = { id: { eq: ctx.credentials.app_user_id } };

  const data = await ctx.raw<{
    issues: { nodes: GqlIssueSummary[]; pageInfo: { hasNextPage: boolean } };
  }>(LIST_ISSUES, {
    filter: Object.keys(filter).length > 0 ? filter : undefined,
    first: limit,
  });

  const issues = data.issues.nodes;

  if (json) {
    emitJson({
      count: issues.length,
      has_more: data.issues.pageInfo.hasNextPage,
      filters: {
        team: team ?? null,
        state: state ?? null,
        delegated_to_app: delegated,
        limit,
      },
      issues: issues.map(summaryToJson),
    });
    return;
  }

  if (issues.length === 0) {
    line("No issues matched.");
    return;
  }

  const idWidth = Math.max(...issues.map((issue) => issue.identifier.length));
  const stateWidth = Math.min(
    16,
    Math.max(...issues.map((issue) => (issue.state?.name ?? "").length)),
  );

  for (const issue of issues) {
    const id = issue.identifier.padEnd(idWidth);
    const stateName = truncate(issue.state?.name ?? "", stateWidth).padEnd(stateWidth);
    const who = issue.delegate
      ? `  [delegate: ${actorLabel(issue.delegate)}]`
      : issue.assignee
        ? `  [${actorLabel(issue.assignee)}]`
        : "";
    line(`${id}  ${stateName}  ${truncate(issue.title, 72)}${who}`);
  }

  if (data.issues.pageInfo.hasNextPage) {
    line();
    line(`(more issues available — raise --limit, currently ${limit})`);
  }
}
