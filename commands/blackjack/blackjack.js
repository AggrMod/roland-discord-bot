const { SlashCommandBuilder } = require('discord.js');
const bjService = require('../../services/blackjackService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function takeTurn(channel, game, userId, guildId) {
  let hand = game.hands.get(userId);

  while (true) {
    const turnMsg = await channel.send({ content: `<@${userId}>`, embeds: [bjService.buildTurnEmbed({ userId, hand, guildId })] });
    await turnMsg.react(bjService.HIT_EMOJI).catch(() => {});
    await turnMsg.react(bjService.STAND_EMOJI).catch(() => {});

    let decision = null;
    const collector = turnMsg.createReactionCollector({
      filter: (r, u) => [bjService.HIT_EMOJI, bjService.STAND_EMOJI].includes(r.emoji.name) && u.id === userId && !u.bot,
      time: bjService.TURN_SECS * 1000,
      max: 1,
    });
    await new Promise(resolve => {
      collector.on('collect', (r) => { decision = r.emoji.name; resolve(); });
      collector.on('end', resolve);
    });

    // Default stand if no reaction
    if (!decision || decision === bjService.STAND_EMOJI) break;

    // Hit
    hand.push(game.deck.pop());
    const val = require('../../services/blackjackService').handValue?.(hand);
    // Check bust (we just check inline)
    let total = 0, aces = 0;
    for (const c of hand) { if (c.r === 'A') { total += 11; aces++; } else total += ['J','Q','K'].includes(c.r) ? 10 : parseInt(c.r); }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    if (total >= 21) break;
  }
}

async function runGame(game, lobbyMessage, guildId) {
  const channel = lobbyMessage.channel;
  try {
    await lobbyMessage.edit({ embeds: [bjService.buildCancelledEmbed('🎴 Dealing cards...', guildId)] });
    await lobbyMessage.reactions.removeAll().catch(() => {});
  } catch (_) {}

  game.status = 'playing';
  bjService.deal(game);
  await sleep(1500);

  // Show initial table
  await channel.send({ embeds: [bjService.buildTableEmbed({ game, dealerVisible: false, guildId })] });
  await sleep(2000);

  // Each player takes their turn sequentially
  for (const userId of game.players) {
    await takeTurn(channel, game, userId, guildId);
    await sleep(1000);
  }

  // Dealer plays
  bjService.dealerPlay(game);
  await sleep(1500);

  // Resolve
  const { results, dealerVal, dealerBust } = bjService.resolveAll(game);
  await channel.send({ embeds: [bjService.buildResultEmbed({ results, dealerVal, dealerBust, dealerHand: game.dealerHand, guildId })] });

  await sleep(2000);
  const winners = [...results.entries()].filter(([, r]) => r.outcome === 'win').map(([id]) => id);
  if (winners.length > 0) {
    await channel.send({ content: winners.map(id => `<@${id}>`).join(' '), embeds: [bjService.buildWinnerEmbed({ winners, guildId })] });
  } else {
    await channel.send({ embeds: [bjService.buildCancelledEmbed('🃏 Dealer wins! Nobody beat the house this time.', guildId)] });
  }

  bjService.endGame(game.lobbyMessageId);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('🎴 Blackjack — beat the dealer!')
    .addSubcommand(s => s.setName('start').setDescription('Start a Blackjack game')
      .addIntegerOption(o => o.setName('join_time').setDescription('Seconds to gather (10–120, default 60)').setMinValue(10).setMaxValue(120).setRequired(false)))
    .addSubcommand(s => s.setName('cancel').setDescription('Cancel the current lobby')),

  async execute(interaction) {
    try {
      if (!await moduleGuard.checkModuleEnabled(interaction, 'battle')) return;
      if (!await moduleGuard.checkAdminOrModerator(interaction)) return;
      const sub = interaction.options.getSubcommand();
      const { guildId, user, channel } = interaction;

      if (sub === 'start') {
        const gatherSecs = interaction.options.getInteger('join_time') || 60;
        await interaction.deferReply({ ephemeral: true });
        for (const [, g] of bjService._games) {
          if (g.channelId === channel.id && g.status === 'waiting')
            return interaction.editReply({ content: '❌ A Blackjack game is already open here.' });
        }
        const placeholder = await channel.send({ content: '🎴 Setting up Blackjack...' });
        const game = bjService.createLobby({ channelId: channel.id, messageId: placeholder.id, creatorId: user.id, gatherSecs });
        await placeholder.edit({ content: '', embeds: [bjService.buildLobbyEmbed(game, guildId)] });
        await placeholder.react(bjService.JOIN_EMOJI).catch(() => {});
        await interaction.editReply({ content: `✅ Blackjack table open! React ${bjService.JOIN_EMOJI} to join. Starts in **${gatherSecs}s**.` });

        game.gatherTimer = setTimeout(async () => {
          try {
            if (game.status !== 'waiting') return;
            if (game.players.size < 2) {
              await placeholder.edit({ embeds: [bjService.buildCancelledEmbed('❌ Not enough players. Game cancelled.', guildId)] });
              await placeholder.reactions.removeAll().catch(() => {});
              bjService.endGame(game.lobbyMessageId); return;
            }
            await runGame(game, placeholder, guildId);
          } catch (err) { logger.error('[Blackjack] runGame error:', err); bjService.endGame(game.lobbyMessageId); }
        }, gatherSecs * 1000);
        return;
      }

      if (sub === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        let found = null;
        for (const [, g] of bjService._games) { if (g.channelId === channel.id && g.status === 'waiting' && g.creatorId === user.id) { found = g; break; } }
        if (!found) return interaction.editReply({ content: '❌ No open Blackjack game found for you here.' });
        try { const msg = await channel.messages.fetch(found.lobbyMessageId); await msg.edit({ embeds: [bjService.buildCancelledEmbed('❌ Cancelled by host.', guildId)] }); await msg.reactions.removeAll().catch(() => {}); } catch (_) {}
        bjService.endGame(found.lobbyMessageId);
        return interaction.editReply({ content: '✅ Game cancelled.' });
      }
    } catch (err) {
      logger.error('[Blackjack] error:', err);
      try { const r = { content: '❌ Error occurred.', ephemeral: true }; if (interaction.deferred || interaction.replied) await interaction.editReply(r); else await interaction.reply(r); } catch (_) {}
    }
  },
};
