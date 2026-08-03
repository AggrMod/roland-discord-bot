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
const ALCHEMY_SALES_TIMEOUT_MS = Math.max(3000, Math.min(60000, Number(process.env.ALCHEMY_NFT_SALES_TIMEOUT_MS || 15000)));
const ALCHEMY_SALES_MAX_PAGES = Math.max(1, Math.min(25, Number(process.env.ALCHEMY_NFT_SALES_MAX_PAGES || 10)));

function normalizeAlchemySalesEndpoint(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'eth-mainnet.g.alchemy.com') return '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length === 3 && parts[0] === 'nft' && parts[1] === 'v2' && parts[2]) {
      parsed.pathname = `/nft/v2/${parts[2]}/getNFTSales`;
    } else if (!(parts.length === 4 && parts[0] === 'nft' && parts[1] === 'v2' && parts[2] && parts[3] === 'getNFTSales')) {
      return '';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_error) {
    return '';
  }
}

function getAlchemyEthereumSalesEndpoint() {
  const explicit = normalizeAlchemySalesEndpoint(process.env.ALCHEMY_ETHEREUM_NFT_API_URL);
  if (explicit) return explicit;
  try {
    const rpcUrl = new URL(getEvmRpcUrl('eip155:1'));
    if (rpcUrl.protocol !== 'https:' || rpcUrl.hostname.toLowerCase() !== 'eth-mainnet.g.alchemy.com') return '';
    const parts = rpcUrl.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[0] !== 'v2' || !parts[1]) return '';
    return normalizeAlchemySalesEndpoint(`${rpcUrl.origin}/nft/v2/${parts[1]}`);
  } catch (_error) {
    return '';
  }
}

function getAlchemySalePrice(sale) {
  const fees = [sale?.sellerFee, sale?.protocolFee, sale?.royaltyFee]
    .filter(fee => fee && fee.amount !== null && fee.amount !== undefined);
  if (!fees.length) return { amount: null, symbol: null };
  const decimals = Number(fees[0].decimals ?? 18);
  const symbol = String(fees[0].symbol || 'ETH').trim().toUpperCase() || 'ETH';
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return { amount: null, symbol };
  try {
    const totalRaw = fees.reduce((total, fee) => {
      const feeDecimals = Number(fee.decimals ?? decimals);
      const feeSymbol = String(fee.symbol || symbol).trim().toUpperCase();
      if (feeDecimals !== decimals || feeSymbol !== symbol) throw new Error('Mixed sale currencies are unsupported');
      return total + BigInt(String(fee.amount || '0'));
    }, 0n);
    const amount = Number(formatUnits(totalRaw, decimals));
    return { amount: Number.isFinite(amount) ? amount : null, symbol };
  } catch (_error) {
    return { amount: null, symbol };
  }
}

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

  async fetchAlchemyCollectionSales(endpoint, collectionAddress, fromBlock, toBlock) {
    const sales = [];
    let pageKey = '';
    for (let page = 0; page < ALCHEMY_SALES_MAX_PAGES; page += 1) {
      const requestUrl = new URL(endpoint);
      requestUrl.searchParams.set('contractAddress', collectionAddress);
      requestUrl.searchParams.set('fromBlock', String(fromBlock));
      requestUrl.searchParams.set('toBlock', String(toBlock));
      requestUrl.searchParams.set('order', 'asc');
      requestUrl.searchParams.set('limit', '1000');
      if (pageKey) requestUrl.searchParams.set('pageKey', pageKey);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ALCHEMY_SALES_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(requestUrl, {
          method: 'GET',
          headers: { Accept: 'application/json', 'User-Agent': 'GuildPilot-Ethereum-NFT-Sales/1.0' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!response.ok) throw new Error(`Alchemy NFT Sales request failed with status ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload?.nftSales)) throw new Error('Alchemy NFT Sales returned an invalid response');
      sales.push(...payload.nftSales);
      pageKey = String(payload.pageKey || '').trim();
      if (!pageKey) return sales;
    }
    throw new Error(`Alchemy NFT Sales exceeded ${ALCHEMY_SALES_MAX_PAGES} pages for one polling range`);
  }

  async pollCollectionSales(config) {
    if (String(config.chain_id || '') !== 'eip155:1' || Number(config.track_sale || 0) !== 1) {
      return { skipped: true, processed: 0 };
    }
    const endpoint = getAlchemyEthereumSalesEndpoint();
    if (!endpoint) return { skipped: true, reason: 'alchemy_sales_not_configured', processed: 0 };

    const provider = evmService.getProvider('eip155:1');
    const safeHead = await getSafeHead(provider);
    const cursor = getCursor(config.guild_id, 'eip155:1', 'nft-sale', config.id);
    if (!cursor) {
      saveCursor(config.guild_id, 'eip155:1', 'nft-sale', config.id, safeHead);
      return { initialized: true, processed: 0 };
    }
    const range = getPollRange(cursor, safeHead, BLOCK_SPAN);
    if (!range) return { processed: 0 };

    const sales = await this.fetchAlchemyCollectionSales(
      endpoint,
      config.collection_address,
      range.fromBlock,
      range.toBlock
    );
    const configuredTokenId = config.token_id === null || config.token_id === undefined || config.token_id === ''
      ? null
      : String(config.token_id);
    let processed = 0;
    for (const sale of sales) {
      const tokenId = sale?.tokenId === null || sale?.tokenId === undefined ? '' : String(sale.tokenId);
      if (!tokenId || (configuredTokenId !== null && tokenId !== configuredTokenId)) continue;
      const transactionHash = String(sale.transactionHash || '').trim();
      if (!transactionHash) continue;
      const blockNumber = Number(sale.blockNumber);
      const logIndex = Number(sale.logIndex ?? 0);
      const bundleIndex = Number(sale.bundleIndex ?? 0);
      const price = getAlchemySalePrice(sale);
      const eventTime = Number.isFinite(blockNumber)
        ? await this.getBlockTime(provider, 'eip155:1', blockNumber)
        : new Date().toISOString();
      const result = nftActivityService.ingestEvent({
        type: 'NFT_SALE',
        chainId: 'eip155:1',
        collectionKey: config.collection_address,
        tokenMint: `${config.collection_address}#${tokenId}`,
        tokenName: `${config.collection_name} #${tokenId}`,
        fromWallet: sale.sellerAddress || null,
        toWallet: sale.buyerAddress || null,
        price: price.amount,
        currencySymbol: price.symbol,
        txSignature: `${transactionHash}:${logIndex}:${bundleIndex}:${tokenId}`,
        eventTime,
        source: 'alchemy-nft-sales',
        marketplace: sale.marketplace || null,
        quantity: sale.quantity || '1',
        blockNumber,
        logIndex,
        bundleIndex,
      }, 'alchemy-nft-sales');
      if (result?.success) processed += 1;
    }
    saveCursor(config.guild_id, 'eip155:1', 'nft-sale', config.id, range.toBlock);
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
    const summary = { tokens: 0, nft: 0, sales: 0, wallets: 0, errors: [] };
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
        if (Number(config.track_mint || 0) === 1 || Number(config.track_transfer || 0) === 1) {
          try { summary.nft += Number((await this.pollCollection(config)).processed || 0); }
          catch (error) {
            saveCursor(config.guild_id, config.chain_id, 'nft', config.id, Number(getCursor(config.guild_id, config.chain_id, 'nft', config.id)?.last_block || 0), error?.message);
            summary.errors.push(`nft:${config.id}:${error?.message || error}`);
          }
        }
        if (String(config.chain_id) === 'eip155:1' && Number(config.track_sale || 0) === 1) {
          try { summary.sales += Number((await this.pollCollectionSales(config)).processed || 0); }
          catch (error) {
            saveCursor(config.guild_id, config.chain_id, 'nft-sale', config.id, Number(getCursor(config.guild_id, config.chain_id, 'nft-sale', config.id)?.last_block || 0), error?.message);
            summary.errors.push(`nft-sale:${config.id}:${error?.message || error}`);
          }
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
      if (summary.tokens || summary.nft || summary.sales || summary.wallets || summary.errors.length) {
        logger.log(`[evm-tracker] tokens=${summary.tokens} nft=${summary.nft} sales=${summary.sales} wallets=${summary.wallets} errors=${summary.errors.length}`);
      }
      return summary;
    } finally {
      this.polling = false;
    }
  }
}

module.exports = new EvmTrackerService();
module.exports.getAlchemyEthereumSalesEndpoint = getAlchemyEthereumSalesEndpoint;
module.exports.getAlchemySalePrice = getAlchemySalePrice;
