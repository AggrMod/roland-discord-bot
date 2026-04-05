const { REST, Routes, Colors } = require('discord.js');
const db = require('../database/db');
const logger = require('../utils/logger');
const moduleGuard = require('../utils/moduleGuard');
const { getCommandModuleKey } = require('../config/commandModules');
const {
  getDefaultPlanKey,
  getModuleKeys,
  getPlanKeys,
  getPlanPreset,
  normalizePlanKey
} = require('../config/plans');

const MULTITENANT_ENABLED = process.env.MULTITENANT_ENABLED === 'true';
const TENANT_STATUSES = new Set(['active', 'suspended']);
const ALL_MODULE_KEYS = getModuleKeys();
const BRANDING_COLOR_KEYS = new Set([
  'brand_color',
  'primary_color',
  'secondary_color',
  'ticketing_color',
  'selfserve_color',
  'nfttracker_color'
]);
const DISCORD_COLOR_NAME_LOOKUP = (() => {
  const map = Object.create(null);
  for (const [name, value] of Object.entries(Colors || {})) {
    const lower = String(name || '').toLowerCase();
    if (!lower) continue;
    map[lower] = value;
    map[lower.replace(/[\s_-]+/g, '')] = value;
  }
  return map;
})();

function normalizeGuildId(guildId) {
  if (typeof guildId !== 'string') return '';
  const trimmed = guildId.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : '';
}

function normalizeString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeBrandingUrl(value, { allowRelative = false } = {}) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  if (normalized.length > 2048) {
    return null;
  }

  if (allowRelative && normalized.startsWith('/') && !normalized.startsWith('//')) {
    return normalized;
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_error) {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }

  return parsed.toString();
}

function toHexColor(value) {
  if (!Number.isFinite(value)) return null;
  if (value < 0 || value > 0xFFFFFF) return null;
  return `#${Number(value).toString(16).padStart(6, '0').toUpperCase()}`;
}

function normalizeBrandingColor(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;

  const withoutHash = normalized.startsWith('#') ? normalized.slice(1) : normalized;
  if (/^[0-9a-f]{3}$/i.test(withoutHash) || /^[0-9a-f]{6}$/i.test(withoutHash)) {
    return `#${withoutHash.toUpperCase()}`;
  }

  if (/^\d+$/.test(normalized)) {
    const numericHex = toHexColor(Number(normalized));
    if (numericHex) return numericHex;
  }

  if (/^0x[0-9a-f]+$/i.test(normalized)) {
    const numericHex = toHexColor(Number.parseInt(normalized, 16));
    if (numericHex) return numericHex;
  }

  const colorKey = normalized.toLowerCase();
  const compactKey = colorKey.replace(/[\s_-]+/g, '');
  const namedValue = DISCORD_COLOR_NAME_LOOKUP[colorKey] ?? DISCORD_COLOR_NAME_LOOKUP[compactKey];
  if (namedValue !== undefined) {
    const namedHex = toHexColor(Number(namedValue));
    if (namedHex) return namedHex;
  }

  // Unknown color text -> clear to force safe default rendering path.
  return null;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 1 || value === '1' || value === 'true' || value === 'TRUE') {
    return true;
  }

  return false;
}

function normalizeCommands(commands) {
  if (!commands) {
    return [];
  }

  if (Array.isArray(commands)) {
    return commands;
  }

  if (typeof commands.values === 'function') {
    return Array.from(commands.values());
  }

  return [];
}

function commandToPayload(command) {
  if (!command || !command.data || typeof command.data.toJSON !== 'function') {
    return null;
  }

  return command.data.toJSON();
}

function serializeJson(value) {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value);
}

class TenantService {
  constructor() {
    this.commandSource = null;
  }

  setCommandSource(commandSource) {
    this.commandSource = commandSource;
  }

  getCommandSource() {
    if (typeof this.commandSource === 'function') {
      return this.commandSource();
    }

    return this.commandSource;
  }

  isMultitenantEnabled() {
    return MULTITENANT_ENABLED;
  }

  ensureTenant(guildId, guildName = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
      return null;
    }

    const nowTenant = db.prepare('SELECT * FROM tenants WHERE guild_id = ?').get(normalizedGuildId);
    const defaultPlanKey = getDefaultPlanKey();
    const defaultPlan = getPlanPreset(defaultPlanKey);
    let created = false;

    if (!nowTenant) {
      db.prepare(`
        INSERT INTO tenants (guild_id, guild_name, plan_key, status, read_only_managed)
        VALUES (?, ?, ?, ?, 0)
      `).run(normalizedGuildId, normalizeString(guildName), defaultPlanKey, 'active');
      created = true;
    } else if (guildName && nowTenant.guild_name !== guildName) {
      db.prepare(`
        UPDATE tenants
        SET guild_name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ?
      `).run(normalizeString(guildName), normalizedGuildId);
    }

    const tenant = db.prepare('SELECT * FROM tenants WHERE guild_id = ?').get(normalizedGuildId);
    if (!tenant) {
      return null;
    }

    const tenantId = tenant.id;
    const plan = getPlanPreset(tenant.plan_key || defaultPlanKey);

    for (const moduleKey of ALL_MODULE_KEYS) {
      const defaultEnabled = plan.modules[moduleKey] === true ? 1 : 0;
      db.prepare(`
        INSERT OR IGNORE INTO tenant_modules (tenant_id, module_key, enabled)
        VALUES (?, ?, ?)
      `).run(tenantId, moduleKey, defaultEnabled);
    }

    db.prepare(`
      INSERT OR IGNORE INTO tenant_branding (tenant_id)
      VALUES (?)
    `).run(tenantId);

    db.prepare(`
      INSERT OR IGNORE INTO tenant_limits (tenant_id)
      VALUES (?)
    `).run(tenantId);

    db.prepare(`
      UPDATE tenants
      SET plan_key = COALESCE(NULLIF(plan_key, ''), ?),
          status = COALESCE(NULLIF(status, ''), 'active'),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(defaultPlanKey, tenantId);

    db.prepare(`
      UPDATE tenant_limits
      SET max_commands = COALESCE(max_commands, ?),
          max_enabled_modules = COALESCE(max_enabled_modules, ?),
          max_branding_profiles = COALESCE(max_branding_profiles, ?),
          max_read_only_overrides = COALESCE(max_read_only_overrides, ?),
          mock_data_enabled = COALESCE(mock_data_enabled, 0),
          updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ?
    `).run(
      defaultPlan.limits.max_commands,
      defaultPlan.limits.max_enabled_modules,
      defaultPlan.limits.max_branding_profiles,
      defaultPlan.limits.max_read_only_overrides,
      tenantId
    );

    if (created) {
      logger.log(`🏗️ Created tenant scaffold for ${normalizedGuildId}${guildName ? ` (${guildName})` : ''}`);
    }

    return this.getTenantContext(normalizedGuildId);
  }

  buildTenantShape(tenantRecord) {
    if (!tenantRecord) {
      return null;
    }

    const brandingRow = db.prepare('SELECT * FROM tenant_branding WHERE tenant_id = ?').get(tenantRecord.id) || null;
    const limitsRow = db.prepare('SELECT * FROM tenant_limits WHERE tenant_id = ?').get(tenantRecord.id) || null;
    const moduleRows = db.prepare(`
      SELECT module_key, enabled
      FROM tenant_modules
      WHERE tenant_id = ?
      ORDER BY module_key ASC
    `).all(tenantRecord.id);

    const modules = {};
    const enabledModules = [];
    const disabledModules = [];

    for (const row of moduleRows) {
      const enabled = row.enabled === 1;
      modules[row.module_key] = enabled;
      if (enabled) {
        enabledModules.push(row.module_key);
      } else {
        disabledModules.push(row.module_key);
      }
    }

    const planKey = normalizePlanKey(tenantRecord.plan_key || getDefaultPlanKey()) || getDefaultPlanKey();
    const plan = getPlanPreset(planKey);
    const branding = brandingRow ? {
      bot_display_name: brandingRow.bot_display_name || brandingRow.display_name || null,
      brand_emoji: brandingRow.brand_emoji || null,
      brand_color: brandingRow.brand_color || brandingRow.primary_color || null,
      logo_url: brandingRow.logo_url || brandingRow.icon_url || null,
      support_url: brandingRow.support_url || null,
      footer_text: brandingRow.footer_text || null,
      display_name: brandingRow.display_name || brandingRow.bot_display_name || null,
      primary_color: brandingRow.primary_color || brandingRow.brand_color || null,
      secondary_color: brandingRow.secondary_color || null,
      icon_url: brandingRow.icon_url || brandingRow.logo_url || null,
      ticketing_color: brandingRow.ticketing_color || null,
      selfserve_color: brandingRow.selfserve_color || null,
      nfttracker_color: brandingRow.nfttracker_color || null,
      ticket_panel_title: brandingRow.ticket_panel_title || null,
      ticket_panel_description: brandingRow.ticket_panel_description || null,
      selfserve_panel_title: brandingRow.selfserve_panel_title || null,
      selfserve_panel_description: brandingRow.selfserve_panel_description || null,
      nfttracker_panel_title: brandingRow.nfttracker_panel_title || null,
      nfttracker_panel_description: brandingRow.nfttracker_panel_description || null,
      raw: brandingRow
    } : null;

    const limits = limitsRow ? {
      ...limitsRow,
      plan_key: planKey
    } : null;

    return {
      guildId: tenantRecord.guild_id,
      guildName: tenantRecord.guild_name,
      planKey,
      planLabel: plan.label,
      planDescription: plan.description,
      status: tenantRecord.status || 'active',
      readOnlyManaged: tenantRecord.read_only_managed === 1,
      tenant: tenantRecord,
      modules,
      branding,
      limits,
      enabledModules,
      disabledModules,
      enabledModulesCount: enabledModules.length,
      totalModulesCount: ALL_MODULE_KEYS.length
    };
  }

  getTenant(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
      return null;
    }

    const tenantRecord = db.prepare('SELECT * FROM tenants WHERE guild_id = ?').get(normalizedGuildId);
    if (!tenantRecord) {
      return null;
    }

    return {
      ...this.buildTenantShape(tenantRecord),
      multiTenantEnabled: MULTITENANT_ENABLED
    };
  }

  listTenants({ q, status, page = 1, pageSize = 25 } = {}) {
    const query = normalizeString(q);
    const normalizedStatus = normalizeString(status)?.toLowerCase() || null;
    const params = [];
    const where = [];

    if (query) {
      where.push('(LOWER(t.guild_id) LIKE ? OR LOWER(COALESCE(t.guild_name, \'\')) LIKE ?)');
      params.push(`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`);
    }

    if (normalizedStatus && TENANT_STATUSES.has(normalizedStatus)) {
      where.push('LOWER(COALESCE(t.status, \'active\')) = ?');
      params.push(normalizedStatus);
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 200);
    const offset = (pageNum - 1) * sizeNum;

    const totalRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM tenants t
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    `).get(...params);
    const total = Number(totalRow?.total || 0);

    const rows = db.prepare(`
      SELECT
        t.*,
        COALESCE(SUM(CASE WHEN tm.enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled_module_count,
        COUNT(tm.id) AS module_count
      FROM tenants t
      LEFT JOIN tenant_modules tm ON tm.tenant_id = t.id
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY t.id
      ORDER BY COALESCE(t.guild_name, t.guild_id) COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `).all(...params, sizeNum, offset);

    const tenants = rows.map(row => {
      const tenant = this.buildTenantShape(row);
      return {
        ...tenant,
        enabledModulesCount: Number(row.enabled_module_count || 0),
        totalModulesCount: ALL_MODULE_KEYS.length
      };
    });

    return {
      tenants,
      pagination: {
        page: pageNum,
        pageSize: sizeNum,
        total,
        totalPages: Math.max(Math.ceil(total / sizeNum), 1)
      }
    };
  }

  getTenantContext(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
      return {
        guildId: null,
        guildName: null,
        multiTenantEnabled: MULTITENANT_ENABLED,
        readOnlyManaged: false,
        tenant: null,
        planKey: getDefaultPlanKey(),
        planLabel: getPlanPreset(getDefaultPlanKey()).label,
        planDescription: getPlanPreset(getDefaultPlanKey()).description,
        status: 'active',
        modules: {},
        branding: null,
        limits: null,
        enabledModules: [],
        disabledModules: [],
        enabledModulesCount: 0,
        totalModulesCount: ALL_MODULE_KEYS.length
      };
    }

    const tenantRecord = db.prepare('SELECT * FROM tenants WHERE guild_id = ?').get(normalizedGuildId);
    if (!tenantRecord) {
      return this.ensureTenant(normalizedGuildId);
    }

    return {
      ...this.buildTenantShape(tenantRecord),
      multiTenantEnabled: MULTITENANT_ENABLED
    };
  }

  isModuleEnabled(guildId, moduleKey) {
    if (!moduleKey) {
      return true;
    }

    if (!MULTITENANT_ENABLED) {
      return moduleGuard.isModuleEnabled(moduleKey);
    }

    const context = this.getTenantContext(guildId);
    if (!context || !context.tenant) {
      return true;
    }

    const row = db.prepare(`
      SELECT enabled
      FROM tenant_modules
      WHERE tenant_id = ? AND module_key = ?
    `).get(context.tenant.id, moduleKey);

    if (!row) {
      return true;
    }

    return row.enabled === 1;
  }

  logAudit(guildId, actorId, action, beforeValue, afterValue) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
      return null;
    }

    db.prepare(`
      INSERT INTO tenant_audit_logs (guild_id, actor_id, action, before_json, after_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      normalizedGuildId,
      normalizeString(actorId),
      action,
      serializeJson(beforeValue),
      serializeJson(afterValue)
    );

    return true;
  }

  applyPlanBundle(guildId, planKey) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedPlanKey = normalizePlanKey(planKey);
    const plan = getPlanPreset(normalizedPlanKey);

    if (!normalizedGuildId) {
      return { success: false, message: 'guildId is required' };
    }

    if (!getPlanKeys().includes(normalizedPlanKey)) {
      return { success: false, message: 'Invalid plan' };
    }

    const context = this.ensureTenant(normalizedGuildId);
    const tenantId = context?.tenant?.id;

    if (!tenantId) {
      return { success: false, message: 'Tenant not found' };
    }

    db.prepare(`
      UPDATE tenants
      SET plan_key = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(normalizedPlanKey, tenantId);

    for (const moduleKey of ALL_MODULE_KEYS) {
      const enabled = plan.modules[moduleKey] === true ? 1 : 0;
      db.prepare(`
        INSERT INTO tenant_modules (tenant_id, module_key, enabled)
        VALUES (?, ?, ?)
        ON CONFLICT(tenant_id, module_key) DO UPDATE SET
          enabled = excluded.enabled,
          updated_at = CURRENT_TIMESTAMP
      `).run(tenantId, moduleKey, enabled);
    }

    db.prepare(`
      INSERT INTO tenant_limits (
        tenant_id,
        max_commands,
        max_enabled_modules,
        max_branding_profiles,
        max_read_only_overrides,
        mock_data_enabled
      )
      VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(tenant_id) DO UPDATE SET
        max_commands = excluded.max_commands,
        max_enabled_modules = excluded.max_enabled_modules,
        max_branding_profiles = excluded.max_branding_profiles,
        max_read_only_overrides = excluded.max_read_only_overrides,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      tenantId,
      plan.limits.max_commands,
      plan.limits.max_enabled_modules,
      plan.limits.max_branding_profiles,
      plan.limits.max_read_only_overrides
    );

    return this.getTenantContext(normalizedGuildId);
  }

  setTenantPlan(guildId, planKey, actorId) {
    const normalizedPlanKey = normalizePlanKey(planKey);

    if (!getPlanKeys().includes(normalizedPlanKey)) {
      return { success: false, message: 'Invalid plan' };
    }

    const before = this.getTenantContext(guildId);

    const after = this.applyPlanBundle(guildId, normalizedPlanKey);
    if (!after || !after.tenant) {
      return { success: false, message: 'Tenant not found' };
    }

    this.logAudit(guildId, actorId, 'set_plan', before, after);

    if (MULTITENANT_ENABLED) {
      this.syncGuildCommandsForGuild(guildId, after.guildName).catch(error => {
        logger.error(`Error syncing commands after plan update for ${guildId}:`, error);
      });
    }

    return {
      success: true,
      tenant: after
    };
  }

  setTenantModule(guildId, moduleKey, enabled, actorId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedModuleKey = normalizeString(moduleKey);

    if (!normalizedGuildId) {
      return { success: false, message: 'guildId is required' };
    }

    if (!normalizedModuleKey) {
      return { success: false, message: 'moduleKey is required' };
    }

    const before = this.getTenantContext(normalizedGuildId);
    const context = this.ensureTenant(normalizedGuildId);
    const tenantId = context?.tenant?.id;
    if (!tenantId) {
      return { success: false, message: 'Tenant not found' };
    }

    db.prepare(`
      INSERT INTO tenant_modules (tenant_id, module_key, enabled)
      VALUES (?, ?, ?)
      ON CONFLICT(tenant_id, module_key) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = CURRENT_TIMESTAMP
    `).run(tenantId, normalizedModuleKey, normalizeBoolean(enabled) ? 1 : 0);

    const after = this.getTenantContext(normalizedGuildId);
    this.logAudit(guildId, actorId, 'set_module', before, after);

    if (MULTITENANT_ENABLED) {
      this.syncGuildCommandsForGuild(guildId, after.guildName).catch(error => {
        logger.error(`Error syncing commands after module update for ${guildId}:`, error);
      });
    }

    return {
      success: true,
      tenant: after
    };
  }

  setTenantMockData(guildId, enabled, actorId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guild id' };

    const tenantRecord = db.prepare('SELECT * FROM tenants WHERE guild_id = ?').get(normalizedGuildId);
    if (!tenantRecord) return { success: false, message: 'Tenant not found' };

    const before = this.getTenantContext(normalizedGuildId);
    db.prepare(`
      UPDATE tenant_limits
      SET mock_data_enabled = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ?
    `).run(enabled ? 1 : 0, tenantRecord.id);

    const after = this.getTenantContext(normalizedGuildId);
    this.logAudit(
      normalizedGuildId,
      actorId,
      'tenant.mock_data.update',
      before,
      after
    );

    return { success: true, message: `Mock data ${enabled ? 'enabled' : 'disabled'}`, tenant: after };
  }

  setTenantStatus(guildId, status, actorId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedStatus = normalizeString(status)?.toLowerCase();

    if (!normalizedGuildId) {
      return { success: false, message: 'guildId is required' };
    }

    if (!TENANT_STATUSES.has(normalizedStatus)) {
      return { success: false, message: 'Invalid status' };
    }

    const before = this.getTenantContext(normalizedGuildId);
    const context = this.ensureTenant(normalizedGuildId);
    const tenantId = context?.tenant?.id;
    if (!tenantId) {
      return { success: false, message: 'Tenant not found' };
    }

    db.prepare(`
      UPDATE tenants
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(normalizedStatus, tenantId);

    const after = this.getTenantContext(normalizedGuildId);
    this.logAudit(guildId, actorId, 'set_status', before, after);

    return {
      success: true,
      tenant: after
    };
  }

  getTenantVerificationSettings(guildId) {
    try {
      const guild = String(guildId || '').trim();
      if (!guild) return { ogRoleId: null, ogRoleLimit: 0 };
      const tenantRow = this.getTenant(guild);
      if (!tenantRow) return { ogRoleId: null, ogRoleLimit: 0 };

      const row = db.prepare('SELECT og_role_id, og_role_limit FROM tenant_verification_settings WHERE tenant_id = ?').get(tenantRow.id);
      return {
        ogRoleId: row?.og_role_id || null,
        ogRoleLimit: Number(row?.og_role_limit || 0)
      };
    } catch (error) {
      logger.warn('[TenantService] getTenantVerificationSettings fallback:', error?.message || error);
      return { ogRoleId: null, ogRoleLimit: 0 };
    }
  }

  updateTenantVerificationSettings(guildId, patch = {}, actorId = 'system') {
    try {
      const guild = String(guildId || '').trim();
      if (!guild) return { success: false, message: 'guildId is required' };
      const tenantRow = this.getTenant(guild);
      if (!tenantRow) return { success: false, message: 'Tenant not found' };

      const current = this.getTenantVerificationSettings(guild);
      const next = {
        ogRoleId: patch.ogRoleId !== undefined ? (patch.ogRoleId || null) : current.ogRoleId,
        ogRoleLimit: patch.ogRoleLimit !== undefined ? Number(patch.ogRoleLimit || 0) : current.ogRoleLimit,
      };

      db.prepare(`
        INSERT INTO tenant_verification_settings (tenant_id, og_role_id, og_role_limit)
        VALUES (?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
          og_role_id = excluded.og_role_id,
          og_role_limit = excluded.og_role_limit,
          updated_at = CURRENT_TIMESTAMP
      `).run(tenantRow.id, next.ogRoleId, next.ogRoleLimit);

      this.logTenantAudit(tenantRow.id, actorId, 'verification_settings_update', {
        changed: Object.keys(patch),
        next
      });

      return { success: true, settings: next };
    } catch (error) {
      logger.error('[TenantService] updateTenantVerificationSettings failed:', error);
      return { success: false, message: 'Failed to update tenant verification settings' };
    }
  }

  updateTenantBranding(guildId, brandingPatch, actorId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
      return { success: false, message: 'guildId is required' };
    }

    const allowedKeys = [
      'bot_display_name',
      'brand_emoji',
      'brand_color',
      'logo_url',
      'support_url',
      'footer_text',
      'display_name',
      'primary_color',
      'secondary_color',
      'icon_url',
      'ticketing_color',
      'selfserve_color',
      'nfttracker_color',
      'ticket_panel_title',
      'ticket_panel_description',
      'selfserve_panel_title',
      'selfserve_panel_description',
      'nfttracker_panel_title',
      'nfttracker_panel_description'
    ];

    const patch = {};
    for (const key of allowedKeys) {
      if (brandingPatch && Object.prototype.hasOwnProperty.call(brandingPatch, key)) {
        patch[key] = normalizeString(brandingPatch[key]);
      }
    }

    for (const key of BRANDING_COLOR_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        patch[key] = normalizeBrandingColor(patch[key]);
      }
    }

    for (const key of ['logo_url', 'icon_url', 'support_url']) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) {
        continue;
      }
      if (patch[key] === null) {
        continue;
      }

      const normalizedUrl = normalizeBrandingUrl(patch[key], { allowRelative: true });
      if (!normalizedUrl) {
        return { success: false, message: `Invalid ${key}` };
      }
      patch[key] = normalizedUrl;
    }

    const before = this.getTenantContext(normalizedGuildId);
    const context = this.ensureTenant(normalizedGuildId);
    const tenantId = context?.tenant?.id;
    if (!tenantId) {
      return { success: false, message: 'Tenant not found' };
    }

    const brandingRow = db.prepare('SELECT * FROM tenant_branding WHERE tenant_id = ?').get(tenantId) || {};

    const nextBranding = {
      bot_display_name: patch.bot_display_name !== undefined ? patch.bot_display_name : (brandingRow.bot_display_name || brandingRow.display_name || null),
      brand_emoji: patch.brand_emoji !== undefined ? patch.brand_emoji : (brandingRow.brand_emoji || null),
      brand_color: patch.brand_color !== undefined ? patch.brand_color : (brandingRow.brand_color || brandingRow.primary_color || null),
      logo_url: patch.logo_url !== undefined ? patch.logo_url : (brandingRow.logo_url || brandingRow.icon_url || null),
      support_url: patch.support_url !== undefined ? patch.support_url : (brandingRow.support_url || null),
      footer_text: patch.footer_text !== undefined ? patch.footer_text : (brandingRow.footer_text || null),
      display_name: patch.display_name !== undefined ? patch.display_name : (brandingRow.display_name || brandingRow.bot_display_name || null),
      primary_color: patch.primary_color !== undefined ? patch.primary_color : (brandingRow.primary_color || brandingRow.brand_color || null),
      secondary_color: patch.secondary_color !== undefined ? patch.secondary_color : (brandingRow.secondary_color || null),
      icon_url: patch.icon_url !== undefined ? patch.icon_url : (brandingRow.icon_url || brandingRow.logo_url || null),
      ticketing_color: patch.ticketing_color !== undefined ? patch.ticketing_color : (brandingRow.ticketing_color || null),
      selfserve_color: patch.selfserve_color !== undefined ? patch.selfserve_color : (brandingRow.selfserve_color || null),
      nfttracker_color: patch.nfttracker_color !== undefined ? patch.nfttracker_color : (brandingRow.nfttracker_color || null),
      ticket_panel_title: patch.ticket_panel_title !== undefined ? patch.ticket_panel_title : (brandingRow.ticket_panel_title || null),
      ticket_panel_description: patch.ticket_panel_description !== undefined ? patch.ticket_panel_description : (brandingRow.ticket_panel_description || null),
      selfserve_panel_title: patch.selfserve_panel_title !== undefined ? patch.selfserve_panel_title : (brandingRow.selfserve_panel_title || null),
      selfserve_panel_description: patch.selfserve_panel_description !== undefined ? patch.selfserve_panel_description : (brandingRow.selfserve_panel_description || null),
      nfttracker_panel_title: patch.nfttracker_panel_title !== undefined ? patch.nfttracker_panel_title : (brandingRow.nfttracker_panel_title || null),
      nfttracker_panel_description: patch.nfttracker_panel_description !== undefined ? patch.nfttracker_panel_description : (brandingRow.nfttracker_panel_description || null)
    };

    db.prepare(`
      INSERT INTO tenant_branding (
        tenant_id,
        bot_display_name,
        brand_emoji,
        brand_color,
        display_name,
        primary_color,
        secondary_color,
        logo_url,
        icon_url,
        support_url,
        footer_text,
        ticketing_color,
        selfserve_color,
        nfttracker_color,
        ticket_panel_title,
        ticket_panel_description,
        selfserve_panel_title,
        selfserve_panel_description,
        nfttracker_panel_title,
        nfttracker_panel_description
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        bot_display_name = excluded.bot_display_name,
        brand_emoji = excluded.brand_emoji,
        brand_color = excluded.brand_color,
        display_name = excluded.display_name,
        primary_color = excluded.primary_color,
        secondary_color = excluded.secondary_color,
        logo_url = excluded.logo_url,
        icon_url = excluded.icon_url,
        support_url = excluded.support_url,
        footer_text = excluded.footer_text,
        ticketing_color = excluded.ticketing_color,
        selfserve_color = excluded.selfserve_color,
        nfttracker_color = excluded.nfttracker_color,
        ticket_panel_title = excluded.ticket_panel_title,
        ticket_panel_description = excluded.ticket_panel_description,
        selfserve_panel_title = excluded.selfserve_panel_title,
        selfserve_panel_description = excluded.selfserve_panel_description,
        nfttracker_panel_title = excluded.nfttracker_panel_title,
        nfttracker_panel_description = excluded.nfttracker_panel_description,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      tenantId,
      nextBranding.bot_display_name,
      nextBranding.brand_emoji,
      nextBranding.brand_color,
      nextBranding.display_name,
      nextBranding.primary_color,
      nextBranding.secondary_color,
      nextBranding.logo_url,
      nextBranding.icon_url,
      nextBranding.support_url,
      nextBranding.footer_text,
      nextBranding.ticketing_color,
      nextBranding.selfserve_color,
      nextBranding.nfttracker_color,
      nextBranding.ticket_panel_title,
      nextBranding.ticket_panel_description,
      nextBranding.selfserve_panel_title,
      nextBranding.selfserve_panel_description,
      nextBranding.nfttracker_panel_title,
      nextBranding.nfttracker_panel_description
    );

    const after = this.getTenantContext(normalizedGuildId);
    this.logAudit(guildId, actorId, 'update_branding', before, after);

    return {
      success: true,
      tenant: after
    };
  }

  getTenantAuditLogs(guildId, limit = 10) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
      return [];
    }

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
    return db.prepare(`
      SELECT id, guild_id, actor_id, action, before_json, after_json, created_at
      FROM tenant_audit_logs
      WHERE guild_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(normalizedGuildId, safeLimit);
  }

  async syncGuildCommands(commands, guildId, guildName = null) {
    if (!MULTITENANT_ENABLED) {
      return {
        success: true,
        skipped: true,
        message: 'Multi-tenant mode is disabled'
      };
    }

    if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
      throw new Error('DISCORD_TOKEN and CLIENT_ID are required to sync guild commands');
    }

    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
      throw new Error('guildId is required to sync guild commands');
    }

    const context = this.ensureTenant(normalizedGuildId, guildName);
    const normalized = normalizeCommands(commands);
    const payloads = [];
    const skippedCommands = [];

    for (const command of normalized) {
      const payload = commandToPayload(command);
      if (!payload) {
        continue;
      }

      const moduleKey = getCommandModuleKey(payload.name);
      if (moduleKey && !this.isModuleEnabled(normalizedGuildId, moduleKey)) {
        skippedCommands.push(payload.name);
        continue;
      }

      payloads.push(payload);
    }

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const data = await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, normalizedGuildId),
      { body: payloads }
    );

    logger.log(
      `✅ Synced ${data.length} guild commands for ${normalizedGuildId}${context?.guildName ? ` (${context.guildName})` : ''}`
    );

    if (skippedCommands.length > 0) {
      logger.log(`🚧 Skipped disabled tenant commands: ${skippedCommands.join(', ')}`);
    }

    return {
      success: true,
      guildId: normalizedGuildId,
      commandCount: data.length,
      skippedCommands
    };
  }

  async syncGuildCommandsForGuild(guildId, guildName = null) {
    const commands = this.getCommandSource();

    if (!commands) {
      logger.warn(`No command source available for tenant command sync on ${guildId}`);
      return {
        success: false,
        skipped: true,
        message: 'No command source available'
      };
    }

    return this.syncGuildCommands(commands, guildId, guildName);
  }
}

module.exports = new TenantService();
