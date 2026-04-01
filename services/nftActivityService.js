const db = require('../database/db');
const logger = require('../utils/logger');
const { applyEmbedBranding, getBranding } = require('./embedBranding');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const clientProvider = require('../utils/clientProvider');
const settings = require('../config/settings');

const CHAIN_PRICE_META = {
  solana: { unit: 'SOL', icon: '<:1000042064:1488241763222290564>' },
  ethereum: { unit: 'ETH', icon: '⟠' },
  base: { unit: 'ETH', icon: '🔵' },
  polygon: { unit: 'MATIC', icon: '🟣' },
  arbitrum: { unit: 'ETH', icon: '🔷' },
  optimism: { unit: 'ETH', icon: '🔴' },
  bsc: { unit: 'BNB', icon: '🟡' },
  avalanche: { unit: 'AVAX', icon: '🔺' },
};

function normalizeChain(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return 'solana';
  if (['sol', 'solana'].includes(raw)) return 'solana';
  if (['eth', 'ethereum', 'mainnet'].includes(raw)) return 'ethereum';
  if (['matic', 'polygon', 'polygon-pos'].includes(raw)) return 'polygon';
  return raw;
}

function getChainPriceMeta(chainRaw) {
  const chain = normalizeChain(chainRaw);
  return CHAIN_PRICE_META[chain] || { unit: 'USD', icon: '💠' };
}

class NFTActivityService {
  async resolveTokenAssetMeta(tokenMint) {
    if (!tokenMint) return { name: null, image: null };

    // 1) Reuse a previously seen readable name/image from DB if available
    try {
      const row = db.prepare(`
        SELECT token_name, raw_json
        FROM nft_activity_events
        WHERE LOWER(token_mint) = LOWER(?)
        ORDER BY datetime(created_at) DESC
        LIMIT 1
      `).get(tokenMint);

      const cachedName = String(row?.token_name || '').trim();
      let cachedImage = null;
      try {
        const raw = row?.raw_json ? JSON.parse(row.raw_json) : null;
        cachedImage = raw?.imageUrl || raw?.image || raw?.content?.files?.[0]?.uri || null;
      } catch {}

      if (cachedName && !/^[A-Za-z0-9]{32,}$/.test(cachedName)) {
        return { name: cachedName, image: cachedImage };
      }
    } catch {}

    // 2) Helius DAS fallback for proper metadata naming/image
    try {
      const heliusKey = process.env.HELIUS_API_KEY;
      if (!heliusKey) return { name: null, image: null };
      const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'gp-token-asset',
          method: 'getAsset',
          params: { id: tokenMint },
        }),
      });
      if (!res.ok) return { name: null, image: null };
      const data = await res.json();
      const name = String(data?.result?.content?.metadata?.name || '').trim() || null;
      const image = data?.result?.content?.files?.[0]?.uri || data?.result?.content?.links?.image || null;
      return { name, image };
    } catch {}

    return { name: null, image: null };
  }

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

  addTrackedCollection({ guildId, collectionAddress, collectionName, channelId, trackMint, trackSale, trackList, trackDelist, trackTransfer, trackBid, meSymbol }) {
    try {
      const normalizedAddress = String(collectionAddress || '').trim();
      const normalizedName = String(collectionName || '').trim();
      const normalizedChannelId = String(channelId || '').trim();
      if (!normalizedAddress || !normalizedName || !normalizedChannelId) {
        return { success: false, message: 'collectionAddress, collectionName, and channelId are required' };
      }
      const result = db.prepare(`
        INSERT INTO nft_tracked_collections (guild_id, collection_address, collection_name, channel_id, track_mint, track_sale, track_list, track_delist, track_transfer, track_bid, me_symbol)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        guildId || '',
        normalizedAddress,
        normalizedName,
        normalizedChannelId,
        trackMint !== undefined ? (trackMint ? 1 : 0) : 1,
        trackSale !== undefined ? (trackSale ? 1 : 0) : 1,
        trackList !== undefined ? (trackList ? 1 : 0) : 1,
        trackDelist !== undefined ? (trackDelist ? 1 : 0) : 1,
        trackTransfer !== undefined ? (trackTransfer ? 1 : 0) : 0,
        trackBid !== undefined ? (trackBid ? 1 : 0) : 0,
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
      const allowed = ['collection_name', 'channel_id', 'track_mint', 'track_sale', 'track_list', 'track_delist', 'track_transfer', 'track_bid', 'enabled', 'me_symbol'];
      const fieldMap = {
        collectionName: 'collection_name',
        channelId: 'channel_id',
        trackMint: 'track_mint',
        trackSale: 'track_sale',
        trackList: 'track_list',
        trackDelist: 'track_delist',
        trackTransfer: 'track_transfer',
        trackBid: 'track_bid',
        enabled: 'enabled',
        meSymbol: 'me_symbol'
      };
      const setClauses = [];
      const params = [];
      for (const [key, val] of Object.entries(updates)) {
        const col = fieldMap[key];
        if (col && allowed.includes(col)) {
          if (col === 'channel_id') {
            const normalizedChannelId = String(val || '').trim();
            if (!normalizedChannelId) {
              return { success: false, message: 'channelId cannot be empty' };
            }
            setClauses.push(`${col} = ?`);
            params.push(normalizedChannelId);
            continue;
          }
          setClauses.push(`${col} = ?`);
          params.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
        }
      }
      if (!setClauses.length) return { success: false, message: 'No valid updates provided' };
      let info;
      if (guildId) {
        params.push(id, guildId);
        info = db.prepare(`UPDATE nft_tracked_collections SET ${setClauses.join(', ')} WHERE id = ? AND guild_id = ?`).run(...params);
      } else {
        params.push(id);
        info = db.prepare(`UPDATE nft_tracked_collections SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
      }
      if (!info.changes) return { success: false, message: 'Collection not found or not owned by this server' };
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

  getTrackedCollectionsByAddress(address) {
    try {
      return db.prepare(`
        SELECT *
        FROM nft_tracked_collections
        WHERE enabled = 1
          AND LOWER(TRIM(collection_address)) = LOWER(TRIM(?))
      `).all(address);
    } catch (e) {
      return [];
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
      const source = String(event.source || nftData.source || 'solana').toLowerCase();
      const chain = normalizeChain(event.chain || event.network || source);

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
        chain,
        imageUrl: event.imageUrl || null
      }).catch(err => logger.error('Error sending NFT activity alert:', err));

      return { success: true };
    } catch (e) {
      logger.error('Error ingesting NFT activity event:', e);
      return { success: false, message: 'Failed to ingest event' };
    }
  }

  async _fireWalletAlerts(evt) {
    // Lazy-require to avoid circular dependency
    const trackedWalletsService = require('./trackedWalletsService');
    const involvedWallets = [evt.fromWallet, evt.toWallet].filter(Boolean);
    const typeUpper = (evt.eventType || 'unknown').toUpperCase();
    const iconMap = { MINT: '🪄', SELL: '💸', LIST: '🏷️', DELIST: '📦', TRANSFER: '🔁' };
    const typeIcon = iconMap[typeUpper] || '🧩';
    const chainMeta = getChainPriceMeta(evt.chain);
    const priceDisplay = evt.priceSol !== null && evt.priceSol !== undefined && evt.priceSol > 0
      ? `${chainMeta.icon} ${Number(evt.priceSol).toFixed(3)} ${chainMeta.unit}`
      : '—';

    for (const addr of involvedWallets) {
      const rows = trackedWalletsService.getTrackedWalletsByAddress(addr);
      for (const row of rows) {
        if (!row.alert_channel_id) continue;
        trackedWalletsService.sendWalletAlert({
          walletRow: row,
          guildId: row.guild_id,
          evt,
          typeIcon,
          priceDisplay,
          chain: evt.chain,
        }).catch(err => logger.error('[wallet-alert] error:', err));
      }
    }
  }

  async maybeSendAlert(evt) {
    // Per-collection tracked config (can be multiple tenants/channels for same collection)
    const trackedRows = evt.collectionKey ? this.getTrackedCollectionsByAddress(evt.collectionKey) : [];
    const eventFlagMap = { mint: 'track_mint', sell: 'track_sale', list: 'track_list', delist: 'track_delist', transfer: 'track_transfer', bid: 'track_bid' };
    // Event types with no flag (bid, pool_update, etc.) are not user-configurable
    // — block them unless explicitly mapped to a flag column
    const KNOWN_TYPES = new Set(Object.keys(eventFlagMap));

    const targetRows = trackedRows.filter(row => {
      const flagCol = eventFlagMap[evt.eventType];
      if (!KNOWN_TYPES.has(evt.eventType)) return false; // block bid, pool_update, etc.
      if (flagCol && !row[flagCol]) return false;
      return !!String(row.channel_id || '').trim();
    });

    logger.log(`[nft-alert] targets tx=${evt.txSignature || 'none'} event=${evt.eventType} collection=${evt.collectionKey || 'none'} tracked=${trackedRows.length} eligible=${targetRows.length} channels=${targetRows.map(r => r.channel_id).join(',')}`);

    const client = clientProvider.getClient();
    if (!client) return;

    if (!targetRows.length) {
      const cfg = this.getAlertConfig();
      if (!cfg || cfg.enabled !== 1 || !cfg.channel_id) return;
      const typeSet = new Set((cfg.event_types || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
      if (typeSet.size && !typeSet.has(evt.eventType)) return;
      const minSol = Number(cfg.min_sol || 0);
      const price = Number(evt.priceSol || 0);
      if (price < minSol) return;
      targetRows.push({ channel_id: cfg.channel_id, guild_id: '' });
    }


    const whenTs = evt.eventTime ? Math.floor(new Date(evt.eventTime).getTime() / 1000) : null;
    const shortSig = evt.txSignature ? `${evt.txSignature.slice(0, 12)}...${evt.txSignature.slice(-8)}` : null;

    const typeUpper = (evt.eventType || 'unknown').toUpperCase();
    const colorMap = {
      MINT: '#57F287',
      SELL: '#57F287',
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

    const chainMeta = getChainPriceMeta(evt.chain);
    const chainKey = normalizeChain(evt.chain);
    const chainEmojiMap = settings.getSettings().chainEmojiMap || {};
    const envSolIcon = process.env.SOL_EMOJI || '<:1000042064:1488241763222290564>';
    const defaultChainIcon = chainMeta.icon;
    const mappedIcon = chainEmojiMap[chainKey] || (chainKey === 'solana' ? envSolIcon : defaultChainIcon);
    const priceDisplay = evt.priceSol !== null && evt.priceSol !== undefined && evt.priceSol > 0
      ? `${mappedIcon} ${Number(evt.priceSol).toFixed(3)} ${chainMeta.unit}`
      : '—';

    const displayType = typeUpper === 'SELL' ? 'BUY' : typeUpper;

    const walletToDisplay = (wallet) => {
      if (!wallet) return '—';
      try {
        const row = db.prepare(`
          SELECT u.username
          FROM wallets w
          JOIN users u ON u.discord_id = w.discord_id
          WHERE lower(w.wallet_address) = lower(?)
          LIMIT 1
        `).get(wallet);
        if (row?.username) return `@${row.username}`;
      } catch {}
      return `\`${wallet.slice(0, 6)}...${wallet.slice(-4)}\``;
    };

    const explorer = evt.txSignature ? `https://solscan.io/tx/${evt.txSignature}` : null;
    const meLink = evt.tokenMint ? `https://magiceden.io/item-details/${evt.tokenMint}` : null;
    const buttons = [];
    if (explorer) buttons.push(new ButtonBuilder().setLabel('View Tx').setURL(explorer).setStyle(ButtonStyle.Link).setEmoji('🔍'));
    if (meLink) buttons.push(new ButtonBuilder().setLabel('Magic Eden').setURL(meLink).setStyle(ButtonStyle.Link).setEmoji('🌊'));
    const components = buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [];

    const resolvedMeta = await this.resolveTokenAssetMeta(evt.tokenMint);
    const resolvedTokenName = resolvedMeta?.name || null;
    const resolvedTokenImage = resolvedMeta?.image || null;

    for (const target of targetRows) {
      const channel = await client.channels.fetch(target.channel_id).catch(() => null);
      if (!channel || !channel.send) continue;

      const collectionDisplay = target.collection_name ||
        (evt.collectionKey ? `${evt.collectionKey.slice(0, 6)}...${evt.collectionKey.slice(-4)}` : 'Unknown');

      const tokenIdShort = evt.tokenMint ? `\`${evt.tokenMint.slice(0, 6)}...${evt.tokenMint.slice(-4)}\`` : null;
      const tokenNameRaw = String(resolvedTokenName || evt.tokenName || '').trim();
      const tokenNumberMatch = tokenNameRaw.match(/#\s*(\d{1,8})\b/) || tokenNameRaw.match(/\b(\d{1,8})\b/);
      const tokenNumber = tokenNumberMatch?.[1] || null;
      const tokenDisplay = (tokenNameRaw && !tokenNameRaw.match(/^[A-Za-z0-9]{32,}$/))
        ? tokenNameRaw
        : (collectionDisplay !== 'Unknown' && tokenNumber)
          ? `${collectionDisplay} #${tokenNumber}`
          : (collectionDisplay !== 'Unknown' && evt.tokenMint)
            ? `${collectionDisplay} #${evt.tokenMint.slice(-4)}`
            : (tokenIdShort || '—');

      const fields = [
        { name: 'Token Name', value: tokenDisplay, inline: true },
        { name: 'When', value: whenTs ? `<t:${whenTs}:R>` : null, inline: true },
      ];
      if (evt.priceSol !== null && evt.priceSol !== undefined && evt.priceSol > 0) {
        fields.push({ name: 'Price', value: priceDisplay, inline: true });
      }
      if (evt.fromWallet) {
        fields.push({ name: 'From', value: walletToDisplay(evt.fromWallet), inline: true });
      }
      if (evt.toWallet) {
        fields.push({ name: 'To', value: walletToDisplay(evt.toWallet), inline: true });
      }

      const embed = new EmbedBuilder()
        .addFields(fields.filter(f => f.value))
        .setTimestamp()
        .setTitle(`${typeIcon} ${collectionDisplay} ${displayType}`);

      const branding = getBranding(target.guild_id || '', 'nfttracker');
      const fallbackLogo = branding.logo || client?.user?.displayAvatarURL?.() || null;
      const authorText = `${branding.brandName || 'Guild Pilot'}`;
      try {
        if (fallbackLogo) embed.setAuthor({ name: authorText, iconURL: fallbackLogo });
        else embed.setAuthor({ name: authorText });
      } catch {}

      applyEmbedBranding(embed, {
        guildId: target.guild_id || '',
        moduleKey: 'nfttracker',
        defaultColor: colorMap[typeUpper] || '#5865F2',
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: fallbackLogo,
        footerPrefix: shortSig ? `Tx: ${shortSig}` : 'No tx',
        useThumbnail: false,
      });

      const tokenImage = evt.imageUrl || resolvedTokenImage;
      if (tokenImage) embed.setThumbnail(tokenImage);
      if (explorer) embed.setURL(explorer);

      try {
        await channel.send({ embeds: [embed], components });
        logger.log(`[nft-alert] sent guild=${target.guild_id || 'global'} channel=${target.channel_id} type=${evt.eventType} tx=${evt.txSignature || 'none'}`);
      } catch (sendErr) {
        logger.error(`[nft-alert] failed guild=${target.guild_id || 'global'} channel=${target.channel_id} type=${evt.eventType} tx=${evt.txSignature || 'none'}`, sendErr);
      }
    }

    // Also fire per-wallet alerts for any tracked_wallets that match from/to
    this._fireWalletAlerts(evt).catch(err => logger.error('[wallet-alert] _fireWalletAlerts error:', err));
  }

  getEventByTx(txSignature) {
    try {
      if (!txSignature) return null;
      return db.prepare(`
        SELECT event_type, collection_key, token_name, token_mint, from_wallet, to_wallet, price_sol, tx_signature, source, event_time, created_at
        FROM nft_activity_events
        WHERE tx_signature = ?
        ORDER BY datetime(COALESCE(event_time, created_at)) DESC
        LIMIT 1
      `).get(txSignature);
    } catch (e) {
      logger.error('Error getting NFT activity event by tx:', e);
      return null;
    }
  }

  async replayEventByTx(txSignature) {
    const row = this.getEventByTx(txSignature);
    if (!row) return { success: false, message: 'Event not found for tx signature' };

    const evt = {
      eventType: row.event_type,
      collectionKey: row.collection_key,
      tokenName: row.token_name,
      tokenMint: row.token_mint,
      fromWallet: row.from_wallet,
      toWallet: row.to_wallet,
      priceSol: row.price_sol !== null && row.price_sol !== undefined ? Number(row.price_sol) : null,
      txSignature: row.tx_signature,
      eventTime: row.event_time || row.created_at,
      chain: row.source || 'solana',
      imageUrl: null,
    };

    await this.maybeSendAlert(evt);
    return { success: true, txSignature: row.tx_signature };
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

  listEventsForGuild(guildId, limit = 20) {
    try {
      if (!guildId) return this.listEvents(limit);
      return db.prepare(`
        SELECT e.event_type, e.collection_key, e.token_name, e.token_mint, e.from_wallet, e.to_wallet, e.price_sol, e.tx_signature, e.source, e.event_time, e.created_at
        FROM nft_activity_events e
        WHERE EXISTS (
          SELECT 1 FROM nft_tracked_collections c
          WHERE c.guild_id = ?
            AND (
              LOWER(COALESCE(c.collection_address, '')) = LOWER(COALESCE(e.collection_key, ''))
              OR LOWER(COALESCE(c.me_symbol, '')) = LOWER(COALESCE(e.collection_key, ''))
            )
        )
        ORDER BY datetime(COALESCE(e.event_time, e.created_at)) DESC
        LIMIT ?
      `).all(guildId, Math.min(Math.max(limit, 1), 100));
    } catch (e) {
      logger.error('Error listing NFT activity events for guild:', e);
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
              tokenName: act.tokenName || act.name || act.tokenMint || null,
              fromWallet: act.seller || act.creatorAddress || null,
              toWallet: act.buyer || null,
              priceSol: act.price !== null && act.price !== undefined ? Number(act.price) : null,
              txSignature: sig,
              imageUrl: act.image || null,
              chain: 'solana',
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
                  tokenName: tx.name || null,
                  fromWallet: tx.seller || null,
                  toWallet: tx.buyer || null,
                  priceSol: tx.grossAmount ? Number(tx.grossAmount) / 1e9 : null,
                  txSignature: tx.signature,
                  chain: 'solana',
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
