import { getContext } from "../client.js";
import { ApiError, UsageError } from "../errors.js";
import { CREATE_COMMENT, type GqlUser } from "../gql.js";
import { resolveIssueId } from "../resolve.js";
import { actorLabel, emitJson, line } from "../output.js";
import { resolveTextArg } from "../stdin.js";
import type { ParsedArgs } from "../args.js";

interface CreateCommentResult {
  commentCreate: {
    success: boolean;
    comment: {
      id: string;
      url: string;
      body: string;
      createdAt: string;
      user: GqlUser | null;
    } | null;
  };
}

export async function commentCommand(
  args: ParsedArgs,
  json: boolean,
): Promise<void> {
  const ref = args.positionals[0];
  if (!ref) {
    throw new UsageError(
      "Missing issue identifier.",
      'Usage: linear-agent comment ENG-42 "text"   (or pass - to read stdin)',
    );
  }

  // Everything after the identifier is the body, so an unquoted sentence still
  // works. `-` means stdin.
  const bodyArg =
    args.positionals.length > 2
      ? args.positionals.slice(1).join(" ")
      : args.positionals[1];
  const body = await resolveTextArg(bodyArg, "comment body");

  const ctx = getContext();
  const { id, identifier } = await resolveIssueId(ctx, ref);

  const data = await ctx.raw<CreateCommentResult>(CREATE_COMMENT, {
    input: { issueId: id, body },
  });

  const created = data.commentCreate.comment;
  if (!data.commentCreate.success || !created) {
    throw new ApiError(`Linear did not create the comment on ${identifier}.`);
  }

  if (json) {
    emitJson({
      posted: true,
      issue: identifier,
      comment: {
        id: created.id,
        url: created.url,
        created_at: created.createdAt,
        author: created.user
          ? {
              id: created.user.id,
              name: created.user.displayName || created.user.name,
              is_app: created.user.app,
            }
          : null,
      },
    });
    return;
  }

  line(`Commented on ${identifier} as ${actorLabel(created.user)}.`);
  line(created.url);
}
