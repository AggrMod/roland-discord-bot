const {
  Contract,
  JsonRpcProvider,
  formatEther,
  formatUnits,
  getAddress,
  verifyMessage,
} = require('ethers');
const logger = require('../utils/logger');
const { getChain, getEvmRpcUrl, normalizeAddress } = require('../utils/chainIdentity');

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];
const ERC721_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];
const ERC1155_ABI = ['function balanceOf(address owner, uint256 id) view returns (uint256)'];

class EvmService {
  constructor() {
    this.providers = new Map();
  }

  getProvider(chainValue) {
    const chain = getChain(chainValue, { allowCustomEvm: true });
    if (!chain || chain.family !== 'evm') throw new Error('Unsupported EVM chain');
    const rpcUrl = getEvmRpcUrl(chain.chainId);
    if (!rpcUrl) throw new Error(`${chain.name} RPC is not configured`);
    const cacheKey = `${chain.chainId}:${rpcUrl}`;
    if (!this.providers.has(cacheKey)) {
      this.providers.set(cacheKey, new JsonRpcProvider(rpcUrl, chain.numericChainId, { staticNetwork: true }));
    }
    return this.providers.get(cacheKey);
  }

  verifyWalletSignature({ address, message, signature }) {
    try {
      const normalizedAddress = normalizeAddress(address, 'eip155:1');
      if (!normalizedAddress || !message || !signature) return false;
      return getAddress(verifyMessage(String(message), String(signature))) === normalizedAddress;
    } catch (_error) {
      return false;
    }
  }

  async getNativeBalance(address, chainValue) {
    const chain = getChain(chainValue);
    const normalizedAddress = normalizeAddress(address, chain?.chainId);
    if (!chain || chain.family !== 'evm' || !normalizedAddress) throw new Error('Invalid EVM wallet or chain');
    const balance = await this.getProvider(chain.chainId).getBalance(normalizedAddress);
    return { raw: balance.toString(), formatted: formatEther(balance), symbol: chain.nativeSymbol, chainId: chain.chainId };
  }

  async getTokenBalance(address, tokenAddress, chainValue) {
    const chain = getChain(chainValue);
    const owner = normalizeAddress(address, chain?.chainId);
    const token = normalizeAddress(tokenAddress, chain?.chainId);
    if (!chain || chain.family !== 'evm' || !owner || !token) throw new Error('Invalid EVM wallet, token, or chain');
    const contract = new Contract(token, ERC20_ABI, this.getProvider(chain.chainId));
    const [raw, decimals, symbol, name] = await Promise.all([
      contract.balanceOf(owner),
      contract.decimals().catch(() => 18),
      contract.symbol().catch(() => 'TOKEN'),
      contract.name().catch(() => 'Token'),
    ]);
    return {
      raw: raw.toString(),
      formatted: formatUnits(raw, Number(decimals)),
      decimals: Number(decimals),
      symbol: String(symbol),
      name: String(name),
      tokenAddress: token,
      chainId: chain.chainId,
    };
  }

  async getTokenMetadata(tokenAddress, chainValue) {
    const chain = getChain(chainValue);
    const token = normalizeAddress(tokenAddress, chain?.chainId);
    if (!chain || chain.family !== 'evm' || !token) throw new Error('Invalid EVM token or chain');
    const contract = new Contract(token, ERC20_ABI, this.getProvider(chain.chainId));
    const [decimals, symbol, name] = await Promise.all([
      contract.decimals().catch(() => 18),
      contract.symbol().catch(() => 'TOKEN'),
      contract.name().catch(() => 'Token'),
    ]);
    return { decimals: Number(decimals), symbol: String(symbol), name: String(name), tokenAddress: token, chainId: chain.chainId };
  }

  async getNftBalance(address, collectionAddress, chainValue, { standard = 'erc721', tokenId = null } = {}) {
    const chain = getChain(chainValue);
    const owner = normalizeAddress(address, chain?.chainId);
    const collection = normalizeAddress(collectionAddress, chain?.chainId);
    if (!chain || chain.family !== 'evm' || !owner || !collection) throw new Error('Invalid EVM wallet, collection, or chain');
    const provider = this.getProvider(chain.chainId);
    if (String(standard).toLowerCase() === 'erc1155') {
      if (tokenId === null || tokenId === undefined || tokenId === '') throw new Error('ERC-1155 token ID is required');
      const balance = await new Contract(collection, ERC1155_ABI, provider).balanceOf(owner, tokenId);
      return { balance: balance.toString(), standard: 'erc1155', tokenId: String(tokenId), collectionAddress: collection, chainId: chain.chainId };
    }
    const contract = new Contract(collection, ERC721_ABI, provider);
    if (tokenId !== null && tokenId !== undefined && tokenId !== '') {
      const holder = await contract.ownerOf(tokenId);
      return { balance: getAddress(holder) === owner ? '1' : '0', standard: 'erc721', tokenId: String(tokenId), collectionAddress: collection, chainId: chain.chainId };
    }
    const balance = await contract.balanceOf(owner);
    return { balance: balance.toString(), standard: 'erc721', tokenId: null, collectionAddress: collection, chainId: chain.chainId };
  }

  async getNftCollectionMetadata(collectionAddress, chainValue) {
    const chain = getChain(chainValue);
    const collection = normalizeAddress(collectionAddress, chain?.chainId);
    if (!chain || chain.family !== 'evm' || !collection) throw new Error('Invalid EVM collection or chain');
    const contract = new Contract(collection, ERC721_ABI, this.getProvider(chain.chainId));
    const [name, symbol] = await Promise.all([
      contract.name().catch(() => ''),
      contract.symbol().catch(() => ''),
    ]);
    return {
      name: String(name || '').trim() || null,
      symbol: String(symbol || '').trim() || null,
      collectionAddress: collection,
      chainId: chain.chainId,
    };
  }

  clearProviderCache() {
    this.providers.clear();
    logger.log('[evm] provider cache cleared');
  }
}

module.exports = new EvmService();
