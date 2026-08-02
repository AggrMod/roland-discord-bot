const { AbiCoder, ZeroAddress, formatEther, formatUnits, id } = require('ethers');
const db = require('../database/db');
const logger = require('../utils/logger');
const { getChain, getEvmRpcUrl } = require('../utils/chainIdentity');
const evmService = require('./evmService');
const nftActivityService = require('./nftActivityService');
const trackedWalletsService = require('./trackedWalletsService');

const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
const TRANSFER_SINGLE_TOPIC = id('TransferSingle(address,address,address,uint256,uint256)');
const TRANSFER_BATCH_TOPIC = id('TransferBatch(address,address,address,uint256[],uint256[])');
const abiCoder = AbiCoder.defaultAbiCoder();
const CONFIRMATIONS = Math.max(0, Math.min(64, Number(process.env.EVM_TRACKER_CONFIRMATIONS || 3)));
const BLOCK_SPAN = Math.max(1, Math.min(5000, Number(process.env.EVM_TRACKER_BLOCK_SPAN || 750)));
const WALLET_BLOCK_SPAN = Math.max(1, Math.min(25, Number(process.env.EVM_WALLET_TRACKER_BLOCK_SPAN || 6)));
const MAX_ALERTS_PER_POLL = Math.max(1, Math.min(250, Number(process.env.EVM_TRACKER_ALERT_CAP || 50)));

function topicAddress(topic) {
  const value = String(topic || '');
  return value.length >= 42 ? `0x${value.slice(-40)}`.toLowerCase() : '';
}

function normalizeEvmKey(value) {
  return String(value || '').trim().toLowerCase();
}

function getCursor(guildId, chainId, trackerType, trackerId) {
  return db.prepare(`
    SELECT * FROM evm_tracker_cursors
    WHERE guild_id = ? AND chain_id = ? AND tracker_type = ? AND tracker_id = ?
  `).get(String(guildId || ''), chainId, trackerType, Number(trackerId));
}

function saveCursor(guildId, chainId, trackerType, trackerId, lastBlock, lastError = null) {
  db.prepare(`
    INSERT INTO evm_tracker_cursors (guild_id, chain_id, tracker_type, tracker_id, last_block, last_error, checked_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, chain_id, tracker_type, tracker_id) DO UPDATE SET
      last_block = excluded.last_block,
      last_error = excluded.last_error,
      checked_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(String(guildId || ''), chainId, trackerType, Number(trackerId), Number(lastBlock), lastError ? String(lastError).slice(0, 500) : null);
}

async function getSafeHead(provider) {
  return Math.max(0, Number(await provider.getBlockNumber()) - CONFIRMATIONS);
}

function getPollRange(cursor, safeHead, span) {
  if (!cursor) return null;
  const fromBlock = Number(cursor.last_block || 0) + 1;
  if (fromBlock > safeHead) return null;
  return { fromBlock, toBlock: Math.min(safeHead, fromBlock + span - 1) };
}

class EvmTrackerService {
  constructor() {
    this.polling = false;
    this.blockTimeCache = new Map();
  }

  async getBlockTime(provider, chainId, blockNumber) {
    const key = `${chainId}:${blockNumber}`;
    if (this.blockTimeCache.has(key)) return this.blockTimeCache.get(key);
    const block = await provider.getBlock(blockNumber).catch(() => null);
    const value = block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : new Date().toISOString();
    this.blockTimeCache.set(key, value);
    if (this.blockTimeCache.size > 1000) this.blockTimeCache.clear();
    return value;
  }

  async pollToken(config) {
    const chain = getChain(config.chain_id);
    if (!chain || chain.family !== 'evm') return { processed: 0, alerts: 0 };
    const provider = evmService.getProvider(chain.chainId);
    const safeHead = await getSafeHead(provider);
    const cursor = getCursor(config.guild_id, chain.chainId, 'token', config.id);
    if (!cursor) {
      saveCursor(config.guild_id, chain.chainId, 'token', config.id, safeHead);
      return { initialized: true, processed: 0, alerts: 0 };
    }
    const range = getPollRange(cursor, safeHead, BLOCK_SPAN);
    if (!range) {
      saveCursor(config.guild_id, chain.chainId, 'token', config.id, Number(cursor.last_block || safeHead));
      return { processed: 0, alerts: 0 };
    }

    let metadata = {
      decimals: Number.isInteger(Number(config.decimals)) ? Number(config.decimals) : 18,
      symbol: String(config.token_symbol || 'TOKEN'),
      name: String(config.token_name || 'Token'),
    };
    if (!config.token_symbol || config.decimals === null || config.decimals === undefined) {
      metadata = await evmService.getTokenMetadata(config.token_mint, chain.chainId).catch(() => metadata);
      db.prepare(`
        UPDATE tracked_tokens SET token_symbol = COALESCE(token_symbol, ?), token_name = COALESCE(token_name, ?), decimals = COALESCE(decimals, ?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(metadata.symbol, metadata.name, metadata.decimals, config.id);
    }

    const walletRows = db.prepare(`
      SELECT * FROM tracked_wallets
      WHERE guild_id = ? AND chain_id = ? AND enabled = 1
    `).all(config.guild_id, chain.chainId);
    const wallets = new Map(walletRows.map(row => [normalizeEvmKey(row.wallet_address), row]));
    const logs = await provider.getLogs({
      address: config.token_mint,
      topics: [TRANSFER_TOPIC],
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    });
    let processed = 0;
    let alerts = 0;
    for (const log of logs) {
      if (!Array.isArray(log.topics) || log.topics.length !== 3) continue;
      const from = topicAddress(log.topics[1]);
      const to = topicAddress(log.topics[2]);
      const rawAmount = BigInt(log.data || '0x0');
      const amount = Number(formatUnits(rawAmount, metadata.decimals));
      if (!Number.isFinite(amount)) continue;
      const matches = [];
      if (wallets.has(from)) matches.push({ row: wallets.get(from), direction: -1, type: 'transfer_out' });
      if (wallets.has(to) && to !== from) matches.push({ row: wallets.get(to), direction: 1, type: 'transfer_in' });
      if (!matches.length) continue;
      const eventTime = await this.getBlockTime(provider, chain.chainId, log.blockNumber);
      for (const match of matches) {
        const saved = trackedWalletsService.saveTrackedTokenEvent({
          guildId: config.guild_id,
          chainId: chain.chainId,
          walletId: match.row.id,
          walletAddress: match.row.wallet_address,
          tokenMint: config.token_mint,
          tokenSymbol: metadata.symbol,
          tokenName: metadata.name,
          eventType: match.type,
          amountDelta: amount * match.direction,
          amountRaw: (rawAmount * BigInt(match.direction)).toString(),
          txSignature: log.transactionHash,
          eventTime,
          source: 'evm-rpc',
          rawJson: { blockNumber: log.blockNumber, logIndex: log.index, from, to, amountRaw: rawAmount.toString() },
        });
        if (!saved?.inserted) continue;
        processed += 1;
        if (Number(config.alert_transfers || 0) === 1 && amount >= Number(config.min_alert_amount || 0) && alerts < MAX_ALERTS_PER_POLL) {
          await trackedWalletsService.sendTrackedTokenAlert({
            walletRow: match.row,
            guildId: config.guild_id,
            evt: {
              chainId: chain.chainId,
              eventType: match.type,
              amountDelta: amount * match.direction,
              tokenMint: config.token_mint,
              tokenSymbol: metadata.symbol,
              tokenName: metadata.name,
              txSignature: log.transactionHash,
              eventTime,
              alertChannelId: config.alert_channel_id,
              alertChannelIds: config.alert_channel_ids,
            },
          });
          alerts += 1;
        }
      }
    }
    saveCursor(config.guild_id, chain.chainId, 'token', config.id, range.toBlock);
    return { processed, alerts, fromBlock: range.fromBlock, toBlock: range.toBlock };
  }

  async pollCollection(config) {
    const chain = getChain(config.chain_id);
    if (!chain || chain.family !== 'evm') return { processed: 0 };
    const provider = evmService.getProvider(chain.chainId);
    const safeHead = await getSafeHead(provider);
    const cursor = getCursor(config.guild_id, chain.chainId, 'nft', config.id);
    if (!cursor) {
      saveCursor(config.guild_id, chain.chainId, 'nft', config.id, safeHead);
      return { initialized: true, processed: 0 };
    }
    const range = getPollRange(cursor, safeHead, BLOCK_SPAN);
    if (!range) return { processed: 0 };
    const standard = String(config.nft_standard || 'erc721').toLowerCase();
    const eventTopics = standard === 'erc1155'
      ? [TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]
      : [TRANSFER_TOPIC];
    const logs = await provider.getLogs({
      address: config.collection_address,
      topics: [eventTopics],
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    });
    let processed = 0;
    for (const log of logs) {
      if (!Array.isArray(log.topics)) continue;
      const topic = String(log.topics[0] || '').toLowerCase();
      let transfers = [];
      if (topic === TRANSFER_TOPIC.toLowerCase() && log.topics.length >= 4) {
        transfers = [{ from: topicAddress(log.topics[1]), to: topicAddress(log.topics[2]), tokenId: BigInt(log.topics[3]).toString(), amount: '1' }];
      } else if (topic === TRANSFER_SINGLE_TOPIC.toLowerCase() && log.topics.length >= 4) {
        const [tokenId, amount] = abiCoder.decode(['uint256', 'uint256'], log.data || '0x');
        transfers = [{ from: topicAddress(log.topics[2]), to: topicAddress(log.topics[3]), tokenId: tokenId.toString(), amount: amount.toString() }];
      } else if (topic === TRANSFER_BATCH_TOPIC.toLowerCase() && log.topics.length >= 4) {
        const [tokenIds, amounts] = abiCoder.decode(['uint256[]', 'uint256[]'], log.data || '0x');
        transfers = tokenIds.map((tokenId, index) => ({
          from: topicAddress(log.topics[2]),
          to: topicAddress(log.topics[3]),
          tokenId: tokenId.toString(),
          amount: amounts[index]?.toString() || '0',
        }));
      }

      const configuredTokenId = config.token_id === null || config.token_id === undefined || config.token_id === '' ? null : String(config.token_id);
      for (const transfer of transfers) {
        if (configuredTokenId !== null && transfer.tokenId !== configuredTokenId) continue;
        const isMint = transfer.from === ZeroAddress.toLowerCase();
        if (isMint ? Number(config.track_mint || 0) !== 1 : Number(config.track_transfer || 0) !== 1) continue;
        const eventTime = await this.getBlockTime(provider, chain.chainId, log.blockNumber);
        const result = nftActivityService.ingestEvent({
          type: isMint ? 'NFT_MINT' : 'TRANSFER',
          chainId: chain.chainId,
          collectionKey: config.collection_address,
          tokenMint: `${config.collection_address}#${transfer.tokenId}`,
          tokenName: `${config.collection_name} #${transfer.tokenId}`,
          fromWallet: transfer.from,
          toWallet: transfer.to,
          txSignature: `${log.transactionHash}:${log.index}:${transfer.tokenId}`,
          eventTime,
          source: 'evm-rpc',
          blockNumber: log.blockNumber,
          logIndex: log.index,
          amount: transfer.amount,
          nftStandard: standard,
        }, 'evm-rpc');
        if (result?.success) processed += 1;
      }
    }
    saveCursor(config.guild_id, chain.chainId, 'nft', config.id, range.toBlock);
    return { processed, fromBlock: range.fromBlock, toBlock: range.toBlock };
  }

  async pollNativeWallets(guildId, chainId, walletRows) {
    const chain = getChain(chainId);
    if (!chain || chain.family !== 'evm' || !walletRows.length) return { processed: 0 };
    const provider = evmService.getProvider(chain.chainId);
    const safeHead = await getSafeHead(provider);
    const cursor = getCursor(guildId, chain.chainId, 'wallet-chain', 0);
    if (!cursor) {
      saveCursor(guildId, chain.chainId, 'wallet-chain', 0, safeHead);
      return { initialized: true, processed: 0 };
    }
    const range = getPollRange(cursor, safeHead, WALLET_BLOCK_SPAN);
    if (!range) return { processed: 0 };
    const wallets = new Map(walletRows.map(row => [normalizeEvmKey(row.wallet_address), row]));
    let processed = 0;
    for (let blockNumber = range.fromBlock; blockNumber <= range.toBlock; blockNumber += 1) {
      const block = await provider.getBlock(blockNumber, true);
      if (!block) continue;
      let transactions = [];
      try { transactions = block.prefetchedTransactions; } catch (_error) {}
      if (!transactions.length && Array.isArray(block.transactions)) {
        transactions = (await Promise.all(block.transactions.map(hash => provider.getTransaction(hash).catch(() => null)))).filter(Boolean);
      }
      for (const tx of transactions) {
        const from = normalizeEvmKey(tx.from);
        const to = normalizeEvmKey(tx.to);
        const matches = [];
        if (wallets.has(from)) matches.push(wallets.get(from));
        if (wallets.has(to) && to !== from) matches.push(wallets.get(to));
        if (!matches.length) continue;
        const amount = formatEther(tx.value || 0n);
        for (const walletRow of matches) {
          await trackedWalletsService.sendWalletAlert({
            walletRow,
            guildId,
            evt: { chainId: chain.chainId, eventType: 'transfer', from_wallet: tx.from, to_wallet: tx.to, txSignature: tx.hash },
            typeIcon: '↔️',
            priceDisplay: `${amount} ${chain.nativeSymbol}`,
            chain: chain.name.toLowerCase(),
          });
          processed += 1;
          if (processed >= MAX_ALERTS_PER_POLL) break;
        }
        if (processed >= MAX_ALERTS_PER_POLL) break;
      }
      if (processed >= MAX_ALERTS_PER_POLL) break;
    }
    saveCursor(guildId, chain.chainId, 'wallet-chain', 0, range.toBlock);
    return { processed, fromBlock: range.fromBlock, toBlock: range.toBlock };
  }

  async pollAll() {
    if (this.polling) return { skipped: true, reason: 'already_running' };
    this.polling = true;
    const summary = { tokens: 0, nft: 0, wallets: 0, errors: [] };
    try {
      const tokenConfigs = db.prepare("SELECT * FROM tracked_tokens WHERE enabled = 1 AND chain_family = 'evm'").all();
      const collectionConfigs = db.prepare("SELECT * FROM nft_tracked_collections WHERE enabled = 1 AND chain_family = 'evm'").all();
      const walletRows = db.prepare("SELECT * FROM tracked_wallets WHERE enabled = 1 AND chain_family = 'evm'").all();

      for (const config of tokenConfigs) {
        if (!getEvmRpcUrl(config.chain_id)) continue;
        try { summary.tokens += Number((await this.pollToken(config)).processed || 0); }
        catch (error) {
          saveCursor(config.guild_id, config.chain_id, 'token', config.id, Number(getCursor(config.guild_id, config.chain_id, 'token', config.id)?.last_block || 0), error?.message);
          summary.errors.push(`token:${config.id}:${error?.message || error}`);
        }
      }
      for (const config of collectionConfigs) {
        if (!getEvmRpcUrl(config.chain_id)) continue;
        try { summary.nft += Number((await this.pollCollection(config)).processed || 0); }
        catch (error) {
          saveCursor(config.guild_id, config.chain_id, 'nft', config.id, Number(getCursor(config.guild_id, config.chain_id, 'nft', config.id)?.last_block || 0), error?.message);
          summary.errors.push(`nft:${config.id}:${error?.message || error}`);
        }
      }
      const walletGroups = new Map();
      for (const row of walletRows) {
        const key = `${row.guild_id}\u0000${row.chain_id}`;
        if (!walletGroups.has(key)) walletGroups.set(key, []);
        walletGroups.get(key).push(row);
      }
      for (const rows of walletGroups.values()) {
        if (!getEvmRpcUrl(rows[0].chain_id)) continue;
        try { summary.wallets += Number((await this.pollNativeWallets(rows[0].guild_id, rows[0].chain_id, rows)).processed || 0); }
        catch (error) { summary.errors.push(`wallet:${rows[0].chain_id}:${error?.message || error}`); }
      }
      if (summary.tokens || summary.nft || summary.wallets || summary.errors.length) {
        logger.log(`[evm-tracker] tokens=${summary.tokens} nft=${summary.nft} wallets=${summary.wallets} errors=${summary.errors.length}`);
      }
      return summary;
    } finally {
      this.polling = false;
    }
  }
}

module.exports = new EvmTrackerService();
