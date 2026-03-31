const { SlashCommandBuilder } = require('discord.js');
const slotsService = require('../../services/slotsService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runGame(game, lobbyMessage, guildId) {
  const channel = lobbyMessage.channel;
  try {
    await lobbyMessage.edit({ embeds: [slotsService.buildCancelledEmbed('🎰 Spinning the reels... good luck!', guildId)] });
    await lobbyMessage.reactions.removeAll().catch(() => {});
  } catch (_) {}

  game.status = 'playing';
  await sleep(2000);

  // Everyone spins simultaneously
  const results = [...game.players].map(userId => {
    const reels = slotsService.spin();
    const score = slotsService.score(reels);
    const combo = slotsService.comboLabel(reels);
    return { userId, reels, score, combo };
  }).sort((a, b) => b.score - a.score);

  await channel.send({ embeds: [slotsService.buildSpinEmbed({ results, guildId })] });
  await sleep(3000);

  const top = results[0];
  const winners = results.filter(r => r.score === top.score);
  if (winners.length === 1) {
    await channel.send({ content: `🏆 <@${top.userId}>`, embeds: [slotsService.buildWinnerEmbed({ winnerId: top.userId, reels: top.reels, score: top.score, combo: top.combo, guildId })] });
  } else {
    const mention = winners.map(w => `<@${w.userId}>`).join(', ');
    await channel.send({ embeds: [slotsService.buildCancelledEmbed(`🤝 Tie! ${mention} all share top score of **${top.score} pts** with **${top.combo}**!`, guildId)] });
  }

  slotsService.endGame(game.lobbyMessageId);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('slots')
    .setDescription('🎰 Slots — highest spin wins!')
    .addSubcommand(s => s.setName('start').setDescription('Start a Slots game')
      .addIntegerOption(o => o.setName('join_time').setDescription('Seconds to gather (10–120, default 45)').setMinValue(10).setMaxValue(120).setRequired(false)))
    .addSubcommand(s => s.setName('cancel').setDescription('Cancel the current lobby')),

  async execute(interaction) {
    try {
      if (!await moduleGuard.checkModuleEnabled(interaction, 'battle')) return;
      const sub = interaction.options.getSubcommand();
      const { guildId, user, channel } = interaction;

      if (sub === 'start') {
        const gatherSecs = interaction.options.getInteger('join_time') || 45;
        await interaction.deferReply({ ephemeral: true });
        for (const [, g] of slotsService._games) {
          if (g.channelId === channel.id && g.status === 'waiting')
            return interaction.editReply({ content: '❌ A Slots lobby is already open here.' });
        }
        const placeholder = await channel.send({ content: '🎰 Setting up Slots...' });
        const game = slotsService.createLobby({ channelId: channel.id, messageId: placeholder.id, creatorId: user.id, gatherSecs });
        await placeholder.edit({ content: '', embeds: [slotsService.buildLobbyEmbed(game, guildId)] });
        await placeholder.react(slotsService.JOIN_EMOJI).catch(() => {});
        await interaction.editReply({ content: `✅ Slots lobby created! React ${slotsService.JOIN_EMOJI} to join. Starts in **${gatherSecs}s**.` });

        game.gatherTimer = setTimeout(async () => {
          try {
            if (game.status !== 'waiting') return;
            if (game.players.size < 2) {
              await placeholder.edit({ embeds: [slotsService.buildCancelledEmbed('❌ Not enough players. Game cancelled.', guildId)] });
              await placeholder.reactions.removeAll().catch(() => {});
              slotsService.endGame(game.lobbyMessageId); return;
            }
            await runGame(game, placeholder, guildId);
          } catch (err) { logger.error('[Slots] runGame error:', err); slotsService.endGame(game.lobbyMessageId); }
        }, gatherSecs * 1000);
        return;
      }

      if (sub === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        let found = null;
        for (const [, g] of slotsService._games) { if (g.channelId === channel.id && g.status === 'waiting' && g.creatorId === user.id) { found = g; break; } }
        if (!found) return interaction.editReply({ content: '❌ No open Slots lobby found for you here.' });
        try { const msg = await channel.messages.fetch(found.lobbyMessageId); await msg.edit({ embeds: [slotsService.buildCancelledEmbed('❌ Cancelled by host.', guildId)] }); await msg.reactions.removeAll().catch(() => {}); } catch (_) {}
        slotsService.endGame(found.lobbyMessageId);
        return interaction.editReply({ content: '✅ Lobby cancelled.' });
      }
    } catch (err) {
      logger.error('[Slots] error:', err);
      try { const r = { content: '❌ Error occurred.', ephemeral: true }; if (interaction.deferred || interaction.replied) await interaction.editReply(r); else await interaction.reply(r); } catch (_) {}
    }
  },
};
