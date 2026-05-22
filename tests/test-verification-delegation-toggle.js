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
    tenantService.getTenantVerificationSettings = () => ({ includeDelegatedWallets: true });
    walletService.getAllUserWallets = () => ['direct-wallet', 'delegated-cold-wallet'];
    walletService.getLinkedWallets = () => [{ wallet_address: 'direct-wallet' }];

    const withDelegated = roleService.getVerificationWallets('user-1', 'guild-1');
    assert.deepStrictEqual(
      withDelegated,
      ['direct-wallet', 'delegated-cold-wallet'],
      'when includeDelegatedWallets=true, verification should use full wallet set'
    );

    tenantService.getTenantVerificationSettings = () => ({ includeDelegatedWallets: false });
    const directOnly = roleService.getVerificationWallets('user-1', 'guild-1');
    assert.deepStrictEqual(
      directOnly,
      ['direct-wallet'],
      'when includeDelegatedWallets=false, verification should use only directly linked wallets'
    );

    // No guild scope keeps backward-compatible behavior.
    tenantService.getTenantVerificationSettings = () => ({ includeDelegatedWallets: false });
    walletService.getAllUserWallets = () => ['direct-wallet', 'delegated-cold-wallet'];
    const noGuildScope = roleService.getVerificationWallets('user-1', '');
    assert.deepStrictEqual(
      noGuildScope,
      ['direct-wallet', 'delegated-cold-wallet'],
      'without guild context, behavior remains backward compatible and includes all effective wallets'
    );

    console.log('verification delegation toggle assertions passed');
  } finally {
    tenantService.getTenantVerificationSettings = originalGetTenantVerificationSettings;
    walletService.getAllUserWallets = originalGetAllUserWallets;
    walletService.getLinkedWallets = originalGetLinkedWallets;
  }
}

run();

