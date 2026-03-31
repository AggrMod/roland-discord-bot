const { SlashCommandBuilder } = require('discord.js');
const rrService = require('../../services/reactionRaceService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROUND_GAP_MS = 4000;

async function runGame(game, lobbyMessage, guildId) {
  const channel = lobbyMessage.channel;
  try {
    await lobbyMessage.edit({ embeds: [rrService.buildCancelledEmbed('✅ Game started! Get ready to react! ⚡', guildId)] });
    await lobbyMessage.reactions.removeAll().catch(() => {});
  } catch (_) {}

  const alive = () => rrService.activePlayers(game);
  game.status = 'playing';

  while (alive().length > 1) {
    game.roundNumber++;
    await sleep(ROUND_GAP_MS);

    // Ready message
    const readyMsg = await channel.send({ embeds: [rrService.buildReadyEmbed(game.roundNumber, guildId)] });

    // Random delay 2–7s
    await sleep(2000 + Math.floor(Math.random() * 5000));

    // GO!
    await readyMsg.edit({ embeds: [rrService.buildGoEmbed(game.roundNumber, alive().length, guildId)] });
    await readyMsg.react(rrService.RACE_EMOJI).catch(() => {});

    // Collect reactions in order
    const reactionOrder = [];
    const aliveNow = alive();
    const collector = readyMsg.createReactionCollector({
      filter: (r, u) => r.emoji.name === rrService.RACE_EMOJI && !u.bot && aliveNow.includes(u.id),
      time: 8000,
    });
    collector.on('collect', (_, user) => {
      if (!reactionOrder.includes(user.id)) reactionOrder.push(user.id);
    });
    await new Promise(resolve => collector.on('end', resolve));

    // Eliminate: last to react (or non-reactors)
    const didntReact = aliveNow.filter(id => !reactionOrder.includes(id));
    let eliminated = [];

    if (didntReact.length > 0) {
      // Eliminate all who didn't react first
      eliminated = didntReact;
    } else if (reactionOrder.length > 0) {
      // Eliminate the last reactor
      eliminated = [reactionOrder[reactionOrder.length - 1]];
    }
    // If everyone tied (all reacted at same instant) — no eliminations this round

    for (const id of eliminated) game.eliminated.add(id);

    const resultEmbed = rrService.buildResultEmbed({ round: game.roundNumber, reacted: reactionOrder, eliminated, remaining: alive().length, guildId });
    await channel.send({ embeds: [resultEmbed] });

    if (alive().length <= 1) break;
  }

  const survivors = alive();
  if (survivors.length === 1) {
    await channel.send({ content: `🏆 <@${survivors[0]}>`, embeds: [rrService.buildWinnerEmbed({ winnerId: survivors[0], rounds: game.roundNumber, guildId })] });
  } else {
    await channel.send({ embeds: [rrService.buildCancelledEmbed(survivors.length === 0 ? '💀 Everyone eliminated!' : `🤝 Draw! ${survivors.map(id=>`<@${id}>`).join(', ')}`, guildId)] });
  }
  rrService.endGame(game.lobbyMessageId);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reactionrace')
    .setDescription('⚡ Reaction Race — first to react survives!')
    .addSubcommand(s => s.setName('start').setDescription('Start a Reaction Race lobby')
      .addIntegerOption(o => o.setName('join_time').setDescription('Seconds to gather (10–120, default 60)').setMinValue(10).setMaxValue(120).setRequired(false)))
    .addSubcommand(s => s.setName('cancel').setDescription('Cancel the current lobby')),

  async execute(interaction) {
    try {
      if (!await moduleGuard.checkModuleEnabled(interaction, 'battle')) return;
      const sub = interaction.options.getSubcommand();
      const { guildId, user, channel } = interaction;

      if (sub === 'start') {
        const gatherSecs = interaction.options.getInteger('join_time') || 60;
        await interaction.deferReply({ ephemeral: true });
        for (const [, g] of rrService._games) {
          if (g.channelId === channel.id && g.status === 'waiting')
            return interaction.editReply({ content: '❌ A Reaction Race lobby is already open here.' });
        }
        const placeholder = await channel.send({ content: '⚡ Setting up Reaction Race...' });
        const game = rrService.createLobby({ channelId: channel.id, messageId: placeholder.id, creatorId: user.id, gatherSecs });
        await placeholder.edit({ content: '', embeds: [rrService.buildLobbyEmbed(game, guildId)] });
        await placeholder.react(rrService.JOIN_EMOJI).catch(() => {});
        await interaction.editReply({ content: `✅ Reaction Race lobby created! React ${rrService.JOIN_EMOJI} to join. Starts in **${gatherSecs}s**.` });

        game.gatherTimer = setTimeout(async () => {
          try {
            if (game.status !== 'waiting') return;
            if (game.players.size < 2) {
              await placeholder.edit({ embeds: [rrService.buildCancelledEmbed('❌ Not enough players. Game cancelled.', guildId)] });
              await placeholder.reactions.removeAll().catch(() => {});
              rrService.endGame(game.lobbyMessageId); return;
            }
            await runGame(game, placeholder, guildId);
          } catch (err) { logger.error('[ReactionRace] runGame error:', err); rrService.endGame(game.lobbyMessageId); }
        }, gatherSecs * 1000);
        return;
      }

      if (sub === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        let found = null;
        for (const [, g] of rrService._games) { if (g.channelId === channel.id && g.status === 'waiting' && g.creatorId === user.id) { found = g; break; } }
        if (!found) return interaction.editReply({ content: '❌ No open Reaction Race lobby found for you here.' });
        try { const msg = await channel.messages.fetch(found.lobbyMessageId); await msg.edit({ embeds: [rrService.buildCancelledEmbed('❌ Cancelled by host.', guildId)] }); await msg.reactions.removeAll().catch(() => {}); } catch (_) {}
        rrService.endGame(found.lobbyMessageId);
        return interaction.editReply({ content: '✅ Lobby cancelled.' });
      }
    } catch (err) {
      logger.error('[ReactionRace] error:', err);
      try { const r = { content: '❌ Error occurred.', ephemeral: true }; if (interaction.deferred || interaction.replied) await interaction.editReply(r); else await interaction.reply(r); } catch (_) {}
    }
  },
};
