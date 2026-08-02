const { PublicKey } = require('@solana/web3.js');
const { getAddress, isAddress } = require('ethers');

const SOLANA_MAINNET = Object.freeze({
  family: 'solana',
  chainId: 'solana:mainnet',
  name: 'Solana',
  nativeSymbol: 'SOL',
});

const EVM_NETWORKS = Object.freeze({
  'eip155:1': { family: 'evm', chainId: 'eip155:1', numericChainId: 1, hexChainId: '0x1', name: 'Ethereum', nativeSymbol: 'ETH', rpcEnv: 'EVM_ETHEREUM_RPC_URL', explorerBase: 'https://etherscan.io' },
  'eip155:8453': { family: 'evm', chainId: 'eip155:8453', numericChainId: 8453, hexChainId: '0x2105', name: 'Base', nativeSymbol: 'ETH', rpcEnv: 'EVM_BASE_RPC_URL', explorerBase: 'https://basescan.org' },
  'eip155:137': { family: 'evm', chainId: 'eip155:137', numericChainId: 137, hexChainId: '0x89', name: 'Polygon', nativeSymbol: 'POL', rpcEnv: 'EVM_POLYGON_RPC_URL', explorerBase: 'https://polygonscan.com' },
  'eip155:42161': { family: 'evm', chainId: 'eip155:42161', numericChainId: 42161, hexChainId: '0xa4b1', name: 'Arbitrum One', nativeSymbol: 'ETH', rpcEnv: 'EVM_ARBITRUM_RPC_URL', explorerBase: 'https://arbiscan.io' },
  'eip155:10': { family: 'evm', chainId: 'eip155:10', numericChainId: 10, hexChainId: '0xa', name: 'Optimism', nativeSymbol: 'ETH', rpcEnv: 'EVM_OPTIMISM_RPC_URL', explorerBase: 'https://optimistic.etherscan.io' },
});

const CHAIN_ALIASES = Object.freeze({
  solana: 'solana:mainnet',
  'solana-mainnet': 'solana:mainnet',
  ethereum: 'eip155:1',
  eth: 'eip155:1',
  mainnet: 'eip155:1',
  base: 'eip155:8453',
  polygon: 'eip155:137',
  matic: 'eip155:137',
  arbitrum: 'eip155:42161',
  'arbitrum-one': 'eip155:42161',
  optimism: 'eip155:10',
  op: 'eip155:10',
});

function normalizeChainId(value, fallback = 'solana:mainnet') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (CHAIN_ALIASES[raw]) return CHAIN_ALIASES[raw];
  if (raw === 'solana:mainnet') return raw;
  if (/^eip155:[1-9]\d{0,9}$/.test(raw)) return raw;
  if (/^[1-9]\d{0,9}$/.test(raw)) return `eip155:${Number(raw)}`;
  if (/^0x[0-9a-f]+$/.test(raw)) return `eip155:${parseInt(raw, 16)}`;
  return '';
}

function getChain(value, { allowCustomEvm = false } = {}) {
  const chainId = normalizeChainId(value);
  if (chainId === SOLANA_MAINNET.chainId) return SOLANA_MAINNET;
  if (EVM_NETWORKS[chainId]) return EVM_NETWORKS[chainId];
  if (allowCustomEvm && /^eip155:[1-9]\d{0,9}$/.test(chainId)) {
    const numericChainId = Number(chainId.split(':')[1]);
    return { family: 'evm', chainId, numericChainId, hexChainId: `0x${numericChainId.toString(16)}`, name: `EVM ${numericChainId}`, nativeSymbol: 'ETH', rpcEnv: null };
  }
  return null;
}

function normalizeAddress(value, chainValue = 'solana:mainnet') {
  const chain = getChain(chainValue, { allowCustomEvm: true });
  const raw = String(value || '').trim();
  if (!chain || !raw) return '';
  if (chain.family === 'evm') {
    if (!isAddress(raw)) return '';
    return getAddress(raw);
  }
  try {
    const publicKey = new PublicKey(raw);
    return publicKey.toBase58() === raw ? raw : '';
  } catch (_error) {
    return '';
  }
}

function addressLookupKey(value, chainValue = 'solana:mainnet') {
  const chain = getChain(chainValue, { allowCustomEvm: true });
  const normalized = normalizeAddress(value, chainValue);
  if (!chain || !normalized) return '';
  return chain.family === 'evm' ? normalized.toLowerCase() : normalized;
}

function getEvmRpcUrl(chainValue) {
  const chain = getChain(chainValue, { allowCustomEvm: true });
  if (!chain || chain.family !== 'evm') return '';
  if (chain.rpcEnv) return String(process.env[chain.rpcEnv] || '').trim();
  const custom = String(process.env.EVM_CUSTOM_RPC_URLS_JSON || '').trim();
  if (!custom) return '';
  try {
    const entries = JSON.parse(custom);
    return String(entries?.[chain.chainId] || entries?.[String(chain.numericChainId)] || '').trim();
  } catch (_error) {
    return '';
  }
}

function listSupportedChains() {
  return [SOLANA_MAINNET, ...Object.values(EVM_NETWORKS)].map(chain => ({ ...chain }));
}

function getExplorerUrl(chainValue, type, value) {
  const chain = getChain(chainValue, { allowCustomEvm: true });
  const normalizedValue = String(value || '').trim();
  if (!chain || !normalizedValue) return '';
  if (chain.family === 'solana') {
    const path = type === 'tx' ? 'tx' : type === 'token' ? 'token' : 'account';
    return `https://solscan.io/${path}/${encodeURIComponent(normalizedValue)}`;
  }
  if (!chain.explorerBase) return '';
  const path = type === 'tx' ? 'tx' : type === 'token' ? 'token' : 'address';
  return `${chain.explorerBase}/${path}/${encodeURIComponent(normalizedValue.split(':')[0])}`;
}

module.exports = {
  SOLANA_MAINNET,
  EVM_NETWORKS,
  normalizeChainId,
  getChain,
  normalizeAddress,
  addressLookupKey,
  getEvmRpcUrl,
  getExplorerUrl,
  listSupportedChains,
};
