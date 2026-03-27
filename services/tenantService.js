const { REST, Routes } = require('discord.js');
const db = require('../database/db');
const logger = require('../utils/logger');
const moduleGuard = require('../utils/moduleGuard');
const { getCommandModuleKey } = require('../config/commandModules');

const MULTITENANT_ENABLED = process.env.MULTITENANT_ENABLED === 'true';

const DEFAULT_MODULE_KEYS = [
  'verification',
  'governance',
  'treasury',
  'battle',
  'heist'
];

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

class TenantService {
  isMultitenantEnabled() {
    return MULTITENANT_ENABLED;
  }

  ensureTenant(guildId, guildName = null) {
    if (!guildId) {
      return null;
    }

    const existingTenant = db.prepare('SELECT * FROM tenants WHERE guild_id = ?').get(guildId);

    if (!existingTenant) {
      db.prepare(`
        INSERT INTO tenants (guild_id, guild_name, read_only_managed)
        VALUES (?, ?, 0)
      `).run(guildId, guildName || null);
    } else if (guildName && existingTenant.guild_name !== guildName) {
      db.prepare(`
        UPDATE tenants
        SET guild_name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ?
      `).run(guildName, guildId);
    }

    const tenant = db.prepare('SELECT * FROM tenants WHERE guild_id = ?').get(guildId);
    if (!tenant) {
      return null;
    }

    const tenantId = tenant.id;

    for (const moduleKey of DEFAULT_MODULE_KEYS) {
      db.prepare(`
        INSERT OR IGNORE INTO tenant_modules (tenant_id, module_key, enabled)
        VALUES (?, ?, 1)
      `).run(tenantId, moduleKey);
    }

    db.prepare(`
      INSERT OR IGNORE INTO tenant_branding (tenant_id)
      VALUES (?)
    `).run(tenantId);

    db.prepare(`
      INSERT OR IGNORE INTO tenant_limits (tenant_id)
      VALUES (?)
    `).run(tenantId);

    return this.getTenantContext(guildId);
  }

  getTenantContext(guildId) {
    if (!guildId) {
      return {
        guildId: null,
        guildName: null,
        multiTenantEnabled: MULTITENANT_ENABLED,
        readOnlyManaged: false,
        tenant: null,
        modules: {},
        branding: null,
        limits: null,
        enabledModules: [],
        disabledModules: []
      };
    }

    let tenantRecord = db.prepare('SELECT * FROM tenants WHERE guild_id = ?').get(guildId);
    if (!tenantRecord) {
      const created = this.ensureTenant(guildId);
      if (!created) {
        return {
          guildId,
          guildName: null,
          multiTenantEnabled: MULTITENANT_ENABLED,
          readOnlyManaged: false,
          tenant: null,
          modules: {},
          branding: null,
          limits: null,
          enabledModules: [],
          disabledModules: []
        };
      }
      tenantRecord = db.prepare('SELECT * FROM tenants WHERE guild_id = ?').get(guildId);
    }

    if (!tenantRecord) {
      return {
        guildId,
        guildName: null,
        multiTenantEnabled: MULTITENANT_ENABLED,
        readOnlyManaged: false,
        tenant: null,
        modules: {},
        branding: null,
        limits: null,
        enabledModules: [],
        disabledModules: []
      };
    }

    const moduleRows = db.prepare(`
      SELECT module_key, enabled
      FROM tenant_modules
      WHERE tenant_id = ?
    `).all(tenantRecord.id);
    const branding = db.prepare('SELECT * FROM tenant_branding WHERE tenant_id = ?').get(tenantRecord.id) || null;
    const limits = db.prepare('SELECT * FROM tenant_limits WHERE tenant_id = ?').get(tenantRecord.id) || null;

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

    return {
      guildId: tenantRecord.guild_id,
      guildName: tenantRecord.guild_name,
      multiTenantEnabled: MULTITENANT_ENABLED,
      readOnlyManaged: tenantRecord.read_only_managed === 1,
      tenant: tenantRecord,
      modules,
      branding,
      limits,
      enabledModules,
      disabledModules
    };
  }

  isModuleEnabled(guildId, moduleKey) {
    if (!moduleKey) {
      return true;
    }

    if (!MULTITENANT_ENABLED) {
      return moduleGuard.isModuleEnabled(moduleKey);
    }

    const context = this.ensureTenant(guildId);
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

    if (!guildId) {
      throw new Error('guildId is required to sync guild commands');
    }

    const context = this.ensureTenant(guildId, guildName);
    const normalized = normalizeCommands(commands);
    const payloads = [];
    const skippedCommands = [];

    for (const command of normalized) {
      const payload = commandToPayload(command);
      if (!payload) {
        continue;
      }

      const moduleKey = getCommandModuleKey(payload.name);
      if (moduleKey && !this.isModuleEnabled(guildId, moduleKey)) {
        skippedCommands.push(payload.name);
        continue;
      }

      payloads.push(payload);
    }

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const data = await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
      { body: payloads }
    );

    logger.log(
      `✅ Synced ${data.length} guild commands for ${guildId}${context?.guildName ? ` (${context.guildName})` : ''}`
    );

    if (skippedCommands.length > 0) {
      logger.log(`🚧 Skipped disabled tenant commands: ${skippedCommands.join(', ')}`);
    }

    return {
      success: true,
      guildId,
      commandCount: data.length,
      skippedCommands
    };
  }
}

module.exports = new TenantService();
