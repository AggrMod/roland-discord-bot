const { success, error } = require('../../utils/apiResponse');

function toSuccessResponse(payload, meta = null) {
  const envelope = success(payload, meta);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return envelope;
  }

  const legacy = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'success' || key === 'error' || key === 'data' || key === 'meta') continue;
    legacy[key] = value;
  }

  return {
    ...legacy,
    ...envelope,
  };
}

function toErrorResponse(message, code = 'INTERNAL_ERROR', details = null, legacy = null) {
  const envelope = error(message, code, details);
  const base = legacy && typeof legacy === 'object' ? legacy : {};
  return {
    ...base,
    message,
    ...envelope,
  };
}

module.exports = {
  toSuccessResponse,
  toErrorResponse,
};
