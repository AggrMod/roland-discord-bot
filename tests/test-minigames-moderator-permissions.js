#!/usr/bin/env node

const assert = require('assert');
const battleCommand = require('../commands/battle/battle');
const moduleGuard = require('../utils/moduleGuard');

function makeInteraction({ subcommand, subcommandGroup = null } = {}) {
  return {
    deferred: false,
    replied: false,
    options: {
      getSubcommandGroup: () => subcommandGroup,
      getSubcommand: () => subcommand,
    },
    reply: async () => {},
    editReply: async () => {},
  };
}

async function run() {
  const original = {
    checkModuleEnabled: moduleGuard.checkModuleEnabled,
    checkAdminOrModerator: moduleGuard.checkAdminOrModerator,
    checkAdmin: moduleGuard.checkAdmin,
    handleCreate: battleCommand.handleCreate,
    handleStart: battleCommand.handleStart,
    handleAdminList: battleCommand.handleAdminList,
  };

  try {
    moduleGuard.checkModuleEnabled = async () => true;

    let createCalls = 0;
    let startCalls = 0;
    let adminListCalls = 0;
    battleCommand.handleCreate = async () => { createCalls += 1; };
    battleCommand.handleStart = async () => { startCalls += 1; };
    battleCommand.handleAdminList = async () => { adminListCalls += 1; };

    moduleGuard.checkAdminOrModerator = async () => false;
    await battleCommand.execute(makeInteraction({ subcommand: 'create' }));
    await battleCommand.execute(makeInteraction({ subcommand: 'start' }));
    assert.strictEqual(createCalls, 0, 'create should be blocked when admin/mod guard fails');
    assert.strictEqual(startCalls, 0, 'start should be blocked when admin/mod guard fails');

    moduleGuard.checkAdminOrModerator = async () => true;
    await battleCommand.execute(makeInteraction({ subcommand: 'create' }));
    await battleCommand.execute(makeInteraction({ subcommand: 'start' }));
    assert.strictEqual(createCalls, 1, 'create should proceed when admin/mod guard passes');
    assert.strictEqual(startCalls, 1, 'start should proceed when admin/mod guard passes');

    moduleGuard.checkAdmin = async () => false;
    await battleCommand.execute(makeInteraction({ subcommand: 'list', subcommandGroup: 'admin' }));
    assert.strictEqual(adminListCalls, 0, 'admin subgroup should be blocked for non-admins');

    moduleGuard.checkAdmin = async () => true;
    await battleCommand.execute(makeInteraction({ subcommand: 'list', subcommandGroup: 'admin' }));
    assert.strictEqual(adminListCalls, 1, 'admin subgroup should execute for admins');
  } finally {
    moduleGuard.checkModuleEnabled = original.checkModuleEnabled;
    moduleGuard.checkAdminOrModerator = original.checkAdminOrModerator;
    moduleGuard.checkAdmin = original.checkAdmin;
    battleCommand.handleCreate = original.handleCreate;
    battleCommand.handleStart = original.handleStart;
    battleCommand.handleAdminList = original.handleAdminList;
  }

  console.log('minigames moderator/admin permission assertions passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});

