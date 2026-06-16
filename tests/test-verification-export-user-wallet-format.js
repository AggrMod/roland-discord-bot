const assert = require('assert');
const verificationCommand = require('../commands/verification/verification');
const roleService = require('../services/roleService');
const walletService = require('../services/walletService');

async function run() {
  const originalGetUserInfo = roleService.getUserInfo;
  const originalGetAllUserWallets = walletService.getAllUserWallets;

  const longWallet = 'WalletAddress1234567890ABCDEFGH';

  roleService.getUserInfo = async () => ({
    discord_id: 'user-1',
    username: 'Export User',
    total_nfts: 3,
    tier: 'Soldier',
    voting_power: 7,
  });
  walletService.getAllUserWallets = () => [longWallet];

  const runExport = async ({ fullAddresses = false } = {}) => {
    let editedReply = null;
    const interaction = {
      guildId: 'guild-1',
      user: { tag: 'Admin#0001' },
      options: {
        getUser: () => ({ id: 'user-1', username: 'ExportUser', tag: 'ExportUser#0001' }),
        getBoolean: (name) => name === 'full-addresses' ? fullAddresses : null,
      },
      deferReply: async (payload) => {
        assert.deepStrictEqual(payload, { ephemeral: true });
      },
      editReply: async (payload) => {
        editedReply = payload;
      },
    };

    await verificationCommand.handleAdminExportUser(interaction);

    assert.ok(editedReply, 'export command should edit the deferred reply');
    assert.ok(Array.isArray(editedReply.embeds), 'export reply should include an embed');

    const embed = editedReply.embeds[0].toJSON();
    const walletField = embed.fields.find(field => field.name === 'Linked Wallets');
    assert.ok(walletField, 'export embed should include linked wallets');
    return walletField.value;
  };

  try {
    assert.strictEqual(await runExport(), '`WalletAd...ABCDEFGH`');
    assert.strictEqual(await runExport({ fullAddresses: true }), `\`${longWallet}\``);
  } finally {
    roleService.getUserInfo = originalGetUserInfo;
    walletService.getAllUserWallets = originalGetAllUserWallets;
  }

  console.log('verification export-user wallet format assertions passed');
}

run().catch(error => {
  console.error('verification export-user wallet format test failed:', error);
  process.exit(1);
});
