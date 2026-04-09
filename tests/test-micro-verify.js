require('dotenv').config();
const microVerifyService = require('../services/microVerifyService');
const logger = require('../utils/logger');

async function runTests() {
  console.log('=== Micro-Verify Service Test ===\n');

  // Initialize service
  console.log('1. Initializing service...');
  microVerifyService.init();
  
  // Get config
  console.log('\n2. Getting configuration...');
  const config = microVerifyService.getConfig();
  console.log('Config:', JSON.stringify(config, null, 2));

  // Test amount generation
  console.log('\n3. Testing amount generation...');
  const amounts = new Set();
  for (let i = 0; i < 10; i++) {
    const amount = microVerifyService.generateUniqueAmount();
    amounts.add(amount);
    console.log(`  Generated: ${amount} SOL`);
  }
  console.log(`  Unique amounts: ${amounts.size}/10`);

  // Test create request
  console.log('\n4. Testing request creation...');
  const testDiscordId = 'test_user_' + Date.now();
  
  // Create user first (to satisfy foreign key constraint)
  const db = require('../database/db');
  db.prepare('INSERT OR IGNORE INTO users (discord_id, username) VALUES (?, ?)').run(testDiscordId, 'TestUser');
  
  const result = microVerifyService.createRequest(testDiscordId, 'TestUser');
  
  if (result.success) {
    console.log('  ✅ Request created successfully');
    console.log('  Request ID:', result.request.id);
    console.log('  Amount:', result.request.amount, 'SOL');
    console.log('  Destination:', result.request.destinationWallet);
    console.log('  Expires in:', result.request.ttlMinutes, 'minutes');

    // Test get pending request
    console.log('\n5. Testing get pending request...');
    const pendingResult = microVerifyService.getPendingRequest(testDiscordId);
    
    if (pendingResult.success) {
      console.log('  ✅ Pending request found');
      console.log('  Amount:', pendingResult.request.expected_amount, 'SOL');
    } else {
      console.log('  ❌ Failed to get pending request:', pendingResult.message);
    }

    // Test rate limiting
    console.log('\n6. Testing rate limiting...');
    const rateLimitResult = microVerifyService.createRequest(testDiscordId, 'TestUser');
    
    if (!rateLimitResult.success) {
      console.log('  ✅ Rate limiting working:', rateLimitResult.message);
    } else {
      console.log('  ❌ Rate limiting not working');
    }

    // Test expiry
    console.log('\n7. Testing expiry...');
    const expireResult = microVerifyService.expireRequest(result.request.id);
    
    if (expireResult.success) {
      console.log('  ✅ Request expired successfully');
    } else {
      console.log('  ❌ Failed to expire request');
    }
  } else {
    console.log('  ❌ Failed to create request:', result.message);
  }

  // Get stats
  console.log('\n8. Getting statistics...');
  const statsResult = microVerifyService.getStats();
  
  if (statsResult.success) {
    console.log('  Stats:', JSON.stringify(statsResult.stats, null, 2));
  } else {
    console.log('  ❌ Failed to get stats');
  }

  // Test cleanup
  console.log('\n9. Testing stale request cleanup...');
  microVerifyService.expireStaleRequests();
  console.log('  ✅ Cleanup executed');

  console.log('\n=== All Tests Complete ===\n');
  console.log('Note: To test blockchain polling, set MICRO_VERIFY_ENABLED=true and');
  console.log('VERIFICATION_RECEIVE_WALLET to a valid Solana address, then run the bot.');
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});

