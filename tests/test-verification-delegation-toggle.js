#!/usr/bin/env node

const assert = require('assert');
const roleService = require('../services/roleService');
const walletService = require('../services/walletService');
const tenantService = require('../services/tenantService');

function run() {
  const originalGetTenantVerificationSettings = tenantService.getTenantVerificationSettings;
  const originalGetAllUserWallets = walletService.getAllUserWallets;
  const originalGetLinkedWallets = walletService.getLinkedWallets;

  try {
    let getAllUserWalletsCalled = false;
    tenantService.getTenantVerificationSettings = () => ({ includeDelegatedWallets: true });
    walletService.getAllUserWallets = () => {
      getAllUserWalletsCalled = true;
      return ['direct-wallet', 'delegated-cold-wallet'];
    };
    walletService.getLinkedWallets = () => [{ wallet_address: 'direct-wallet' }];

    const withLegacyToggleEnabled = roleService.getVerificationWallets('user-1', 'guild-1');
    assert.deepStrictEqual(
      withLegacyToggleEnabled,
      ['direct-wallet'],
      'verification must ignore delegated wallets even if legacy toggle is enabled'
    );
    assert.strictEqual(getAllUserWalletsCalled, false, 'verification should not call effective wallet resolver');

    const noGuildScope = roleService.getVerificationWallets('user-1', '');
    assert.deepStrictEqual(
      noGuildScope,
      ['direct-wallet'],
      'verification without guild context must still use only directly linked wallets'
    );

    console.log('verification delegation disabled assertions passed');
  } finally {
    tenantService.getTenantVerificationSettings = originalGetTenantVerificationSettings;
    walletService.getAllUserWallets = originalGetAllUserWallets;
    walletService.getLinkedWallets = originalGetLinkedWallets;
  }
}

run();
