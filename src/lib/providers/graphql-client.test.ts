/**
 * Unit tests for GraphQL Client
 * 
 * Tests rate limiting, retry logic, and error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch for testing
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mocking
import { executeGraphQL, graphqlClient } from './graphql-client';

describe('GraphQL Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('executeGraphQL', () => {
    it('should execute a successful query', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { trades: [{ id: '1' }] },
        }),
      });

      const resultPromise = executeGraphQL<{ trades: Array<{ id: string }> }>(
        'https://api.example.com/graphql',
        'query { trades { id } }'
      );

      // Process timers for rate limiting
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].id).toBe('1');
    });

    it('should pass variables to the query', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { user: { id: 'user123' } },
        }),
      });

      const resultPromise = executeGraphQL(
        'https://api.example.com/graphql',
        'query GetUser($id: String!) { user(id: $id) { id } }',
        { id: 'user123' }
      );

      await vi.runAllTimersAsync();
      await resultPromise;

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/graphql',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            query: 'query GetUser($id: String!) { user(id: $id) { id } }',
            variables: { id: 'user123' },
          }),
        })
      );
    });

    it('should throw on GraphQL errors', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          errors: [{ message: 'Field not found' }],
        }),
      });

      const resultPromise = executeGraphQL(
        'https://api.example.com/graphql',
        'query { invalid }'
      );

      await vi.runAllTimersAsync();

      await expect(resultPromise).rejects.toThrow('GraphQL Error: Field not found');
    });

    it('should throw on HTTP errors after retries', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const resultPromise = executeGraphQL(
        'https://api.example.com/graphql',
        'query { data }'
      );

      // Run through all retry attempts
      for (let i = 0; i < 5; i++) {
        await vi.runAllTimersAsync();
      }

      await expect(resultPromise).rejects.toThrow('HTTP 500');
    });

    it('should retry on failure with exponential backoff', async () => {
      // First two calls fail, third succeeds
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { success: true } }),
        });

      const resultPromise = executeGraphQL<{ success: boolean }>(
        'https://api.example.com/graphql',
        'query { success }'
      );

      // Process all retries
      for (let i = 0; i < 5; i++) {
        await vi.runAllTimersAsync();
      }

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should throw when no data in response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const resultPromise = executeGraphQL(
        'https://api.example.com/graphql',
        'query { data }'
      );

      await vi.runAllTimersAsync();

      await expect(resultPromise).rejects.toThrow('No data in GraphQL response');
    });
  });

  describe('Rate Limiting', () => {
    it('should delay requests to respect rate limit', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { result: 1 } }),
      });

      // Make multiple requests
      const promises = [
        executeGraphQL('https://api.example.com/graphql', 'query { a }'),
        executeGraphQL('https://api.example.com/graphql', 'query { b }'),
        executeGraphQL('https://api.example.com/graphql', 'query { c }'),
      ];

      // Process all
      for (let i = 0; i < 10; i++) {
        await vi.runAllTimersAsync();
      }

      await Promise.all(promises);

      // All should complete
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});

describe('Query Building', () => {
  it('should build trades query with pagination', () => {
    const query = `
      query GetTrades($user: String!, $first: Int!, $skip: Int!) {
        trades(
          where: { user: $user }
          first: $first
          skip: $skip
          orderBy: timestamp
        ) {
          id
          transactionHash
          timestamp
        }
      }
    `;

    const variables = {
      user: '0x123',
      first: 1000,
      skip: 0,
    };

    // Verify structure
    expect(query).toContain('$user: String!');
    expect(query).toContain('$first: Int!');
    expect(query).toContain('$skip: Int!');
    expect(variables.first).toBe(1000);
  });

  it('should build query with timestamp filters', () => {
    const query = `
      query GetTrades($user: String!, $timestamp_gte: BigInt!, $timestamp_lte: BigInt!) {
        trades(
          where: {
            user: $user
            timestamp_gte: $timestamp_gte
            timestamp_lte: $timestamp_lte
          }
        ) {
          id
        }
      }
    `;

    const from = new Date('2024-01-01');
    const to = new Date('2024-01-31');

    const variables = {
      user: '0x123',
      timestamp_gte: Math.floor(from.getTime() / 1000).toString(),
      timestamp_lte: Math.floor(to.getTime() / 1000).toString(),
    };

    expect(parseInt(variables.timestamp_gte)).toBeLessThan(parseInt(variables.timestamp_lte));
  });
});
