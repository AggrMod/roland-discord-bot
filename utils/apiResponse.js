/**
 * Standardized API Response Envelope
 * 
 * Ensures consistent response shape across all public API endpoints
 */

const API_VERSION = '1.0.0';

/**
 * Success response envelope
 * @param {Object|Array} data - Response data
 * @param {Object} meta - Optional metadata (pagination, timestamps, etc.)
 * @returns {Object} Standardized success response
 */
function success(data, meta = null) {
  const response = {
    success: true,
    data,
    error: null
  };

  if (meta) {
    response.meta = {
      ...meta,
      version: API_VERSION,
      timestamp: new Date().toISOString()
    };
  } else {
    response.meta = {
      version: API_VERSION,
      timestamp: new Date().toISOString()
    };
  }

  return response;
}

/**
 * Error response envelope
 * @param {String} message - Error message
 * @param {String} code - Error code (optional)
 * @param {Object} details - Additional error details (optional)
 * @returns {Object} Standardized error response
 */
function error(message, code = 'INTERNAL_ERROR', details = null) {
  return {
    success: false,
    data: null,
    error: {
      message,
      code,
      details
    },
    meta: {
      version: API_VERSION,
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * Pagination metadata helper
 * @param {Number} total - Total items
 * @param {Number} page - Current page
 * @param {Number} limit - Items per page
 * @returns {Object} Pagination metadata
 */
function paginationMeta(total, page, limit) {
  return {
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
}

/**
 * Sanitize sensitive fields from objects
 * @param {Object} obj - Object to sanitize
 * @param {Array} sensitiveFields - Fields to remove/redact
 * @returns {Object} Sanitized object
 */
function sanitize(obj, sensitiveFields = []) {
  if (!obj) return obj;
  
  const sanitized = { ...obj };
  
  // Default sensitive fields
  const defaultSensitive = [
    'password',
    'access_token',
    'refresh_token',
    'session_id',
    'secret',
    'private_key'
  ];
  
  const allSensitive = [...defaultSensitive, ...sensitiveFields];
  
  allSensitive.forEach(field => {
    if (field in sanitized) {
      delete sanitized[field];
    }
  });
  
  return sanitized;
}

/**
 * Redact sensitive wallet addresses (show first 4 and last 4 chars)
 * @param {String} address - Wallet address
 * @returns {String} Redacted address
 */
function redactWallet(address) {
  if (!address || address.length < 12) return address;
  return `${address.substring(0, 4)}...${address.substring(address.length - 4)}`;
}

module.exports = {
  success,
  error,
  paginationMeta,
  sanitize,
  redactWallet,
  API_VERSION
};
