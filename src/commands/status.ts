import { getContext } from "../client.js";
import { ApiError, NotFoundError, UsageError } from "../errors.js";
import { UPDATE_ISSUE, type GqlWorkflowState } from "../gql.js";
import { fetchIssueRef, resolveStateByName } from "../resolve.js";
import { emitJson, line } from "../output.js";
import type { ParsedArgs } from "../args.js";

interface UpdateIssueResult {
  issueUpdate: {
    success: boolean;
    issue: {
      id: string;
      identifier: string;
      url: string;
      state: GqlWorkflowState | null;
    } | null;
  };
}

export async function statusCommand(
  args: ParsedArgs,
  json: boolean,
): Promise<void> {
  const ref = args.positionals[0];
  if (!ref) {
    throw new UsageError(
      "Missing issue identifier.",
      'Usage: linear-agent status ENG-42 "In Progress"',
    );
  }

  // Allow an unquoted multi-word state name.
  const stateName = args.positionals.slice(1).join(" ").trim();
  if (stateName === "") {
    throw new UsageError(
      "Missing target workflow state.",
      'Usage: linear-agent status ENG-42 "In Progress"',
    );
  }

  const ctx = getContext();

  // One request gets the issue, its current state, and the team's states.
  const issue = await fetchIssueRef(ctx, ref);
  const states = issue.team?.states?.nodes ?? [];
  if (states.length === 0) {
    throw new NotFoundError(
      `Could not read the workflow states for ${issue.identifier}'s team.`,
    );
  }

  const target = resolveStateByName(
    states,
    stateName,
    issue.team?.key ?? "unknown",
  );
  const previous = issue.state;

  if (previous?.id === target.id) {
    if (json) {
      emitJson({
        changed: false,
        issue: issue.identifier,
        url: issue.url,
        previous_state: previous.name,
        new_state: target.name,
      });
      return;
    }
    line(`${issue.identifier} is already in "${target.name}". Nothing changed.`);
    return;
  }

  const data = await ctx.raw<UpdateIssueResult>(UPDATE_ISSUE, {
    id: issue.id,
    input: { stateId: target.id },
  });

  const updated = data.issueUpdate.issue;
  if (!data.issueUpdate.success || !updated) {
    throw new ApiError(`Linear did not move ${issue.identifier} to "${target.name}".`);
  }

  if (json) {
    emitJson({
      changed: true,
      issue: updated.identifier,
      url: updated.url,
      previous_state: previous?.name ?? null,
      new_state: updated.state?.name ?? target.name,
      new_state_type: updated.state?.type ?? target.type,
    });
    return;
  }

  line(
    `${updated.identifier}: ${previous?.name ?? "unknown"} -> ${updated.state?.name ?? target.name}`,
  );
  line(updated.url);
}
