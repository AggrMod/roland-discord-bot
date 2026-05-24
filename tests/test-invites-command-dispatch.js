#!/usr/bin/env node

const assert = require('assert');
const invitesCommand = require('../commands/invites/invites');
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
    handleWho: invitesCommand.handleWho,
    handleLeaderboard: invitesCommand.handleLeaderboard,
    handlePanel: invitesCommand.handlePanel,
    handleExport: invitesCommand.handleExport,
  };

  const counters = { who: 0, leaderboard: 0, panel: 0, export: 0 };

  try {
    moduleGuard.checkModuleEnabled = async () => true;

    invitesCommand.handleWho = async () => { counters.who += 1; };
    invitesCommand.handleLeaderboard = async () => { counters.leaderboard += 1; };
    invitesCommand.handlePanel = async () => { counters.panel += 1; };
    invitesCommand.handleExport = async () => { counters.export += 1; };

    moduleGuard.checkAdmin = async () => false;
    for (const sub of ['who', 'leaderboard', 'panel', 'export']) {
      await invitesCommand.execute(makeInteraction(sub));
    }
    Object.values(counters).forEach((v) => assert.strictEqual(v, 0, 'invites handlers must be blocked for non-admin'));

    moduleGuard.checkAdmin = async () => true;
    for (const sub of ['who', 'leaderboard', 'panel', 'export']) {
      await invitesCommand.execute(makeInteraction(sub));
    }
    assert.strictEqual(counters.who, 1, 'who should execute once');
    assert.strictEqual(counters.leaderboard, 1, 'leaderboard should execute once');
    assert.strictEqual(counters.panel, 1, 'panel should execute once');
    assert.strictEqual(counters.export, 1, 'export should execute once');
  } finally {
    moduleGuard.checkModuleEnabled = original.checkModuleEnabled;
    moduleGuard.checkAdmin = original.checkAdmin;
    invitesCommand.handleWho = original.handleWho;
    invitesCommand.handleLeaderboard = original.handleLeaderboard;
    invitesCommand.handlePanel = original.handlePanel;
    invitesCommand.handleExport = original.handleExport;
  }

  console.log('invites command dispatch assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
