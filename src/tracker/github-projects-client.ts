import { GraphQLClient, GraphQLError } from './graphql-client.js';

export class TrackerTransportError extends Error {
  constructor(message: string, public readonly causeError?: unknown) {
    super(message);
    this.name = 'TrackerTransportError';
  }
}

export class TrackerStatusError extends Error {
  constructor(public readonly status: number, message?: string) {
    super(message ?? `Tracker request failed with status ${status}`);
    this.name = 'TrackerStatusError';
  }
}

export class TrackerGraphQLError extends Error {
  constructor(message: string, public readonly errors: Array<{ message: string }>) {
    super(message);
    this.name = 'TrackerGraphQLError';
  }
}

export class TrackerMalformedPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackerMalformedPayloadError';
  }
}

interface ProjectV2FieldNode {
  name?: string | null;
}

interface FieldTextValueNode {
  __typename: 'ProjectV2ItemFieldTextValue';
  text?: string | null;
  field?: ProjectV2FieldNode | null;
}

interface FieldSingleSelectValueNode {
  __typename: 'ProjectV2ItemFieldSingleSelectValue';
  name?: string | null;
  field?: ProjectV2FieldNode | null;
}

interface FieldNumberValueNode {
  __typename: 'ProjectV2ItemFieldNumberValue';
  number?: number | null;
  field?: ProjectV2FieldNode | null;
}

interface UnknownFieldValueNode {
  __typename: string;
  field?: ProjectV2FieldNode | null;
}

type ProjectV2ItemFieldValueNode =
  | FieldTextValueNode
  | FieldSingleSelectValueNode
  | FieldNumberValueNode
  | UnknownFieldValueNode;

export interface ProjectItemNode {
  id: string;
  content: {
    __typename: 'Issue' | 'PullRequest';
    number: number;
    title: string;
    body?: string;
    url?: string;
    state?: string;
    labels?: { nodes?: Array<{ name: string | null } | null> | null };
    createdAt?: string;
    updatedAt?: string;
  } | null;
  fieldValues?: {
    nodes?: Array<ProjectV2ItemFieldValueNode | null> | null;
  };
}

export interface ProjectItemsPage {
  items: ProjectItemNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface GitHubProjectsClient {
  fetchProjectItemsPage(params: {
    owner: string;
    projectNumber: number;
    ownerType?: 'org' | 'user';
    first: number;
    after?: string;
  }): Promise<ProjectItemsPage>;
  fetchProjectItemsByIds(ids: string[]): Promise<ProjectItemNode[]>;
}

interface ProjectItemsPageQuery {
  user?: {
    projectV2?: {
      items?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<ProjectItemNode | null>;
      };
    };
  };
  organization?: {
    projectV2?: {
      items?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<ProjectItemNode | null>;
      };
    };
  };
}

interface NodesByIdsQuery {
  nodes?: Array<ProjectItemNode | null>;
}

const PROJECT_FIELD_NAME_FRAGMENT = `
  ... on ProjectV2Field {
    name
  }
  ... on ProjectV2SingleSelectField {
    name
  }
  ... on ProjectV2IterationField {
    name
  }
`;

const PROJECT_ITEM_FIELDS_SELECTION = `
  id
  content {
    __typename
    ... on Issue {
      number
      title
      body
      url
      state
      createdAt
      updatedAt
      labels(first: 20) { nodes { name } }
    }
  }
  fieldValues(first: 20) {
    nodes {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
        field {
          ${PROJECT_FIELD_NAME_FRAGMENT}
        }
      }
      ... on ProjectV2ItemFieldTextValue {
        text
        field {
          ${PROJECT_FIELD_NAME_FRAGMENT}
        }
      }
      ... on ProjectV2ItemFieldNumberValue {
        number
        field {
          ${PROJECT_FIELD_NAME_FRAGMENT}
        }
      }
    }
  }
`;

export class GitHubProjectsGraphQLClient implements GitHubProjectsClient {
  constructor(private readonly client: GraphQLClient) {}

  async fetchProjectItemsPage(params: {
    owner: string;
    projectNumber: number;
    ownerType?: 'org' | 'user';
    first: number;
    after?: string;
  }): Promise<ProjectItemsPage> {
    const query = `
      query ProjectItems($owner: String!, $number: Int!, $first: Int!, $after: String, $includeUser: Boolean!, $includeOrg: Boolean!) {
        user(login: $owner) @include(if: $includeUser) {
          projectV2(number: $number) {
            items(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                ${PROJECT_ITEM_FIELDS_SELECTION}
              }
            }
          }
        }
        organization(login: $owner) @include(if: $includeOrg) {
          projectV2(number: $number) {
            items(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                ${PROJECT_ITEM_FIELDS_SELECTION}
              }
            }
          }
        }
      }
    `;

    const ownerType = params.ownerType;
    const data = await this.safeQuery<ProjectItemsPageQuery>(query, {
      owner: params.owner,
      number: params.projectNumber,
      first: params.first,
      after: params.after ?? null,
      includeUser: ownerType !== 'org',
      includeOrg: ownerType !== 'user',
    });

    const connection = data.user?.projectV2?.items ?? data.organization?.projectV2?.items;
    if (!connection) {
      throw new TrackerMalformedPayloadError('Project items connection missing in GraphQL response');
    }

    return {
      items: (connection.nodes ?? []).filter((n): n is ProjectItemNode => Boolean(n)),
      hasNextPage: Boolean(connection.pageInfo?.hasNextPage),
      endCursor: connection.pageInfo?.endCursor ?? null,
    };
  }

  async fetchProjectItemsByIds(ids: string[]): Promise<ProjectItemNode[]> {
    if (ids.length === 0) return [];

    const query = `
      query ProjectItemsByIds($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProjectV2Item {
            ${PROJECT_ITEM_FIELDS_SELECTION}
          }
        }
      }
    `;

    const data = await this.safeQuery<NodesByIdsQuery>(query, { ids });
    return (data.nodes ?? []).filter((n): n is ProjectItemNode => Boolean(n));
  }

  private async safeQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    try {
      return await this.client.query<T>(query, variables);
    } catch (error) {
      if (error instanceof GraphQLError) {
        const m = error.message.toLowerCase();
        if (m.includes('failed:') || m.includes('status')) {
          const status = Number(error.message.match(/(\d{3})/)?.[1] ?? 0);
          throw new TrackerStatusError(status || 500, error.message);
        }
        if (error.errors.length > 0) {
          throw new TrackerGraphQLError(error.message, error.errors);
        }
        throw new TrackerMalformedPayloadError(error.message);
      }
      throw new TrackerTransportError('Failed to communicate with tracker backend', error);
    }
  }
}
