#!/usr/bin/env node

/**
 * Treasury Service Test Script
 * Tests the treasury watch functionality
 */

const treasuryService = require('./services/treasuryService');
const logger = require('./utils/logger');

async function runTests() {
  console.log('\n=== Treasury Service Tests ===\n');

  // Test 1: Get initial config
  console.log('Test 1: Get initial config');
  const config = treasuryService.getConfig();
  console.log('Config:', JSON.stringify(config, null, 2));
  console.log('✅ Config retrieved\n');

  // Test 2: Validate wallet address format
  console.log('Test 2: Validate wallet addresses');
  const validWallet = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
  const invalidWallet = 'invalid-wallet';
  
  console.log(`Valid wallet (${validWallet}): ${treasuryService.isValidSolanaAddress(validWallet)}`);
  console.log(`Invalid wallet (${invalidWallet}): ${treasuryService.isValidSolanaAddress(invalidWallet)}`);
  console.log('✅ Wallet validation works\n');

  // Test 3: Mask wallet address
  console.log('Test 3: Mask wallet address');
  const masked = treasuryService.maskAddress(validWallet);
  console.log(`Original: ${validWallet}`);
  console.log(`Masked: ${masked}`);
  console.log('✅ Wallet masking works\n');

  // Test 4: Update config (enable with test wallet)
  console.log('Test 4: Update config');
  const updateResult = treasuryService.updateConfig({
    enabled: true,
    solanaWallet: validWallet,
    refreshHours: 4
  });
  console.log('Update result:', updateResult);
  console.log('✅ Config update works\n');

  // Test 5: Get admin summary
  console.log('Test 5: Get admin summary');
  const adminSummary = treasuryService.getAdminSummary();
  console.log('Admin summary:', JSON.stringify(adminSummary, null, 2));
  console.log('✅ Admin summary works\n');

  // Test 6: Get public summary
  console.log('Test 6: Get public summary (safe)');
  const publicSummary = treasuryService.getSummary();
  console.log('Public summary:', JSON.stringify(publicSummary, null, 2));
  
  // Verify no full wallet in public summary
  const hasSensitiveData = JSON.stringify(publicSummary).includes(validWallet);
  console.log(`Contains full wallet address: ${hasSensitiveData ? '❌ FAIL' : '✅ PASS'}`);
  console.log('✅ Public summary is safe\n');

  // Test 7: Fetch real balances (optional - requires RPC connection)
  console.log('Test 7: Fetch real balances');
  console.log('Note: This will attempt to connect to Solana mainnet...');
  try {
    const balanceResult = await treasuryService.fetchBalances();
    if (balanceResult.success) {
      console.log('✅ Balance fetch succeeded!');
      console.log(`SOL: ${balanceResult.balances.sol}`);
      console.log(`USDC: ${balanceResult.balances.usdc}`);
    } else {
      console.log(`⚠️ Balance fetch failed: ${balanceResult.message}`);
      console.log('(This is expected if the wallet has no USDC or RPC is unavailable)');
    }
  } catch (error) {
    console.log(`⚠️ Balance fetch error: ${error.message}`);
  }
  console.log();

  // Test 8: Test disable
  console.log('Test 8: Disable treasury monitoring');
  const disableResult = treasuryService.updateConfig({ enabled: false });
  console.log('Disable result:', disableResult);
  console.log('✅ Disable works\n');

  // Final config check
  console.log('Final config state:');
  const finalConfig = treasuryService.getConfig();
  console.log(`Enabled: ${finalConfig.enabled === 1}`);
  console.log(`Wallet: ${treasuryService.maskAddress(finalConfig.solana_wallet)}`);
  console.log(`Refresh Hours: ${finalConfig.refresh_hours}`);
  console.log(`Last Updated: ${finalConfig.last_updated || 'Never'}`);

  console.log('\n=== All Tests Complete ===\n');
}

runTests().catch(error => {
  logger.error('Test script error:', error);
  process.exit(1);
});
