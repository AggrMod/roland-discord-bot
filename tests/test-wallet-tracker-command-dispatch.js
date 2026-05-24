#!/usr/bin/env node

const assert = require('assert');
const walletTrackerCommand = require('../commands/wallettracker/walletTracker');
const moduleGuard = require('../utils/moduleGuard');

function makeInteraction(subcommand) {
  return {
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => subcommand,
    },
    reply: async () => {},
    editReply: async () => {},
  };
}

async function run() {
  const original = {
    checkModuleEnabled: moduleGuard.checkModuleEnabled,
    checkAdmin: moduleGuard.checkAdmin,
    handleWalletAdd: walletTrackerCommand.handleWalletAdd,
    handleWalletRemove: walletTrackerCommand.handleWalletRemove,
    handleWalletList: walletTrackerCommand.handleWalletList,
    handleWalletEdit: walletTrackerCommand.handleWalletEdit,
    handleWalletHoldings: walletTrackerCommand.handleWalletHoldings,
    handleWalletRefreshAll: walletTrackerCommand.handleWalletRefreshAll,
  };

  const counters = {
    add: 0,
    remove: 0,
    list: 0,
    edit: 0,
    holdings: 0,
    refreshAll: 0,
  };

  try {
    moduleGuard.checkModuleEnabled = async () => true;

    walletTrackerCommand.handleWalletAdd = async () => { counters.add += 1; };
    walletTrackerCommand.handleWalletRemove = async () => { counters.remove += 1; };
    walletTrackerCommand.handleWalletList = async () => { counters.list += 1; };
    walletTrackerCommand.handleWalletEdit = async () => { counters.edit += 1; };
    walletTrackerCommand.handleWalletHoldings = async () => { counters.holdings += 1; };
    walletTrackerCommand.handleWalletRefreshAll = async () => { counters.refreshAll += 1; };

    // admin guard should block all
    moduleGuard.checkAdmin = async () => false;
    for (const sub of ['add', 'remove', 'list', 'edit', 'holdings', 'refresh-all']) {
      await walletTrackerCommand.execute(makeInteraction(sub));
    }
    Object.values(counters).forEach((v) => assert.strictEqual(v, 0, 'all wallet-tracker handlers must be blocked for non-admin'));

    // allow and dispatch
    moduleGuard.checkAdmin = async () => true;
    for (const sub of ['add', 'remove', 'list', 'edit', 'holdings', 'refresh-all']) {
      await walletTrackerCommand.execute(makeInteraction(sub));
    }

    assert.strictEqual(counters.add, 1, 'add handler should run once');
    assert.strictEqual(counters.remove, 1, 'remove handler should run once');
    assert.strictEqual(counters.list, 1, 'list handler should run once');
    assert.strictEqual(counters.edit, 1, 'edit handler should run once');
    assert.strictEqual(counters.holdings, 1, 'holdings handler should run once');
    assert.strictEqual(counters.refreshAll, 1, 'refresh-all handler should run once');
  } finally {
    moduleGuard.checkModuleEnabled = original.checkModuleEnabled;
    moduleGuard.checkAdmin = original.checkAdmin;
    walletTrackerCommand.handleWalletAdd = original.handleWalletAdd;
    walletTrackerCommand.handleWalletRemove = original.handleWalletRemove;
    walletTrackerCommand.handleWalletList = original.handleWalletList;
    walletTrackerCommand.handleWalletEdit = original.handleWalletEdit;
    walletTrackerCommand.handleWalletHoldings = original.handleWalletHoldings;
    walletTrackerCommand.handleWalletRefreshAll = original.handleWalletRefreshAll;
  }

  console.log('wallet-tracker command dispatch assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
