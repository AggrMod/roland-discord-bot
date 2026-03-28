const db = require('../database/db');
const logger = require('../utils/logger');
const { EmbedBuilder } = require('discord.js');
const clientProvider = require('../utils/clientProvider');

class NFTActivityService {
  getAlertConfig() {
    try {
      let cfg = db.prepare('SELECT * FROM nft_activity_alert_config WHERE id = 1').get();
      if (!cfg) {
        db.prepare('INSERT INTO nft_activity_alert_config (id, enabled, event_types, min_sol) VALUES (1, 0, ?, 0)').run('mint,sell,list,delist,transfer');
        cfg = db.prepare('SELECT * FROM nft_activity_alert_config WHERE id = 1').get();
      }
      return cfg;
    } catch (e) {
      logger.error('Error getting NFT activity alert config:', e);
      return null;
    }
  }

  updateAlertConfig({ enabled, channelId, eventTypes, minSol }) {
    try {
      const updates = [];
      const params = [];
      if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
      if (channelId !== undefined) { updates.push('channel_id = ?'); params.push(channelId || null); }
      if (eventTypes !== undefined) { updates.push('event_types = ?'); params.push(eventTypes || ''); }
      if (minSol !== undefined) { updates.push('min_sol = ?'); params.push(Number(minSol) || 0); }
      if (!updates.length) return { success: false, message: 'No updates provided' };
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(1);
      db.prepare(`UPDATE nft_activity_alert_config SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      return { success: true };
    } catch (e) {
      logger.error('Error updating NFT activity alert config:', e);
      return { success: false, message: 'Failed to update alert config' };
    }
  }

  getTrackedCollections(guildId) {
    try {
      if (guildId) {
        return db.prepare('SELECT * FROM nft_tracked_collections WHERE guild_id = ? ORDER BY created_at DESC').all(guildId);
      }
      return db.prepare('SELECT * FROM nft_tracked_collections ORDER BY created_at DESC').all();
    } catch (e) {
      logger.error('Error getting tracked collections:', e);
      return [];
    }
  }

  addTrackedCollection({ guildId, collectionAddress, collectionName, channelId, trackMint, trackSale, trackList, trackDelist, trackTransfer }) {
    try {
      if (!collectionAddress || !collectionName || !channelId) {
        return { success: false, message: 'collectionAddress, collectionName, and channelId are required' };
      }
      const result = db.prepare(`
        INSERT INTO nft_tracked_collections (guild_id, collection_address, collection_name, channel_id, track_mint, track_sale, track_list, track_delist, track_transfer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        guildId || '',
        collectionAddress.trim(),
        collectionName.trim(),
        channelId,
        trackMint !== undefined ? (trackMint ? 1 : 0) : 1,
        trackSale !== undefined ? (trackSale ? 1 : 0) : 1,
        trackList !== undefined ? (trackList ? 1 : 0) : 1,
        trackDelist !== undefined ? (trackDelist ? 1 : 0) : 1,
        trackTransfer !== undefined ? (trackTransfer ? 1 : 0) : 0
      );
      return { success: true, message: 'Collection added', id: result.lastInsertRowid };
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE constraint')) {
        return { success: false, message: 'Collection address already tracked for this server' };
      }
      logger.error('Error adding tracked collection:', e);
      return { success: false, message: 'Failed to add tracked collection' };
    }
  }

  removeTrackedCollection(id, guildId) {
    try {
      const query = guildId
        ? 'DELETE FROM nft_tracked_collections WHERE id = ? AND guild_id = ?'
        : 'DELETE FROM nft_tracked_collections WHERE id = ?';
      const params = guildId ? [id, guildId] : [id];
      const result = db.prepare(query).run(...params);
      if (guildId && result.changes === 0) {
        return { success: false, message: 'Collection not found or access denied' };
      }
      return { success: true, removed: result.changes };
    } catch (e) {
      logger.error('Error removing tracked collection:', e);
      return { success: false, message: 'Failed to remove tracked collection' };
    }
  }

  updateTrackedCollection(id, updates, guildId) {
    try {
      const allowed = ['collection_name', 'channel_id', 'track_mint', 'track_sale', 'track_list', 'track_delist', 'track_transfer', 'enabled'];
      const fieldMap = {
        collectionName: 'collection_name',
        channelId: 'channel_id',
        trackMint: 'track_mint',
        trackSale: 'track_sale',
        trackList: 'track_list',
        trackDelist: 'track_delist',
        trackTransfer: 'track_transfer',
        enabled: 'enabled'
      };
      const setClauses = [];
      const params = [];
      for (const [key, val] of Object.entries(updates)) {
        const col = fieldMap[key];
        if (col && allowed.includes(col)) {
          setClauses.push(`${col} = ?`);
          params.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
        }
      }
      if (!setClauses.length) return { success: false, message: 'No valid updates provided' };
      if (guildId) {
        params.push(id, guildId);
        db.prepare(`UPDATE nft_tracked_collections SET ${setClauses.join(', ')} WHERE id = ? AND guild_id = ?`).run(...params);
      } else {
        params.push(id);
        db.prepare(`UPDATE nft_tracked_collections SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
      }
      return { success: true };
    } catch (e) {
      logger.error('Error updating tracked collection:', e);
      return { success: false, message: 'Failed to update tracked collection' };
    }
  }

  getTrackedCollectionByAddress(address) {
    try {
      return db.prepare('SELECT * FROM nft_tracked_collections WHERE collection_address = ? AND enabled = 1').get(address);
    } catch (e) {
      return null;
    }
  }

  listWatchedCollections() {
    try {
      return db.prepare('SELECT collection_key, created_at FROM nft_activity_watch ORDER BY created_at DESC').all();
    } catch (e) {
      logger.error('Error listing watched collections:', e);
      return [];
    }
  }

  addWatchedCollection(collectionKey) {
    try {
      db.prepare('INSERT OR IGNORE INTO nft_activity_watch (collection_key) VALUES (?)').run(collectionKey.trim().toLowerCase());
      return { success: true };
    } catch (e) {
      logger.error('Error adding watched collection:', e);
      return { success: false, message: 'Failed to add watched collection' };
    }
  }

  removeWatchedCollection(collectionKey) {
    try {
      const r = db.prepare('DELETE FROM nft_activity_watch WHERE collection_key = ?').run(collectionKey.trim().toLowerCase());
      return { success: true, removed: r.changes };
    } catch (e) {
      logger.error('Error removing watched collection:', e);
      return { success: false, message: 'Failed to remove watched collection' };
    }
  }

  isWatched(collectionKey) {
    if (!collectionKey) return false;
    const row = db.prepare('SELECT 1 FROM nft_activity_watch WHERE collection_key = ?').get(collectionKey.trim().toLowerCase());
    return !!row;
  }

  ingestEvent(event, source = 'webhook') {
    try {
      const collectionKey = (event.collectionKey || event.collection || '').toString().trim().toLowerCase() || null;
      if (collectionKey && !this.isWatched(collectionKey)) {
        return { success: false, ignored: true, message: 'Collection not watched' };
      }

      const eventType = (event.type || event.eventType || 'unknown').toString().toLowerCase();
      const tokenMint = event.tokenMint || event.mint || null;
      const tokenName = event.tokenName || event.name || null;
      const fromWallet = event.fromWallet || event.from || null;
      const toWallet = event.toWallet || event.to || null;
      const priceSol = event.priceSol !== undefined && event.priceSol !== null ? Number(event.priceSol) : null;
      const txSignature = event.txSignature || event.signature || null;
      const eventTime = event.eventTime || event.timestamp || new Date().toISOString();

      const insert = db.prepare(`
        INSERT INTO nft_activity_events
        (event_type, collection_key, token_mint, token_name, from_wallet, to_wallet, price_sol, tx_signature, source, event_time, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventType,
        collectionKey,
        tokenMint,
        tokenName,
        fromWallet,
        toWallet,
        Number.isFinite(priceSol) ? priceSol : null,
        txSignature,
        source,
        eventTime,
        JSON.stringify(event)
      );

      this.maybeSendAlert({
        id: insert.lastInsertRowid,
        eventType,
        collectionKey,
        tokenName,
        tokenMint,
        fromWallet,
        toWallet,
        priceSol: Number.isFinite(priceSol) ? priceSol : null,
        txSignature,
        eventTime
      }).catch(err => logger.error('Error sending NFT activity alert:', err));

      return { success: true };
    } catch (e) {
      logger.error('Error ingesting NFT activity event:', e);
      return { success: false, message: 'Failed to ingest event' };
    }
  }

  async maybeSendAlert(evt) {
    // Per-collection tracked config takes priority
    const tracked = evt.collectionKey ? this.getTrackedCollectionByAddress(evt.collectionKey) : null;

    let alertChannelId = null;
    if (tracked) {
      // Use per-collection event flags
      const eventFlagMap = { mint: 'track_mint', sell: 'track_sale', list: 'track_list', delist: 'track_delist', transfer: 'track_transfer' };
      const flagCol = eventFlagMap[evt.eventType];
      if (flagCol && !tracked[flagCol]) return;
      alertChannelId = tracked.channel_id;
    } else {
      // Fallback to global config
      const cfg = this.getAlertConfig();
      if (!cfg || cfg.enabled !== 1 || !cfg.channel_id) return;
      const typeSet = new Set((cfg.event_types || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
      if (typeSet.size && !typeSet.has(evt.eventType)) return;
      const minSol = Number(cfg.min_sol || 0);
      const price = Number(evt.priceSol || 0);
      if (price < minSol) return;
      alertChannelId = cfg.channel_id;
    }

    if (!alertChannelId) return;

    const client = clientProvider.getClient();
    if (!client) return;

    const channel = await client.channels.fetch(alertChannelId).catch(() => null);
    if (!channel || !channel.send) return;

    const whenTs = evt.eventTime ? Math.floor(new Date(evt.eventTime).getTime() / 1000) : null;
    const shortSig = evt.txSignature ? `${evt.txSignature.slice(0, 12)}...${evt.txSignature.slice(-8)}` : null;

    const typeUpper = (evt.eventType || 'unknown').toUpperCase();
    const colorMap = {
      MINT: '#57F287',
      SELL: '#ED4245',
      LIST: '#FEE75C',
      DELIST: '#5865F2',
      TRANSFER: '#EB459E'
    };
    const iconMap = {
      MINT: '🪄',
      SELL: '💸',
      LIST: '🏷️',
      DELIST: '📦',
      TRANSFER: '🔁'
    };
    const typeIcon = iconMap[typeUpper] || '🧩';

    const embed = new EmbedBuilder()
      .setColor(colorMap[typeUpper] || '#5865F2')
      .setTitle(`${typeIcon} NFT Activity • ${typeUpper}`)
      .addFields(
        { name: 'Collection', value: evt.collectionKey || 'unknown', inline: true },
        { name: 'Token', value: evt.tokenName || evt.tokenMint || 'unknown', inline: true },
        { name: 'Price', value: evt.priceSol !== null && evt.priceSol !== undefined ? `${evt.priceSol} SOL` : '—', inline: true },
        { name: 'From', value: evt.fromWallet ? `\`${evt.fromWallet.slice(0, 6)}...${evt.fromWallet.slice(-4)}\`` : '—', inline: true },
        { name: 'To', value: evt.toWallet ? `\`${evt.toWallet.slice(0, 6)}...${evt.toWallet.slice(-4)}\`` : '—', inline: true },
        { name: 'When', value: whenTs ? `<t:${whenTs}:R>` : 'now', inline: true }
      )
      .setFooter({ text: shortSig ? `Tx: ${shortSig}` : 'No tx signature provided' })
      .setTimestamp();

    const explorer = evt.txSignature ? `https://solscan.io/tx/${evt.txSignature}` : null;
    await channel.send({
      content: explorer ? `🔗 ${explorer}` : undefined,
      embeds: [embed]
    });
  }

  listEvents(limit = 20) {
    try {
      return db.prepare(`
        SELECT event_type, collection_key, token_name, token_mint, from_wallet, to_wallet, price_sol, tx_signature, source, event_time, created_at
        FROM nft_activity_events
        ORDER BY datetime(COALESCE(event_time, created_at)) DESC
        LIMIT ?
      `).all(Math.min(Math.max(limit, 1), 100));
    } catch (e) {
      logger.error('Error listing NFT activity events:', e);
      return [];
    }
  }
}

module.exports = new NFTActivityService();
