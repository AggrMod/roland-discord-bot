/**
 * API Error Handling Middleware
 * 
 * Provides consistent error handling and logging for API endpoints
 */

const logger = require('./logger');
const { error } = require('./apiResponse');

/**
 * Error codes mapping
 */
const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RESOURCE_CONFLICT: 'RESOURCE_CONFLICT'
};

/**
 * HTTP status to error code mapping
 */
const statusToCode = {
  400: ErrorCodes.BAD_REQUEST,
  401: ErrorCodes.UNAUTHORIZED,
  403: ErrorCodes.FORBIDDEN,
  404: ErrorCodes.NOT_FOUND,
  409: ErrorCodes.RESOURCE_CONFLICT,
  500: ErrorCodes.INTERNAL_ERROR
};

/**
 * Async route wrapper to catch errors
 * @param {Function} fn - Route handler function
 * @returns {Function} Wrapped route handler
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Global error handler middleware
 * Should be registered last in the middleware chain
 */
function errorHandler(err, req, res, next) {
  // Log error details
  logger.error(`API Error: ${req.method} ${req.path}`, err);

  // Determine status code
  const statusCode = err.statusCode || err.status || 500;
  
  // Determine error code
  const code = err.code || statusToCode[statusCode] || ErrorCodes.INTERNAL_ERROR;

  // Build error response
  const errorResponse = error(
    err.message || 'An unexpected error occurred',
    code,
    process.env.NODE_ENV === 'development' ? { stack: err.stack } : null
  );

  res.status(statusCode).json(errorResponse);
}

/**
 * 404 Not Found handler
 */
function notFoundHandler(req, res) {
  res.status(404).json(error(
    `Route not found: ${req.method} ${req.path}`,
    ErrorCodes.NOT_FOUND
  ));
}

/**
 * Validation error helper
 * @param {String} message - Validation error message
 * @param {Object} details - Validation details
 * @throws {Error} Validation error
 */
function validationError(message, details = null) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = ErrorCodes.VALIDATION_ERROR;
  err.details = details;
  throw err;
}

/**
 * Not found error helper
 * @param {String} resource - Resource name
 * @throws {Error} Not found error
 */
function notFoundError(resource) {
  const err = new Error(`${resource} not found`);
  err.statusCode = 404;
  err.code = ErrorCodes.NOT_FOUND;
  throw err;
}

/**
 * Unauthorized error helper
 * @param {String} message - Error message
 * @throws {Error} Unauthorized error
 */
function unauthorizedError(message = 'Authentication required') {
  const err = new Error(message);
  err.statusCode = 401;
  err.code = ErrorCodes.UNAUTHORIZED;
  throw err;
}

/**
 * Forbidden error helper
 * @param {String} message - Error message
 * @throws {Error} Forbidden error
 */
function forbiddenError(message = 'Access forbidden') {
  const err = new Error(message);
  err.statusCode = 403;
  err.code = ErrorCodes.FORBIDDEN;
  throw err;
}

module.exports = {
  ErrorCodes,
  asyncHandler,
  errorHandler,
  notFoundHandler,
  validationError,
  notFoundError,
  unauthorizedError,
  forbiddenError
};
