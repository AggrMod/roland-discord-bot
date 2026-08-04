const { SlashCommandBuilder } = require('discord.js');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

const GAME_OPTIONS = [
  { name: 'Battle', value: 'battle' },
  { name: 'Game Night', value: 'gamenight' },
  { name: 'Higher or Lower', value: 'higherlower' },
  { name: 'Dice Duel', value: 'diceduel' },
  { name: 'Reaction Race', value: 'reactionrace' },
  { name: 'Number Guess', value: 'numberguess' },
  { name: 'Slots', value: 'slots' },
  { name: 'Trivia', value: 'trivia' },
  { name: 'Word Scramble', value: 'wordscramble' },
  { name: 'RPS Tournament', value: 'rps' },
  { name: 'Blackjack', value: 'blackjack' },
];

const ACTION_OPTIONS = [
  { name: 'Create', value: 'create' },
  { name: 'Start', value: 'start' },
  { name: 'Cancel', value: 'cancel' },
  { name: 'Stats', value: 'stats' },
  { name: 'Leaderboard', value: 'leaderboard' },
  { name: 'Skip', value: 'skip' },
];

const ALLOWED_ACTIONS = Object.freeze({
  battle: new Set(['create', 'start', 'cancel', 'stats']),
  gamenight: new Set(['start', 'cancel', 'skip', 'leaderboard']),
  higherlower: new Set(['start', 'cancel']),
  diceduel: new Set(['start', 'cancel']),
  reactionrace: new Set(['start', 'cancel']),
  numberguess: new Set(['start', 'cancel']),
  slots: new Set(['start', 'cancel']),
  trivia: new Set(['start', 'cancel']),
  wordscramble: new Set(['start', 'cancel']),
  rps: new Set(['start', 'cancel']),
  blackjack: new Set(['start', 'cancel']),
});

const STANDALONE_JOIN_TIME = Object.freeze({ min: 10, max: 120 });
const GAME_NIGHT_JOIN_TIME = Object.freeze({ min: 30, max: 180 });
const BATTLE_PLAYER_LIMIT = Object.freeze({ min: 2, max: 100 });

function validateRouteOptions(interaction, game, action) {
  const joinTime = interaction.options.getInteger('join_time');
  if (action === 'start' && joinTime !== null) {
    const range = game === 'gamenight' ? GAME_NIGHT_JOIN_TIME : STANDALONE_JOIN_TIME;
    if (joinTime < range.min || joinTime > range.max) {
      return `Join time for \`${game}\` must be between ${range.min} and ${range.max} seconds.`;
    }
  }

  const maxPlayers = interaction.options.getInteger('max_players');
  if (game === 'battle' && action === 'create' && maxPlayers !== null
      && (maxPlayers < BATTLE_PLAYER_LIMIT.min || maxPlayers > BATTLE_PLAYER_LIMIT.max)) {
    return `Battle max players must be between ${BATTLE_PLAYER_LIMIT.min} and ${BATTLE_PLAYER_LIMIT.max}.`;
  }

  const games = interaction.options.getString('games');
  if (games && games.length > 200) {
    return 'The Game Night lineup is too long. Use the comma-separated game names shown in `/minigames help`.';
  }
  return null;
}

function buildOptionProxy(interaction, action) {
  return {
    getSubcommandGroup: () => null,
    getSubcommand: () => action,
    getInteger: (name) => {
      if (name === 'join_time') return interaction.options.getInteger('join_time');
      if (name === 'max_players') return interaction.options.getInteger('max_players');
      return null;
    },
    getString: (name) => {
      if (name === 'era') return interaction.options.getString('era');
      if (name === 'games') return interaction.options.getString('games');
      return null;
    },
    getUser: (name) => {
      if (name === 'user') return interaction.options.getUser('user');
      return null;
    },
    getRole: () => null,
    getBoolean: () => null,
  };
}

function createCommandProxy(interaction, game, action) {
  const optionProxy = buildOptionProxy(interaction, action);
  return new Proxy(interaction, {
    get(target, prop, receiver) {
      if (prop === 'commandName') return game;
      if (prop === 'options') return optionProxy;
      return Reflect.get(target, prop, receiver);
    },
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('minigames')
    .setDescription('Module-prefixed command entrypoint for all minigames')
    .addSubcommand(subcommand =>
      subcommand
        .setName('run')
        .setDescription('Run a minigame action (module-prefixed entrypoint)')
        .addStringOption(option =>
          option
            .setName('game')
            .setDescription('Which minigame to route to')
            .setRequired(true)
            .addChoices(...GAME_OPTIONS))
        .addStringOption(option =>
          option
            .setName('action')
            .setDescription('Action to run')
            .setRequired(true)
            .addChoices(...ACTION_OPTIONS))
        .addIntegerOption(option =>
          option
            .setName('join_time')
            .setDescription('Optional join time in seconds (for start actions)')
            .setMinValue(10)
            .setMaxValue(180)
            .setRequired(false))
        .addIntegerOption(option =>
          option
            .setName('max_players')
            .setDescription('Optional max players (battle create)')
            .setMinValue(2)
            .setMaxValue(100)
            .setRequired(false))
        .addStringOption(option =>
          option
            .setName('era')
            .setDescription('Optional battle era (battle create)')
            .setRequired(false))
        .addStringOption(option =>
          option
            .setName('games')
            .setDescription('Optional game list (gamenight start)')
            .setMaxLength(200)
            .setRequired(false))
        .addUserOption(option =>
          option
            .setName('user')
            .setDescription('Optional target user (battle stats)')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('help')
        .setDescription('Show supported game/action routing matrix')),

  async execute(interaction) {
    try {
      if (!await moduleGuard.checkModuleEnabled(interaction, 'minigames')) return;

      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'help') {
        const lines = Object.entries(ALLOWED_ACTIONS)
          .map(([game, actions]) => `- \`${game}\`: ${[...actions].join(', ')}`);
        return interaction.reply({
          content: `Use \`/minigames run\` with:\n${lines.join('\n')}\n\nLegacy game commands remain available during migration.`,
          ephemeral: true
        });
      }

      const game = String(interaction.options.getString('game') || '').trim().toLowerCase();
      const action = String(interaction.options.getString('action') || '').trim().toLowerCase();
      const allowed = ALLOWED_ACTIONS[game];

      if (!allowed) {
        return interaction.reply({ content: 'Unknown minigame selected.', ephemeral: true });
      }
      if (!allowed.has(action)) {
        return interaction.reply({
          content: `\`${action}\` is not supported for \`${game}\`. Allowed: ${[...allowed].join(', ')}`,
          ephemeral: true
        });
      }

      const optionError = validateRouteOptions(interaction, game, action);
      if (optionError) {
        return interaction.reply({ content: optionError, ephemeral: true });
      }

      const target = interaction.client?.commands?.get(game);
      if (!target || typeof target.execute !== 'function') {
        return interaction.reply({
          content: `Command route for \`${game}\` is not available right now.`,
          ephemeral: true
        });
      }

      const proxiedInteraction = createCommandProxy(interaction, game, action);
      await target.execute(proxiedInteraction);
    } catch (error) {
      logger.error('[minigames] route error:', error);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: 'An error occurred while routing this minigame command.' });
        } else {
          await interaction.reply({ content: 'An error occurred while routing this minigame command.', ephemeral: true });
        }
      } catch (_) {}
    }
  },
};


