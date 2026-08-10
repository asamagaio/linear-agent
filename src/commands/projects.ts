import { getContext } from "../client.js";
import { LIST_PROJECTS, type GqlProject } from "../gql.js";
import { actorLabel, emitJson, line, truncate } from "../output.js";
import { getPositiveInt, getValue, type ParsedArgs } from "../args.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

export const PROJECTS_FLAGS = {
  value: ["team", "status", "limit"],
} as const;

function toJson(project: GqlProject) {
  return {
    name: project.name,
    url: project.url,
    status: project.status?.name ?? null,
    status_type: project.status?.type ?? null,
    health: project.health ?? null,
    progress: Math.round((project.progress ?? 0) * 100),
    start_date: project.startDate ?? null,
    target_date: project.targetDate ?? null,
    lead: project.lead
      ? { id: project.lead.id, name: project.lead.displayName || project.lead.name }
      : null,
    teams: (project.teams?.nodes ?? []).map((team) => team.key),
    description: project.description ?? null,
    id: project.id,
  };
}

export async function projectsCommand(
  args: ParsedArgs,
  json: boolean,
): Promise<void> {
  const ctx = getContext();

  const team = getValue(args, "team");
  const status = getValue(args, "status");
  const limit = getPositiveInt(args, "limit", DEFAULT_LIMIT, MAX_LIMIT);

  const filter: Record<string, unknown> = {};
  // Projects span teams, so the team filter asks whether *any* accessible team
  // matches rather than comparing a single key.
  if (team) filter["accessibleTeams"] = { some: { key: { eqIgnoreCase: team } } };
  if (status) filter["status"] = { name: { eqIgnoreCase: status } };

  const data = await ctx.raw<{
    projects: { nodes: GqlProject[]; pageInfo: { hasNextPage: boolean } };
  }>(LIST_PROJECTS, {
    filter: Object.keys(filter).length > 0 ? filter : undefined,
    first: limit,
  });

  const projects = data.projects.nodes;

  if (json) {
    emitJson({
      count: projects.length,
      has_more: data.projects.pageInfo.hasNextPage,
      filters: { team: team ?? null, status: status ?? null, limit },
      projects: projects.map(toJson),
    });
    return;
  }

  if (projects.length === 0) {
    line("No projects matched.");
    return;
  }

  const nameWidth = Math.min(
    32,
    Math.max(...projects.map((project) => project.name.length)),
  );
  const statusWidth = Math.min(
    14,
    Math.max(...projects.map((project) => (project.status?.name ?? "").length)),
  );

  for (const project of projects) {
    const name = truncate(project.name, nameWidth).padEnd(nameWidth);
    const status = truncate(project.status?.name ?? "", statusWidth).padEnd(statusWidth);
    const percent = `${Math.round((project.progress ?? 0) * 100)}%`.padStart(4);
    const teams = (project.teams?.nodes ?? []).map((t) => t.key).join(",");
    const target = project.targetDate ? `  target ${project.targetDate}` : "";
    const lead = project.lead ? `  [${actorLabel(project.lead)}]` : "";
    line(`${name}  ${status}  ${percent}  ${teams}${target}${lead}`);
  }

  if (data.projects.pageInfo.hasNextPage) {
    line();
    line(`(more projects available — raise --limit, currently ${limit})`);
  }
}
