/**
 * Test script to see what the Gamma API actually returns
 */

export {};

const GAMMA_API = 'https://gamma-api.polymarket.com';

async function testGammaAPI() {
  console.log('🔍 Testing Gamma API...\n');

  try {
    // Test 1: Fetch active markets
    console.log('Test 1: Fetching active markets...');
    const response = await fetch(`${GAMMA_API}/markets?active=true&limit=50`);
    
    if (!response.ok) {
      console.error(`❌ API error: ${response.status} ${response.statusText}`);
      return;
    }

    const data = await response.json();
    console.log(`✅ Got response, type: ${Array.isArray(data) ? 'array' : typeof data}`);
    console.log(`   Length: ${Array.isArray(data) ? data.length : 'N/A'}\n`);

    if (Array.isArray(data) && data.length > 0) {
      console.log('Sample market structure:');
      const sample = data[0];
      console.log('Keys:', Object.keys(sample));
      console.log('Question:', sample.question);
      console.log('Slug:', sample.slug);
      console.log('Condition ID:', sample.condition_id);
      console.log('End date:', sample.end_date_iso);
      console.log('Tokens:', sample.tokens?.length || 0);
      if (sample.tokens && sample.tokens.length > 0) {
        console.log('Token structure:', JSON.stringify(sample.tokens[0], null, 2));
      }
      console.log('\n');

      // Search for BTC markets
      console.log('Searching for BTC-related markets...');
      const btcMarkets = data.filter((m: any) => {
        const question = (m.question || '').toLowerCase();
        const slug = (m.slug || '').toLowerCase();
        return question.includes('bitcoin') || question.includes('btc') || slug.includes('btc');
      });

      console.log(`Found ${btcMarkets.length} BTC-related markets:\n`);
      btcMarkets.slice(0, 10).forEach((m: any, i: number) => {
        console.log(`${i + 1}. ${m.question || m.slug || 'Unknown'}`);
        console.log(`   Slug: ${m.slug || 'N/A'}`);
        console.log(`   Condition ID: ${m.condition_id || 'N/A'}`);
        console.log(`   End date: ${m.end_date_iso || 'N/A'}`);
        console.log(`   Tokens: ${m.tokens?.length || 0}`);
        if (m.tokens) {
          m.tokens.forEach((t: any, idx: number) => {
            console.log(`     ${idx}: outcome="${t.outcome}", token_id="${t.token_id}"`);
          });
        }
        console.log('');
      });
    }
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

testGammaAPI();
