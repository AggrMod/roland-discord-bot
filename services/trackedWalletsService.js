const db = require('../database/db');
const logger = require('../utils/logger');
const nftService = require('./nftService');
const clientProvider = require('../utils/clientProvider');
const { applyEmbedBranding, getBranding } = require('./embedBranding');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function _getSolanaBalances(walletAddress) {
  try {
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    const pubkey = new PublicKey(walletAddress);

    const [lamports, tokenAccounts] = await Promise.all([
      connection.getBalance(pubkey),
      connection.getParsedTokenAccountsByOwner(pubkey, { mint: new PublicKey(USDC_MINT) })
    ]);

    const sol = lamports / LAMPORTS_PER_SOL;
    let usdc = 0;
    if (tokenAccounts.value.length > 0) {
      const info = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
      usdc = info.uiAmount || 0;
    }

    return { sol, usdc };
  } catch (e) {
    logger.warn('Could not fetch Solana balances:', e.message);
    return { sol: null, usdc: null };
  }
}

class TrackedWalletsService {
  // ─── CRUD ────────────────────────────────────────────────────────────────

  addTrackedWallet({ guildId, walletAddress, label, alertChannelId, panelChannelId }) {
    try {
      const addr = String(walletAddress || '').trim();
      if (!addr) return { success: false, message: 'walletAddress is required' };

      const result = db.prepare(`
        INSERT INTO tracked_wallets (guild_id, wallet_address, label, alert_channel_id, panel_channel_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        guildId || '',
        addr,
        (label || '').trim() || null,
        (alertChannelId || '').trim() || null,
        (panelChannelId || '').trim() || null,
      );

      return { success: true, id: result.lastInsertRowid };
    } catch (e) {
      if (e.message?.includes('UNIQUE constraint')) {
        return { success: false, message: 'Wallet already tracked for this server' };
      }
      logger.error('Error adding tracked wallet:', e);
      return { success: false, message: 'Failed to add tracked wallet' };
    }
  }

  removeTrackedWallet(id, guildId) {
    try {
      const query = guildId
        ? 'DELETE FROM tracked_wallets WHERE id = ? AND guild_id = ?'
        : 'DELETE FROM tracked_wallets WHERE id = ?';
      const params = guildId ? [id, guildId] : [id];
      const result = db.prepare(query).run(...params);
      return { success: true, removed: result.changes };
    } catch (e) {
      logger.error('Error removing tracked wallet:', e);
      return { success: false, message: 'Failed to remove tracked wallet' };
    }
  }

  getTrackedWallets(guildId) {
    try {
      if (guildId) {
        return db.prepare('SELECT * FROM tracked_wallets WHERE guild_id = ? ORDER BY created_at DESC').all(guildId);
      }
      return db.prepare('SELECT * FROM tracked_wallets ORDER BY created_at DESC').all();
    } catch (e) {
      logger.error('Error getting tracked wallets:', e);
      return [];
    }
  }

  getTrackedWalletById(id, guildId) {
    try {
      if (guildId) {
        return db.prepare('SELECT * FROM tracked_wallets WHERE id = ? AND guild_id = ?').get(id, guildId);
      }
      return db.prepare('SELECT * FROM tracked_wallets WHERE id = ?').get(id);
    } catch (e) {
      return null;
    }
  }

  getTrackedWalletsByAddress(walletAddress) {
    try {
      return db.prepare(`
        SELECT * FROM tracked_wallets
        WHERE LOWER(wallet_address) = LOWER(?) AND enabled = 1
      `).all(walletAddress);
    } catch (e) {
      return [];
    }
  }

  updateTrackedWallet(id, updates, guildId) {
    try {
      const allowed = { label: 'label', alertChannelId: 'alert_channel_id', panelChannelId: 'panel_channel_id', enabled: 'enabled' };
      const setClauses = [];
      const params = [];
      for (const [key, col] of Object.entries(allowed)) {
        if (key in updates) {
          setClauses.push(`${col} = ?`);
          params.push(typeof updates[key] === 'boolean' ? (updates[key] ? 1 : 0) : updates[key]);
        }
      }
      if (!setClauses.length) return { success: false, message: 'No valid updates provided' };
      setClauses.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);
      if (guildId) params.push(guildId);
      const sql = `UPDATE tracked_wallets SET ${setClauses.join(', ')} WHERE id = ?${guildId ? ' AND guild_id = ?' : ''}`;
      const info = db.prepare(sql).run(...params);
      if (!info.changes) return { success: false, message: 'Wallet not found or access denied' };
      return { success: true };
    } catch (e) {
      logger.error('Error updating tracked wallet:', e);
      return { success: false, message: 'Failed to update tracked wallet' };
    }
  }

  savePanelMessageId(id, messageId) {
    try {
      db.prepare('UPDATE tracked_wallets SET panel_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(messageId, id);
    } catch (e) {
      logger.error('Error saving panel message ID:', e);
    }
  }

  // ─── Holdings Panel ───────────────────────────────────────────────────────

  async buildHoldingsEmbed(walletRow, guildId) {
    const addr = walletRow.wallet_address;
    const label = walletRow.label || `${addr.slice(0, 6)}...${addr.slice(-4)}`;

    // Fetch NFTs and SOL/USDC balances in parallel
    let nfts = [];
    let balances = { sol: null, usdc: null };
    try {
      [nfts, balances] = await Promise.all([
        nftService.getNFTsForWallet(addr, { guildId }).catch(e => { logger.error('Error fetching NFTs:', e); return []; }),
        _getSolanaBalances(addr)
      ]);
    } catch (e) {
      logger.error('Error fetching holdings data:', e);
    }

    const total = nfts.length;

    // Group NFTs by collection name (first 5 unique names, then "and X more")
    const nameGroups = {};
    for (const nft of nfts) {
      const key = nft.name?.replace(/#\d+$/, '').trim() || 'Unknown';
      nameGroups[key] = (nameGroups[key] || 0) + 1;
    }

    const collectionLines = Object.entries(nameGroups)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => `• **${name}** × ${count}`);

    if (Object.keys(nameGroups).length > 8) {
      collectionLines.push(`_...and ${Object.keys(nameGroups).length - 8} more collections_`);
    }

    // Trait breakdown from first collection (most common)
    let traitSection = null;
    if (nfts.length > 0) {
      const allTraits = nftService.getAllTraits(nfts);
      const traitLines = Object.entries(allTraits)
        .slice(0, 4)
        .map(([type, values]) => `**${type}**: ${values.slice(0, 3).join(', ')}${values.length > 3 ? ` +${values.length - 3}` : ''}`);
      if (traitLines.length) traitSection = traitLines.join('\n');
    }

    const branding = getBranding(guildId || '', 'nfttracker');
    const client = clientProvider.getClient();
    const botAvatar = client?.user?.displayAvatarURL?.() || null;
    const logoUrl = branding.logo || botAvatar;

    // Chain emoji icons (configurable via Superadmin → Chain Emoji Map)
    const settingsManager = require('../config/settings');
    const chainEmojiMap = settingsManager.getSettings().chainEmojiMap || {};
    const solEmoji  = chainEmojiMap['solana'] || process.env.SOL_EMOJI  || '◎';
    const usdcEmoji = chainEmojiMap['usdc']   || process.env.USDC_EMOJI || '💵';

    const embed = new EmbedBuilder()
      .setTitle(`💼 Holdings: ${label}`)
      .setDescription(
        total === 0
          ? '_No NFTs found in this wallet_'
          : collectionLines.join('\n')
      )
      .setTimestamp()
      .setFooter({ text: `Last updated` });

    // SOL and USDC balance row
    if (balances.sol !== null) {
      embed.addFields(
        { name: `${solEmoji} SOL`, value: balances.sol.toFixed(4), inline: true },
        { name: `${usdcEmoji} USDC`, value: balances.usdc !== null ? balances.usdc.toFixed(2) : '—', inline: true },
        { name: '\u200b', value: '\u200b', inline: true } // spacer
      );
    }

    embed.addFields(
      { name: '🖼️ Total NFTs', value: total.toString(), inline: true },
      { name: '📍 Address', value: `\`${addr.slice(0, 6)}...${addr.slice(-4)}\``, inline: true }
    );

    if (traitSection) {
      embed.addFields({ name: '🎨 Traits', value: traitSection, inline: false });
    }

    applyEmbedBranding(embed, {
      guildId: guildId || '',
      moduleKey: 'nfttracker',
      defaultColor: '#FFD700',
      defaultFooter: 'Wallet Holdings',
      fallbackLogoUrl: logoUrl,
    });

    const solscanUrl = `https://solscan.io/account/${addr}`;
    const meUrl = `https://magiceden.io/u/${addr}`;

    const buttons = [
      new ButtonBuilder().setLabel('Solscan').setURL(solscanUrl).setStyle(ButtonStyle.Link).setEmoji('🔍'),
      new ButtonBuilder().setLabel('Magic Eden').setURL(meUrl).setStyle(ButtonStyle.Link).setEmoji('🌊'),
    ];
    const components = [new ActionRowBuilder().addComponents(...buttons)];

    return { embed, components };
  }

  /**
   * Post (or update) a holdings panel for a tracked wallet in a given channel.
   * If walletRow.panel_message_id exists, tries to edit that message first.
   */
  async postHoldingsPanel(walletRow, targetChannelId, guildId) {
    const client = clientProvider.getClient();
    if (!client) return { success: false, message: 'Discord client not available' };

    const channelId = targetChannelId || walletRow.panel_channel_id;
    if (!channelId) return { success: false, message: 'No channel configured for holdings panel' };

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.send) return { success: false, message: 'Channel not found or bot lacks access' };

    const { embed, components } = await this.buildHoldingsEmbed(walletRow, guildId);

    // Try to edit existing panel message
    if (walletRow.panel_message_id) {
      try {
        const existing = await channel.messages.fetch(walletRow.panel_message_id).catch(() => null);
        if (existing) {
          await existing.edit({ embeds: [embed], components });
          logger.log(`[wallet-panel] updated panel for ${walletRow.wallet_address} in channel ${channelId}`);
          return { success: true, action: 'updated', messageId: walletRow.panel_message_id };
        }
      } catch (e) {
        logger.warn(`[wallet-panel] could not edit old panel message: ${e.message}`);
      }
    }

    // Post fresh panel
    const msg = await channel.send({ embeds: [embed], components });
    this.savePanelMessageId(walletRow.id, msg.id);
    logger.log(`[wallet-panel] posted panel for ${walletRow.wallet_address} in channel ${channelId}`);
    return { success: true, action: 'posted', messageId: msg.id };
  }

  /**
   * Refresh all panels for a guild (or all guilds).
   * Called by a cron job to keep holdings up to date.
   */
  async refreshAllPanels(guildId) {
    const wallets = this.getTrackedWallets(guildId).filter(w => w.enabled && w.panel_channel_id);
    for (const wallet of wallets) {
      try {
        await this.postHoldingsPanel(wallet, wallet.panel_channel_id, wallet.guild_id);
        await new Promise(r => setTimeout(r, 1500)); // avoid rate limits
      } catch (e) {
        logger.error(`[wallet-panel] refresh failed for ${wallet.wallet_address}:`, e);
      }
    }
  }

  // ─── TX alert helpers (called from nftActivityService) ───────────────────

  /**
   * Send a wallet-level TX alert when a tracked wallet is involved in a transaction.
   */
  async sendWalletAlert({ walletRow, guildId, evt, typeIcon, priceDisplay, chain }) {
    const client = clientProvider.getClient();
    if (!client || !walletRow.alert_channel_id) return;

    const channel = await client.channels.fetch(walletRow.alert_channel_id).catch(() => null);
    if (!channel || !channel.send) return;

    const label = walletRow.label || `${walletRow.wallet_address.slice(0, 6)}...${walletRow.wallet_address.slice(-4)}`;
    const role = evt.from_wallet?.toLowerCase() === walletRow.wallet_address.toLowerCase() ? 'Sent' : 'Received';
    const eventType = (evt.eventType || evt.event_type || 'activity').toUpperCase();

    const branding = getBranding(guildId || '', 'nfttracker');
    const botAvatar = client?.user?.displayAvatarURL?.() || null;

    const embed = new EmbedBuilder()
      .setTitle(`${typeIcon} Wallet Alert: ${label}`)
      .setDescription(`**${role}** — ${eventType} detected`)
      .addFields(
        { name: 'Wallet', value: `\`${walletRow.wallet_address.slice(0, 6)}...${walletRow.wallet_address.slice(-4)}\``, inline: true },
        { name: 'Action', value: `${role} ${eventType}`, inline: true },
      )
      .setTimestamp();

    if (evt.token_name || evt.tokenName) {
      embed.addFields({ name: '🖼️ Token', value: evt.token_name || evt.tokenName, inline: true });
    }
    if (priceDisplay && priceDisplay !== '—') {
      embed.addFields({ name: '💰 Price', value: priceDisplay, inline: true });
    }

    const colorMap = { MINT: '#57F287', SELL: '#57F287', LIST: '#FEE75C', DELIST: '#5865F2', TRANSFER: '#EB459E' };
    applyEmbedBranding(embed, {
      guildId: guildId || '',
      moduleKey: 'nfttracker',
      defaultColor: colorMap[eventType] || '#5865F2',
      defaultFooter: 'Wallet Tracker',
      fallbackLogoUrl: branding.logo || botAvatar,
    });

    const txSig = evt.txSignature || evt.tx_signature;
    const tokenMint = evt.tokenMint || evt.token_mint;
    const buttons = [];
    if (txSig) buttons.push(new ButtonBuilder().setLabel('View Tx').setURL(`https://solscan.io/tx/${txSig}`).setStyle(ButtonStyle.Link).setEmoji('🔍'));
    if (tokenMint) buttons.push(new ButtonBuilder().setLabel('Magic Eden').setURL(`https://magiceden.io/item-details/${tokenMint}`).setStyle(ButtonStyle.Link).setEmoji('🌊'));
    const components = buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [];

    try {
      await channel.send({ embeds: [embed], components });
      logger.log(`[wallet-alert] sent for wallet=${walletRow.wallet_address} guild=${guildId} channel=${walletRow.alert_channel_id}`);
    } catch (e) {
      logger.error(`[wallet-alert] failed for wallet=${walletRow.wallet_address}:`, e.message);
    }
  }
}

module.exports = new TrackedWalletsService();
