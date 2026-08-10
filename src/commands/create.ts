import { getContext } from "../client.js";
import { ApiError } from "../errors.js";
import { CREATE_ISSUE, type GqlIssueSummary } from "../gql.js";
import {
  fetchTeamByKey,
  rememberIssueId,
  resolveLabelId,
  resolveProject,
} from "../resolve.js";
import { actorLabel, emitJson, line } from "../output.js";
import { STDIN_SENTINEL, readStdin } from "../stdin.js";
import { getAll, getValue, requireValue, type ParsedArgs } from "../args.js";

export const CREATE_FLAGS = {
  value: ["team", "title", "description", "label", "project"],
} as const;

interface CreateIssueResult {
  issueCreate: { success: boolean; issue: GqlIssueSummary | null };
}

export async function createCommand(
  args: ParsedArgs,
  json: boolean,
): Promise<void> {
  const teamKey = requireValue(args, "team");
  const title = requireValue(args, "title");
  const rawDescription = getValue(args, "description");
  const labelNames = getAll(args, "label");
  const projectName = getValue(args, "project");

  // Descriptions are markdown too, so honour the same stdin sentinel.
  const description =
    rawDescription === STDIN_SENTINEL
      ? await readStdin("issue description")
      : rawDescription;

  const ctx = getContext();
  const team = await fetchTeamByKey(ctx, teamKey);

  const labelIds: string[] = [];
  for (const name of labelNames) {
    labelIds.push(await resolveLabelId(ctx, name, team.id, team.key));
  }

  const input: Record<string, unknown> = { teamId: team.id, title };
  if (description !== undefined && description !== "") {
    input["description"] = description;
  }
  if (labelIds.length > 0) input["labelIds"] = labelIds;
  const project = projectName ? await resolveProject(ctx, projectName) : undefined;
  if (project) input["projectId"] = project.id;

  const data = await ctx.raw<CreateIssueResult>(CREATE_ISSUE, { input });

  const issue = data.issueCreate.issue;
  if (!data.issueCreate.success || !issue) {
    throw new ApiError("Linear did not create the issue.");
  }
  rememberIssueId(issue.identifier, issue.id);

  if (json) {
    emitJson({
      created: true,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: issue.state?.name ?? null,
      team: { key: team.key, name: team.name },
      project: project?.name ?? null,
      labels: (issue.labels?.nodes ?? []).map((label) => label.name),
      id: issue.id,
    });
    return;
  }

  const author = actorLabel({ name: ctx.credentials.app_name, app: true });
  line(`Created ${issue.identifier} in ${team.key} as ${author}.`);
  line(issue.title);
  line(issue.url);
}
