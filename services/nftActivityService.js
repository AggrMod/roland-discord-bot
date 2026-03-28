const db = require('../database/db');
const logger = require('../utils/logger');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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

  addTrackedCollection({ guildId, collectionAddress, collectionName, channelId, trackMint, trackSale, trackList, trackDelist, trackTransfer, meSymbol }) {
    try {
      if (!collectionAddress || !collectionName || !channelId) {
        return { success: false, message: 'collectionAddress, collectionName, and channelId are required' };
      }
      const result = db.prepare(`
        INSERT INTO nft_tracked_collections (guild_id, collection_address, collection_name, channel_id, track_mint, track_sale, track_list, track_delist, track_transfer, me_symbol)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        guildId || '',
        collectionAddress.trim(),
        collectionName.trim(),
        channelId,
        trackMint !== undefined ? (trackMint ? 1 : 0) : 1,
        trackSale !== undefined ? (trackSale ? 1 : 0) : 1,
        trackList !== undefined ? (trackList ? 1 : 0) : 1,
        trackDelist !== undefined ? (trackDelist ? 1 : 0) : 1,
        trackTransfer !== undefined ? (trackTransfer ? 1 : 0) : 0,
        (meSymbol || '').trim()
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
      const allowed = ['collection_name', 'channel_id', 'track_mint', 'track_sale', 'track_list', 'track_delist', 'track_transfer', 'enabled', 'me_symbol'];
      const fieldMap = {
        collectionName: 'collection_name',
        channelId: 'channel_id',
        trackMint: 'track_mint',
        trackSale: 'track_sale',
        trackList: 'track_list',
        trackDelist: 'track_delist',
        trackTransfer: 'track_transfer',
        enabled: 'enabled',
        meSymbol: 'me_symbol'
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
      // Case-insensitive match — ingestEvent lowercases collectionKey but DB stores original case
      return db.prepare('SELECT * FROM nft_tracked_collections WHERE LOWER(collection_address) = LOWER(?) AND enabled = 1').get(address);
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
      // Parse Helius enhanced transaction format
      const nftData = event.events?.nft || {};
      const nfts = nftData.nfts || [];
      const mintFromNft = nfts[0]?.mint || null;

      // Collection key: prefer explicit field, then check accountData for a tracked address
      let collectionKey = (
        event.collectionKey || event.collection ||
        nftData.collectionKey || nftData.collection || ''
      ).toString().trim().toLowerCase() || null;

      // If no direct collection key, scan accountData for any tracked collection address
      if (!collectionKey) {
        const accountAddresses = (event.accountData || []).map(a => (a.account || '').toLowerCase());
        if (mintFromNft) accountAddresses.push(mintFromNft.toLowerCase());
        const allTracked = db.prepare('SELECT collection_address FROM nft_tracked_collections WHERE enabled = 1').all();
        for (const row of allTracked) {
          if (accountAddresses.includes(row.collection_address.toLowerCase())) {
            collectionKey = row.collection_address.toLowerCase();
            break;
          }
        }
      }

      // Check both nft_activity_watch (legacy) and nft_tracked_collections (new)
      const trackedByAddress = collectionKey ? this.getTrackedCollectionByAddress(collectionKey) : null;
      const watchedLegacy = collectionKey ? this.isWatched(collectionKey) : false;
      if (!trackedByAddress && !watchedLegacy) {
        return { success: false, ignored: true, message: 'Collection not watched' };
      }

      // Map Helius event types to internal types
      const rawType = (event.type || event.eventType || 'unknown').toString().toUpperCase();
      const typeMap = { NFT_LISTING: 'list', NFT_SALE: 'sell', NFT_MINT: 'mint', NFT_BID: 'bid', NFT_CANCEL_LISTING: 'delist', TRANSFER: 'transfer' };
      const eventType = typeMap[rawType] || rawType.toLowerCase();

      const tokenMint = event.tokenMint || mintFromNft || nftData.mint || event.mint || null;
      const tokenName = event.tokenName || nfts[0]?.name || nftData.name || event.name || null;
      const fromWallet = event.fromWallet || nftData.seller || nftData.from || event.from || null;
      const toWallet = event.toWallet || nftData.buyer || nftData.to || event.to || null;
      const rawPrice = nftData.amount ?? event.priceSol ?? event.price ?? null;
      const priceSol = rawPrice !== null ? Number(rawPrice) / (rawPrice > 1000 ? 1e9 : 1) : null; // convert lamports if needed
      const txSignature = event.txSignature || event.signature || null;
      const eventTime = event.eventTime || event.timestamp || new Date().toISOString();

      // Dedup: skip if tx_signature already recorded (webhook + poll overlap)
      if (txSignature) {
        const existing = db.prepare('SELECT id FROM nft_activity_events WHERE tx_signature = ?').get(txSignature);
        if (existing) return { success: false, ignored: true, message: 'Duplicate tx' };
      }

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
        eventTime,
        imageUrl: event.imageUrl || null
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
    logger.log(`[nft-alert] type=${evt.eventType} key=${evt.collectionKey} tracked=${!!tracked}`);

    let alertChannelId = null;
    if (tracked) {
      const eventFlagMap = { mint: 'track_mint', sell: 'track_sale', list: 'track_list', delist: 'track_delist', transfer: 'track_transfer' };
      const flagCol = eventFlagMap[evt.eventType];
      logger.log(`[nft-alert] flagCol=${flagCol} flagVal=${tracked[flagCol]} channelId=${tracked.channel_id}`);
      if (flagCol && !tracked[flagCol]) { logger.log('[nft-alert] dropped: flag disabled'); return; }
      alertChannelId = tracked.channel_id;
    } else {
      const cfg = this.getAlertConfig();
      logger.log(`[nft-alert] no tracked row — global cfg=${JSON.stringify(cfg)}`);
      if (!cfg || cfg.enabled !== 1 || !cfg.channel_id) { logger.log('[nft-alert] dropped: no global config'); return; }
      const typeSet = new Set((cfg.event_types || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
      if (typeSet.size && !typeSet.has(evt.eventType)) { logger.log(`[nft-alert] dropped: type ${evt.eventType} not in ${[...typeSet]}`); return; }
      const minSol = Number(cfg.min_sol || 0);
      const price = Number(evt.priceSol || 0);
      if (price < minSol) { logger.log(`[nft-alert] dropped: price ${price} < minSol ${minSol}`); return; }
      alertChannelId = cfg.channel_id;
    }

    if (!alertChannelId) { logger.log('[nft-alert] dropped: no alertChannelId'); return; }

    const client = clientProvider.getClient();
    if (!client) { logger.log('[nft-alert] dropped: no discord client'); return; }

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

    // Resolve collection name from DB (tracked) — fall back to shortened address
    const collectionDisplay = tracked?.collection_name ||
      (evt.collectionKey ? `${evt.collectionKey.slice(0, 6)}...${evt.collectionKey.slice(-4)}` : 'Unknown');

    // Token display: prefer name, then shorten mint address
    const tokenDisplay = (evt.tokenName && !evt.tokenName.match(/^[A-Za-z0-9]{32,}$/))
      ? evt.tokenName
      : evt.tokenMint ? `\`${evt.tokenMint.slice(0, 6)}...${evt.tokenMint.slice(-4)}\`` : '—';

    const priceDisplay = evt.priceSol != null && evt.priceSol > 0 ? `◎ ${Number(evt.priceSol).toFixed(3)} SOL` : '—';

    const embed = new EmbedBuilder()
      .setColor(colorMap[typeUpper] || '#5865F2')
      .setTitle(`${typeIcon} ${collectionDisplay} • ${typeUpper}`)
      .addFields(
        { name: 'Token', value: tokenDisplay, inline: true },
        { name: 'Price', value: priceDisplay, inline: true },
        { name: 'When', value: whenTs ? `<t:${whenTs}:R>` : 'now', inline: true },
        { name: 'From', value: evt.fromWallet ? `\`${evt.fromWallet.slice(0, 6)}...${evt.fromWallet.slice(-4)}\`` : '—', inline: true },
        { name: 'To', value: evt.toWallet ? `\`${evt.toWallet.slice(0, 6)}...${evt.toWallet.slice(-4)}\`` : '—', inline: true },
        { name: 'Collection', value: collectionDisplay, inline: true }
      )
      .setFooter({ text: shortSig ? `Tx: ${shortSig}` : 'No tx' })
      .setTimestamp();

    if (evt.imageUrl) embed.setThumbnail(evt.imageUrl);

    const explorer = evt.txSignature ? `https://solscan.io/tx/${evt.txSignature}` : null;
    const meLink = evt.tokenMint ? `https://magiceden.io/item-details/${evt.tokenMint}` : null;

    if (explorer) embed.setURL(explorer);

    const buttons = [];
    if (explorer) buttons.push(new ButtonBuilder().setLabel('View Tx').setURL(explorer).setStyle(ButtonStyle.Link).setEmoji('🔍'));
    if (meLink) buttons.push(new ButtonBuilder().setLabel('Magic Eden').setURL(meLink).setStyle(ButtonStyle.Link).setEmoji('🌊'));

    const components = buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [];

    await channel.send({ embeds: [embed], components });
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
  async syncAddressToHelius(collectionAddress, action) {
    const apiKey = process.env.HELIUS_API_KEY;
    const webhookId = process.env.HELIUS_WEBHOOK_ID;
    if (!apiKey || !webhookId) {
      logger.warn('HELIUS_API_KEY or HELIUS_WEBHOOK_ID not set — skipping webhook sync');
      return;
    }

    try {
      const baseUrl = `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${apiKey}`;

      // GET current webhook config
      const getRes = await fetch(baseUrl);
      if (!getRes.ok) {
        logger.error(`Helius GET webhook failed: ${getRes.status} ${await getRes.text()}`);
        return;
      }
      const webhook = await getRes.json();

      let addresses = Array.isArray(webhook.accountAddresses) ? [...webhook.accountAddresses] : [];

      if (action === 'add') {
        if (!addresses.includes(collectionAddress)) {
          addresses.push(collectionAddress);
        }
      } else if (action === 'remove') {
        addresses = addresses.filter(a => a !== collectionAddress);
      }

      // PUT updated webhook
      const putRes = await fetch(baseUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookURL: webhook.webhookURL,
          transactionTypes: webhook.transactionTypes,
          accountAddresses: addresses,
          webhookType: webhook.webhookType || 'enhanced',
          authHeader: webhook.authHeader,
        }),
      });

      if (!putRes.ok) {
        logger.error(`Helius PUT webhook failed: ${putRes.status} ${await putRes.text()}`);
        return;
      }

      logger.log(`Helius webhook synced: ${action} ${collectionAddress} (${addresses.length} addresses total)`);
    } catch (e) {
      logger.error('Error syncing address to Helius webhook:', e);
    }
  }

  /**
   * Poll Helius enhanced transactions API for each tracked collection.
   * Catches Magic Eden/Tensor listings that webhooks miss.
   * @param {string} [guildId] - optional guild filter; polls all if omitted
   */
  async pollCollectionActivity(guildId) {
    try {
      const collections = this.getTrackedCollections(guildId).filter(c => c.enabled);
      if (!collections.length) return;

      for (const col of collections) {
        try {
          // Magic Eden poll — only if me_symbol is configured
          if (col.me_symbol) {
          // No type filter — ME returns all activity types; we filter client-side
          const meUrl = `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(col.me_symbol)}/activities?offset=0&limit=100`;
          const res = await fetch(meUrl, { method: 'GET', headers: { 'Accept': 'application/json' } });

          if (!res.ok) {
            logger.error(`[nft-poll] ME API error for ${col.collection_name}: ${res.status}`);
            await new Promise(r => setTimeout(r, 500));
            continue;
          }

          const activities = await res.json();
          const list = Array.isArray(activities) ? activities : (activities?.results || []);
          logger.log(`[nft-poll] ${col.collection_name} ME raw=${list.length}`);

          let newCount = 0;
          let skipped = 0;

          for (const act of list) {
            const sig = act.txId || act.signature || null;
            if (sig) {
              const exists = db.prepare('SELECT id FROM nft_activity_events WHERE tx_signature = ?').get(sig);
              if (exists) { skipped++; continue; }
            }

            // Normalise ME activity to ingestEvent shape
            const meTypeMap = { list: 'list', buyNow: 'sell', cancelBid: 'delist', bid: 'bid', cancelListing: 'delist' };
            const normalized = {
              type: meTypeMap[act.type] || act.type || 'unknown',
              collectionKey: col.collection_address,
              tokenMint: act.tokenMint || act.mint || null,
              tokenName: act.tokenMint || null,
              fromWallet: act.seller || act.creatorAddress || null,
              toWallet: act.buyer || null,
              priceSol: act.price != null ? Number(act.price) : null,
              txSignature: sig,
              imageUrl: act.image || null,
              eventTime: act.blockTime ? new Date(act.blockTime * 1000).toISOString() : new Date().toISOString(),
            };

            const result = this.ingestEvent(normalized, 'poll');
            if (result.success) newCount++;
            else skipped++;
          }

          logger.log(`[nft-poll] guild=${col.guild_id} collection=${col.collection_name} ME new=${newCount} skipped=${skipped}`);
          await new Promise(r => setTimeout(r, 600));
          } // end ME block

          // Tensor poll — always runs using collection_address as collId directly
          try {
            const tensorQuery = `query { recentTransactions(collId: "${col.collection_address}", limit: 100) { txs { tx { txType signature grossAmount seller buyer mintOnchainId blockTime } } } }`;
            const tensorCtrl = new AbortController();
            const tensorTimeout = setTimeout(() => tensorCtrl.abort(), 8000);
            const tensorRes = await fetch("https://api.tensor.trade/graphql", {
              method: "POST",
              headers: { "Content-Type": "application/json", "User-Agent": "GuildPilot/1.0" },
              body: JSON.stringify({ query: tensorQuery }),
              signal: tensorCtrl.signal,
            });
            clearTimeout(tensorTimeout);
            if (tensorRes.ok) {
              const tensorData = await tensorRes.json();
              const txs = tensorData?.data?.recentTransactions?.txs || [];
              const tensorTypeMap = { LIST: "list", SALE_BUY_NOW: "sell", DELIST: "delist", BID: "bid" };
              for (const { tx } of txs) {
                if (!tx?.signature) continue;
                const exists = db.prepare("SELECT id FROM nft_activity_events WHERE tx_signature = ?").get(tx.signature);
                if (exists) continue;
                const normalized = {
                  type: tensorTypeMap[tx.txType] || tx.txType?.toLowerCase() || "unknown",
                  collectionKey: col.collection_address,
                  tokenMint: tx.mintOnchainId || null,
                  fromWallet: tx.seller || null,
                  toWallet: tx.buyer || null,
                  priceSol: tx.grossAmount ? Number(tx.grossAmount) / 1e9 : null,
                  txSignature: tx.signature,
                  eventTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString(),
                };
                this.ingestEvent(normalized, "poll");
              }
              logger.log(`[nft-poll] ${col.collection_name} Tensor txs=${txs.length}`);
            }
          } catch (tensorErr) {
            if (!tensorErr.message?.includes('fetch failed') && !tensorErr.message?.includes('abort')) {
              logger.error(`[nft-poll] Tensor error for ${col.collection_name}:`, tensorErr.message);
            }
          }

          await new Promise(r => setTimeout(r, 600));
        } catch (colErr) {
          logger.error(`[nft-poll] Error polling ${col.collection_name}:`, colErr);
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } catch (e) {
      logger.error('[nft-poll] Fatal error in pollCollectionActivity:', e);
    }
  }
}

module.exports = new NFTActivityService();
