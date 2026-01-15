/**
 * Debug script to test Gamma API directly
 */

export {};

const GAMMA_API = 'https://gamma-api.polymarket.com';

async function debugGammaAPI() {
  console.log('=== Debugging Gamma API ===\n');

  // Test 1: Search for Bitcoin markets
  console.log('1. Search for Bitcoin markets...');
  try {
    const r1 = await fetch(`${GAMMA_API}/markets?_q=bitcoin&active=true&limit=50`);
    if (r1.ok) {
      const data = await r1.json();
      console.log(`   Found: ${Array.isArray(data) ? data.length : 0} markets`);
      
      if (Array.isArray(data)) {
        data.slice(0, 10).forEach((m: any) => {
          const q = (m.question || '').substring(0, 60);
          const s = (m.slug || '').substring(0, 40);
          console.log(`   - ${q}... (${s})`);
        });
      }
    }
  } catch (e: any) {
    console.log(`   Error: ${e.message}`);
  }

  // Test 2: Search for "up or down"
  console.log('\n2. Search for "up or down"...');
  try {
    const r2 = await fetch(`${GAMMA_API}/markets?_q=up%20or%20down&active=true&limit=50`);
    if (r2.ok) {
      const data = await r2.json();
      console.log(`   Found: ${Array.isArray(data) ? data.length : 0} markets`);
      
      if (Array.isArray(data)) {
        data.slice(0, 10).forEach((m: any) => {
          const q = (m.question || '').substring(0, 60);
          const s = (m.slug || '').substring(0, 40);
          console.log(`   - ${q}... (${s})`);
        });
      }
    }
  } catch (e: any) {
    console.log(`   Error: ${e.message}`);
  }

  // Test 3: Check all active markets for BTC patterns
  console.log('\n3. Check all active for BTC patterns...');
  try {
    const r3 = await fetch(`${GAMMA_API}/markets?active=true&limit=1000`);
    if (r3.ok) {
      const data = await r3.json();
      console.log(`   Total: ${Array.isArray(data) ? data.length : 0}`);
      
      if (Array.isArray(data)) {
        // Find any market with btc in slug or question
        const btcMarkets = data.filter((m: any) => {
          const q = (m.question || '').toLowerCase();
          const s = (m.slug || '').toLowerCase();
          return (q.includes('bitcoin') || q.includes('btc') || s.includes('btc')) &&
                 (q.includes('up') || s.includes('up'));
        });
        
        console.log(`   BTC Up markets: ${btcMarkets.length}`);
        btcMarkets.slice(0, 10).forEach((m: any) => {
          console.log(`   - ${m.question || m.slug}`);
          console.log(`     Slug: ${m.slug}`);
          console.log(`     Tokens: ${m.tokens?.length || 0}`);
        });
      }
    }
  } catch (e: any) {
    console.log(`   Error: ${e.message}`);
  }

  // Test 4: Try CLOB API sampling endpoint
  console.log('\n4. CLOB API sampling...');
  try {
    const r4 = await fetch('https://clob.polymarket.com/sampling-markets');
    if (r4.ok) {
      const data = await r4.json();
      console.log(`   Type: ${typeof data}, isArray: ${Array.isArray(data)}`);
      if (Array.isArray(data)) {
        console.log(`   Count: ${data.length}`);
        // Check for btc in data
        const btc = data.filter((m: any) => {
          const str = JSON.stringify(m).toLowerCase();
          return str.includes('btc') || str.includes('bitcoin');
        });
        console.log(`   BTC related: ${btc.length}`);
      } else if (typeof data === 'object') {
        console.log(`   Keys: ${Object.keys(data).join(', ')}`);
      }
    } else {
      console.log(`   Status: ${r4.status}`);
    }
  } catch (e: any) {
    console.log(`   Error: ${e.message}`);
  }

  // Test 5: CLOB sampling data
  console.log('\n5. CLOB sampling data...');
  try {
    const r5 = await fetch('https://clob.polymarket.com/sampling-markets');
    if (r5.ok) {
      const data = await r5.json();
      if (data.data && Array.isArray(data.data)) {
        console.log(`   Total markets in CLOB: ${data.count || data.data.length}`);
        
        // Find BTC markets
        const btcMarkets = data.data.filter((m: any) => {
          const q = (m.question || '').toLowerCase();
          return q.includes('bitcoin') || q.includes('btc');
        });
        console.log(`   BTC markets: ${btcMarkets.length}`);
        btcMarkets.slice(0, 5).forEach((m: any) => {
          console.log(`   - ${m.question}`);
          console.log(`     Condition: ${m.condition_id}`);
        });
      }
    }
  } catch (e: any) {
    console.log(`   Error: ${e.message}`);
  }

  // Test 6: CLOB markets endpoint
  console.log('\n6. CLOB /markets endpoint...');
  try {
    const r6 = await fetch('https://clob.polymarket.com/markets?next_cursor=MA==');
    if (r6.ok) {
      const data = await r6.json();
      console.log(`   Type: ${typeof data}`);
      if (data && typeof data === 'object') {
        console.log(`   Keys: ${Object.keys(data).slice(0, 10).join(', ')}`);
        // Check if it's a map of token_id -> market
        const keys = Object.keys(data);
        if (keys.length > 0) {
          const first = data[keys[0]];
          console.log(`   First item type: ${typeof first}`);
          if (typeof first === 'object') {
            console.log(`   First item keys: ${Object.keys(first).join(', ')}`);
          }
        }
      }
    }
  } catch (e: any) {
    console.log(`   Error: ${e.message}`);
  }

  // Test 7: Direct token lookup from known market - FULL DATA
  console.log('\n7. Try known BTC 15m market URL structure (full data)...');
  const timestamp = 1768391100; // From your URL
  try {
    const r7 = await fetch(`${GAMMA_API}/markets?slug=btc-updown-15m-${timestamp}`);
    console.log(`   Gamma slug query: ${r7.status}`);
    if (r7.ok) {
      const data = await r7.json();
      const market = Array.isArray(data) ? data[0] : data;
      console.log(`   Question: ${market?.question}`);
      console.log(`   conditionId: ${market?.conditionId || market?.condition_id}`);
      
      // Debug: show EXACT types
      console.log(`   outcomes type: ${typeof market?.outcomes}`);
      console.log(`   outcomes isArray: ${Array.isArray(market?.outcomes)}`);
      console.log(`   outcomes value: ${JSON.stringify(market?.outcomes)}`);
      console.log(`   clobTokenIds type: ${typeof market?.clobTokenIds}`);
      console.log(`   clobTokenIds isArray: ${Array.isArray(market?.clobTokenIds)}`);
      console.log(`   clobTokenIds value: ${JSON.stringify(market?.clobTokenIds)}`);
      console.log(`   endDateIso: ${market?.endDateIso}`);
    }
  } catch (e: any) {
    console.log(`   Error: ${e.message}`);
  }

  // Test 7b: Try condition_id query for full market
  console.log('\n7b. Query by condition_id for full tokens...');
  try {
    const conditionId = '0x048d40ed3a1950fc9924c1a5a042ed092599fe92667df6fa1621eb558d6bad75';
    const r7b = await fetch(`${GAMMA_API}/markets?condition_id=${conditionId}`);
    if (r7b.ok) {
      const data = await r7b.json();
      const market = Array.isArray(data) ? data[0] : data;
      console.log(`   Tokens: ${market?.tokens?.length || 'undefined'}`);
      if (market?.tokens) {
        market.tokens.forEach((t: any, i: number) => {
          console.log(`     Token ${i}: outcome=${t.outcome}, token_id=${t.token_id}`);
        });
      }
    }
  } catch (e: any) {
    console.log(`   Error: ${e.message}`);
  }

  // Test 8: Try events API for 15m
  console.log('\n8. Events API for crypto/15m...');
  try {
    const r8 = await fetch(`${GAMMA_API}/events?tag=15m&limit=20`);
    console.log(`   Status: ${r8.status}`);
    if (r8.ok) {
      const data = await r8.json();
      console.log(`   Count: ${Array.isArray(data) ? data.length : 'not array'}`);
      if (Array.isArray(data)) {
        data.slice(0, 5).forEach((e: any) => {
          console.log(`   - ${e.title || e.slug}`);
        });
      }
    }
  } catch (e: any) {
    console.log(`   Error: ${e.message}`);
  }

  console.log('\n=== Done ===');
}

debugGammaAPI();
