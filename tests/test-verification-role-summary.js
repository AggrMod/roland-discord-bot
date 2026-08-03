const assert = require('assert');
const { buildVerificationRoleFields, buildVerificationRoleMessage } = require('../utils/verificationRoleSummary');

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
assert.match(fields[0].value, /^Solpranos:/);
assert.doesNotMatch(fields[0].value, /Solana/);
assert.match(fields[0].value, /Holds 3 NFTs/);
assert.match(fields[0].value, /Requires 1\+ NFTs/);
assert.strictEqual(fields[1].name, '<@&100000000000000002>');
assert.match(fields[1].value, /^Ethereum Collection:/);
assert.doesNotMatch(fields[1].value, /Ethereum ·/);
assert.match(fields[1].value, /Holds 2 NFTs/);
assert.match(fields[1].value, /Requires 1–5 NFTs/);

const rendered = JSON.stringify(fields);
for (const removedLabel of ['Linked Wallets', 'Primary Wallet', 'raw', 'Tracked Tokens', 'Voting Power', 'Role Sync']) {
  assert.ok(!rendered.includes(removedLabel), `${removedLabel} should not appear in the member role summary`);
}

const empty = buildVerificationRoleFields([]);
assert.strictEqual(empty[0].name, 'No holding-based roles matched');

const message = buildVerificationRoleMessage([
  {
    roleId: '100000000000000003', roleName: 'ETHROLEB', kind: 'nft', chainName: 'Ethereum',
    assetName: 'The Deck by Gamblor', balance: 17, min: 1, max: 999999, unit: 'NFTs',
  },
]);
assert.match(message, /<@&100000000000000003>/, 'native Discord message content contains the real role mention');
assert.match(message, /The Deck by Gamblor: Holds 17 NFTs · Requires 1\+ NFTs/);
assert.doesNotMatch(message, /Ethereum ·/);
assert.ok(message.length <= 1900, 'role message stays below Discord content limits');

console.log('verification role summary assertions passed');
