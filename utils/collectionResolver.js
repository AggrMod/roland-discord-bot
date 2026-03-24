const logger = require('./logger');

/**
 * Solana address validation pattern
 * Base58 characters, typically 32-44 characters for Solana addresses
 */
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Resolve collection input to a canonical format
 * 
 * @param {string} input - User input (slug or address/mint)
 * @returns {Object} Resolved collection data:
 *   - key: Internal storage key
 *   - label: Human-readable display label
 *   - type: 'slug' or 'address'
 *   - original: Original input value
 */
function resolveCollectionInput(input) {
  if (!input || typeof input !== 'string' || input.trim().length < 3) {
    throw new Error('Collection input must be at least 3 characters');
  }

  const trimmed = input.trim();
  
  // Check if input looks like a Solana address
  if (SOLANA_ADDRESS_PATTERN.test(trimmed)) {
    // Treat as address/mint
    return {
      key: `addr:${trimmed}`,  // Prefix to distinguish from slugs
      label: `${trimmed.slice(0, 8)}...${trimmed.slice(-8)}`,
      type: 'address',
      original: trimmed,
      address: trimmed
    };
  }
  
  // Treat as human-readable slug
  // Normalize slug to lowercase for consistency
  const normalizedSlug = trimmed.toLowerCase().replace(/\s+/g, '-');
  
  return {
    key: normalizedSlug,
    label: trimmed,
    type: 'slug',
    original: trimmed,
    slug: normalizedSlug
  };
}

/**
 * Validate Solana address format
 * 
 * @param {string} address - Address to validate
 * @returns {boolean} True if valid format
 */
function isValidSolanaAddress(address) {
  if (!address || typeof address !== 'string') {
    return false;
  }
  return SOLANA_ADDRESS_PATTERN.test(address.trim());
}

/**
 * Extract display info from collection data
 * Handles both new format (with type) and legacy format
 * 
 * @param {Object} collection - Collection object from config
 * @returns {Object} Display info with type indicator
 */
function getCollectionDisplayInfo(collection) {
  if (!collection) {
    return null;
  }

  // Check if this is an address-based collection
  if (collection.id && collection.id.startsWith('addr:')) {
    const address = collection.id.substring(5); // Remove 'addr:' prefix
    return {
      type: 'address',
      displayName: collection.name || `${address.slice(0, 8)}...${address.slice(-8)}`,
      identifier: address,
      typeIcon: '🔑'
    };
  }

  // Token-based (legacy special case)
  if (collection.id && collection.id.startsWith('token:')) {
    const tokenId = collection.id.substring(6);
    return {
      type: 'token',
      displayName: collection.name || tokenId,
      identifier: tokenId,
      typeIcon: '💰'
    };
  }

  // Slug-based (default)
  return {
    type: 'slug',
    displayName: collection.name || collection.id,
    identifier: collection.id,
    typeIcon: '📦'
  };
}

/**
 * Format collection for admin display
 * 
 * @param {Object} collection - Collection config object
 * @returns {string} Formatted display string
 */
function formatCollectionForDisplay(collection) {
  const info = getCollectionDisplayInfo(collection);
  if (!info) {
    return '_Unknown collection_';
  }

  const status = collection.roleId ? '✅' : '⚠️';
  const roleInfo = collection.roleId ? `<@&${collection.roleId}>` : '_No role assigned_';
  const enabledStatus = collection.enabled !== false ? '' : ' (disabled)';
  const typeIndicator = info.type === 'address' ? ' 🔑' : info.type === 'token' ? ' 💰' : '';
  
  return `${status} **${info.displayName}**${typeIndicator} → ${roleInfo}${enabledStatus}`;
}

module.exports = {
  resolveCollectionInput,
  isValidSolanaAddress,
  getCollectionDisplayInfo,
  formatCollectionForDisplay,
  SOLANA_ADDRESS_PATTERN
};
