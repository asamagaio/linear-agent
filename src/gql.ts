/**
 * GraphQL documents.
 *
 * Every field here was checked against the schema shipped in @linear/sdk's
 * generated types before being written. Raw documents rather than the SDK's
 * lazy model getters, because the getters fetch each relation as a separate
 * request — one `read` would become a dozen round trips against a 5,000/hour
 * budget.
 */

export const USER_FIELDS = /* GraphQL */ `
  fragment UserFields on User {
    id
    name
    displayName
    app
  }
`;

export const ISSUE_SUMMARY = /* GraphQL */ `
  fragment IssueSummary on Issue {
    id
    identifier
    number
    title
    url
    priority
    priorityLabel
    createdAt
    updatedAt
    state {
      id
      name
      type
    }
    team {
      id
      key
      name
    }
    assignee {
      ...UserFields
    }
    delegate {
      ...UserFields
    }
    labels(first: 50) {
      nodes {
        id
        name
      }
    }
    project {
      id
      name
      status {
        name
        type
      }
    }
  }
`;

/**
 * Projects are workspace-level and span teams, so `status` here is a
 * ProjectStatus object — not the plain `state` an issue has. Verified against
 * the live schema; Project has no `state` field at all.
 */
export const PROJECT_FIELDS = /* GraphQL */ `
  fragment ProjectFields on Project {
    id
    name
    description
    url
    progress
    health
    startDate
    targetDate
    status {
      name
      type
    }
    lead {
      ...UserFields
    }
    teams(first: 10) {
      nodes {
        key
        name
      }
    }
  }
`;

export const LIST_PROJECTS = /* GraphQL */ `
  ${USER_FIELDS}
  ${PROJECT_FIELDS}
  query ListProjects($filter: ProjectFilter, $first: Int!) {
    projects(filter: $filter, first: $first, orderBy: updatedAt) {
      nodes {
        ...ProjectFields
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

export const PROJECT_BY_NAME = /* GraphQL */ `
  query ProjectByName($name: String!) {
    projects(filter: { name: { eqIgnoreCase: $name } }, first: 25) {
      nodes {
        id
        name
        teams(first: 10) {
          nodes {
            key
          }
        }
      }
    }
  }
`;

export const ISSUE_DETAIL = /* GraphQL */ `
  fragment IssueDetail on Issue {
    ...IssueSummary
    description
    comments(first: 100) {
      nodes {
        id
        body
        url
        createdAt
        updatedAt
        parent {
          id
        }
        user {
          ...UserFields
        }
        externalUser {
          id
          name
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

export const WHOAMI = /* GraphQL */ `
  query Whoami {
    viewer {
      id
      name
      displayName
      email
      app
      admin
      active
      url
      createdAt
    }
    organization {
      id
      name
      urlKey
    }
  }
`;

export const ISSUE_BY_NUMBER = /* GraphQL */ `
  ${USER_FIELDS}
  ${ISSUE_SUMMARY}
  ${ISSUE_DETAIL}
  query IssueByNumber($teamKey: String!, $number: Float!) {
    issues(
      filter: {
        team: { key: { eqIgnoreCase: $teamKey } }
        number: { eq: $number }
      }
      first: 1
    ) {
      nodes {
        ...IssueDetail
      }
    }
  }
`;

/**
 * Just enough of an issue to mutate it: its uuid, its current state, and its
 * team's workflow states so `status` can resolve a state name in one round trip.
 */
export const ISSUE_REF_FIELDS = /* GraphQL */ `
  fragment IssueRef on Issue {
    id
    identifier
    title
    url
    state {
      id
      name
      type
    }
    team {
      id
      key
      name
      states(first: 100) {
        nodes {
          id
          name
          type
          position
        }
      }
    }
  }
`;

export const ISSUE_REF_BY_NUMBER = /* GraphQL */ `
  ${ISSUE_REF_FIELDS}
  query IssueRefByNumber($teamKey: String!, $number: Float!) {
    issues(
      filter: {
        team: { key: { eqIgnoreCase: $teamKey } }
        number: { eq: $number }
      }
      first: 1
    ) {
      nodes {
        ...IssueRef
      }
    }
  }
`;

export const ISSUE_REF_BY_UUID = /* GraphQL */ `
  ${ISSUE_REF_FIELDS}
  query IssueRefByUuid($id: String!) {
    issue(id: $id) {
      ...IssueRef
    }
  }
`;

export const ISSUE_BY_UUID = /* GraphQL */ `
  ${USER_FIELDS}
  ${ISSUE_SUMMARY}
  ${ISSUE_DETAIL}
  query IssueByUuid($id: String!) {
    issue(id: $id) {
      ...IssueDetail
    }
  }
`;

export const LIST_ISSUES = /* GraphQL */ `
  ${USER_FIELDS}
  ${ISSUE_SUMMARY}
  query ListIssues($filter: IssueFilter, $first: Int!) {
    issues(filter: $filter, first: $first, orderBy: updatedAt) {
      nodes {
        ...IssueSummary
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

export const TEAM_BY_KEY = /* GraphQL */ `
  query TeamByKey($key: String!) {
    teams(filter: { key: { eqIgnoreCase: $key } }, first: 1) {
      nodes {
        id
        key
        name
        states(first: 100) {
          nodes {
            id
            name
            type
            position
          }
        }
      }
    }
  }
`;

export const LABEL_BY_NAME = /* GraphQL */ `
  query LabelByName($name: String!) {
    issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 25) {
      nodes {
        id
        name
        team {
          id
          key
        }
      }
    }
  }
`;

export const CREATE_COMMENT = /* GraphQL */ `
  ${USER_FIELDS}
  mutation CreateComment($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment {
        id
        url
        body
        createdAt
        user {
          ...UserFields
        }
      }
    }
  }
`;

export const UPDATE_ISSUE = /* GraphQL */ `
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id
        identifier
        url
        state {
          id
          name
          type
        }
      }
    }
  }
`;

export const CREATE_ISSUE = /* GraphQL */ `
  ${USER_FIELDS}
  ${ISSUE_SUMMARY}
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        ...IssueSummary
      }
    }
  }
`;

/* -------------------------------------------------------------------------- */
/* Response types                                                              */
/* -------------------------------------------------------------------------- */

export interface GqlUser {
  id: string;
  name: string;
  displayName: string;
  app: boolean;
}

export interface GqlViewer extends GqlUser {
  email: string;
  admin: boolean;
  active: boolean;
  url: string;
  createdAt: string;
}

export interface GqlOrganization {
  id: string;
  name: string;
  urlKey: string;
}

export interface GqlWorkflowState {
  id: string;
  name: string;
  type: string;
  position?: number;
}

export interface GqlTeam {
  id: string;
  key: string;
  name: string;
  states?: { nodes: GqlWorkflowState[] };
}

export interface GqlLabel {
  id: string;
  name: string;
  team?: { id: string; key: string } | null;
}

export interface GqlComment {
  id: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  parent?: { id: string } | null;
  user?: GqlUser | null;
  externalUser?: { id: string; name: string } | null;
}

export interface GqlProjectStatus {
  name: string;
  type: string;
}

export interface GqlProject {
  id: string;
  name: string;
  description?: string | null;
  url: string;
  /** 0..1 */
  progress: number;
  health?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  status: GqlProjectStatus | null;
  lead?: GqlUser | null;
  teams?: { nodes: Array<{ key: string; name: string }> };
}

export interface GqlIssueSummary {
  id: string;
  identifier: string;
  number: number;
  title: string;
  url: string;
  priority: number;
  priorityLabel: string;
  createdAt: string;
  updatedAt: string;
  state: GqlWorkflowState | null;
  team: GqlTeam | null;
  assignee?: GqlUser | null;
  delegate?: GqlUser | null;
  labels?: { nodes: Array<{ id: string; name: string }> };
  project?: {
    id: string;
    name: string;
    status: GqlProjectStatus | null;
  } | null;
}

export interface GqlIssueRef {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: GqlWorkflowState | null;
  team: GqlTeam | null;
}

export interface GqlIssueDetail extends GqlIssueSummary {
  description?: string | null;
  comments?: {
    nodes: GqlComment[];
    pageInfo: { hasNextPage: boolean };
  };
}
