const db = require('../database/db');
const logger = require('../utils/logger');
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
      return value.map(v => String(v).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
      return value.split(',').map(v => v.trim()).filter(Boolean);
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
    const allowedRoles = this._normalizeIdArray(ticket.allowed_role_ids);
    if (!interaction.member?.roles?.cache) return false;
    return allowedRoles.some(roleId => interaction.member.roles.cache.has(roleId));
  }

  // ==================== Category CRUD ====================

  getCategories() {
    return db.prepare('SELECT * FROM ticket_categories WHERE enabled = 1 ORDER BY sort_order ASC, id ASC').all();
  }

  getAllCategories() {
    return db.prepare('SELECT * FROM ticket_categories ORDER BY sort_order ASC, id ASC').all();
  }

  getCategory(id) {
    return db.prepare('SELECT * FROM ticket_categories WHERE id = ?').get(id);
  }

  addCategory({ name, emoji, description, parentChannelId, closedParentChannelId, allowedRoleIds, pingRoleIds, templateFields }) {
    try {
      const normalizedAllowedRoleIds = this._normalizeIdArray(allowedRoleIds);
      const normalizedPingRoleIds = this._normalizeIdArray(pingRoleIds);
      const normalizedTemplateFields = this._normalizeTemplateFields(templateFields);
      const stmt = db.prepare(`
        INSERT INTO ticket_categories (name, emoji, description, parent_channel_id, closed_parent_channel_id, allowed_role_ids, ping_role_ids, template_fields)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        String(name || '').trim(),
        emoji || '🎫',
        String(description || ''),
        parentChannelId || null,
        closedParentChannelId || null,
        JSON.stringify(normalizedAllowedRoleIds),
        JSON.stringify(normalizedPingRoleIds),
        JSON.stringify(normalizedTemplateFields)
      );
      return { success: true, id: result.lastInsertRowid };
    } catch (error) {
      logger.error('Error adding ticket category:', error);
      return { success: false, message: error.message };
    }
  }

  updateCategory(id, updates) {
    try {
      const category = this.getCategory(id);
      if (!category) return { success: false, message: 'Category not found' };

      const fields = [];
      const values = [];

      if (updates.name !== undefined) { fields.push('name = ?'); values.push(String(updates.name).trim()); }
      if (updates.emoji !== undefined) { fields.push('emoji = ?'); values.push(updates.emoji || '🎫'); }
      if (updates.description !== undefined) { fields.push('description = ?'); values.push(String(updates.description || '')); }
      if (updates.parentChannelId !== undefined) { fields.push('parent_channel_id = ?'); values.push(updates.parentChannelId || null); }
      if (updates.closedParentChannelId !== undefined) { fields.push('closed_parent_channel_id = ?'); values.push(updates.closedParentChannelId || null); }
      if (updates.allowedRoleIds !== undefined) { fields.push('allowed_role_ids = ?'); values.push(JSON.stringify(this._normalizeIdArray(updates.allowedRoleIds))); }
      if (updates.pingRoleIds !== undefined) { fields.push('ping_role_ids = ?'); values.push(JSON.stringify(this._normalizeIdArray(updates.pingRoleIds))); }
      if (updates.templateFields !== undefined) { fields.push('template_fields = ?'); values.push(JSON.stringify(this._normalizeTemplateFields(updates.templateFields))); }
      if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
      if (updates.sortOrder !== undefined) { fields.push('sort_order = ?'); values.push(updates.sortOrder); }

      if (fields.length === 0) return { success: false, message: 'No updates provided' };

      values.push(id);
      db.prepare(`UPDATE ticket_categories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      return { success: true };
    } catch (error) {
      logger.error('Error updating ticket category:', error);
      return { success: false, message: error.message };
    }
  }

  deleteCategory(id) {
    try {
      db.prepare('DELETE FROM ticket_categories WHERE id = ?').run(id);
      return { success: true };
    } catch (error) {
      logger.error('Error deleting ticket category:', error);
      return { success: false, message: error.message };
    }
  }

  // ==================== Panel ====================

  async postOrUpdatePanel(channelId, { title, description }) {
    if (!this.client) return { success: false, message: 'Client not initialized' };

    try {
      const guildId = process.env.GUILD_ID;
      const guild = await this.client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(channelId);

      if (!channel || !channel.isTextBased()) {
        return { success: false, message: 'Invalid text channel' };
      }

      const categories = this.getCategories();
      if (categories.length === 0) {
        return { success: false, message: 'No enabled categories. Add at least one category first.' };
      }

      const normalizedTitle = String(title || '🎫 Support').slice(0, 256);
      const normalizedDescription = String(description || 'Select a category below to open a support ticket.');

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(normalizedTitle)
        .setDescription(normalizedDescription)
        .setFooter({ text: 'Click a button to open a ticket' })
        .setTimestamp();

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
      const existing = db.prepare('SELECT * FROM ticket_panels WHERE channel_id = ?').get(channelId);

      if (existing && existing.message_id) {
        try {
          const oldMsg = await channel.messages.fetch(existing.message_id);
          await oldMsg.edit({ embeds: [embed], components: rows });
          db.prepare('UPDATE ticket_panels SET title = ?, description = ? WHERE id = ?')
            .run(normalizedTitle, normalizedDescription, existing.id);
          return { success: true, messageId: existing.message_id, updated: true };
        } catch {
          // Message was deleted, post new one
        }
      }

      const msg = await channel.send({ embeds: [embed], components: rows });

      if (existing) {
        db.prepare('UPDATE ticket_panels SET message_id = ?, title = ?, description = ? WHERE id = ?')
          .run(msg.id, normalizedTitle, normalizedDescription, existing.id);
      } else {
        db.prepare('INSERT INTO ticket_panels (channel_id, message_id, title, description) VALUES (?, ?, ?, ?)')
          .run(channelId, msg.id, normalizedTitle, normalizedDescription);
      }

      return { success: true, messageId: msg.id };
    } catch (error) {
      logger.error('Error posting ticket panel:', error);
      return { success: false, message: error.message };
    }
  }

  // ==================== Ticket Lifecycle ====================

  _nextTicketNumber() {
    const row = db.prepare('SELECT value FROM ticket_sequences WHERE name = ?').get('ticket');
    if (!row) {
      db.prepare('INSERT INTO ticket_sequences (name, value) VALUES (?, ?)').run('ticket', 1);
      return 1;
    }
    const next = row.value + 1;
    db.prepare('UPDATE ticket_sequences SET value = ? WHERE name = ?').run(next, 'ticket');
    return next;
  }

  async createTicket(interaction, categoryId, templateResponses) {
    if (!this.client) return { success: false, message: 'Client not initialized' };
    if (!this.isEnabled()) return { success: false, message: 'Ticketing is currently disabled' };

    try {
      const category = this.getCategory(categoryId);
      if (!category) return { success: false, message: 'Category not found' };

      if (!category.enabled) {
        return { success: false, message: 'This ticket category is disabled' };
      }

      const ticketNumber = this._nextTicketNumber();
      const username = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
      const categorySlug = String(category.name || 'ticket').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ticket';
      const ticketDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const channelName = `${categorySlug}-${username}-${ticketDate}`.slice(0, 100);

      const guildId = process.env.GUILD_ID;
      const guild = await this.client.guilds.fetch(guildId);

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

      // Add allowed roles (skip stale/invalid role IDs to avoid Discord.js resolver crash)
      const allowedRoleIds = this._normalizeIdArray(category.allowed_role_ids);
      for (const roleId of allowedRoleIds) {
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

      if (templateText) {
        embed.addFields({ name: 'Details', value: templateText.slice(0, 1024) });
      }

      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_claim')
          .setLabel('Claim')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId('ticket_close')
          .setLabel('Close')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔒'),
      );

      const pingRoleIds = this._normalizeIdArray(category.ping_role_ids);
      const pingMentions = pingRoleIds.map(id => `<@&${id}>`).join(' ');
      const intro = [`<@${interaction.user.id}> welcome to your ticket!`, pingMentions].filter(Boolean).join(' ');
      await ticketChannel.send({ content: intro, embeds: [embed], components: [actionRow] });

      // Insert into DB
      db.prepare(`
        INSERT INTO tickets (ticket_number, category_id, category_name, channel_id, opener_id, opener_name, template_responses)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(ticketNumber, categoryId, category.name, ticketChannel.id, interaction.user.id, interaction.user.username, JSON.stringify(templateResponses || {}));

      return { success: true, channelId: ticketChannel.id, ticketNumber };
    } catch (error) {
      logger.error('Error creating ticket:', error);
      return { success: false, message: error.message };
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
      if (!this._canManageTicket(interaction, ticket)) {
        return { success: false, message: 'Only the ticket opener or staff can claim this ticket' };
      }

      db.prepare('UPDATE tickets SET claimed_by = ? WHERE channel_id = ?').run(interaction.user.id, channelId);

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
      return { success: false, message: error.message };
    }
  }

  async closeTicket(interaction, channelId) {
    try {
      const ticket = this.getTicket(channelId);
      if (!ticket) return { success: false, message: 'Ticket not found' };
      if (ticket.status === 'closed') return { success: false, message: 'Ticket is already closed' };

      const channel = await this.client.channels.fetch(channelId);

      const transcript = await this._buildTranscript(channel, ticket);

      // Update DB
      db.prepare('UPDATE tickets SET status = ?, closed_at = CURRENT_TIMESTAMP, transcript = ? WHERE channel_id = ?')
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
        const category = ticket.category_id ? this.getCategory(ticket.category_id) : null;
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
        embed.setColor('#ED4245');
        await botMsg.edit({ embeds: [embed], components: [] });
      }

      // Post close embed with reopen/delete buttons
      const closeEmbed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('🔒 Ticket Closed')
        .setDescription(`Closed by <@${interaction.user.id}>`)
        .addFields({ name: 'Transcript', value: 'Saved to the database for admin retrieval.', inline: false })
        .setTimestamp();

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
      return { success: false, message: error.message };
    }
  }

  async reopenTicket(channelId) {
    try {
      const ticket = this.getTicket(channelId);
      if (!ticket) return { success: false, message: 'Ticket not found' };
      if (ticket.status === 'open') return { success: false, message: 'Ticket is already open' };

      db.prepare('UPDATE tickets SET status = ?, closed_at = NULL WHERE channel_id = ?').run('open', channelId);

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
        embed.setColor('#5865F2');

        const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('ticket_claim')
            .setLabel('Claim')
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

      await channel.send({ embeds: [new EmbedBuilder().setColor('#57F287').setTitle('🔓 Ticket Reopened').setTimestamp()] });

      return { success: true };
    } catch (error) {
      logger.error('Error reopening ticket:', error);
      return { success: false, message: error.message };
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
      return { success: false, message: error.message };
    }
  }

  // ==================== Queries ====================

  getTicket(channelId) {
    return db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId);
  }

  getTicketById(id) {
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

  getAllTickets({ status, category, opener } = {}) {
    let query = 'SELECT * FROM tickets WHERE 1=1';
    const params = [];
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (category) { query += ' AND category_id = ?'; params.push(category); }
    if (opener) { query += ' AND opener_id = ?'; params.push(opener); }
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
