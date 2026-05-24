#!/usr/bin/env node

const assert = require('assert');
const configCommand = require('../commands/config/config');
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
    checkAdmin: moduleGuard.checkAdmin,
    handleModules: configCommand.handleModules,
    handleToggle: configCommand.handleToggle,
    handleStatus: configCommand.handleStatus,
  };

  try {
    let modulesCalls = 0;
    let toggleCalls = 0;
    let statusCalls = 0;

    configCommand.handleModules = async () => { modulesCalls += 1; };
    configCommand.handleToggle = async () => { toggleCalls += 1; };
    configCommand.handleStatus = async () => { statusCalls += 1; };

    moduleGuard.checkAdmin = async () => false;
    await configCommand.execute(makeInteraction('modules'));
    await configCommand.execute(makeInteraction('toggle'));
    await configCommand.execute(makeInteraction('status'));
    assert.strictEqual(modulesCalls, 0, 'modules must be blocked for non-admin');
    assert.strictEqual(toggleCalls, 0, 'toggle must be blocked for non-admin');
    assert.strictEqual(statusCalls, 0, 'status must be blocked for non-admin');

    moduleGuard.checkAdmin = async () => true;
    await configCommand.execute(makeInteraction('modules'));
    await configCommand.execute(makeInteraction('toggle'));
    await configCommand.execute(makeInteraction('status'));
    assert.strictEqual(modulesCalls, 1, 'modules should execute for admin');
    assert.strictEqual(toggleCalls, 1, 'toggle should execute for admin');
    assert.strictEqual(statusCalls, 1, 'status should execute for admin');
  } finally {
    moduleGuard.checkAdmin = original.checkAdmin;
    configCommand.handleModules = original.handleModules;
    configCommand.handleToggle = original.handleToggle;
    configCommand.handleStatus = original.handleStatus;
  }

  console.log('config command dispatch assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
