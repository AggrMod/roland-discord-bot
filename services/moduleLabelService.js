const tenantService = require('./tenantService');
const { getModuleDisplayName: getDefaultModuleDisplayName } = require('../config/moduleMetadata');

function normalizeModuleKey(value) {
  return String(value || '').trim().toLowerCase();
}

function getModuleDisplayName(moduleKey, guildId = '') {
  const normalizedModule = normalizeModuleKey(moduleKey);
  const fallback = getDefaultModuleDisplayName(normalizedModule || moduleKey || 'Module');

  if (!normalizedModule || !guildId) {
    return fallback;
  }

  try {
    const context = tenantService.getTenantContext(guildId);
    const brandingEnabled = !!context?.modules?.branding;
    if ((normalizedModule === 'heist' || normalizedModule === 'missions') && brandingEnabled) {
      const custom = String(context?.branding?.missions_label || '').trim();
      if (custom) return custom;
    }
  } catch (_error) {
    // Fall back to static module name on any tenant lookup issue.
  }

  return fallback;
}

module.exports = {
  getModuleDisplayName,
};

