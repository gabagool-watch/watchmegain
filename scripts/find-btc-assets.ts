/**
 * Script to find BTC 15m UP/DOWN asset IDs and update .env
 * 
 * Usage: npm run find-btc-assets
 */

export {};

const GAMMA_API = 'https://gamma-api.polymarket.com';
const fs = require('fs');
const path = require('path');

async function findAndUpdateAssets() {
  console.log('🔍 Searching for active BTC 15m market...\n');

  try {
    // Fetch active markets
    const response = await fetch(`${GAMMA_API}/markets?active=true&limit=200`);
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const markets = await response.json();
    
    // Find BTC 15m markets
    const btcMarkets = markets.filter((m: any) => {
      const question = (m.question || '').toLowerCase();
      const slug = (m.slug || '').toLowerCase();
      return (
        (question.includes('bitcoin') || question.includes('btc')) &&
        (question.includes('15m') || question.includes('15 min') || slug.includes('btc-updown-15m'))
      );
    });

    if (btcMarkets.length === 0) {
      console.error('❌ No BTC 15m markets found');
      process.exit(1);
    }

    // Find active market (or next upcoming)
    const now = new Date();
    let activeMarket = null;

    for (const market of btcMarkets) {
      if (!market.tokens || market.tokens.length < 2) continue;

      const upToken = market.tokens.find((t: any) => 
        (t.outcome || '').toLowerCase().includes('up')
      );
      const downToken = market.tokens.find((t: any) => 
        (t.outcome || '').toLowerCase().includes('down')
      );

      if (!upToken || !downToken) continue;

      const endTime = market.end_date_iso ? new Date(market.end_date_iso) : null;
      if (!endTime) continue;

      const startTime = new Date(endTime.getTime() - 15 * 60 * 1000);
      const isActive = now >= startTime && now <= endTime;

      if (isActive || !activeMarket) {
        activeMarket = {
          question: market.question,
          conditionId: market.condition_id,
          upTokenId: upToken.token_id,
          downTokenId: downToken.token_id,
          isActive,
          endTime,
        };
        
        if (isActive) break; // Found active, use this one
      }
    }

    if (!activeMarket) {
      console.error('❌ No suitable BTC 15m market found');
      process.exit(1);
    }

    console.log('✅ Found market:');
    console.log(`   Question: ${activeMarket.question}`);
    console.log(`   Condition ID: ${activeMarket.conditionId}`);
    console.log(`   UP Token ID: ${activeMarket.upTokenId}`);
    console.log(`   DOWN Token ID: ${activeMarket.downTokenId}`);
    console.log(`   Active: ${activeMarket.isActive ? 'Yes' : 'No (upcoming)'}\n`);

    // Read .env file
    const envPath = path.join(process.cwd(), '.env');
    let envContent = '';

    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf-8');
    } else {
      // If .env doesn't exist, read from .env.example
      const examplePath = path.join(process.cwd(), 'env.example');
      if (fs.existsSync(examplePath)) {
        envContent = fs.readFileSync(examplePath, 'utf-8');
        // Create .env from example
        fs.writeFileSync(envPath, envContent, 'utf-8');
        console.log('📝 Created .env from env.example\n');
      }
    }

    // Update or add asset IDs
    const lines = envContent.split('\n');
    const updatedLines: string[] = [];
    let foundUpAsset = false;
    let foundDownAsset = false;

    for (const line of lines) {
      if (line.startsWith('POLYMARKET_BTC_UP_ASSET_ID=')) {
        updatedLines.push(`POLYMARKET_BTC_UP_ASSET_ID="${activeMarket.upTokenId}"`);
        foundUpAsset = true;
      } else if (line.startsWith('POLYMARKET_BTC_DOWN_ASSET_ID=')) {
        updatedLines.push(`POLYMARKET_BTC_DOWN_ASSET_ID="${activeMarket.downTokenId}"`);
        foundDownAsset = true;
      } else {
        updatedLines.push(line);
      }
    }

    // Add if not found
    if (!foundUpAsset) {
      updatedLines.push(`POLYMARKET_BTC_UP_ASSET_ID="${activeMarket.upTokenId}"`);
    }
    if (!foundDownAsset) {
      updatedLines.push(`POLYMARKET_BTC_DOWN_ASSET_ID="${activeMarket.downTokenId}"`);
    }

    // Write back
    const newContent = updatedLines.join('\n');
    fs.writeFileSync(envPath, newContent, 'utf-8');

    console.log('✅ Updated .env file with asset IDs');
    console.log(`   POLYMARKET_BTC_UP_ASSET_ID="${activeMarket.upTokenId}"`);
    console.log(`   POLYMARKET_BTC_DOWN_ASSET_ID="${activeMarket.downTokenId}"`);
    console.log('\n💡 Tip: Je kunt nu de lag-recorder starten met: npm run lag-recorder');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error('\n💡 Tip: Zorg dat je internet verbinding hebt en probeer het opnieuw.');
    process.exit(1);
  }
}

findAndUpdateAssets();
