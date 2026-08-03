const assert = require('assert');
const { buildVerificationRoleFields } = require('../utils/verificationRoleSummary');

const fields = buildVerificationRoleFields([
  {
    roleId: '100000000000000001',
    roleName: 'SOLROLEA',
    kind: 'nft',
    chainName: 'Solana',
    assetName: 'Solpranos',
    balance: 3,
    min: 1,
    max: 999999,
    unit: 'NFTs',
  },
  {
    roleId: '100000000000000002',
    roleName: 'ETHROLEB',
    kind: 'nft',
    chainName: 'Ethereum',
    assetName: 'Ethereum Collection',
    balance: 2,
    min: 1,
    max: 5,
    unit: 'NFTs',
  },
]);

assert.strictEqual(fields.length, 2);
assert.strictEqual(fields[0].name, '<@&100000000000000001>');
assert.match(fields[0].value, /Solana · Solpranos:/);
assert.match(fields[0].value, /Holds 3 NFTs/);
assert.match(fields[0].value, /Requires 1\+ NFTs/);
assert.strictEqual(fields[1].name, '<@&100000000000000002>');
assert.match(fields[1].value, /Ethereum · Ethereum Collection:/);
assert.match(fields[1].value, /Holds 2 NFTs/);
assert.match(fields[1].value, /Requires 1–5 NFTs/);

const rendered = JSON.stringify(fields);
for (const removedLabel of ['Linked Wallets', 'Primary Wallet', 'raw', 'Tracked Tokens', 'Voting Power', 'Role Sync']) {
  assert.ok(!rendered.includes(removedLabel), `${removedLabel} should not appear in the member role summary`);
}

const empty = buildVerificationRoleFields([]);
assert.strictEqual(empty[0].name, 'No holding-based roles matched');

console.log('verification role summary assertions passed');
