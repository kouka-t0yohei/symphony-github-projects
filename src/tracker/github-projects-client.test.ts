import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubProjectsGraphQLClient } from './github-projects-client.js';

class FakeGraphQLClient {
  public calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];

  async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    this.calls.push({ query, variables });
    return {
      user: {
        projectV2: {
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    } as T;
  }
}

test('uses inline fragments when selecting ProjectV2 field names', async () => {
  const fake = new FakeGraphQLClient();
  const client = new GitHubProjectsGraphQLClient(fake as never);

  await client.fetchProjectItemsPage({
    owner: 't0yohei',
    projectNumber: 1,
    first: 10,
  });

  const query = fake.calls[0]?.query ?? '';
  assert.match(query, /field\s*\{[\s\S]*\.\.\. on ProjectV2Field[\s\S]*name[\s\S]*\}/);
  assert.match(query, /\.\.\. on ProjectV2SingleSelectField/);
  assert.match(query, /\.\.\. on ProjectV2IterationField/);
  assert.doesNotMatch(query, /field\s*\{\s*name\s*\}/);
});
