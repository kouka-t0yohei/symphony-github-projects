import test from "node:test";
import assert from "node:assert/strict";

import { GitHubProjectsAdapter } from "./adapter.js";

test("fetchEligibleItems paginates and filters by active states", async () => {
  const calls: Array<string | null> = [];

  const fetchImpl: typeof fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const after = body.variables.after as string | null;
    calls.push(after);

    const page1 = {
      data: {
        user: {
          projectV2: {
            items: {
              nodes: [
                makeNode({ issueId: "ISSUE_1", number: 101, status: "Todo", issueState: "OPEN" }),
                makeNode({ issueId: "ISSUE_2", number: 102, status: "Done", issueState: "OPEN" }),
              ],
              pageInfo: { hasNextPage: true, endCursor: "CURSOR_1" },
            },
          },
        },
        organization: null,
      },
    };

    const page2 = {
      data: {
        user: {
          projectV2: {
            items: {
              nodes: [
                makeNode({ issueId: "ISSUE_3", number: 103, status: "In Progress", issueState: "OPEN" }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
        organization: null,
      },
    };

    return new Response(JSON.stringify(after ? page2 : page1), { status: 200 });
  }) as typeof fetch;

  const adapter = new GitHubProjectsAdapter({
    owner: "kouka-t0yohei",
    projectNumber: 7,
    token: "dummy",
    activeStates: ["todo", "in_progress"],
    fetchImpl,
    pageSize: 2,
  });

  const eligible = await adapter.fetchEligibleItems();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [null, "CURSOR_1"]);
  assert.deepEqual(
    eligible.map((item) => item.number),
    [101, 103],
  );
});

test("fetchByIssueNumbers returns only matched issue numbers", async () => {
  const fetchImpl: typeof fetch = (async () => {
    const body = {
      data: {
        user: {
          projectV2: {
            items: {
              nodes: [
                makeNode({ issueId: "ISSUE_7", number: 201, status: "Todo", issueState: "OPEN" }),
                makeNode({ issueId: "ISSUE_8", number: 202, status: "In Progress", issueState: "OPEN" }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
        organization: null,
      },
    };

    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  const adapter = new GitHubProjectsAdapter({
    owner: "kouka-t0yohei",
    projectNumber: 7,
    token: "dummy",
    activeStates: ["todo"],
    fetchImpl,
  });

  const reconciled = await adapter.fetchByIssueNumbers([202]);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.number, 202);
});

test("throws on GraphQL errors", async () => {
  const fetchImpl: typeof fetch = (async () => {
    return new Response(
      JSON.stringify({
        data: null,
        errors: [{ message: "API rate limit exceeded" }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const adapter = new GitHubProjectsAdapter({
    owner: "kouka-t0yohei",
    projectNumber: 7,
    token: "dummy",
    activeStates: ["todo"],
    fetchImpl,
  });

  await assert.rejects(async () => adapter.fetchEligibleItems(), /rate limit exceeded/i);
});

function makeNode(input: {
  issueId: string;
  number: number;
  status: string;
  issueState: "OPEN" | "CLOSED";
}) {
  return {
    id: `PITEM_${input.number}`,
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: input.status,
          field: { name: "Status" },
        },
      ],
    },
    content: {
      __typename: "Issue",
      id: input.issueId,
      number: input.number,
      title: `Issue ${input.number}`,
      body: "",
      url: `https://github.com/kouka-t0yohei/symphony-github-projects/issues/${input.number}`,
      updatedAt: "2026-03-06T00:00:00Z",
      state: input.issueState,
      labels: { nodes: [] },
      assignees: { nodes: [] },
    },
  };
}
