const db = require('../database/db');
const logger = require('../utils/logger');

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
    const cfg = this.getAlertConfig();
    if (!cfg || cfg.enabled !== 1 || !cfg.channel_id) return;

    const typeSet = new Set((cfg.event_types || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    if (typeSet.size && !typeSet.has(evt.eventType)) return;

    const minSol = Number(cfg.min_sol || 0);
    const price = Number(evt.priceSol || 0);
    if (price < minSol) return;

    const client = global.discordClient;
    if (!client) return;

    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!channel || !channel.send) return;

    const sig = evt.txSignature ? `\n\`${evt.txSignature.slice(0, 12)}...${evt.txSignature.slice(-8)}\`` : '';
    const when = evt.eventTime ? `<t:${Math.floor(new Date(evt.eventTime).getTime() / 1000)}:R>` : 'now';

    await channel.send({
      content:
        `🧩 **NFT Activity** • **${evt.eventType.toUpperCase()}**` +
        `\nCollection: ${evt.collectionKey || 'unknown'}` +
        `\nToken: ${evt.tokenName || evt.tokenMint || 'unknown'}` +
        `${evt.priceSol !== null && evt.priceSol !== undefined ? `\nPrice: ${evt.priceSol} SOL` : ''}` +
        `\nTime: ${when}` +
        sig
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
