#!/usr/bin/env node

const assert = require('assert');
const moderationCommand = require('../commands/moderation/moderation');
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
    checkAdminOrModerator: moduleGuard.checkAdminOrModerator,
    handleKick: moderationCommand.handleKick,
    handleBan: moderationCommand.handleBan,
    handleTimeout: moderationCommand.handleTimeout,
    handlePurge: moderationCommand.handlePurge,
    handleSettingsView: moderationCommand.handleSettingsView,
    handleSettingsRaid: moderationCommand.handleSettingsRaid,
    handleSettingsKeywords: moderationCommand.handleSettingsKeywords,
    handleKeywordAdd: moderationCommand.handleKeywordAdd,
    handleKeywordRemove: moderationCommand.handleKeywordRemove,
    handleKeywordList: moderationCommand.handleKeywordList,
  };

  const counters = {
    kick: 0,
    ban: 0,
    timeout: 0,
    purge: 0,
    settingsView: 0,
    settingsRaid: 0,
    settingsKeywords: 0,
    keywordAdd: 0,
    keywordRemove: 0,
    keywordList: 0,
  };

  try {
    moderationCommand.handleKick = async () => { counters.kick += 1; };
    moderationCommand.handleBan = async () => { counters.ban += 1; };
    moderationCommand.handleTimeout = async () => { counters.timeout += 1; };
    moderationCommand.handlePurge = async () => { counters.purge += 1; };
    moderationCommand.handleSettingsView = async () => { counters.settingsView += 1; };
    moderationCommand.handleSettingsRaid = async () => { counters.settingsRaid += 1; };
    moderationCommand.handleSettingsKeywords = async () => { counters.settingsKeywords += 1; };
    moderationCommand.handleKeywordAdd = async () => { counters.keywordAdd += 1; };
    moderationCommand.handleKeywordRemove = async () => { counters.keywordRemove += 1; };
    moderationCommand.handleKeywordList = async () => { counters.keywordList += 1; };

    const subcommands = [
      'kick', 'ban', 'timeout', 'purge',
      'settings-view', 'settings-raid', 'settings-keywords',
      'keyword-add', 'keyword-remove', 'keyword-list'
    ];

    moduleGuard.checkAdminOrModerator = async () => false;
    for (const subcommand of subcommands) {
      await moderationCommand.execute(makeInteraction(subcommand));
    }
    Object.values(counters).forEach((value) => {
      assert.strictEqual(value, 0, 'all moderation handlers must be blocked when guard fails');
    });

    moduleGuard.checkAdminOrModerator = async () => true;
    for (const subcommand of subcommands) {
      await moderationCommand.execute(makeInteraction(subcommand));
    }

    assert.strictEqual(counters.kick, 1, 'kick should execute');
    assert.strictEqual(counters.ban, 1, 'ban should execute');
    assert.strictEqual(counters.timeout, 1, 'timeout should execute');
    assert.strictEqual(counters.purge, 1, 'purge should execute');
    assert.strictEqual(counters.settingsView, 1, 'settings-view should execute');
    assert.strictEqual(counters.settingsRaid, 1, 'settings-raid should execute');
    assert.strictEqual(counters.settingsKeywords, 1, 'settings-keywords should execute');
    assert.strictEqual(counters.keywordAdd, 1, 'keyword-add should execute');
    assert.strictEqual(counters.keywordRemove, 1, 'keyword-remove should execute');
    assert.strictEqual(counters.keywordList, 1, 'keyword-list should execute');
  } finally {
    moduleGuard.checkAdminOrModerator = original.checkAdminOrModerator;
    moderationCommand.handleKick = original.handleKick;
    moderationCommand.handleBan = original.handleBan;
    moderationCommand.handleTimeout = original.handleTimeout;
    moderationCommand.handlePurge = original.handlePurge;
    moderationCommand.handleSettingsView = original.handleSettingsView;
    moderationCommand.handleSettingsRaid = original.handleSettingsRaid;
    moderationCommand.handleSettingsKeywords = original.handleSettingsKeywords;
    moderationCommand.handleKeywordAdd = original.handleKeywordAdd;
    moderationCommand.handleKeywordRemove = original.handleKeywordRemove;
    moderationCommand.handleKeywordList = original.handleKeywordList;
  }

  console.log('moderation command dispatch assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
