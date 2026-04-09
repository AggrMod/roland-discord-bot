const db = require('../database/db');
const logger = require('../utils/logger');
const entitlementService = require('./entitlementService');
const tenantService = require('./tenantService');
const { applyEmbedBranding, createBrandedPanelEmbed } = require('./embedBranding');
const settingsManager = require('../config/settings');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

class TicketService {
  constructor() {
    this.client = null;
  }

  setClient(client) {
    this.client = client;
  }

  isEnabled() {
    return settingsManager.getSettings().moduleTicketingEnabled !== false;
  }

  _normalizeIdArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return [];
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return [...new Set(parsed.map(v => String(v).trim()).filter(Boolean))];
        }
      } catch {
        // Fallback to comma-separated IDs for legacy values.
      }
      return [...new Set(trimmed.split(',').map(v => v.trim()).filter(Boolean))];
    }
    return [];
  }

  _normalizeTemplateFields(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value
        .map(field => ({
          label: String(field.label || '').trim(),
          placeholder: String(field.placeholder || ''),
          required: field.required !== false,
          style: field.style === 'paragraph' ? 'paragraph' : 'short'
        }))
        .filter(field => field.label);
    }
    if (typeof value === 'string') {
      try {
        return this._normalizeTemplateFields(JSON.parse(value));
      } catch {
        return [];
      }
    }
    return [];
  }

  _normalizeGuildId(guildId) {
    return String(guildId || '').trim();
  }

  _resolveGuildId(guildId, { allowSingleTenantFallback = true } = {}) {
    const explicitGuildId = this._normalizeGuildId(guildId);
    if (explicitGuildId) return explicitGuildId;

    if (!allowSingleTenantFallback) return '';
    if (tenantService.isMultitenantEnabled()) return '';

    return this._normalizeGuildId(process.env.GUILD_ID || process.env.DISCORD_GUILD_ID || '');
  }

  _defaultChannelNameTemplate() {
    const raw = String(settingsManager.getSettings().ticketChannelNameTemplate || '').trim();
    return raw || '{category}-{user}-{date}';
  }

  _slugifyChannelNamePart(value, fallback = '') {
    const normalized = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || fallback;
  }

  getGuildTicketSettings(guildId = null) {
    const normalizedGuildId = this._resolveGuildId(guildId);
    const defaultTemplate = this._defaultChannelNameTemplate();
    if (!normalizedGuildId) {
      return { channelNameTemplate: defaultTemplate };
    }

    const row = db.prepare(`
      SELECT channel_name_template
      FROM ticket_guild_settings
      WHERE guild_id = ?
    `).get(normalizedGuildId);

    const template = String(row?.channel_name_template || defaultTemplate).trim() || defaultTemplate;
    return { channelNameTemplate: template };
  }

  updateGuildTicketSettings(guildId, updates = {}) {
    try {
      const normalizedGuildId = this._normalizeGuildId(guildId);
      if (!normalizedGuildId) {
        return { success: false, message: 'Guild is required' };
      }

      const current = this.getGuildTicketSettings(normalizedGuildId);
      const nextTemplate = updates.channelNameTemplate !== undefined
        ? String(updates.channelNameTemplate || '').trim()
        : current.channelNameTemplate;

      if (!nextTemplate) {
        return { success: false, message: 'Ticket channel name template cannot be empty' };
      }
      if (nextTemplate.length > 120) {
        return { success: false, message: 'Ticket channel name template cannot exceed 120 characters' };
      }
      if (!/\{(category|user|date|number)\}/i.test(nextTemplate)) {
        return { success: false, message: 'Template must include at least one token: {category}, {user}, {date}, or {number}' };
      }

      db.prepare(`
        INSERT INTO ticket_guild_settings (guild_id, channel_name_template, created_at, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(guild_id) DO UPDATE SET
          channel_name_template = excluded.channel_name_template,
          updated_at = CURRENT_TIMESTAMP
      `).run(normalizedGuildId, nextTemplate);

      return { success: true, settings: { channelNameTemplate: nextTemplate } };
    } catch (error) {
      logger.error('Error updating ticket guild settings:', error);
      return { success: false, message: 'Ticketing operation failed' };
    }
  }

  _buildTicketChannelName({ guildId, categoryName, username, ticketDate, ticketNumber }) {
    const template = this.getGuildTicketSettings(guildId).channelNameTemplate || this._defaultChannelNameTemplate();
    const replacements = {
      category: this._slugifyChannelNamePart(categoryName, 'ticket'),
      user: this._slugifyChannelNamePart(username, 'user'),
      date: this._slugifyChannelNamePart(ticketDate, ''),
      number: String(ticketNumber || '').trim() || '0',
    };

    const rendered = String(template).replace(/\{(category|user|date|number)\}/gi, (match, token) => {
      const key = String(token || '').toLowerCase();
      return replacements[key] ?? '';
    });

    const channelName = this._slugifyChannelNamePart(rendered, `ticket-${replacements.number}`).slice(0, 100);
    return channelName || `ticket-${replacements.number}`;
  }

  _bootstrapGuildCategories(guildId) {
    const normalizedGuildId = this._normalizeGuildId(guildId);
    if (!normalizedGuildId) return;

    const scopedCountRow = db.prepare(`
      SELECT COUNT(1) AS count
      FROM ticket_categories
      WHERE guild_id = ?
    `).get(normalizedGuildId);
    if ((scopedCountRow?.count || 0) > 0) return;

    const legacyCategories = db.prepare(`
      SELECT *
      FROM ticket_categories
      WHERE COALESCE(guild_id, '') = ''
      ORDER BY sort_order ASC, id ASC
    `).all();
    if (legacyCategories.length === 0) return;

    const cloneLegacyCategories = db.transaction(() => {
      const insertStmt = db.prepare(`
        INSERT INTO ticket_categories (
          guild_id, name, emoji, description, parent_channel_id, closed_parent_channel_id,
          handler_role_ids, allowed_role_ids, ping_role_ids, template_fields, enabled, sort_order
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const category of legacyCategories) {
        insertStmt.run(
          normalizedGuildId,
          category.name,
          category.emoji || '🎫',
          category.description || '',
          category.parent_channel_id || null,
          category.closed_parent_channel_id || null,
          category.handler_role_ids || '[]',
          category.allowed_role_ids || '[]',
          category.ping_role_ids || '[]',
          category.template_fields || '[]',
          category.enabled === 0 ? 0 : 1,
          Number.isFinite(category.sort_order) ? category.sort_order : 0
        );
      }
    });

    cloneLegacyCategories();
  }

  _getCategoryHandlerRoleIds(category) {
    if (!category) return [];
    const handlerRoles = this._normalizeIdArray(category.handler_role_ids);
    if (handlerRoles.length > 0) return handlerRoles;
    return this._normalizeIdArray(category.allowed_role_ids);
  }

  _getTicketHandlerRoleIds(ticket) {
    if (!ticket) return [];

    const storedHandlerRoles = this._normalizeIdArray(ticket.handler_role_ids);
    if (storedHandlerRoles.length > 0) return storedHandlerRoles;

    const legacyAllowedRoles = this._normalizeIdArray(ticket.allowed_role_ids);
    if (legacyAllowedRoles.length > 0) return legacyAllowedRoles;

    if (ticket.category_id) {
      const category = this.getCategory(ticket.category_id, ticket.guild_id, { allowLegacyFallback: true });
      return this._getCategoryHandlerRoleIds(category);
    }

    return [];
  }

  _escapeTranscriptValue(value) {
    return String(value ?? '')
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async _fetchAllMessages(channel, limit = 500) {
    const collected = [];
    let before;

    while (collected.length < limit) {
      const batch = await channel.messages.fetch({ limit: Math.min(100, limit - collected.length), ...(before ? { before } : {}) });
      if (!batch.size) break;

      const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      collected.push(...sorted);
      before = sorted[0].id;

      if (batch.size < 100) break;
    }

    return collected;
  }

  async _buildTranscript(channel, ticket) {
    const messages = await this._fetchAllMessages(channel);
    const lines = [
      `Ticket #${ticket.ticket_number} | ${ticket.category_name || 'Uncategorized'} | ${new Date().toISOString()}`,
      `Channel: #${channel.name}`,
      `Opened by: ${ticket.opener_name || ticket.opener_id}`,
      '---'
    ];

    for (const msg of messages) {
      const ts = new Date(msg.createdTimestamp).toISOString();
      const content = this._escapeTranscriptValue(msg.content);
      const attachments = msg.attachments.size > 0
        ? ` [attachments: ${[...msg.attachments.values()].map(a => a.url).join(', ')}]`
        : '';
      const embeds = msg.embeds.length > 0
        ? ` [embeds: ${msg.embeds.map(embed => this._escapeTranscriptValue(embed.title || embed.description || 'embed')).join(' | ')}]`
        : '';
      lines.push(`[${ts}] ${msg.author.tag}: ${content || '[no content]'}${attachments}${embeds}`);
    }

    return lines.join('\n');
  }

  _canManageTicket(interaction, ticket) {
    if (!interaction || !ticket) return false;
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (interaction.user?.id === ticket.opener_id) return true;
    const allowedRoles = this._getTicketHandlerRoleIds(ticket);
    if (!interaction.member?.roles?.cache) return false;
    return allowedRoles.some(roleId => interaction.member.roles.cache.has(roleId));
  }

  _canClaimTicket(interaction, ticket) {
    if (!interaction || !ticket) return false;
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    const allowedRoles = this._getTicketHandlerRoleIds(ticket);
    if (!interaction.member?.roles?.cache) return false;
    return allowedRoles.some(roleId => interaction.member.roles.cache.has(roleId));
  }

  // ==================== Category CRUD ====================

  getCategories(guildId = null) {
    const normalizedGuildId = this._resolveGuildId(guildId);
    if (!normalizedGuildId) {
      if (tenantService.isMultitenantEnabled()) return [];
      return db.prepare('SELECT * FROM ticket_categories WHERE enabled = 1 ORDER BY sort_order ASC, id ASC').all();
    }
    this._bootstrapGuildCategories(normalizedGuildId);
    return db.prepare('SELECT * FROM ticket_categories WHERE guild_id = ? AND enabled = 1 ORDER BY sort_order ASC, id ASC').all(normalizedGuildId);
  }

  getAllCategories(guildId = null) {
    const normalizedGuildId = this._resolveGuildId(guildId);
    if (!normalizedGuildId) {
      if (tenantService.isMultitenantEnabled()) return [];
      return db.prepare('SELECT * FROM ticket_categories ORDER BY sort_order ASC, id ASC').all();
    }
    this._bootstrapGuildCategories(normalizedGuildId);
    return db.prepare('SELECT * FROM ticket_categories WHERE guild_id = ? ORDER BY sort_order ASC, id ASC').all(normalizedGuildId);
  }

  getCategory(id, guildId = null, { allowLegacyFallback = true } = {}) {
    const normalizedGuildId = this._resolveGuildId(guildId);
    if (!normalizedGuildId) {
      if (tenantService.isMultitenantEnabled()) return null;
      return db.prepare('SELECT * FROM ticket_categories WHERE id = ?').get(id);
    }

    const scopedCategory = db.prepare('SELECT * FROM ticket_categories WHERE id = ? AND guild_id = ?').get(id, normalizedGuildId);
    if (scopedCategory) return scopedCategory;
    if (!allowLegacyFallback) return null;
    return db.prepare("SELECT * FROM ticket_categories WHERE id = ? AND COALESCE(guild_id, '') = ''").get(id);
  }

  addCategory({ name, emoji, description, parentChannelId, closedParentChannelId, allowedRoleIds, handlerRoleIds, pingRoleIds, templateFields }, guildId = null) {
    try {
      const normalizedGuildId = this._resolveGuildId(guildId);
      if (!normalizedGuildId) {
        return { success: false, message: 'Guild is required' };
      }
      if (normalizedGuildId) {
        const countRow = db.prepare(`
          SELECT COUNT(1) AS count
          FROM ticket_categories
          WHERE guild_id = ?
        `).get(normalizedGuildId);
        const limitCheck = entitlementService.enforceLimit({
          guildId: normalizedGuildId,
          moduleKey: 'ticketing',
          limitKey: 'max_categories',
          currentCount: Number(countRow?.count || 0),
          incrementBy: 1,
          itemLabel: 'ticket categories',
        });
        if (!limitCheck.success) {
          return {
            success: false,
            code: 'limit_exceeded',
            message: limitCheck.message,
            limit: limitCheck.limit,
            used: limitCheck.used,
          };
        }
      }

      const normalizedHandlerRoleIds = this._normalizeIdArray(handlerRoleIds !== undefined ? handlerRoleIds : allowedRoleIds);
      const normalizedPingRoleIds = this._normalizeIdArray(pingRoleIds);
      const normalizedTemplateFields = this._normalizeTemplateFields(templateFields);
      const stmt = db.prepare(`
        INSERT INTO ticket_categories (guild_id, name, emoji, description, parent_channel_id, closed_parent_channel_id, handler_role_ids, allowed_role_ids, ping_role_ids, template_fields)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        normalizedGuildId,
        String(name || '').trim(),
        emoji || '🎫',
        String(description || ''),
        parentChannelId || null,
        closedParentChannelId || null,
        JSON.stringify(normalizedHandlerRoleIds),
        JSON.stringify(normalizedHandlerRoleIds),
        JSON.stringify(normalizedPingRoleIds),
        JSON.stringify(normalizedTemplateFields)
      );
      return { success: true, id: result.lastInsertRowid };
    } catch (error) {
      logger.error('Error adding ticket category:', error);
      return { success: false, message: 'Ticketing operation failed' };
    }
  }

  updateCategory(id, updates, guildId = null) {
    try {
      const normalizedGuildId = this._resolveGuildId(guildId);
      if (!normalizedGuildId) {
        return { success: false, message: 'Guild is required' };
      }
      const category = this.getCategory(id, normalizedGuildId, { allowLegacyFallback: false });
      if (!category) return { success: false, message: 'Category not found' };

      const fields = [];
      const values = [];

      if (updates.name !== undefined) { fields.push('name = ?'); values.push(String(updates.name).trim()); }
      if (updates.emoji !== undefined) { fields.push('emoji = ?'); values.push(updates.emoji || '🎫'); }
      if (updates.description !== undefined) { fields.push('description = ?'); values.push(String(updates.description || '')); }
      if (updates.parentChannelId !== undefined) { fields.push('parent_channel_id = ?'); values.push(updates.parentChannelId || null); }
      if (updates.closedParentChannelId !== undefined) { fields.push('closed_parent_channel_id = ?'); values.push(updates.closedParentChannelId || null); }
      if (updates.handlerRoleIds !== undefined || updates.allowedRoleIds !== undefined) {
        const normalizedHandlerRoleIds = this._normalizeIdArray(
          updates.handlerRoleIds !== undefined ? updates.handlerRoleIds : updates.allowedRoleIds
        );
        fields.push('handler_role_ids = ?');
        values.push(JSON.stringify(normalizedHandlerRoleIds));
        // Keep legacy column in sync for backward compatibility.
        fields.push('allowed_role_ids = ?');
        values.push(JSON.stringify(normalizedHandlerRoleIds));
      }
      if (updates.pingRoleIds !== undefined) { fields.push('ping_role_ids = ?'); values.push(JSON.stringify(this._normalizeIdArray(updates.pingRoleIds))); }
      if (updates.templateFields !== undefined) { fields.push('template_fields = ?'); values.push(JSON.stringify(this._normalizeTemplateFields(updates.templateFields))); }
      if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
      if (updates.sortOrder !== undefined) { fields.push('sort_order = ?'); values.push(updates.sortOrder); }

      if (fields.length === 0) return { success: false, message: 'No updates provided' };

      values.push(id, normalizedGuildId);
      db.prepare(`UPDATE ticket_categories SET ${fields.join(', ')} WHERE id = ? AND guild_id = ?`).run(...values);
      return { success: true };
    } catch (error) {
      logger.error('Error updating ticket category:', error);
      return { success: false, message: 'Ticketing operation failed' };
    }
  }

  deleteCategory(id, guildId = null) {
    try {
      const normalizedGuildId = this._resolveGuildId(guildId);
      if (!normalizedGuildId) {
        return { success: false, message: 'Guild is required' };
      }
      db.prepare('DELETE FROM ticket_categories WHERE id = ? AND guild_id = ?').run(id, normalizedGuildId);
      return { success: true };
    } catch (error) {
      logger.error('Error deleting ticket category:', error);
      return { success: false, message: 'Ticketing operation failed' };
    }
  }

  // ==================== Panel ====================

  async postOrUpdatePanel(channelId, { title, description }, guildId = null) {
    if (!this.client) return { success: false, message: 'Client not initialized' };

    try {
      const normalizedGuildId = this._resolveGuildId(guildId);
      if (!normalizedGuildId) {
        return { success: false, message: 'Guild is required' };
      }
      const guild = await this.client.guilds.fetch(normalizedGuildId);
      const channel = await guild.channels.fetch(channelId);

      if (!channel || !channel.isTextBased()) {
        return { success: false, message: 'Invalid text channel' };
      }

      const categories = this.getCategories(normalizedGuildId);
      if (categories.length === 0) {
        return { success: false, message: 'No enabled categories. Add at least one category first.' };
      }

      const normalizedTitle = String(title || '🎫 Support').slice(0, 256);
      const normalizedDescription = String(description || 'Select a category below to open a support ticket.');

      const embed = createBrandedPanelEmbed({
        guildId: normalizedGuildId,
        moduleKey: 'ticketing',
        panelTitle: normalizedTitle,
        description: normalizedDescription,
        defaultColor: '#5865F2',
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
        useThumbnail: false,
      });

      // Build button rows (max 5 buttons per row)
      const rows = [];
      for (let i = 0; i < categories.length; i += 5) {
        const row = new ActionRowBuilder();
        const chunk = categories.slice(i, i + 5);
        for (const cat of chunk) {
          const btn = new ButtonBuilder()
            .setCustomId(`ticket_open_${cat.id}`)
            .setLabel(String(cat.name || 'Support').slice(0, 80))
            .setStyle(ButtonStyle.Primary);
          if (cat.emoji) btn.setEmoji(cat.emoji);
          row.addComponents(btn);
        }
        rows.push(row);
      }

      // Check if panel already exists for this channel
      const existing = db.prepare(`
        SELECT *
        FROM ticket_panels
        WHERE channel_id = ?
          AND (guild_id = ? OR COALESCE(guild_id, '') = '')
        ORDER BY CASE WHEN guild_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(channelId, normalizedGuildId, normalizedGuildId);

      if (existing && existing.message_id) {
        try {
          const oldMsg = await channel.messages.fetch(existing.message_id);
          await oldMsg.edit({ embeds: [embed], components: rows });
          db.prepare('UPDATE ticket_panels SET guild_id = ?, title = ?, description = ? WHERE id = ?')
            .run(normalizedGuildId, normalizedTitle, normalizedDescription, existing.id);
          return { success: true, messageId: existing.message_id, updated: true };
        } catch {
          // Message was deleted, post new one
        }
      }

      const msg = await channel.send({ embeds: [embed], components: rows });

      if (existing) {
        db.prepare('UPDATE ticket_panels SET guild_id = ?, message_id = ?, title = ?, description = ? WHERE id = ?')
          .run(normalizedGuildId, msg.id, normalizedTitle, normalizedDescription, existing.id);
      } else {
        db.prepare('INSERT INTO ticket_panels (guild_id, channel_id, message_id, title, description) VALUES (?, ?, ?, ?, ?)')
          .run(normalizedGuildId, channelId, msg.id, normalizedTitle, normalizedDescription);
      }

      return { success: true, messageId: msg.id };
    } catch (error) {
      logger.error('Error posting ticket panel:', error);
      return { success: false, message: 'Ticketing operation failed' };
    }
  }

  // ==================== Ticket Lifecycle ====================

  _nextTicketNumber(guildId = null) {
    const normalizedGuildId = this._resolveGuildId(guildId);
    if (!normalizedGuildId && tenantService.isMultitenantEnabled()) {
      throw new Error('Guild is required');
    }
    const sequenceName = normalizedGuildId ? `ticket:${normalizedGuildId}` : 'ticket';

    // Wrap in transaction to prevent ticket number collisions
    const getNext = db.transaction(() => {
      const row = db.prepare('SELECT value FROM ticket_sequences WHERE name = ?').get(sequenceName);
      if (!row) {
        let seed = 0;
        if (normalizedGuildId) {
          const maxRow = db.prepare(`
            SELECT COALESCE(MAX(ticket_number), 0) AS max_ticket_number
            FROM tickets
            WHERE guild_id = ?
          `).get(normalizedGuildId);
          seed = Number(maxRow?.max_ticket_number || 0);
        }
        const nextValue = seed + 1;
        db.prepare('INSERT INTO ticket_sequences (name, value) VALUES (?, ?)').run(sequenceName, nextValue);
        return nextValue;
      }
      const next = Number(row.value || 0) + 1;
      db.prepare('UPDATE ticket_sequences SET value = ? WHERE name = ?').run(next, sequenceName);
      return next;
    });
    return getNext();
  }

  async createTicket(interaction, categoryId, templateResponses, guildId = null) {
    if (!this.client) return { success: false, message: 'Client not initialized' };
    if (!this.isEnabled()) return { success: false, message: 'Ticketing is currently disabled' };

    try {
      const normalizedGuildId = this._resolveGuildId(guildId || interaction?.guildId, { allowSingleTenantFallback: true });
      if (!normalizedGuildId) return { success: false, message: 'Guild is required' };
      const category = this.getCategory(categoryId, normalizedGuildId, { allowLegacyFallback: false });
      if (!category) return { success: false, message: 'Category not found' };

      if (!category.enabled) {
        return { success: false, message: 'This ticket category is disabled' };
      }

      const ticketNumber = this._nextTicketNumber(normalizedGuildId);
      const username = interaction.user.username || 'user';
      const ticketDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const channelName = this._buildTicketChannelName({
        guildId: normalizedGuildId,
        categoryName: category.name || 'ticket',
        username,
        ticketDate,
        ticketNumber,
      });

      const guild = await this.client.guilds.fetch(normalizedGuildId);

      // Build permission overwrites
      const permissionOverwrites = [
        {
          id: guild.id, // @everyone
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: interaction.user.id, // opener
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
        },
        {
          id: this.client.user.id, // bot
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory],
        },
      ];

      // Add handler roles (skip stale/invalid role IDs to avoid Discord.js resolver crash)
      const handlerRoleIds = this._getCategoryHandlerRoleIds(category);
      for (const roleId of handlerRoleIds) {
        if (!roleId) continue;
        const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
        if (!role) {
          logger.warn(`Ticket category ${category.id} has invalid role id: ${roleId} (skipped)`);
          continue;
        }
        permissionOverwrites.push({
          id: role.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        });
      }

      const ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.parent_channel_id || undefined,
        permissionOverwrites,
      });

      // Build template responses display
      let templateText = '';
      if (templateResponses && Object.keys(templateResponses).length > 0) {
        templateText = Object.entries(templateResponses)
          .map(([label, value]) => `**${label}:**\n${String(value)}`)
          .join('\n\n');
      }

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`Ticket #${ticketNumber} | ${category.name}`)
        .setDescription(`Opened by <@${interaction.user.id}>`)
        .addFields(
          { name: 'Category', value: `${category.emoji || '🎫'} ${category.name}`, inline: true },
          { name: 'Status', value: '🟢 Open', inline: true },
          { name: 'Claimed By', value: 'Unclaimed', inline: true },
        )
        .setFooter({ text: `Ticket #${ticketNumber}` })
        .setTimestamp();

      applyEmbedBranding(embed, {
        guildId: normalizedGuildId,
        moduleKey: 'ticketing',
        defaultColor: '#5865F2',
        defaultFooter: 'Powered by Guild Pilot',
        footerPrefix: `Ticket #${ticketNumber}`,
        fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
      });

      if (templateText) {
        embed.addFields({ name: 'Details', value: templateText.slice(0, 1024) });
      }

      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_assign_me')
          .setLabel('Assign to Me')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId('ticket_close')
          .setLabel('Close')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔒'),
      );

      const pingRoleIds = this._normalizeIdArray(category.ping_role_ids);
      const notifyRoleIds = pingRoleIds.length > 0 ? pingRoleIds : handlerRoleIds;
      const pingMentions = [...new Set(notifyRoleIds)].map(id => `<@&${id}>`).join(' ');
      const intro = [`<@${interaction.user.id}> welcome to your ticket!`, pingMentions].filter(Boolean).join(' ');
      await ticketChannel.send({ content: intro, embeds: [embed], components: [actionRow] });

      // Insert into DB
      db.prepare(`
        INSERT INTO tickets (ticket_number, guild_id, category_id, category_name, channel_id, opener_id, opener_name, handler_role_ids, template_responses)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ticketNumber,
        normalizedGuildId,
        categoryId,
        category.name,
        ticketChannel.id,
        interaction.user.id,
        interaction.user.username,
        JSON.stringify(handlerRoleIds),
        JSON.stringify(templateResponses || {})
      );

      return { success: true, channelId: ticketChannel.id, ticketNumber };
    } catch (error) {
      logger.error('Error creating ticket:', error);
      return { success: false, message: 'Ticketing operation failed' };
    }
  }

  async claimTicket(interaction, channelId) {
    try {
      const ticket = this.getTicket(channelId);
      if (!ticket) return { success: false, message: 'Ticket not found' };
      if (ticket.status !== 'open') return { success: false, message: 'Ticket is not open' };
      if (ticket.claimed_by && ticket.claimed_by !== interaction.user.id) {
        return { success: false, message: 'This ticket has already been claimed' };
      }
      if (!this._canClaimTicket(interaction, ticket)) {
        return { success: false, message: 'Only assigned handlers can claim this ticket' };
      }

      db.prepare('UPDATE tickets SET claimed_by = ?, last_activity_at = CURRENT_TIMESTAMP, inactive_warning_sent_at = NULL WHERE channel_id = ?')
        .run(interaction.user.id, channelId);

      // Update the embed in the channel
      const channel = await this.client.channels.fetch(channelId);
      const messages = await channel.messages.fetch({ limit: 10 });
      const botMsg = messages.find(m => m.author.id === this.client.user.id && m.embeds.length > 0);

      if (botMsg) {
        const embed = EmbedBuilder.from(botMsg.embeds[0]);
        const claimedIdx = embed.data.fields?.findIndex(f => f.name === 'Claimed By');
        if (claimedIdx >= 0) {
          embed.data.fields[claimedIdx].value = `<@${interaction.user.id}>`;
        }
        await botMsg.edit({ embeds: [embed], components: botMsg.components });
      }

      return { success: true };
    } catch (error) {
      logger.error('Error claiming ticket:', error);
      return { success: false, message: 'Ticketing operation failed' };
    }
  }

  async closeTicket(interaction, channelId, options = {}) {
    try {
      const ticket = this.getTicket(channelId);
      if (!ticket) return { success: false, message: 'Ticket not found' };
      if (ticket.status === 'closed') return { success: false, message: 'Ticket is already closed' };
      if (!options.skipPermission && !this._canManageTicket(interaction, ticket)) {
        return { success: false, message: 'Only the ticket opener or assigned handlers can close this ticket' };
      }

      const channel = await this.client.channels.fetch(channelId);

      const transcript = await this._buildTranscript(channel, ticket);

      // Update DB
      db.prepare('UPDATE tickets SET status = ?, closed_at = CURRENT_TIMESTAMP, transcript = ?, inactive_warning_sent_at = NULL WHERE channel_id = ?')
        .run('closed', transcript, channelId);

      // Remove opener write permission
      try {
        await channel.permissionOverwrites.edit(ticket.opener_id, {
          SendMessages: false,
        });
      } catch (e) {
        logger.warn('Could not edit opener permissions on close:', e.message);
      }

      // Move closed ticket channel into closed category bucket (if configured)
      try {
        const category = ticket.category_id ? this.getCategory(ticket.category_id, ticket.guild_id, { allowLegacyFallback: true }) : null;
        if (category && category.closed_parent_channel_id) {
          await channel.setParent(category.closed_parent_channel_id, { lockPermissions: false });
        }
      } catch (e) {
        logger.warn('Could not move closed ticket to closed category:', e.message);
      }

      // Update embed
      const msgs = await channel.messages.fetch({ limit: 10 });
      const botMsg = msgs.find(m => m.author.id === this.client.user.id && m.embeds.length > 0);
      if (botMsg) {
        const embed = EmbedBuilder.from(botMsg.embeds[0]);
        const statusIdx = embed.data.fields?.findIndex(f => f.name === 'Status');
        if (statusIdx >= 0) embed.data.fields[statusIdx].value = '🔴 Closed';
        applyEmbedBranding(embed, {
          guildId: ticket.guild_id || '',
          moduleKey: 'ticketing',
          defaultColor: '#ED4245',
          defaultFooter: 'Powered by Guild Pilot',
          fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
        });
        await botMsg.edit({ embeds: [embed], components: [] });
      }

      const closeDescription = options.closedByText
        ? options.closedByText
        : interaction?.user?.id
          ? `Closed by <@${interaction.user.id}>`
          : 'Closed';

      // Post close embed with reopen/delete buttons
      const closeEmbed = new EmbedBuilder()
        .setTitle('🔒 Ticket Closed')
        .setDescription(closeDescription)
        .addFields({ name: 'Transcript', value: 'Saved to the database for admin retrieval.', inline: false })
        .setTimestamp();

      applyEmbedBranding(closeEmbed, {
        guildId: ticket.guild_id || '',
        moduleKey: 'ticketing',
        defaultColor: '#ED4245',
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_reopen')
          .setLabel('Reopen')
          .setStyle(ButtonStyle.Success)
          .setEmoji('🔓'),
        new ButtonBuilder()
          .setCustomId('ticket_delete')
          .setLabel('Delete')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🗑️'),
      );

      await channel.send({ embeds: [closeEmbed], components: [row] });

      return { success: true, transcript };
    } catch (error) {
      logger.error('Error closing ticket:', error);
      return { success: false, message: 'Ticketing operation failed' };
    }
  }

  async reopenTicket(interaction, channelId) {
    try {
      const ticket = this.getTicket(channelId);
      if (!ticket) return { success: false, message: 'Ticket not found' };
      if (ticket.status === 'open') return { success: false, message: 'Ticket is already open' };
      if (!this._canManageTicket(interaction, ticket)) {
        return { success: false, message: 'Only the ticket opener or assigned handlers can reopen this ticket' };
      }

      db.prepare('UPDATE tickets SET status = ?, closed_at = NULL, last_activity_at = CURRENT_TIMESTAMP, inactive_warning_sent_at = NULL WHERE channel_id = ?')
        .run('open', channelId);

      const channel = await this.client.channels.fetch(channelId);

      // Restore opener write permission
      try {
        await channel.permissionOverwrites.edit(ticket.opener_id, {
          SendMessages: true,
        });
      } catch (e) {
        logger.warn('Could not restore opener permissions on reopen:', e.message);
      }

      // Update the original embed
      const msgs = await channel.messages.fetch({ limit: 20 });
      const botMsg = msgs.find(m => m.author.id === this.client.user.id && m.embeds.length > 0 && m.embeds[0].data.title?.startsWith('Ticket #'));
      if (botMsg) {
        const embed = EmbedBuilder.from(botMsg.embeds[0]);
        const statusIdx = embed.data.fields?.findIndex(f => f.name === 'Status');
        if (statusIdx >= 0) embed.data.fields[statusIdx].value = '🟢 Open';
        applyEmbedBranding(embed, {
          guildId: ticket.guild_id || '',
          moduleKey: 'ticketing',
          defaultColor: '#5865F2',
          defaultFooter: 'Powered by Guild Pilot',
          fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
        });

        const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('ticket_assign_me')
            .setLabel('Assign to Me')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅'),
          new ButtonBuilder()
            .setCustomId('ticket_close')
            .setLabel('Close')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔒'),
        );
        await botMsg.edit({ embeds: [embed], components: [actionRow] });
      }

      const reopenEmbed = new EmbedBuilder().setTitle('🔓 Ticket Reopened').setTimestamp();
      applyEmbedBranding(reopenEmbed, {
        guildId: ticket.guild_id || '',
        moduleKey: 'ticketing',
        defaultColor: '#57F287',
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
      });
      await channel.send({ embeds: [reopenEmbed] });

      return { success: true };
    } catch (error) {
      logger.error('Error reopening ticket:', error);
      return { success: false, message: 'Ticketing operation failed' };
    }
  }

  async deleteTicket(channelId) {
    try {
      const ticket = this.getTicket(channelId);
      if (!ticket) return { success: false, message: 'Ticket not found' };

      db.prepare('UPDATE tickets SET status = ? WHERE channel_id = ?').run('deleted', channelId);

      const channel = await this.client.channels.fetch(channelId);
      await channel.delete('Ticket deleted');

      return { success: true };
    } catch (error) {
      logger.error('Error deleting ticket:', error);
      return { success: false, message: 'Ticketing operation failed' };
    }
  }

  markTicketActivity(channelId) {
    if (!channelId) return false;
    try {
      const result = db.prepare(`
        UPDATE tickets
        SET last_activity_at = CURRENT_TIMESTAMP,
            inactive_warning_sent_at = NULL
        WHERE channel_id = ?
          AND status = 'open'
      `).run(channelId);
      return result.changes > 0;
    } catch (error) {
      logger.error('Error marking ticket activity:', error);
      return false;
    }
  }

  async runInactivitySweep({ inactiveHours = 168, warningHours = 24, maxPerRun = 20 } = {}) {
    if (!this.client) return { success: false, message: 'Client not initialized' };
    if (!this.isEnabled()) return { success: false, message: 'Ticketing is currently disabled' };

    const normalizedInactiveHours = Number(inactiveHours);
    if (!Number.isFinite(normalizedInactiveHours) || normalizedInactiveHours <= 0) {
      return { success: false, message: 'Auto-close inactivity is disabled' };
    }

    const normalizedWarningHours = Math.max(
      0,
      Math.min(Number(warningHours) || 0, normalizedInactiveHours)
    );
    const normalizedMaxPerRun = Math.max(1, Math.min(Number(maxPerRun) || 20, 200));
    const warningWindowStartHours = Math.max(0, normalizedInactiveHours - normalizedWarningHours);
    const cutoff = `-${warningWindowStartHours} hours`;

    const candidates = db.prepare(`
      SELECT *
      FROM tickets
      WHERE status = 'open'
        AND DATETIME(COALESCE(last_activity_at, created_at)) <= DATETIME('now', ?)
      ORDER BY DATETIME(COALESCE(last_activity_at, created_at)) ASC
      LIMIT ?
    `).all(cutoff, normalizedMaxPerRun);

    let warnedCount = 0;
    let closedCount = 0;
    let errorCount = 0;

    for (const ticket of candidates) {
      try {
        const lastActivityText = ticket.last_activity_at || ticket.created_at;
        const lastActivityDate = lastActivityText ? new Date(lastActivityText) : null;
        if (!lastActivityDate || Number.isNaN(lastActivityDate.getTime())) continue;

        const inactiveForHours = (Date.now() - lastActivityDate.getTime()) / (60 * 60 * 1000);

        if (inactiveForHours >= normalizedInactiveHours) {
          const closeResult = await this.closeTicket(null, ticket.channel_id, {
            skipPermission: true,
            closedByText: `Automatically closed after ${Math.round(normalizedInactiveHours)} hour(s) of inactivity.`,
          });
          if (closeResult.success) {
            closedCount += 1;
          } else {
            errorCount += 1;
            logger.warn(`Auto-close failed for ticket ${ticket.ticket_number}: ${closeResult.message}`);
          }
          continue;
        }

        if (normalizedWarningHours <= 0 || ticket.inactive_warning_sent_at) continue;

        const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
        if (!channel || !channel.isTextBased()) {
          errorCount += 1;
          continue;
        }

        const hoursLeft = Math.max(1, Math.ceil(normalizedInactiveHours - inactiveForHours));
        await channel.send({
          content: `⏳ This ticket will auto-close in about ${hoursLeft} hour(s) if there are no new replies.`,
        });

        db.prepare('UPDATE tickets SET inactive_warning_sent_at = CURRENT_TIMESTAMP WHERE channel_id = ?')
          .run(ticket.channel_id);
        warnedCount += 1;
      } catch (error) {
        errorCount += 1;
        logger.error(`Error processing inactive ticket ${ticket?.ticket_number || ticket?.id || 'unknown'}:`, error);
      }
    }

    return { success: true, warnedCount, closedCount, errorCount, processed: candidates.length };
  }

  // ==================== Queries ====================

  getTicket(channelId) {
    return db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId);
  }

  getTicketById(id, guildId = '') {
    const normalizedGuildId = this._normalizeGuildId(guildId);
    if (normalizedGuildId) {
      return db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(id, normalizedGuildId);
    }
    return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  }

  getOpenTickets() {
    return db.prepare('SELECT * FROM tickets WHERE status = ? ORDER BY created_at DESC').all('open');
  }

  getTicketsByUser(userId) {
    return db.prepare('SELECT * FROM tickets WHERE opener_id = ? ORDER BY created_at DESC').all(userId);
  }

  getTicketsByCategory(categoryId) {
    return db.prepare('SELECT * FROM tickets WHERE category_id = ? ORDER BY created_at DESC').all(categoryId);
  }

  getAllTickets({ guildId, status, statuses, category, opener, q, from, to } = {}) {
    let query = 'SELECT * FROM tickets WHERE 1=1';
    if (guildId) { query += ' AND guild_id = ?'; }
    const params = guildId ? [guildId] : [];
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (Array.isArray(statuses) && statuses.length > 0) {
      query += ` AND status IN (${statuses.map(() => '?').join(',')})`;
      params.push(...statuses);
    }
    if (category) { query += ' AND category_id = ?'; params.push(category); }
    if (opener) { query += ' AND opener_id = ?'; params.push(opener); }
    if (from) { query += ' AND DATE(created_at) >= DATE(?)'; params.push(from); }
    if (to) { query += ' AND DATE(created_at) <= DATE(?)'; params.push(to); }
    if (q) {
      const s = `%${String(q).trim()}%`;
      query += ' AND (opener_name LIKE ? OR opener_id LIKE ? OR category_name LIKE ? OR transcript LIKE ?)';
      params.push(s, s, s, s);
    }
    query += ' ORDER BY created_at DESC';
    return db.prepare(query).all(...params);
  }

  // ==================== Modal Builder ====================

  buildTemplateModal(category) {
    const fields = this._normalizeTemplateFields(category.template_fields);
    const modal = new ModalBuilder()
      .setCustomId(`ticket_modal_${category.id}`)
      .setTitle(`${category.emoji || '🎫'} ${category.name}`.slice(0, 45));

    // Discord allows max 5 text inputs per modal
    const limitedFields = fields.slice(0, 5);

    if (limitedFields.length === 0) {
      // Add a default "reason" field
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ticket_reason')
            .setLabel('How can we help?')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder('Describe your issue...')
        )
      );
    } else {
      limitedFields.forEach((field, idx) => {
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(`field_${idx}`)
              .setLabel(field.label.slice(0, 45))
              .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
              .setRequired(field.required !== false)
              .setPlaceholder(field.placeholder || '')
          )
        );
      });
    }

    return modal;
  }

  extractTemplateResponses(category, interaction) {
    const fields = this._normalizeTemplateFields(category.template_fields).slice(0, 5);
    const responses = {};

    fields.forEach((field, idx) => {
      const key = field.label;
      const value = interaction.fields?.getTextInputValue(`field_${idx}`) ?? interaction.fields?.fields?.get(`field_${idx}`)?.value ?? '';
      responses[key] = value;
    });

    if (Object.keys(responses).length === 0 && interaction.fields?.getTextInputValue) {
      try {
        const fallback = interaction.fields.getTextInputValue('ticket_reason');
        if (fallback) responses['How can we help?'] = fallback;
      } catch {
        // ignore
      }
    }

    return responses;
  }

  async getTranscript(channelId) {
    const ticket = this.getTicket(channelId);
    if (!ticket) {
      return { success: false, message: 'Ticket not found' };
    }
    if (ticket.transcript) {
      return { success: true, transcript: ticket.transcript, live: false };
    }

    if (!this.client) {
      return { success: false, message: 'Transcript not available' };
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) {
        return { success: false, message: 'Transcript not available' };
      }
      const transcript = await this._buildTranscript(channel, ticket);
      return { success: true, transcript, live: true };
    } catch (error) {
      logger.error('Error generating live transcript:', error);
      return { success: false, message: 'Transcript not available' };
    }
  }
}

module.exports = new TicketService();
