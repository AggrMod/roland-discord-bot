const db = require('../database/db');
const logger = require('../utils/logger');
const entitlementService = require('./entitlementService');

class RolePanelService {
  listPanels(guildId) {
    try {
      const panels = guildId
        ? db.prepare('SELECT * FROM role_panels WHERE guild_id = ? ORDER BY created_at ASC').all(guildId)
        : db.prepare('SELECT * FROM role_panels ORDER BY created_at ASC').all();
      return panels.map(p => ({
        ...p,
        roles: db.prepare('SELECT * FROM role_panel_roles WHERE panel_id = ? ORDER BY sort_order ASC, id ASC').all(p.id)
      }));
    } catch (e) {
      logger.error('Error listing role panels:', e);
      return [];
    }
  }

  getPanel(id, guildId) {
    try {
      const panel = guildId
        ? db.prepare('SELECT * FROM role_panels WHERE id = ? AND guild_id = ?').get(id, guildId)
        : db.prepare('SELECT * FROM role_panels WHERE id = ?').get(id);
      if (!panel) return null;
      panel.roles = db.prepare('SELECT * FROM role_panel_roles WHERE panel_id = ? ORDER BY sort_order ASC, id ASC').all(panel.id);
      return panel;
    } catch (e) {
      logger.error('Error getting role panel:', e);
      return null;
    }
  }

  createPanel({ guildId = '', title, description, channelId, singleSelect = false } = {}) {
    try {
      const normalizedGuildId = String(guildId || '').trim();
      if (normalizedGuildId) {
        const countRow = db.prepare(`
          SELECT COUNT(1) AS count
          FROM role_panels
          WHERE guild_id = ?
        `).get(normalizedGuildId);
        const limitCheck = entitlementService.enforceLimit({
          guildId: normalizedGuildId,
          moduleKey: 'selfserveroles',
          limitKey: 'max_panels',
          currentCount: Number(countRow?.count || 0),
          incrementBy: 1,
          itemLabel: 'role panels',
        });
        if (!limitCheck.success) {
          return {
            success: false,
            code: 'limit_exceeded',
            message: limitCheck.message,
            limit: limitCheck.limit,
            used: limitCheck.used,
          };
        }
      }

      const info = db.prepare(`
        INSERT INTO role_panels (guild_id, title, description, channel_id, single_select)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        normalizedGuildId,
        title || 'Get Your Roles',
        description || 'Click a button below to claim or unclaim a community role.',
        channelId || null,
        singleSelect ? 1 : 0
      );
      return { success: true, id: info.lastInsertRowid };
    } catch (e) {
      logger.error('Error creating role panel:', e);
      return { success: false, message: 'Failed to create panel' };
    }
  }

  updatePanel(id, { title, description, channelId, messageId, singleSelect } = {}, guildId) {
    try {
      const sets = [];
      const params = [];
      if (title !== undefined)       { sets.push('title = ?');       params.push(title); }
      if (description !== undefined) { sets.push('description = ?'); params.push(description); }
      if (channelId !== undefined)   { sets.push('channel_id = ?'); params.push(channelId); }
      if (messageId !== undefined)   { sets.push('message_id = ?'); params.push(messageId); }
      if (singleSelect !== undefined){ sets.push('single_select = ?'); params.push(singleSelect ? 1 : 0); }
      if (!sets.length) return { success: false, message: 'Nothing to update' };
      sets.push('updated_at = CURRENT_TIMESTAMP');
      if (guildId) { params.push(id, guildId); }
      else { params.push(id); }
      const q = `UPDATE role_panels SET ${sets.join(', ')} WHERE id = ?${guildId ? ' AND guild_id = ?' : ''}`;
      const info = db.prepare(q).run(...params);
      if (!info.changes) return { success: false, message: 'Panel not found' };
      return { success: true };
    } catch (e) {
      logger.error('Error updating role panel:', e);
      return { success: false, message: 'Failed to update panel' };
    }
  }

  deletePanel(id, guildId) {
    try {
      db.prepare('DELETE FROM role_panel_roles WHERE panel_id = ?').run(id);
      const info = guildId
        ? db.prepare('DELETE FROM role_panels WHERE id = ? AND guild_id = ?').run(id, guildId)
        : db.prepare('DELETE FROM role_panels WHERE id = ?').run(id);
      if (!info.changes) return { success: false, message: 'Panel not found' };
      return { success: true };
    } catch (e) {
      logger.error('Error deleting role panel:', e);
      return { success: false, message: 'Failed to delete panel' };
    }
  }

  addRole(panelId, { roleId, label } = {}, guildId) {
    try {
      if (!roleId) return { success: false, message: 'roleId is required' };
      // Verify panel belongs to guild
      if (guildId) {
        const panel = db.prepare('SELECT id FROM role_panels WHERE id = ? AND guild_id = ?').get(panelId, guildId);
        if (!panel) return { success: false, message: 'Panel not found' };
      }
      const info = db.prepare(`
        INSERT INTO role_panel_roles (panel_id, role_id, label, enabled)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(panel_id, role_id) DO UPDATE SET label = excluded.label, enabled = 1
      `).run(panelId, roleId, label || roleId);
      return { success: true, id: info.lastInsertRowid };
    } catch (e) {
      logger.error('Error adding role to panel:', e);
      return { success: false, message: 'Failed to add role' };
    }
  }

  removeRole(panelId, roleId, guildId) {
    try {
      if (guildId) {
        const panel = db.prepare('SELECT id FROM role_panels WHERE id = ? AND guild_id = ?').get(panelId, guildId);
        if (!panel) return { success: false, message: 'Panel not found' };
      }
      const info = db.prepare('DELETE FROM role_panel_roles WHERE panel_id = ? AND role_id = ?').run(panelId, roleId);
      if (!info.changes) return { success: false, message: 'Role not found in panel' };
      return { success: true };
    } catch (e) {
      logger.error('Error removing role from panel:', e);
      return { success: false, message: 'Failed to remove role' };
    }
  }

  updateRole(panelId, roleId, { label, enabled } = {}, guildId) {
    try {
      if (guildId) {
        const panel = db.prepare('SELECT id FROM role_panels WHERE id = ? AND guild_id = ?').get(panelId, guildId);
        if (!panel) return { success: false, message: 'Panel not found' };
      }
      const sets = [];
      const params = [];
      if (label !== undefined)   { sets.push('label = ?');   params.push(label); }
      if (enabled !== undefined) { sets.push('enabled = ?'); params.push(enabled ? 1 : 0); }
      if (!sets.length) return { success: false, message: 'Nothing to update' };
      params.push(panelId, roleId);
      db.prepare(`UPDATE role_panel_roles SET ${sets.join(', ')} WHERE panel_id = ? AND role_id = ?`).run(...params);
      return { success: true };
    } catch (e) {
      logger.error('Error updating role in panel:', e);
      return { success: false, message: 'Failed to update role' };
    }
  }

  // Look up panel by role
  getPanelByRole(roleId, guildId) {
    try {
      const row = guildId
        ? db.prepare(`
            SELECT rp.* FROM role_panels rp
            JOIN role_panel_roles rpr ON rpr.panel_id = rp.id
            WHERE rpr.role_id = ? AND rpr.enabled = 1 AND rp.guild_id = ?
            ORDER BY rp.id ASC
            LIMIT 1
          `).get(roleId, guildId)
        : db.prepare(`
            SELECT rp.* FROM role_panels rp
            JOIN role_panel_roles rpr ON rpr.panel_id = rp.id
            WHERE rpr.role_id = ? AND rpr.enabled = 1
            ORDER BY rp.id ASC
            LIMIT 1
          `).get(roleId);
      if (!row) return null;
      row.roles = db.prepare('SELECT * FROM role_panel_roles WHERE panel_id = ? AND enabled = 1 ORDER BY sort_order ASC, id ASC').all(row.id);
      return row;
    } catch {
      return null;
    }
  }

  // Check if a roleId is claimable via ANY panel (for the Discord button handler)
  isRoleClaimable(roleId, guildId) {
    try {
      const row = guildId
        ? db.prepare(`
            SELECT rpr.role_id FROM role_panel_roles rpr
            JOIN role_panels rp ON rp.id = rpr.panel_id
            WHERE rpr.role_id = ? AND rpr.enabled = 1 AND rp.guild_id = ?
          `).get(roleId, guildId)
        : db.prepare('SELECT role_id FROM role_panel_roles WHERE role_id = ? AND enabled = 1').get(roleId);
      return !!row;
    } catch (_error) {
      return false;
    }
  }
}

module.exports = new RolePanelService();
