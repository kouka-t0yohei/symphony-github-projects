import type { Logger } from "../logging/logger.js";
import type { NormalizedWorkItem, WorkItemState } from "../model/work-item.js";

type FetchLike = typeof fetch;

export interface TrackerAdapter {
  listEligibleItems(): Promise<NormalizedWorkItem[]>;
  markInProgress(itemId: string): Promise<void>;
  markDone(itemId: string): Promise<void>;
}

export interface GitHubProjectsAdapterOptions {
  owner: string;
  projectNumber: number;
  token: string;
  activeStates: string[];
  pageSize?: number;
  fetchImpl?: FetchLike;
  logger?: Logger;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; type?: string }>;
}

interface ProjectItemsQueryData {
  user?: { projectV2: ProjectV2Node | null } | null;
  organization?: { projectV2: ProjectV2Node | null } | null;
}

interface ProjectV2Node {
  items: {
    nodes: ProjectItemNode[];
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}

interface ProjectItemNode {
  id: string;
  content?: IssueNode | null;
  fieldValues: {
    nodes: Array<
      | {
          __typename: "ProjectV2ItemFieldSingleSelectValue";
          name: string;
          field?: { name: string } | null;
        }
      | {
          __typename: string;
        }
    >;
  };
}

interface IssueNode {
  __typename: "Issue";
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
  state: "OPEN" | "CLOSED";
  labels: { nodes: Array<{ name: string }> };
  assignees: { nodes: Array<{ login: string }> };
}

const PROJECT_ITEMS_QUERY = `
  query ProjectItems($owner: String!, $projectNumber: Int!, $after: String, $pageSize: Int!) {
    user(login: $owner) {
      projectV2(number: $projectNumber) {
        items(first: $pageSize, after: $after) {
          nodes {
            id
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field {
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
              }
            }
            content {
              __typename
              ... on Issue {
                id
                number
                title
                body
                url
                updatedAt
                state
                labels(first: 20) {
                  nodes {
                    name
                  }
                }
                assignees(first: 20) {
                  nodes {
                    login
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
    organization(login: $owner) {
      projectV2(number: $projectNumber) {
        items(first: $pageSize, after: $after) {
          nodes {
            id
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field {
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
              }
            }
            content {
              __typename
              ... on Issue {
                id
                number
                title
                body
                url
                updatedAt
                state
                labels(first: 20) {
                  nodes {
                    name
                  }
                }
                assignees(first: 20) {
                  nodes {
                    login
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

export class GitHubProjectsAdapter implements TrackerAdapter {
  private readonly fetchImpl: FetchLike;
  private readonly pageSize: number;
  private readonly activeStates: Set<string>;

  constructor(private readonly options: GitHubProjectsAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pageSize = options.pageSize ?? 50;
    this.activeStates = new Set(options.activeStates.map(normalizeState));
  }

  async listEligibleItems(): Promise<NormalizedWorkItem[]> {
    return this.fetchEligibleItems();
  }

  async fetchEligibleItems(): Promise<NormalizedWorkItem[]> {
    const items = await this.fetchAllProjectItems();
    return items.filter((item) => this.activeStates.has(normalizeState(item.state)));
  }

  async fetchByIssueNumbers(issueNumbers: number[]): Promise<NormalizedWorkItem[]> {
    if (issueNumbers.length === 0) {
      return [];
    }

    const wanted = new Set(issueNumbers);
    const items = await this.fetchAllProjectItems();
    return items.filter((item) => item.number !== undefined && wanted.has(item.number));
  }

  async markInProgress(_itemId: string): Promise<void> {
    throw new Error("GitHub Projects write path not implemented yet");
  }

  async markDone(_itemId: string): Promise<void> {
    throw new Error("GitHub Projects write path not implemented yet");
  }

  private async fetchAllProjectItems(): Promise<NormalizedWorkItem[]> {
    const items: NormalizedWorkItem[] = [];
    const seen = new Set<string>();

    let cursor: string | null = null;
    let hasNextPage = true;
    let page = 0;

    while (hasNextPage) {
      page += 1;
      if (page > 100) {
        throw new Error("GitHub Projects pagination exceeded safe limit (100 pages)");
      }

      const responseData: ProjectItemsQueryData = await this.query<ProjectItemsQueryData>(
        PROJECT_ITEMS_QUERY,
        {
          owner: this.options.owner,
          projectNumber: this.options.projectNumber,
          after: cursor,
          pageSize: this.pageSize,
        },
      );

      const project: ProjectV2Node | null | undefined =
        responseData.user?.projectV2 ?? responseData.organization?.projectV2;
      if (!project) {
        throw new Error(
          `Project #${this.options.projectNumber} not found for owner ${this.options.owner}`,
        );
      }

      for (const node of project.items.nodes) {
        const normalized = mapProjectItem(node);
        if (!normalized || seen.has(normalized.id)) {
          continue;
        }
        seen.add(normalized.id);
        items.push(normalized);
      }

      hasNextPage = project.items.pageInfo.hasNextPage;
      cursor = project.items.pageInfo.endCursor;
    }

    this.options.logger?.info("tracker.github_projects.fetch", {
      fetchedCount: items.length,
      projectNumber: this.options.projectNumber,
      owner: this.options.owner,
    });

    return items;
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const httpResponse: Response = await this.fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!httpResponse.ok) {
      const bodyText = await httpResponse.text();
      throw new Error(`GitHub GraphQL request failed (${httpResponse.status}): ${bodyText}`);
    }

    const payload = (await httpResponse.json()) as GraphQLResponse<T>;
    if (payload.errors && payload.errors.length > 0) {
      const message = payload.errors.map((error) => error.message).join("; ");
      throw new Error(`GitHub GraphQL returned errors: ${message}`);
    }

    if (!payload.data) {
      throw new Error("GitHub GraphQL returned an empty response body");
    }

    return payload.data;
  }
}

export class GitHubProjectsAdapterPlaceholder extends GitHubProjectsAdapter {
  constructor() {
    super({
      owner: "",
      projectNumber: 0,
      token: "",
      activeStates: [],
      fetchImpl: async () => {
        throw new Error("GitHub Projects adapter placeholder is not configured");
      },
    });
  }
}

function mapProjectItem(node: ProjectItemNode): NormalizedWorkItem | null {
  if (!node.content || node.content.__typename !== "Issue") {
    return null;
  }

  const issue = node.content;
  const statusFromField = findProjectStatus(node);
  const derivedState = statusFromField ?? (issue.state === "CLOSED" ? "done" : "todo");

  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    updatedAt: issue.updatedAt,
    state: coerceWorkItemState(derivedState),
    labels: issue.labels.nodes.map((label) => label.name),
    assignees: issue.assignees.nodes.map((assignee) => assignee.login),
  };
}

function findProjectStatus(node: ProjectItemNode): string | undefined {
  for (const value of node.fieldValues.nodes) {
    if (!isSingleSelectFieldValue(value)) {
      continue;
    }

    const fieldName = value.field?.name?.toLowerCase();
    if (!fieldName) {
      continue;
    }

    if (fieldName === "status" || fieldName.includes("state")) {
      return value.name;
    }
  }

  return undefined;
}

function isSingleSelectFieldValue(
  value: ProjectItemNode["fieldValues"]["nodes"][number],
): value is Extract<
  ProjectItemNode["fieldValues"]["nodes"][number],
  { __typename: "ProjectV2ItemFieldSingleSelectValue" }
> {
  return value.__typename === "ProjectV2ItemFieldSingleSelectValue";
}

function normalizeState(state: string): string {
  return state.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function coerceWorkItemState(state: string): WorkItemState {
  const normalized = normalizeState(state);
  if (normalized === "in_progress" || normalized === "inprogress") {
    return "in_progress";
  }
  if (normalized === "blocked") {
    return "blocked";
  }
  if (normalized === "done" || normalized === "closed") {
    return "done";
  }
  return "todo";
}
