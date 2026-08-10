import { getContext } from "../client.js";
import { UsageError } from "../errors.js";
import type { GqlComment, GqlIssueDetail } from "../gql.js";
import { fetchIssueDetail } from "../resolve.js";
import {
  actorLabel,
  block,
  emitJson,
  formatTimestamp,
  line,
} from "../output.js";
import type { ParsedArgs } from "../args.js";

/** Oldest first, so the thread reads as a conversation. */
function inOrder(comments: GqlComment[]): GqlComment[] {
  return [...comments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

function commentToJson(comment: GqlComment) {
  return {
    id: comment.id,
    body: comment.body,
    url: comment.url,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    parent_id: comment.parent?.id ?? null,
    author: comment.user
      ? {
          id: comment.user.id,
          name: comment.user.displayName || comment.user.name,
          is_app: comment.user.app,
        }
      : comment.externalUser
        ? { id: comment.externalUser.id, name: comment.externalUser.name, is_app: false }
        : null,
  };
}

function issueToJson(issue: GqlIssueDetail) {
  return {
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    description: issue.description ?? null,
    state: issue.state ? { name: issue.state.name, type: issue.state.type } : null,
    team: issue.team ? { key: issue.team.key, name: issue.team.name } : null,
    priority: issue.priorityLabel,
    labels: (issue.labels?.nodes ?? []).map((label) => label.name),
    project: issue.project
      ? { name: issue.project.name, status: issue.project.status?.name ?? null }
      : null,
    assignee: issue.assignee
      ? {
          id: issue.assignee.id,
          name: issue.assignee.displayName || issue.assignee.name,
          is_app: issue.assignee.app,
        }
      : null,
    delegate: issue.delegate
      ? {
          id: issue.delegate.id,
          name: issue.delegate.displayName || issue.delegate.name,
          is_app: issue.delegate.app,
        }
      : null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    id: issue.id,
    comments: inOrder(issue.comments?.nodes ?? []).map(commentToJson),
    comments_truncated: issue.comments?.pageInfo.hasNextPage ?? false,
  };
}

export async function readCommand(args: ParsedArgs, json: boolean): Promise<void> {
  const ref = args.positionals[0];
  if (!ref) {
    throw new UsageError(
      "Missing issue identifier.",
      "Usage: linear-agent read ENG-42 [--json]",
    );
  }

  const ctx = getContext();
  const issue = await fetchIssueDetail(ctx, ref);

  if (json) {
    emitJson(issueToJson(issue));
    return;
  }

  line(`${issue.identifier}  ${issue.title}`);
  line(issue.url);
  line();
  line(`State:     ${issue.state?.name ?? "unknown"}`);
  line(`Team:      ${issue.team ? `${issue.team.key} — ${issue.team.name}` : "unknown"}`);
  line(`Project:   ${issue.project ? issue.project.name + (issue.project.status ? ` (${issue.project.status.name})` : "") : "none"}`);
  line(`Priority:  ${issue.priorityLabel || "none"}`);
  line(`Assignee:  ${issue.assignee ? actorLabel(issue.assignee) : "unassigned"}`);
  line(`Delegate:  ${issue.delegate ? actorLabel(issue.delegate) : "none"}`);
  const labels = (issue.labels?.nodes ?? []).map((label) => label.name);
  line(`Labels:    ${labels.length > 0 ? labels.join(", ") : "none"}`);
  line(`Created:   ${formatTimestamp(issue.createdAt)}`);
  line(`Updated:   ${formatTimestamp(issue.updatedAt)}`);

  line();
  line("Description");
  line("-----------");
  if (issue.description && issue.description.trim() !== "") {
    block(issue.description);
  } else {
    line("(none)");
  }

  const comments = inOrder(issue.comments?.nodes ?? []);
  line();
  line(`Comments (${comments.length})`);
  line("-----------");
  if (comments.length === 0) {
    line("(none)");
  }

  for (const comment of comments) {
    const indent = comment.parent ? "    " : "";
    line();
    line(
      `${indent}${actorLabel(comment.user, comment.externalUser)} · ` +
        `${formatTimestamp(comment.createdAt)}${comment.parent ? " · reply" : ""}`,
    );
    block(comment.body, indent);
  }

  if (issue.comments?.pageInfo.hasNextPage) {
    line();
    line("(only the first 100 comments are shown)");
  }
}
