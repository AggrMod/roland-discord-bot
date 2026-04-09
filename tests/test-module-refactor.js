#!/usr/bin/env node

/**
 * Module Architecture Refactor - Sanity Test
 * Tests that the new module system loads correctly
 */

const path = require('path');
const fs = require('fs');
const repoRoot = path.resolve(__dirname, '..');

console.log('🧪 Testing Module Architecture Refactor...\n');

let errors = 0;

// Test 1: Module toggles config exists
console.log('1. Checking module toggles config...');
const togglesPath = path.join(repoRoot, 'config/module-toggles.json');
if (!fs.existsSync(togglesPath)) {
  console.error('  ❌ config/module-toggles.json not found');
  errors++;
} else {
  const toggles = JSON.parse(fs.readFileSync(togglesPath, 'utf8'));
  const requiredModules = ['verificationEnabled', 'governanceEnabled', 'treasuryEnabled', 'battleEnabled', 'heistEnabled'];
  const missing = requiredModules.filter(m => !(m in toggles));
  if (missing.length > 0) {
    console.error(`  ❌ Missing toggles: ${missing.join(', ')}`);
    errors++;
  } else {
    console.log('  ✅ All module toggles present');
  }
}

// Test 2: Module guard utility exists
console.log('\n2. Checking module guard utility...');
const moduleGuardPath = path.join(repoRoot, 'utils/moduleGuard.js');
if (!fs.existsSync(moduleGuardPath)) {
  console.error('  ❌ utils/moduleGuard.js not found');
  errors++;
} else {
  try {
    const moduleGuard = require('../utils/moduleGuard');
    if (typeof moduleGuard.isModuleEnabled !== 'function') {
      console.error('  ❌ moduleGuard.isModuleEnabled not found');
      errors++;
    } else {
      console.log('  ✅ Module guard loaded successfully');
    }
  } catch (error) {
    console.error(`  ❌ Error loading module guard: ${error.message}`);
    errors++;
  }
}

// Test 3: New module commands exist
console.log('\n3. Checking new module commands...');
const newCommands = [
  'commands/verification/verification.js',
  'commands/governance/governance.js',
  'commands/treasury/treasury.js',
  'commands/minigames/minigames.js',
  'commands/battle/battle.js',
  'commands/heist/heist.js',
  'commands/config/config.js'
];

for (const cmd of newCommands) {
  const cmdPath = path.join(repoRoot, cmd);
  if (!fs.existsSync(cmdPath)) {
    console.error(`  ❌ ${cmd} not found`);
    errors++;
  } else {
    console.log(`  ✅ ${cmd.split('/')[1]} module command exists`);
  }
}

// Test 3b: Command-module map includes canonical minigames command
console.log('\n3b. Checking command module map...');
try {
  const { getCommandModuleMap } = require('../config/commandModules');
  const commandMap = getCommandModuleMap();
  if (commandMap.minigames !== 'minigames') {
    console.error('  ❌ /minigames is not mapped to minigames module');
    errors++;
  } else if (commandMap.battle !== 'minigames' || commandMap.gamenight !== 'minigames') {
    console.error('  ❌ Legacy minigame aliases are not mapped to minigames module');
    errors++;
  } else {
    console.log('  ✅ Canonical + legacy minigame command mappings are correct');
  }
} catch (error) {
  console.error(`  ❌ Error loading command module map: ${error.message}`);
  errors++;
}

// Test 4: Legacy commands removed
console.log('\n4. Verifying legacy commands removed...');
const legacyPath = path.join(repoRoot, 'commands/legacy');
if (fs.existsSync(legacyPath)) {
  console.error('  ❌ commands/legacy folder still exists (should be removed)');
  errors++;
} else {
  console.log('  ✅ Legacy command aliases removed');
}

// Test 5: Old commands renamed
console.log('\n5. Checking old commands renamed to .OLD...');
const oldCommands = [
  'commands/verification/verify.js',
  'commands/governance/propose.js',
  'commands/heist/view.js'
];

for (const cmd of oldCommands) {
  const cmdPath = path.join(repoRoot, cmd);
  if (fs.existsSync(cmdPath)) {
    console.error(`  ❌ ${cmd} still exists (should be renamed to .OLD)`);
    errors++;
  } else {
    console.log(`  ✅ ${cmd} removed/renamed`);
  }
}

// Test 6: Documentation exists
console.log('\n6. Checking documentation...');
const docsPath = path.join(repoRoot, 'docs/COMMAND_ARCHITECTURE.md');
if (!fs.existsSync(docsPath)) {
  console.error('  ❌ docs/COMMAND_ARCHITECTURE.md not found');
  errors++;
} else {
  const docs = fs.readFileSync(docsPath, 'utf8');
  if (!docs.includes('Module-First Refactor')) {
    console.error('  ❌ Documentation missing Module-First Refactor content');
    errors++;
  } else {
    console.log('  ✅ Command architecture documentation exists');
  }
}

// Test 7: Try loading commands
console.log('\n7. Testing command loading...');
try {
  const verificationCmd = require('../commands/verification/verification.js');
  if (!verificationCmd.data || !verificationCmd.execute) {
    console.error('  ❌ Verification command missing data or execute');
    errors++;
  } else {
    console.log('  ✅ Verification command loads correctly');
  }
} catch (error) {
  console.error(`  ❌ Error loading verification command: ${error.message}`);
  errors++;
}

try {
  const governanceCmd = require('../commands/governance/governance.js');
  if (!governanceCmd.data || !governanceCmd.execute) {
    console.error('  ❌ Governance command missing data or execute');
    errors++;
  } else {
    console.log('  ✅ Governance command loads correctly');
  }
} catch (error) {
  console.error(`  ❌ Error loading governance command: ${error.message}`);
  errors++;
}

// Final summary
console.log('\n' + '='.repeat(50));
if (errors === 0) {
  console.log('✅ ALL TESTS PASSED!');
  console.log('\nNext steps:');
  console.log('1. Run: node deploy-commands.js');
  console.log('2. Restart the bot');
  console.log('3. Test /config modules');
  console.log('4. Test new command structure');
  process.exit(0);
} else {
  console.error(`❌ ${errors} TEST(S) FAILED`);
  console.error('\nPlease fix the errors above before deploying.');
  process.exit(1);
}

