#!/usr/bin/env node

/**
 * API Sanity Check Script
 * 
 * Validates that public API v1 endpoints conform to the standardized contract:
 * - Response envelope structure
 * - Required fields presence
 * - Data types
 * - Privacy/security (no sensitive data leaks)
 * 
 * Usage: node scripts/api-sanity-check.js [base-url]
 * Example: node scripts/api-sanity-check.js http://localhost:3000
 */

const https = require('https');
const http = require('http');

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const API_PREFIX = '/api/public/v1';

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m'
};

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

/**
 * Make HTTP request
 */
function request(path) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${API_PREFIX}${path}`;
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ 
            status: res.statusCode, 
            headers: res.headers,
            body: JSON.parse(data) 
          });
        } catch (err) {
          reject(new Error(`Failed to parse JSON: ${data.substring(0, 100)}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Test assertion helpers
 */
function assert(condition, message) {
  testsRun++;
  if (condition) {
    testsPassed++;
    console.log(`  ${colors.green}✓${colors.reset} ${colors.gray}${message}${colors.reset}`);
    return true;
  } else {
    testsFailed++;
    console.log(`  ${colors.red}✗${colors.reset} ${message}`);
    return false;
  }
}

function assertExists(obj, path, message) {
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current && typeof current === 'object' && key in current) {
      current = current[key];
    } else {
      return assert(false, message || `Missing: ${path}`);
    }
  }
  return assert(true, message || `Present: ${path}`);
}

function assertType(obj, path, expectedType, message) {
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current && typeof current === 'object' && key in current) {
      current = current[key];
    } else {
      return assert(false, `Missing path for type check: ${path}`);
    }
  }
  const actualType = Array.isArray(current) ? 'array' : typeof current;
  return assert(
    actualType === expectedType || (expectedType === 'number' && !isNaN(current)),
    message || `${path} is ${expectedType} (got ${actualType})`
  );
}

function assertNoSensitiveData(obj, message) {
  const sensitivePatterns = [
    /access_token/i,
    /session_id/i,
    /private_key/i,
    /secret/i
  ];
  
  const objStr = JSON.stringify(obj);
  for (const pattern of sensitivePatterns) {
    if (pattern.test(objStr)) {
      return assert(false, `Sensitive data leak detected: ${pattern}`);
    }
  }
  return assert(true, message || 'No sensitive data leaks detected');
}

function assertRedactedId(value, fieldName) {
  // Check if ID is redacted (format: XXXX...XXXX)
  if (typeof value === 'string' && value.includes('...')) {
    return assert(true, `${fieldName} is properly redacted`);
  }
  return assert(false, `${fieldName} should be redacted (format: XXXX...XXXX)`);
}

/**
 * Test the standard response envelope
 */
function testEnvelope(response, endpoint) {
  console.log(`\n${colors.blue}Testing envelope structure: ${endpoint}${colors.reset}`);
  
  assertExists(response, 'success', 'Has success field');
  assertType(response, 'success', 'boolean', 'success is boolean');
  assertExists(response, 'data', 'Has data field');
  assertExists(response, 'error', 'Has error field');
  assertExists(response, 'meta', 'Has meta field');
  assertExists(response, 'meta.version', 'Has meta.version');
  assertExists(response, 'meta.timestamp', 'Has meta.timestamp');
  
  if (response.success) {
    assert(response.error === null, 'error is null on success');
    assert(response.data !== null, 'data is not null on success');
  } else {
    assert(response.data === null, 'data is null on error');
    assert(response.error !== null, 'error is not null on error');
    assertExists(response, 'error.message', 'Has error.message');
    assertExists(response, 'error.code', 'Has error.code');
  }
  
  assertNoSensitiveData(response);
}

/**
 * Test proposals/active endpoint
 */
async function testProposalsActive() {
  console.log(`\n${colors.yellow}=== Testing /proposals/active ===${colors.reset}`);
  
  try {
    const res = await request('/proposals/active');
    assert(res.status === 200, 'HTTP 200 status');
    
    testEnvelope(res.body, '/proposals/active');
    
    assertExists(res.body, 'data.proposals', 'Has proposals array');
    assertType(res.body, 'data.proposals', 'array', 'proposals is an array');
    
    if (res.body.data.proposals.length > 0) {
      const proposal = res.body.data.proposals[0];
      assertExists(proposal, 'proposalId', 'Proposal has proposalId');
      assertExists(proposal, 'title', 'Proposal has title');
      assertExists(proposal, 'status', 'Proposal has status');
      assertExists(proposal, 'votes', 'Proposal has votes');
      assertExists(proposal, 'votes.yes', 'Has yes votes');
      assertExists(proposal, 'votes.no', 'Has no votes');
      assertExists(proposal, 'quorum', 'Has quorum data');
      
      // Check privacy
      if (proposal.creatorId) {
        assertRedactedId(proposal.creatorId, 'creatorId');
      }
    }
    
    assertExists(res.body, 'meta.count', 'Has meta.count');
  } catch (err) {
    console.log(`  ${colors.red}✗ Request failed: ${err.message}${colors.reset}`);
    testsFailed++;
  }
}

/**
 * Test proposals/concluded endpoint
 */
async function testProposalsConcluded() {
  console.log(`\n${colors.yellow}=== Testing /proposals/concluded ===${colors.reset}`);
  
  try {
    const res = await request('/proposals/concluded?limit=10&offset=0');
    assert(res.status === 200, 'HTTP 200 status');
    
    testEnvelope(res.body, '/proposals/concluded');
    
    assertExists(res.body, 'data.proposals', 'Has proposals array');
    assertType(res.body, 'data.proposals', 'array', 'proposals is an array');
    assertExists(res.body, 'meta.limit', 'Has pagination limit');
    assertExists(res.body, 'meta.offset', 'Has pagination offset');
    assertExists(res.body, 'meta.total', 'Has total count');
  } catch (err) {
    console.log(`  ${colors.red}✗ Request failed: ${err.message}${colors.reset}`);
    testsFailed++;
  }
}

/**
 * Test stats endpoint
 */
async function testStats() {
  console.log(`\n${colors.yellow}=== Testing /stats ===${colors.reset}`);
  
  try {
    const res = await request('/stats');
    assert(res.status === 200, 'HTTP 200 status');
    
    testEnvelope(res.body, '/stats');
    
    assertExists(res.body, 'data.stats', 'Has stats object');
    assertExists(res.body, 'data.stats.totalProposals', 'Has totalProposals');
    assertExists(res.body, 'data.stats.passedProposals', 'Has passedProposals');
    assertExists(res.body, 'data.stats.passRate', 'Has passRate');
    assertType(res.body, 'data.stats.totalProposals', 'number', 'totalProposals is number');
    assertType(res.body, 'data.stats.passRate', 'number', 'passRate is number');
  } catch (err) {
    console.log(`  ${colors.red}✗ Request failed: ${err.message}${colors.reset}`);
    testsFailed++;
  }
}

/**
 * Test treasury endpoint
 */
async function testTreasury() {
  console.log(`\n${colors.yellow}=== Testing /treasury ===${colors.reset}`);
  
  try {
    const res = await request('/treasury');
    assert(res.status === 200, 'HTTP 200 status');
    
    testEnvelope(res.body, '/treasury');
    
    // Check no wallet address is exposed
    const bodyStr = JSON.stringify(res.body);
    assert(!bodyStr.includes('wallet'), 'No wallet field in response');
    assert(!bodyStr.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/), 'No raw Solana addresses detected');
  } catch (err) {
    console.log(`  ${colors.red}✗ Request failed: ${err.message}${colors.reset}`);
    testsFailed++;
  }
}

/**
 * Test missions/active endpoint
 */
async function testMissionsActive() {
  console.log(`\n${colors.yellow}=== Testing /missions/active ===${colors.reset}`);
  
  try {
    const res = await request('/missions/active');
    assert(res.status === 200, 'HTTP 200 status');
    
    testEnvelope(res.body, '/missions/active');
    
    assertExists(res.body, 'data.missions', 'Has missions array');
    assertType(res.body, 'data.missions', 'array', 'missions is an array');
    
    if (res.body.data.missions.length > 0) {
      const mission = res.body.data.missions[0];
      assertExists(mission, 'missionId', 'Mission has missionId');
      assertExists(mission, 'title', 'Mission has title');
      assertExists(mission, 'status', 'Mission has status');
      assertExists(mission, 'participants', 'Mission has participants');
      
      if (mission.participants && mission.participants.length > 0) {
        const participant = mission.participants[0];
        
        // Check privacy - participant IDs should be redacted
        if (participant.participantId) {
          assertRedactedId(participant.participantId, 'participantId');
        }
        
        // Check no raw wallet addresses
        const missionStr = JSON.stringify(mission);
        assert(!missionStr.includes('wallet_address'), 'No wallet_address field');
        assert(!missionStr.includes('assigned_nft_mint'), 'No NFT mint address');
      }
    }
  } catch (err) {
    console.log(`  ${colors.red}✗ Request failed: ${err.message}${colors.reset}`);
    testsFailed++;
  }
}

/**
 * Test missions/completed endpoint
 */
async function testMissionsCompleted() {
  console.log(`\n${colors.yellow}=== Testing /missions/completed ===${colors.reset}`);
  
  try {
    const res = await request('/missions/completed?limit=10');
    assert(res.status === 200, 'HTTP 200 status');
    
    testEnvelope(res.body, '/missions/completed');
    
    assertExists(res.body, 'data.missions', 'Has missions array');
    assertExists(res.body, 'meta.limit', 'Has pagination limit');
    assertExists(res.body, 'meta.total', 'Has total count');
  } catch (err) {
    console.log(`  ${colors.red}✗ Request failed: ${err.message}${colors.reset}`);
    testsFailed++;
  }
}

/**
 * Test leaderboard endpoint
 */
async function testLeaderboard() {
  console.log(`\n${colors.yellow}=== Testing /leaderboard ===${colors.reset}`);
  
  try {
    const res = await request('/leaderboard');
    assert(res.status === 200, 'HTTP 200 status');
    
    testEnvelope(res.body, '/leaderboard');
    
    assertExists(res.body, 'data.leaderboard', 'Has leaderboard array');
    assertType(res.body, 'data.leaderboard', 'array', 'leaderboard is an array');
    
    if (res.body.data.leaderboard.length > 0) {
      const entry = res.body.data.leaderboard[0];
      assertExists(entry, 'rank', 'Entry has rank');
      assertExists(entry, 'username', 'Entry has username');
      assertExists(entry, 'totalPoints', 'Entry has totalPoints');
      assertType(entry, 'rank', 'number', 'rank is number');
      
      // Check privacy
      if (entry.userId) {
        assertRedactedId(entry.userId, 'userId');
      }
    }
  } catch (err) {
    console.log(`  ${colors.red}✗ Request failed: ${err.message}${colors.reset}`);
    testsFailed++;
  }
}

/**
 * Test 404 handling
 */
async function test404() {
  console.log(`\n${colors.yellow}=== Testing 404 Error Handling ===${colors.reset}`);
  
  try {
    const res = await request('/nonexistent-endpoint');
    assert(res.status === 404, 'HTTP 404 status');
    
    testEnvelope(res.body, '404 error');
    
    assert(res.body.success === false, 'success is false');
    assertExists(res.body, 'error.code', 'Has error code');
    assert(res.body.error.code === 'NOT_FOUND', 'Error code is NOT_FOUND');
  } catch (err) {
    console.log(`  ${colors.red}✗ Request failed: ${err.message}${colors.reset}`);
    testsFailed++;
  }
}

/**
 * Test validation error handling
 */
async function testValidationError() {
  console.log(`\n${colors.yellow}=== Testing Validation Error Handling ===${colors.reset}`);
  
  try {
    const res = await request('/proposals/concluded?limit=999');
    assert(res.status === 400, 'HTTP 400 status for invalid limit');
    
    testEnvelope(res.body, 'validation error');
    
    assert(res.body.success === false, 'success is false');
    assertExists(res.body, 'error.code', 'Has error code');
  } catch (err) {
    console.log(`  ${colors.red}✗ Request failed: ${err.message}${colors.reset}`);
    testsFailed++;
  }
}

/**
 * Test CORS headers
 */
async function testCORS() {
  console.log(`\n${colors.yellow}=== Testing CORS Configuration ===${colors.reset}`);
  
  try {
    const res = await request('/stats');
    
    // Note: CORS headers might not appear in same-origin requests
    // This is more of an informational check
    if (res.headers['access-control-allow-origin']) {
      assert(true, 'CORS headers present');
      console.log(`  ${colors.gray}  Origin: ${res.headers['access-control-allow-origin']}${colors.reset}`);
    } else {
      console.log(`  ${colors.gray}  (CORS headers not visible in same-origin request)${colors.reset}`);
    }
  } catch (err) {
    console.log(`  ${colors.yellow}⚠ Could not check CORS: ${err.message}${colors.reset}`);
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log(`${colors.blue}╔════════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.blue}║           API v1 Public Contract Sanity Check             ║${colors.reset}`);
  console.log(`${colors.blue}╚════════════════════════════════════════════════════════════╝${colors.reset}`);
  console.log(`\n${colors.gray}Testing API at: ${BASE_URL}${API_PREFIX}${colors.reset}\n`);
  
  // Run all tests
  await testProposalsActive();
  await testProposalsConcluded();
  await testStats();
  await testTreasury();
  await testMissionsActive();
  await testMissionsCompleted();
  await testLeaderboard();
  await test404();
  await testValidationError();
  await testCORS();
  
  // Summary
  console.log(`\n${colors.blue}═══════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.blue}Summary${colors.reset}`);
  console.log(`${colors.blue}═══════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`Total tests:  ${testsRun}`);
  console.log(`${colors.green}Passed:       ${testsPassed}${colors.reset}`);
  console.log(`${colors.red}Failed:       ${testsFailed}${colors.reset}`);
  
  if (testsFailed === 0) {
    console.log(`\n${colors.green}✓ All tests passed! API contract is valid.${colors.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n${colors.red}✗ Some tests failed. Please review the API implementation.${colors.reset}\n`);
    process.exit(1);
  }
}

// Run tests
runTests().catch(err => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
