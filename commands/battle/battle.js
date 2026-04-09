const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const battleService = require('../../services/battleService');
const battleDb = require('../../database/battleDb');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');
const settingsManager = require('../../config/settings');
const tenantService = require('../../services/tenantService');
const entitlementService = require('../../services/entitlementService');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getBattleRuntimeSettings(guildId = null) {
  const globalSettings = settingsManager.getSettings() || {};
  const runtimeSettings = {
    battleRoundPauseMinSec: parseFloat(settingsManager.getBattleRoundPauseMinSec()),
    battleRoundPauseMaxSec: parseFloat(settingsManager.getBattleRoundPauseMaxSec()),
    battleElitePrepSec: parseFloat(settingsManager.getBattleElitePrepSec()),
    battleForcedEliminationIntervalRounds: settingsManager.getBattleForcedEliminationIntervalRounds
      ? settingsManager.getBattleForcedEliminationIntervalRounds()
      : 3,
    battleDefaultEra: globalSettings.battleDefaultEra || 'mafia',
  };

  if (tenantService.isMultitenantEnabled() && guildId) {
    const tenantBattleSettings = tenantService.getTenantBattleSettings(guildId);
    if (tenantBattleSettings.battleRoundPauseMinSec !== null) runtimeSettings.battleRoundPauseMinSec = tenantBattleSettings.battleRoundPauseMinSec;
    if (tenantBattleSettings.battleRoundPauseMaxSec !== null) runtimeSettings.battleRoundPauseMaxSec = tenantBattleSettings.battleRoundPauseMaxSec;
    if (tenantBattleSettings.battleElitePrepSec !== null) runtimeSettings.battleElitePrepSec = tenantBattleSettings.battleElitePrepSec;
    if (tenantBattleSettings.battleForcedEliminationIntervalRounds !== null) runtimeSettings.battleForcedEliminationIntervalRounds = tenantBattleSettings.battleForcedEliminationIntervalRounds;
    if (tenantBattleSettings.battleDefaultEra) runtimeSettings.battleDefaultEra = tenantBattleSettings.battleDefaultEra;
  }

  return runtimeSettings;
}

function getBattleTimingMs(guildId = null) {
  const envMin = parseFloat(process.env.BATTLE_ROUND_PAUSE_MIN_MS);
  const envMax = parseFloat(process.env.BATTLE_ROUND_PAUSE_MAX_MS);
  const envElite = parseFloat(process.env.BATTLE_ELITE_FOUR_PREP_MS);

  const runtime = getBattleRuntimeSettings(guildId);
  const dbMinSec = parseFloat(runtime.battleRoundPauseMinSec);
  const dbMaxSec = parseFloat(runtime.battleRoundPauseMaxSec);
  const dbEliteSec = parseFloat(runtime.battleElitePrepSec);

  // DB settings (seconds) win if valid; otherwise env (ms); otherwise defaults
  const minMs = Number.isFinite(dbMinSec)
    ? Math.max(0, Math.round(dbMinSec * 1000))
    : (Number.isFinite(envMin) ? Math.max(0, Math.round(envMin)) : 5000);

  const maxMs = Number.isFinite(dbMaxSec)
    ? Math.max(minMs, Math.round(dbMaxSec * 1000))
    : (Number.isFinite(envMax) ? Math.max(minMs, Math.round(envMax)) : 10000);

  const elitePrepMs = Number.isFinite(dbEliteSec)
    ? Math.max(0, Math.round(dbEliteSec * 1000))
    : (Number.isFinite(envElite) ? Math.max(0, Math.round(envElite)) : 12000);

  return { minMs, maxMs, elitePrepMs };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('⚔️ Battle module - Mafia battle competition')
    
    // User commands
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('Create a new battle lobby')
        .addIntegerOption(option =>
          option
            .setName('max_players')
            .setDescription('Maximum players (optional, leave empty for unlimited)')
            .setMinValue(2)
            .setRequired(false))
        .addRoleOption(option =>
          option
            .setName('required_role_1')
            .setDescription('First required role (optional)')
            .setRequired(false))
        .addRoleOption(option =>
          option
            .setName('required_role_2')
            .setDescription('Second required role (optional)')
            .setRequired(false))
        .addRoleOption(option =>
          option
            .setName('required_role_3')
            .setDescription('Third required role (optional)')
            .setRequired(false))
        .addRoleOption(option =>
          option
            .setName('excluded_role_1')
            .setDescription('First excluded role (optional)')
            .setRequired(false))
        .addRoleOption(option =>
          option
            .setName('excluded_role_2')
            .setDescription('Second excluded role (optional)')
            .setRequired(false))
        .addRoleOption(option =>
          option
            .setName('excluded_role_3')
            .setDescription('Third excluded role (optional)')
            .setRequired(false))
        .addStringOption(option =>
          option
            .setName('era')
            .setDescription('Battle theme/era (default: mafia)')
            .setAutocomplete(true)
            .setRequired(false)))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('start')
        .setDescription('Start the battle (creator only)')
        .addUserOption(option =>
          option
            .setName('bounty_1')
            .setDescription('Optional bounty target #1 (must be in this battle)')
            .setRequired(false))
        .addUserOption(option =>
          option
            .setName('bounty_2')
            .setDescription('Optional bounty target #2 (must be in this battle)')
            .setRequired(false))
        .addUserOption(option =>
          option
            .setName('bounty_3')
            .setDescription('Optional bounty target #3 (must be in this battle)')
            .setRequired(false)))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('cancel')
        .setDescription('Cancel the battle lobby (creator only)'))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('View battle statistics')
        .addUserOption(option =>
          option
            .setName('user')
            .setDescription('User to check stats for (leave empty for yourself)')
            .setRequired(false)))
    
    // Admin subgroup
    .addSubcommandGroup(group =>
      group
        .setName('admin')
        .setDescription('Admin battle management')
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('list')
            .setDescription('List all active battles'))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('force-end')
            .setDescription('Force end a battle (emergency)')
            .addStringOption(option =>
              option
                .setName('battle_id')
                .setDescription('Battle ID to end')
                .setRequired(true))
            .addBooleanOption(option =>
              option
                .setName('confirm')
                .setDescription('Confirm force-end')
                .setRequired(true)))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('settings')
            .setDescription('View/configure battle settings'))),

  async autocomplete(interaction) {
    try {
      if (interaction.options.getSubcommand(false) !== 'create') return;
      const focused = interaction.options.getFocused(true);
      if (!focused || focused.name !== 'era') return;

      const guildId = interaction.guildId;
      const allAvailable = battleService.getAvailableEras(guildId);
      const rawQuery = String(focused.value || '').trim().toLowerCase();
      const normalizedQuery = battleService.normalizeEraKey(rawQuery);

      const filtered = allAvailable
        .filter(era => {
          if (!rawQuery) return true;
          const key = era.key.toLowerCase();
          const name = String(era.name || '').toLowerCase();
          return key.includes(rawQuery) || name.includes(rawQuery) || (normalizedQuery && key.includes(normalizedQuery));
        })
        .slice(0, 25)
        .map(era => ({ name: era.name, value: era.key }));

      await interaction.respond(filtered);
    } catch (error) {
      logger.error('Battle era autocomplete failed:', error);
      try {
        await interaction.respond([]);
      } catch (_) {}
    }
  },

  async execute(interaction) {
    // Check if minigames module is enabled
    if (!await moduleGuard.checkModuleEnabled(interaction, 'minigames')) {
      return;
    }

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommandGroup === 'admin') {
        // Admin commands require admin check
        if (!await moduleGuard.checkAdmin(interaction)) {
          return;
        }

        switch (subcommand) {
          case 'list':
            await this.handleAdminList(interaction);
            break;
          case 'force-end':
            await this.handleAdminForceEnd(interaction);
            break;
          case 'settings':
            await this.handleAdminSettings(interaction);
            break;
        }
      } else {
        // User commands
        switch (subcommand) {
          case 'create':
            if (!await moduleGuard.checkAdminOrModerator(interaction)) return;
            await this.handleCreate(interaction);
            break;
          case 'start':
            if (!await moduleGuard.checkAdminOrModerator(interaction)) return;
            await this.handleStart(interaction);
            break;
          case 'cancel':
            await this.handleCancel(interaction);
            break;
          case 'stats':
            await this.handleStats(interaction);
            break;
        }
      }
    } catch (error) {
      logger.error('[CommandError]', error);
      const userMsg = 'An error occurred. Please try again or contact an admin.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: userMsg });
      } else {
        await interaction.reply({ content: userMsg, ephemeral: true });
      }
    }
  },

  // ==================== USER COMMANDS ====================

  async handleCreate(interaction) {
    await interaction.deferReply();

    const creatorId = interaction.user.id;
    const channelId = interaction.channelId;
    const guildId = interaction.guildId;
    const maxPlayers = interaction.options.getInteger('max_players') || 999;

    // Determine era: explicit option → guild's assigned exclusive era → mafia default
    const availableEras = battleService.getAvailableEras(guildId);
    const availableEraKeys = availableEras.map(era => era.key);
    const configuredDefaultEra = getBattleRuntimeSettings(guildId).battleDefaultEra || 'mafia';
    const defaultEra = battleService.getDefaultAvailableEra(guildId, configuredDefaultEra);
    const requestedEraInput = interaction.options.getString('era');
    const requestedEra = requestedEraInput
      ? battleService.normalizeEraKey(requestedEraInput)
      : defaultEra;

    if (!availableEraKeys.includes(requestedEra)) {
      const availableList = availableEras.map(era => era.name).join(', ') || 'none';
      const requestedDisplay = requestedEraInput || requestedEra || 'unknown';
      return interaction.editReply({
        content: `❌ Era "${requestedDisplay}" is not available for this server. Available eras: ${availableList}`,
        ephemeral: true
      });
    }

    const requiredRoleArray = [];
    const requiredRoles = [];
    for (let i = 1; i <= 3; i++) {
      const role = interaction.options.getRole(`required_role_${i}`);
      if (role) {
        requiredRoleArray.push(role.id);
        requiredRoles.push(role);
      }
    }

    const excludedRoleArray = [];
    const excludedRoles = [];
    for (let i = 1; i <= 3; i++) {
      const role = interaction.options.getRole(`excluded_role_${i}`);
      if (role) {
        excludedRoleArray.push(role.id);
        excludedRoles.push(role);
      }
    }

    // Prevent multiple active battles in the same channel (open or in_progress)
    const existing = battleDb.prepare(
      "SELECT * FROM battle_lobbies WHERE channel_id = ? AND status IN ('open','in_progress') ORDER BY created_at DESC LIMIT 1"
    ).get(channelId);

    if (existing) {
      return interaction.editReply({ content: '❌ There is already an active battle in this channel. Finish or cancel it before creating a new one.', ephemeral: true });
    }

    // Create temporary message first to get messageId
    const placeholder = await interaction.channel.send({ content: '⚔️ Setting up battle lobby...' });

    const createResult = battleService.createLobby(
      channelId,
      placeholder.id,
      creatorId,
      2,
      maxPlayers,
      requiredRoleArray.length ? requiredRoleArray : null,
      excludedRoleArray.length ? excludedRoleArray : null,
      requestedEra
    );

    if (!createResult.success) {
      await placeholder.delete().catch(() => {});
      return interaction.editReply({ content: `❌ ${createResult.message}`, ephemeral: true });
    }

    const lobby = battleService.getLobby(createResult.lobbyId);
    const participants = battleService.getParticipants(createResult.lobbyId);
    const lobbyEmbed = battleService.buildLobbyEmbed(lobby, participants, requiredRoles.length ? requiredRoles : null, excludedRoles.length ? excludedRoles : null);
    const joinEmoji = battleService.getLobbyJoinEmoji(requestedEra);

    await placeholder.edit({ content: '', embeds: [lobbyEmbed] });
    await placeholder.react(joinEmoji);

    await interaction.editReply({
      content: `✅ Battle lobby created! Players can join by reacting ${joinEmoji} on the lobby message.`
    });

    logger.log(`User ${interaction.user.username} created battle lobby ${createResult.lobbyId}`);
  },

  async handleStart(interaction) {
    await interaction.deferReply();

    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const lobby = battleDb.prepare(
      'SELECT * FROM battle_lobbies WHERE channel_id = ? AND creator_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
    ).get(channelId, userId, 'open');

    if (!lobby) {
      return interaction.editReply({ content: 'No open lobby found for you in this channel.', ephemeral: true });
    }

    const joinedParticipants = battleService.getParticipants(lobby.lobby_id);
    const joinedParticipantIds = new Set(joinedParticipants.map(p => p.user_id));
    const selectedBountyUsers = [
      interaction.options.getUser('bounty_1'),
      interaction.options.getUser('bounty_2'),
      interaction.options.getUser('bounty_3'),
    ].filter(Boolean);
    const bountyTargetIds = [...new Set(selectedBountyUsers.map(user => user.id))];
    const bountyLimitCheck = entitlementService.enforceLimit({
      guildId: interaction.guildId || '',
      moduleKey: 'minigames',
      limitKey: 'max_bounties_per_battle',
      currentCount: 0,
      incrementBy: bountyTargetIds.length,
      itemLabel: 'bounties per battle'
    });

    if (selectedBountyUsers.length !== bountyTargetIds.length) {
      return interaction.editReply({ content: 'Duplicate bounty targets detected. Select up to 3 unique fighters.', ephemeral: true });
    }

    if (!bountyLimitCheck.success) {
      return interaction.editReply({ content: bountyLimitCheck.message });
    }

    const invalidBountyTargets = bountyTargetIds.filter(id => !joinedParticipantIds.has(id));
    if (invalidBountyTargets.length) {
      return interaction.editReply({
        content: `Bounty targets must be fighters already joined in this lobby. Invalid: ${invalidBountyTargets.map(id => `<@${id}>`).join(', ')}`,
        ephemeral: true
      });
    }

    const bountySave = battleService.setLobbyBounties(lobby.lobby_id, bountyTargetIds);
    if (!bountySave.success) {
      return interaction.editReply({ content: bountySave.message || 'Failed to save bounty targets.', ephemeral: true });
    }

    const startResult = battleService.startBattle(lobby.lobby_id, userId);
    if (!startResult.success) {
      return interaction.editReply({ content: startResult.message, ephemeral: true });
    }

    const bountyIntro = bountyTargetIds.length
      ? `\nBounties active: ${bountyTargetIds.map(id => `<@${id}>`).join(', ')}`
      : '';
    await interaction.editReply({ content: `Battle started with ${startResult.participants.length} fighters. Let the chaos begin...${bountyIntro}` });

    // Simulate and post rounds
    const forcedEliminationInterval = getBattleRuntimeSettings(interaction.guildId).battleForcedEliminationIntervalRounds || 3;
    const sim = battleService.simulateBattle(lobby.lobby_id, {
      era: lobby.era || 'mafia',
      forcedEliminationInterval
    });
    if (!sim || !sim.winner) {
      return interaction.followUp({ content: 'Battle simulation failed unexpectedly.' });
    }

    const timing = getBattleTimingMs(interaction.guildId);

    for (let i = 0; i < sim.rounds.length; i++) {
      const r = sim.rounds[i];
      const lines = (r.events || []).slice(0, 8).map(e => `- ${e}`).join('\n');
      const isEliteIntro = !!r.eliteFourActivated;

      if (isEliteIntro && Array.isArray(r.eliteFourUserIds) && r.eliteFourUserIds.length) {
        const mentions = r.eliteFourUserIds.map(id => `<@${id}>`).join(' ');
        await interaction.channel.send({
          content: `Elite Four incoming. Prepare yourselves...\n${mentions}`
        });
        await sleep(timing.elitePrepMs);
      }

      const roundEmbed = new EmbedBuilder()
        .setColor(isEliteIntro ? '#ED4245' : '#57F287')
        .setTitle(isEliteIntro ? `ELITE FOUR - Round ${r.round}` : `Round ${r.round}`)
        .setDescription(`${lines}\n\n**Players Left:** ${r.playersLeft}`)
        .setFooter({ text: isEliteIntro ? 'No revivals. No mercy. Final circle.' : `Era: ${battleService.getEraConfig(lobby.era || 'mafia').name}` });

      await interaction.channel.send({ embeds: [roundEmbed] });

      if (r.hpSnapshot && (r.hpSnapshot.mostHp?.length || r.hpSnapshot.leastHp?.length)) {
        const formatHpRows = (rows) => (rows || [])
          .map((entry, idx) => `${idx + 1}. <@${entry.userId}> - **${entry.hp} HP**`)
          .join('\n') || 'No fighters remaining.';

        const hpEmbed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle(`HP Leaderboard - Round ${r.round}`)
          .addFields(
            { name: 'Top 5 Most HP', value: formatHpRows(r.hpSnapshot.mostHp), inline: true },
            { name: 'Top 5 Least HP', value: formatHpRows(r.hpSnapshot.leastHp), inline: true }
          )
          .setFooter({ text: 'HP checkpoint every 10 rounds' });

        await interaction.channel.send({ embeds: [hpEmbed] });
      }

      // Add pacing pause between rounds (5-10 seconds), except after the final round
      if (i < sim.rounds.length - 1) {
        const pauseMs = timing.minMs + Math.floor(Math.random() * (timing.maxMs - timing.minMs + 1));
        await sleep(pauseMs);
      }
    }

    const winner = sim.winner;
    const outro = sim.finaleOutro || sim.winnerLine;
    const victoryEraKey = sim.eraKey || lobby.era || 'mafia';
    const victoryTitle = battleService.getVictoryEmbedTitle(victoryEraKey);
    const victoryFooter = battleService.getVictoryEmbedFooter(victoryEraKey);
    const victoryAnnouncement = battleService.getVictoryAnnouncement(victoryEraKey, winner.user_id);
    const topDamageSummary = (sim.topDamageDealers || [])
      .map(row => `${row.rank}. <@${row.userId}> - **${row.damage}** dmg`)
      .join('\n') || 'No damage data available.';
    const bountySummary = (sim.bountyResults || [])
      .map(result => {
        if (result.winnerId) {
          const reason = result.reason === 'final_blow' ? 'final blow' : 'most damage fallback';
          return `<@${result.targetId}> -> <@${result.winnerId}> (${reason})`;
        }
        if (result.reason === 'not_eliminated') {
          return `<@${result.targetId}> survived - bounty unclaimed`;
        }
        return `<@${result.targetId}> - no eligible claimant`;
      })
      .join('\n');
    const bountyWinners = [...new Set((sim.bountyResults || [])
      .filter(result => !!result.winnerId)
      .map(result => `<@${result.winnerId}>`))];

    const winnerEmbed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(victoryTitle)
      .setDescription(`🎉 **<@${winner.user_id}>**\n\n${outro}`)
      .addFields(
        { name: 'Rounds Survived', value: `${sim.roundCount || sim.rounds.length}`, inline: true },
        { name: 'Final HP', value: `${winner.hp ?? 0}`, inline: true },
        { name: 'Total Damage', value: `${winner.total_damage_dealt ?? 0}`, inline: true },
        { name: 'Total Fighters', value: `${sim.totalPlayers || startResult.participants.length}`, inline: true },
        { name: 'Top 5 Damage Dealers', value: topDamageSummary, inline: false },
        ...(bountySummary ? [{ name: 'Bounty Claims', value: bountySummary, inline: false }] : [])
      )
      .setFooter({ text: victoryFooter })
      .setTimestamp();

    const bountyWinnerText = bountyWinners.length
      ? `\nBounties claimed by: ${bountyWinners.join(', ')}`
      : '';

    await interaction.channel.send({ content: `${victoryAnnouncement}${bountyWinnerText}`, embeds: [winnerEmbed] });

    logger.log(`Battle ${lobby.lobby_id} completed. Winner: ${winner.username}`);
  },

  async handleCancel(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const lobby = battleDb.prepare(
      'SELECT * FROM battle_lobbies WHERE channel_id = ? AND creator_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
    ).get(channelId, userId, 'open');

    if (!lobby) {
      return interaction.editReply({ content: '❌ No open lobby found for you in this channel.', ephemeral: true });
    }

    const result = battleService.cancelBattle(lobby.lobby_id, userId);

    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
    }

    // Close/update the original lobby message so channel state is clear
    try {
      const channel = await interaction.client.channels.fetch(lobby.channel_id);
      if (channel) {
        const msg = await channel.messages.fetch(lobby.message_id);
        if (msg) {
          const cancelledEmbed = new EmbedBuilder()
            .setColor('#ED4245')
            .setTitle('🛑 Battle Cancelled')
            .setDescription(`This battle was cancelled by <@${interaction.user.id}>.`)
            .setFooter({ text: 'Create a new battle with /battle create' })
            .setTimestamp();

          await msg.edit({ content: '', embeds: [cancelledEmbed] });
          await msg.reactions.removeAll().catch(() => {});
        }
      }
    } catch (e) {
      const apiCode = Number(e?.code || e?.rawError?.code || 0);
      if (apiCode === 10008) {
        logger.warn(`Cancelled battle message already gone (battle ${lobby.lobby_id}, message ${lobby.message_id})`);
      } else {
        logger.error('Failed to update cancelled battle message:', e);
      }
    }

    await interaction.editReply({ content: '✅ Battle cancelled and lobby closed.', ephemeral: true });
    logger.log(`Battle ${lobby.lobby_id} cancelled by ${interaction.user.username}`);
  },

  async handleStats(interaction) {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const stats = battleService.getStats(targetUser.id) || {};

    const played = stats.battles_played || 0;
    const won = stats.battles_won || 0;
    const losses = Math.max(played - won, 0);
    const winRate = played > 0 ? ((won / played) * 100).toFixed(1) : '0.0';

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(`⚔️ Battle Stats: ${targetUser.username}`)
      .setDescription('Battle performance overview')
      .addFields(
        { name: '🏆 Wins', value: `${won}`, inline: true },
        { name: '💀 Losses', value: `${losses}`, inline: true },
        { name: '📊 Win Rate', value: `${winRate}%`, inline: true },
        { name: '⚔️ Total Battles', value: `${played}`, inline: true },
        { name: '💥 Total Damage', value: `${stats.total_damage_dealt || 0}`, inline: true }
      )
      .setFooter({ text: 'Keep fighting for the Family!' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} viewed battle stats for ${targetUser.username}`);
  },

  // ==================== ADMIN COMMANDS ====================

  async handleAdminList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const battles = battleDb.prepare("SELECT * FROM battle_lobbies WHERE status IN ('open', 'in_progress') ORDER BY created_at DESC").all();

    if (battles.length === 0) {
      return interaction.editReply({ content: '❌ No active battles.', ephemeral: true });
    }

    const battleList = battles.map((b, i) => {
      const count = battleService.getParticipants(b.lobby_id).length;
      return `${i + 1}. **${b.lobby_id}**: ${count} players (Status: ${b.status})`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚔️ All Active Battles')
      .setDescription(battleList)
      .setFooter({ text: `Total: ${battles.length}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed battle list`);
  },

  async handleAdminForceEnd(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const battleId = interaction.options.getString('battle_id');
    const confirm = interaction.options.getBoolean('confirm');

    if (!confirm) {
      return interaction.editReply({ content: '❌ You must set confirm=true to force-end a battle.', ephemeral: true });
    }

    const lobby = battleService.getLobby(battleId);
    if (!lobby) {
      return interaction.editReply({ content: `❌ Battle ${battleId} not found.`, ephemeral: true });
    }

    battleDb.prepare('UPDATE battle_lobbies SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE lobby_id = ?').run('cancelled', battleId);
    battleDb.prepare('DELETE FROM battle_participants WHERE lobby_id = ?').run(battleId);

    // Close/update original lobby message for consistency
    try {
      const channel = await interaction.client.channels.fetch(lobby.channel_id);
      if (channel) {
        const msg = await channel.messages.fetch(lobby.message_id);
        if (msg) {
          const endedEmbed = new EmbedBuilder()
            .setColor('#ED4245')
            .setTitle('🛑 Battle Force-Ended')
            .setDescription(`This battle was force-ended by admin <@${interaction.user.id}>.`)
            .setFooter({ text: 'State closed by moderation action' })
            .setTimestamp();

          await msg.edit({ content: '', embeds: [endedEmbed] });
          await msg.reactions.removeAll().catch(() => {});
        }
      }
    } catch (e) {
      logger.error('Failed to update force-ended battle message:', e);
    }

    await interaction.editReply({ content: `✅ Battle ${battleId} force-ended and lobby closed.`, ephemeral: true });
    logger.log(`Admin ${interaction.user.tag} force-ended battle ${battleId}`);
  },

  async handleAdminSettings(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚙️ Battle Settings')
      .setDescription('Current battle system configuration')
      .addFields(
        { name: 'Max Players (default)', value: 'Unlimited', inline: true },
        { name: 'Required Role', value: 'Optional', inline: true }
      )
      .setFooter({ text: 'Additional settings in Sprint B' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed battle settings`);
  }
};


