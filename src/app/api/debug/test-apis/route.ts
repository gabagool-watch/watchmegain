/**
 * Debug API to test which Polymarket endpoints work
 * GET /api/debug/test-apis?address=0x...
 */

import { NextRequest, NextResponse } from 'next/server';

const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';
const POLYMARKET_CLOB_API = 'https://clob.polymarket.com';
const GAMMA_MARKETS_API = 'https://gamma-api.polymarket.com';

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address');
  
  if (!address) {
    return NextResponse.json({ error: 'Missing address parameter' }, { status: 400 });
  }

  const addr = address.toLowerCase();
  
  // All possible endpoints to try
  const endpoints = [
    // Polymarket website API
    `https://polymarket.com/api/profile/${addr}`,
    `https://polymarket.com/api/profile/${addr}/trades`,
    `https://polymarket.com/api/profile/${addr}/positions`,
    `https://polymarket.com/api/profile/${addr}/history`,
    
    // Data API
    `${POLYMARKET_DATA_API}/trades?user=${addr}`,
    `${POLYMARKET_DATA_API}/trades?address=${addr}`,
    `${POLYMARKET_DATA_API}/activity?user=${addr}`,
    `${POLYMARKET_DATA_API}/activity?address=${addr}`,
    `${POLYMARKET_DATA_API}/positions?user=${addr}`,
    `${POLYMARKET_DATA_API}/profile/${addr}`,
    `${POLYMARKET_DATA_API}/users/${addr}/trades`,
    `${POLYMARKET_DATA_API}/users/${addr}/positions`,
    
    // CLOB API
    `${POLYMARKET_CLOB_API}/data/trade-history?maker=${addr}`,
    `${POLYMARKET_CLOB_API}/data/trade-history?taker=${addr}`,
    `${POLYMARKET_CLOB_API}/orders?maker=${addr}`,
    `${POLYMARKET_CLOB_API}/trades?maker=${addr}`,
    
    // Gamma API
    `${GAMMA_MARKETS_API}/trades?user=${addr}`,
    `${GAMMA_MARKETS_API}/trades?maker=${addr}`,
    `${GAMMA_MARKETS_API}/activity?user=${addr}`,
    `${GAMMA_MARKETS_API}/user/${addr}/trades`,
    `${GAMMA_MARKETS_API}/users/${addr}`,
  ];

  const results: Array<{
    endpoint: string;
    status: number;
    dataType: string;
    count: number | string;
    sample?: unknown;
    error?: string;
  }> = [];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'PnLTracker/1.0',
        },
      });

      if (!response.ok) {
        results.push({
          endpoint,
          status: response.status,
          dataType: 'error',
          count: 0,
          error: response.statusText,
        });
        continue;
      }

      const data = await response.json();
      
      // Analyze the response
      let count: number | string = 0;
      let dataType: string = typeof data;
      let sample: unknown = undefined;

      if (Array.isArray(data)) {
        count = data.length;
        dataType = 'array';
        if (data.length > 0) {
          sample = {
            keys: Object.keys(data[0]),
            firstItem: JSON.stringify(data[0]).slice(0, 200),
          };
        }
      } else if (data && typeof data === 'object') {
        dataType = 'object';
        const keys = Object.keys(data);
        count = `object with ${keys.length} keys: ${keys.slice(0, 5).join(', ')}`;
        
        // Check for nested arrays
        for (const key of keys) {
          if (Array.isArray(data[key])) {
            count = `${key}: ${data[key].length} items`;
            if (data[key].length > 0) {
              sample = {
                keys: Object.keys(data[key][0]),
                firstItem: JSON.stringify(data[key][0]).slice(0, 200),
              };
            }
            break;
          }
        }
      }

      results.push({
        endpoint,
        status: response.status,
        dataType,
        count,
        sample,
      });

    } catch (error) {
      results.push({
        endpoint,
        status: 0,
        dataType: 'error',
        count: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Sort by count (most data first)
  const sorted = results.sort((a, b) => {
    const aCount = typeof a.count === 'number' ? a.count : 0;
    const bCount = typeof b.count === 'number' ? b.count : 0;
    return bCount - aCount;
  });

  // Find working endpoints
  const working = sorted.filter(r => r.status === 200 && (
    (typeof r.count === 'number' && r.count > 0) ||
    (typeof r.count === 'string' && !r.count.includes('0'))
  ));

  return NextResponse.json({
    address: addr,
    totalEndpoints: endpoints.length,
    workingEndpoints: working.length,
    results: sorted,
    recommendation: working.length > 0 
      ? `Best endpoint: ${working[0].endpoint} with ${working[0].count} items`
      : 'No working endpoints found - check if address has trades on Polymarket',
  });
}
