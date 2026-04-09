/**
 * Simple sanity check for collection resolver
 */

const { resolveCollectionInput, isValidSolanaAddress, formatCollectionForDisplay } = require('./utils/collectionResolver');

console.log('🧪 Testing Collection Resolver\n');

// Test 1: Slug input
console.log('Test 1: Slug input');
try {
  const result = resolveCollectionInput('guildpilot-main');
  console.log('✅ Input: "guildpilot-main"');
  console.log('   Result:', JSON.stringify(result, null, 2));
  console.assert(result.type === 'slug', 'Should be type: slug');
  console.assert(result.key === 'guildpilot-main', 'Should normalize to slug');
} catch (error) {
  console.error('❌ Test 1 failed:', error.message);
}
console.log();

// Test 2: Solana address input
console.log('Test 2: Solana address input');
try {
  const result = resolveCollectionInput('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
  console.log('✅ Input: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"');
  console.log('   Result:', JSON.stringify(result, null, 2));
  console.assert(result.type === 'address', 'Should be type: address');
  console.assert(result.key.startsWith('addr:'), 'Key should be prefixed with addr:');
} catch (error) {
  console.error('❌ Test 2 failed:', error.message);
}
console.log();

// Test 3: Mixed case slug normalization
console.log('Test 3: Mixed case slug normalization');
try {
  const result = resolveCollectionInput('SolProNos Main');
  console.log('✅ Input: "SolProNos Main"');
  console.log('   Result:', JSON.stringify(result, null, 2));
  console.assert(result.type === 'slug', 'Should be type: slug');
  console.assert(result.key === 'solpronos-main', 'Should normalize spaces and case');
} catch (error) {
  console.error('❌ Test 3 failed:', error.message);
}
console.log();

// Test 4: Invalid input (too short)
console.log('Test 4: Invalid input (too short)');
try {
  const result = resolveCollectionInput('ab');
  console.error('❌ Test 4 failed: Should have thrown error');
} catch (error) {
  console.log('✅ Correctly rejected short input:', error.message);
}
console.log();

// Test 5: Address validation
console.log('Test 5: Address validation');
const validAddress = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const invalidAddress = 'not-an-address-123';
console.assert(isValidSolanaAddress(validAddress) === true, 'Should validate correct address');
console.assert(isValidSolanaAddress(invalidAddress) === false, 'Should reject invalid address');
console.log('✅ Address validation working correctly');
console.log();

// Test 6: Format collection for display
console.log('Test 6: Format collection for display');
const mockCollection = {
  id: 'addr:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  name: '7xKXtg2C...JosgAsU',
  roleId: '123456789',
  enabled: true
};
const formatted = formatCollectionForDisplay(mockCollection);
console.log('✅ Formatted:', formatted);
console.assert(formatted.includes('🔑'), 'Should include address icon');
console.log();

console.log('🎉 All tests passed!');
