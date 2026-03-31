const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const eng = require('../../services/engagementService');
const { applyEmbedBranding } = require('../../services/embedBranding');
const moduleGuard = require('../../utils/moduleGuard');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('points')
    .setDescription('🏅 Community points — check balance, leaderboard, and shop')
    .addSubcommand(s => s.setName('balance').setDescription('Check your points balance')
      .addUserOption(o => o.setName('user').setDescription('Check another user (admin only)').setRequired(false)))
    .addSubcommand(s => s.setName('leaderboard').setDescription('View the server points leaderboard')
      .addIntegerOption(o => o.setName('limit').setDescription('How many entries (5–25, default 10)').setMinValue(5).setMaxValue(25).setRequired(false)))
    .addSubcommand(s => s.setName('history').setDescription('View your recent points history')
      .addUserOption(o => o.setName('user').setDescription('Check another user\'s history (admin only)').setRequired(false)))
    .addSubcommand(s => s.setName('shop').setDescription('Browse the points shop'))
    .addSubcommand(s => s.setName('redeem').setDescription('Redeem a shop item')
      .addIntegerOption(o => o.setName('item_id').setDescription('Item ID from /points shop').setRequired(true)))
    .addSubcommand(s => s.setName('admin').setDescription('Admin: manage points & shop')
      .addStringOption(o => o.setName('action').setDescription('Action to perform')
        .addChoices(
          { name: 'grant — give points to a user', value: 'grant' },
          { name: 'deduct — remove points from a user', value: 'deduct' },
          { name: 'add-item — add a shop item', value: 'add-item' },
          { name: 'remove-item — remove a shop item', value: 'remove-item' },
          { name: 'config — view/set points config', value: 'config' },
        ).setRequired(true))
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(false))
      .addIntegerOption(o => o.setName('amount').setDescription('Points amount').setRequired(false))
      .addStringOption(o => o.setName('reason').setDescription('Reason / item name / config key').setRequired(false))
      .addStringOption(o => o.setName('value').setDescription('Config value or shop item details').setRequired(false))
      .addIntegerOption(o => o.setName('item_id').setDescription('Shop item ID for remove-item').setRequired(false))),

  async execute(interaction) {
    try {
      if (!await moduleGuard.checkModuleEnabled(interaction, 'verification')) return;
      const sub = interaction.options.getSubcommand();
      const { guildId, user } = interaction;

      // ── /points balance ────────────────────────────────────────────────────
      if (sub === 'balance') {
        const target = interaction.options.getUser('user');
        if (target && !interaction.member.permissions.has('ManageGuild')) {
          return interaction.reply({ content: '❌ Only admins can check other users\' balance.', ephemeral: true });
        }
        const targetId = target?.id || user.id;
        const targetName = target?.username || user.username;
        const pts = eng.getUserPoints(guildId, targetId);
        const rank = eng.getLeaderboard(guildId, 100).findIndex(r => r.user_id === targetId) + 1;

        const e = new EmbedBuilder()
          .setTitle(`🏅 ${targetId === user.id ? 'Your' : `${targetName}'s`} Points Balance`)
          .setDescription(`**${pts.total_points.toLocaleString()} pts**`)
          .addFields(
            { name: '🏆 Server Rank', value: rank > 0 ? `#${rank}` : 'Unranked', inline: true },
            { name: '📊 Total Earned', value: `${pts.total_points.toLocaleString()} pts`, inline: true },
          )
          .setTimestamp();
        applyEmbedBranding(e, { guildId, moduleKey: 'verification', defaultColor: '#6366f1', defaultFooter: 'GuildPilot · Points' });
        return interaction.reply({ embeds: [e], ephemeral: true });
      }

      // ── /points leaderboard ────────────────────────────────────────────────
      if (sub === 'leaderboard') {
        const limit = interaction.options.getInteger('limit') || 10;
        const board = eng.getLeaderboard(guildId, limit);
        if (!board.length) return interaction.reply({ content: '📭 No points earned yet — start chatting!', ephemeral: false });

        const medals = ['🥇','🥈','🥉'];
        const rows = board.map((r, i) => `${medals[i] || `${i+1}.`} **${r.username || r.user_id}** — ${r.total_points.toLocaleString()} pts`).join('\n');
        const myRank = board.findIndex(r => r.user_id === user.id) + 1;
        const myPts = eng.getUserPoints(guildId, user.id);

        const e = new EmbedBuilder()
          .setTitle('🏆 Points Leaderboard')
          .setDescription(rows)
          .addFields({ name: 'Your position', value: myRank > 0 ? `#${myRank} · ${myPts.total_points.toLocaleString()} pts` : 'Not on board yet', inline: false })
          .setTimestamp();
        applyEmbedBranding(e, { guildId, moduleKey: 'verification', defaultColor: '#f59e0b', defaultFooter: `Top ${limit} · GuildPilot · Points` });
        return interaction.reply({ embeds: [e] });
      }

      // ── /points history ────────────────────────────────────────────────────
      if (sub === 'history') {
        const target = interaction.options.getUser('user');
        if (target && !interaction.member.permissions.has('ManageGuild')) {
          return interaction.reply({ content: '❌ Only admins can view other users\' history.', ephemeral: true });
        }
        const targetId = target?.id || user.id;
        const history = eng.getUserHistory(guildId, targetId, 10);
        if (!history.length) return interaction.reply({ content: '📭 No history yet.', ephemeral: true });

        const ACTION_LABEL = {
          discord_message: '💬 Message', discord_reaction: '👍 Reaction',
          game_win: '🏆 Game Win', game_place: '🎮 Game Place',
          game_night_champion: '🎉 Game Night', admin_grant: '✨ Admin Grant',
          admin_deduct: '➖ Admin Deduct', shop_redeem: '🛍️ Shop Redeem',
        };
        const rows = history.map(h => {
          const sign = h.points >= 0 ? '+' : '';
          const label = ACTION_LABEL[h.action_type] || h.action_type;
          return `${label} **${sign}${h.points} pts**${h.note ? ` — ${h.note}` : ''}`;
        }).join('\n');

        const e = new EmbedBuilder()
          .setTitle(`📋 Points History${target ? ` — ${target.username}` : ''}`)
          .setDescription(rows)
          .setTimestamp();
        applyEmbedBranding(e, { guildId, moduleKey: 'verification', defaultColor: '#6366f1', defaultFooter: 'Last 10 entries · GuildPilot · Points' });
        return interaction.reply({ embeds: [e], ephemeral: true });
      }

      // ── /points shop ───────────────────────────────────────────────────────
      if (sub === 'shop') {
        const items = eng.getShopItems(guildId);
        if (!items.length) return interaction.reply({ content: '🛍️ The shop is empty right now — check back later!', ephemeral: true });

        const myPts = eng.getUserPoints(guildId, user.id);
        const rows = items.map(item => {
          const stock = item.quantity_remaining < 0 ? '∞' : item.quantity_remaining;
          const canAfford = myPts.total_points >= item.cost ? '✅' : '❌';
          return `**[${item.id}]** ${canAfford} **${item.name}** — ${item.cost} pts _(${stock} left)_\n${item.description ? `> ${item.description}` : ''}`;
        }).join('\n\n');

        const e = new EmbedBuilder()
          .setTitle('🛍️ Points Shop')
          .setDescription(`Your balance: **${myPts.total_points.toLocaleString()} pts**\n\n${rows}\n\nUse \`/points redeem item_id:<id>\` to redeem an item.`)
          .setTimestamp();
        applyEmbedBranding(e, { guildId, moduleKey: 'verification', defaultColor: '#4ade80', defaultFooter: 'GuildPilot · Points Shop' });
        return interaction.reply({ embeds: [e], ephemeral: true });
      }

      // ── /points redeem ─────────────────────────────────────────────────────
      if (sub === 'redeem') {
        await interaction.deferReply({ ephemeral: true });
        const itemId = interaction.options.getInteger('item_id');
        const myPts = eng.getUserPoints(guildId, user.id);
        const result = eng.redeemItem(guildId, user.id, user.username, itemId);

        if (!result.success) {
          const msgs = { not_found: '❌ Item not found.', insufficient: `❌ Not enough points. You have **${myPts.total_points} pts**.`, out_of_stock: '❌ Item is out of stock.', error: '❌ Something went wrong.' };
          return interaction.editReply({ content: msgs[result.reason] || '❌ Could not redeem.' });
        }

        // If role type — assign it
        if (result.item.type === 'role' && result.item.role_id) {
          try {
            const role = interaction.guild.roles.cache.get(result.item.role_id);
            if (role) await interaction.member.roles.add(role, `Points shop redemption: ${result.item.name}`);
          } catch (e) { logger.warn('[Points] Could not assign role:', e.message); }
        }

        const e = new EmbedBuilder()
          .setTitle('✅ Redeemed!')
          .setDescription(`**${result.item.name}** redeemed for **${result.item.cost} pts**${result.code ? `\n\n🎁 Your code: \`${result.code}\`` : ''}`)
          .addFields({ name: 'Remaining balance', value: `${result.newTotal.toLocaleString()} pts`, inline: true })
          .setTimestamp();
        applyEmbedBranding(e, { guildId, moduleKey: 'verification', defaultColor: '#4ade80', defaultFooter: 'GuildPilot · Points Shop' });
        return interaction.editReply({ embeds: [e] });
      }

      // ── /points admin ──────────────────────────────────────────────────────
      if (sub === 'admin') {
        if (!interaction.member.permissions.has('ManageGuild')) {
          return interaction.reply({ content: '❌ Only admins can use this.', ephemeral: true });
        }
        const action = interaction.options.getString('action');
        await interaction.deferReply({ ephemeral: true });

        if (action === 'grant' || action === 'deduct') {
          const target = interaction.options.getUser('user');
          const amount = interaction.options.getInteger('amount');
          const reason = interaction.options.getString('reason') || (action === 'grant' ? 'Admin grant' : 'Admin deduct');
          if (!target || !amount) return interaction.editReply({ content: '❌ Provide user and amount.' });
          const result = eng.adminGrant(guildId, target.id, target.username, action === 'grant' ? amount : -amount, reason);
          return interaction.editReply({ content: `✅ ${action === 'grant' ? '+' : '-'}**${amount} pts** ${action === 'grant' ? 'granted to' : 'deducted from'} **${target.username}**.\nNew total: **${result.newTotal} pts**` });
        }

        if (action === 'add-item') {
          const name = interaction.options.getString('reason');
          const costRaw = interaction.options.getInteger('amount');
          const details = interaction.options.getString('value') || '';
          if (!name || !costRaw) return interaction.editReply({ content: '❌ Provide item name (reason) and cost (amount).' });
          // Parse details: "type=role role_id=1234 desc=some text qty=5"
          const typeMatch = details.match(/type=(\S+)/); const roleMatch = details.match(/role_id=(\d+)/);
          const descMatch = details.match(/desc=(.+?)(?:\s+\w+=|$)/); const qtyMatch = details.match(/qty=(-?\d+)/);
          const result = eng.addShopItem(guildId, {
            name, cost: costRaw,
            type: typeMatch?.[1] || 'role',
            role_id: roleMatch?.[1] || null,
            description: descMatch?.[1] || null,
            quantity_remaining: qtyMatch ? parseInt(qtyMatch[1]) : -1,
          });
          return interaction.editReply({ content: result.success ? `✅ Shop item added (ID: ${result.id}): **${name}** — ${costRaw} pts` : `❌ ${result.message}` });
        }

        if (action === 'remove-item') {
          const itemId = interaction.options.getInteger('item_id');
          if (!itemId) return interaction.editReply({ content: '❌ Provide item_id.' });
          const result = eng.removeShopItem(guildId, itemId);
          return interaction.editReply({ content: result.success ? `✅ Item #${itemId} removed.` : `❌ ${result.message}` });
        }

        if (action === 'config') {
          const cfg = eng.getConfig(guildId);
          const e = new EmbedBuilder()
            .setTitle('⚙️ Points Configuration')
            .setDescription('Current engagement points settings.')
            .addFields(
              { name: 'Enabled', value: cfg.enabled ? '✅ Yes' : '❌ No', inline: true },
              { name: 'Message points', value: `${cfg.points_message} pts`, inline: true },
              { name: 'Reaction points', value: `${cfg.points_reaction} pts`, inline: true },
              { name: 'Message cooldown', value: `${cfg.cooldown_message_mins} min`, inline: true },
              { name: 'Reaction daily cap', value: `${cfg.cooldown_reaction_daily}/day`, inline: true },
            )
            .setTimestamp();
          applyEmbedBranding(e, { guildId, moduleKey: 'verification', defaultColor: '#6366f1', defaultFooter: 'GuildPilot · Points Config' });
          return interaction.editReply({ embeds: [e] });
        }
      }

    } catch (err) {
      logger.error('[Points] error:', err);
      try { const r = { content: '❌ Error occurred.', ephemeral: true }; if (interaction.deferred || interaction.replied) await interaction.editReply(r); else await interaction.reply(r); } catch (_) {}
    }
  },
};
