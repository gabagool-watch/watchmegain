/**
 * Data Provider Factory
 * 
 * Creates the appropriate data provider based on configuration.
 * Uses environment variable DATA_PROVIDER to select:
 * - "mock" - Mock data for development/testing
 * - "polymarket" - Real Polymarket data via Goldsky + Gamma API
 */

import type { IDataProvider } from './types';
import { createMockProvider } from './mock-provider';
import { createPolymarketProvider } from './polymarket-provider';

export * from './types';
export * from './mock-provider';
export * from './polymarket-provider';
export * from './graphql-client';

type ProviderType = 'mock' | 'polymarket';

let currentProvider: IDataProvider | null = null;

/**
 * Get or create the data provider based on DATA_PROVIDER env var
 */
export function getProvider(type?: ProviderType): IDataProvider {
  if (currentProvider) {
    return currentProvider;
  }

  // Use env var if no type specified
  const providerType = type || (process.env.DATA_PROVIDER as ProviderType) || 'mock';

  switch (providerType) {
    case 'polymarket':
      console.log('Using Polymarket provider (Goldsky + Gamma API)');
      currentProvider = createPolymarketProvider();
      break;
    case 'mock':
    default:
      console.log('Using Mock provider');
      currentProvider = createMockProvider();
      break;
  }

  return currentProvider;
}

/**
 * Reset provider (useful for testing)
 */
export function resetProvider(): void {
  currentProvider = null;
}

/**
 * Get current provider type from env
 */
export function getProviderType(): ProviderType {
  return (process.env.DATA_PROVIDER as ProviderType) || 'mock';
}
