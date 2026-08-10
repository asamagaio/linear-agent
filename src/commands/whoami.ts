import { getContext } from "../client.js";
import { CredentialError } from "../errors.js";
import { WHOAMI, type GqlOrganization, type GqlViewer } from "../gql.js";
import { emitJson, line } from "../output.js";

/**
 * Confirms with Linear — not just with the local store — that the token acts as
 * an app, and reports the identity comments will be attributed to.
 */
export async function whoamiCommand(json: boolean): Promise<void> {
  const ctx = getContext();
  const data = await ctx.raw<{ viewer: GqlViewer; organization: GqlOrganization }>(
    WHOAMI,
  );
  const { viewer, organization } = data;

  if (viewer.app !== true) {
    throw new CredentialError(
      `The stored token authenticates as the user "${viewer.name}", not as an app.`,
      "Every comment would be attributed to that person instead of the agent. " +
        "Run `linear-agent auth` and make sure the authorization uses actor=app.",
    );
  }

  const identityMatchesStore = viewer.id === ctx.credentials.app_user_id;

  if (json) {
    emitJson({
      actor: "app",
      app_user_id: viewer.id,
      name: viewer.name,
      display_name: viewer.displayName,
      email: viewer.email || null,
      url: viewer.url,
      active: viewer.active,
      admin: viewer.admin,
      workspace: {
        id: organization.id,
        name: organization.name,
        url_key: organization.urlKey,
      },
      identity_matches_stored_credentials: identityMatchesStore,
    });
    return;
  }

  line(`Acting as:   ${viewer.displayName || viewer.name} (app)`);
  line(`App user ID: ${viewer.id}`);
  line(`Workspace:   ${organization.name} (${organization.urlKey})`);
  line(`Actor type:  app — comments are attributed to the app, not to a person.`);
  if (!identityMatchesStore) {
    line();
    line(
      `Warning: the stored app user id (${ctx.credentials.app_user_id}) does not ` +
        "match the one Linear just returned. Re-run `linear-agent auth`.",
    );
  }
}
