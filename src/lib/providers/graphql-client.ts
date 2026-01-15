/**
 * GraphQL Client with Rate Limiting and Retry
 * 
 * Handles requests to Goldsky subgraph endpoints with:
 * - Rate limiting (configurable delay between requests)
 * - Exponential backoff retry on failures
 * - Request queuing
 */

const RATE_LIMIT_MS = parseInt(process.env.API_RATE_LIMIT_MS || '100');
const MAX_RETRIES = parseInt(process.env.API_MAX_RETRIES || '3');

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface QueuedRequest<T = unknown> {
  endpoint: string;
  query: string;
  variables?: Record<string, unknown>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

class GraphQLClient {
  private lastRequestTime = 0;
  private queue: QueuedRequest<unknown>[] = [];
  private processing = false;

  /**
   * Execute a GraphQL query with rate limiting and retry
   */
  async query<T>(
    endpoint: string,
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ endpoint, query, variables, resolve: resolve as (value: unknown) => void, reject });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const request = this.queue.shift()!;
      
      // Rate limiting
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < RATE_LIMIT_MS) {
        await this.sleep(RATE_LIMIT_MS - timeSinceLastRequest);
      }

      try {
        const result = await this.executeWithRetry(
          request.endpoint,
          request.query,
          request.variables
        );
        request.resolve(result);
      } catch (error) {
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }

      this.lastRequestTime = Date.now();
    }

    this.processing = false;
  }

  private async executeWithRetry<T>(
    endpoint: string,
    query: string,
    variables?: Record<string, unknown>,
    attempt = 1
  ): Promise<T> {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const json: GraphQLResponse<T> = await response.json();

      if (json.errors && json.errors.length > 0) {
        throw new Error(`GraphQL Error: ${json.errors[0].message}`);
      }

      if (!json.data) {
        throw new Error('No data in GraphQL response');
      }

      return json.data;
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        // Exponential backoff: 1s, 2s, 4s...
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.warn(
          `GraphQL request failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms:`,
          error instanceof Error ? error.message : error
        );
        await this.sleep(delay);
        return this.executeWithRetry(endpoint, query, variables, attempt + 1);
      }
      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance
export const graphqlClient = new GraphQLClient();

/**
 * Execute a GraphQL query
 */
export async function executeGraphQL<T>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  return graphqlClient.query<T>(endpoint, query, variables);
}
