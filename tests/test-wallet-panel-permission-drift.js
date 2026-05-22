#!/usr/bin/env node

const assert = require('assert');
const clientProvider = require('../utils/clientProvider');
const trackedWalletsService = require('../services/trackedWalletsService');

async function run() {
  const originalGetClient = clientProvider.getClient;
  const originalBuildEmbed = trackedWalletsService.buildHoldingsEmbed;

  try {
    trackedWalletsService.buildHoldingsEmbed = async () => ({
      embed: { toJSON: () => ({ title: 'test' }) },
      components: [],
    });

    clientProvider.getClient = () => ({
      channels: {
        fetch: async () => ({
          send: async () => {
            const error = new Error('Missing Permissions');
            error.status = 403;
            error.code = 50013;
            throw error;
          },
          messages: {
            fetch: async () => null,
          },
        }),
      },
    });

    const result = await trackedWalletsService.postHoldingsPanel(
      {
        id: 1,
        wallet_address: 'So11111111111111111111111111111111111111112',
        panel_channel_id: '123456789012345678',
        panel_message_id: null,
      },
      '123456789012345678',
      '1468176555091034265'
    );

    assert.strictEqual(result.success, false, 'permission drift should return structured failure');
    assert.strictEqual(String(result.code || ''), 'forbidden', 'permission drift should return forbidden code');
    assert.match(String(result.message || ''), /permission/i, 'permission drift message should be explicit');
  } finally {
    clientProvider.getClient = originalGetClient;
    trackedWalletsService.buildHoldingsEmbed = originalBuildEmbed;
  }
}

run()
  .then(() => {
    console.log('wallet panel permission drift assertions passed');
  })
  .catch((error) => {
    console.error('wallet panel permission drift test failed:', error);
    process.exitCode = 1;
  });
