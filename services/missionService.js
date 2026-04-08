const db = require('../database/db');
const nftService = require('./nftService');
const walletService = require('./walletService');
const entitlementService = require('./entitlementService');
const logger = require('../utils/logger');

class MissionService {
  constructor() {
    this._missionsGuildColumn = null;
  }

  hasMissionsGuildColumn() {
    if (this._missionsGuildColumn !== null) return this._missionsGuildColumn;
    try {
      const cols = db.prepare(`PRAGMA table_info('missions')`).all();
      this._missionsGuildColumn = cols.some(col => String(col?.name || '').toLowerCase() === 'guild_id');
      return this._missionsGuildColumn;
    } catch (_error) {
      this._missionsGuildColumn = false;
      return false;
    }
  }

  generateMissionId() {
    const { randomUUID } = require('crypto');
    return `M-${randomUUID().split('-')[0].toUpperCase()}`;
  }

  createMission(title, description, requiredRoles, minTier, totalSlots, rewardPoints, guildId = null) {
    try {
      const missionId = this.generateMissionId();
      const normalizedGuildId = String(guildId || '').trim();
      const hasGuildColumn = this.hasMissionsGuildColumn();

      let normalizedRequiredRoles = Array.isArray(requiredRoles) ? requiredRoles : [];
      let normalizedMinTier = minTier || 'Associate';
      let normalizedTotalSlots = Number(totalSlots);
      let normalizedRewardPoints = Number(rewardPoints || 0);

      // Backward compatibility for legacy call shape:
      // createMission(title, description, slots, reward)
      if (
        Number.isFinite(Number(requiredRoles))
        && Number.isFinite(Number(minTier))
        && (totalSlots === undefined || totalSlots === null)
      ) {
        normalizedRequiredRoles = [];
        normalizedMinTier = 'Associate';
        normalizedTotalSlots = Number(requiredRoles);
        normalizedRewardPoints = Number(minTier);
      }

      if (!Number.isFinite(normalizedTotalSlots) || normalizedTotalSlots <= 0) {
        return { success: false, message: 'totalSlots must be a positive number' };
      }
      if (!Number.isFinite(normalizedRewardPoints)) {
        normalizedRewardPoints = 0;
      }

      if (normalizedGuildId && hasGuildColumn) {
        const activeCountRow = db.prepare(`
          SELECT COUNT(1) AS count
          FROM missions
          WHERE guild_id = ?
            AND status IN ('recruiting', 'ready', 'active')
        `).get(normalizedGuildId);

        const limitCheck = entitlementService.enforceLimit({
          guildId: normalizedGuildId,
          moduleKey: 'heist',
          limitKey: 'max_active_missions',
          currentCount: Number(activeCountRow?.count || 0),
          incrementBy: 1,
          itemLabel: 'active missions',
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
      
      if (hasGuildColumn) {
        db.prepare(`
          INSERT INTO missions (mission_id, guild_id, title, description, required_roles, min_tier, total_slots, reward_points, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recruiting')
        `).run(missionId, normalizedGuildId, title, description, JSON.stringify(normalizedRequiredRoles), normalizedMinTier, normalizedTotalSlots, normalizedRewardPoints);
      } else {
        db.prepare(`
          INSERT INTO missions (mission_id, title, description, required_roles, min_tier, total_slots, reward_points, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'recruiting')
        `).run(missionId, title, description, JSON.stringify(normalizedRequiredRoles), normalizedMinTier, normalizedTotalSlots, normalizedRewardPoints);
      }

      logger.log(`Mission ${missionId} created: ${title}`);
      return { success: true, missionId };
    } catch (error) {
      logger.error('Error creating mission:', error);
      return { success: false, message: 'Failed to create mission' };
    }
  }

  getMission(missionId, guildId = null) {
    try {
      const hasGuildColumn = this.hasMissionsGuildColumn();
      const normalizedGuildId = String(guildId || '').trim();
      const mission = (normalizedGuildId && hasGuildColumn)
        ? db.prepare('SELECT * FROM missions WHERE mission_id = ? AND guild_id = ?').get(missionId, normalizedGuildId)
        : db.prepare('SELECT * FROM missions WHERE mission_id = ?').get(missionId);
      if (mission && mission.required_roles) {
        mission.required_roles = JSON.parse(mission.required_roles);
      }
      return mission;
    } catch (error) {
      logger.error('Error fetching mission:', error);
      return null;
    }
  }

  getAvailableMissions(guildId = null) {
    try {
      const hasGuildColumn = this.hasMissionsGuildColumn();
      const normalizedGuildId = String(guildId || '').trim();
      const missions = (normalizedGuildId && hasGuildColumn)
        ? db.prepare('SELECT * FROM missions WHERE status = ? AND guild_id = ? ORDER BY created_at DESC').all('recruiting', normalizedGuildId)
        : db.prepare('SELECT * FROM missions WHERE status = ? ORDER BY created_at DESC').all('recruiting');
      return missions.map(m => {
        if (m.required_roles) {
          m.required_roles = JSON.parse(m.required_roles);
        }
        return m;
      });
    } catch (error) {
      logger.error('Error fetching available missions:', error);
      return [];
    }
  }

  async getEligibleNFTs(discordId, requiredRole) {
    try {
      const wallets = walletService.getAllUserWallets(discordId);
      if (wallets.length === 0) {
        return [];
      }

      const allNFTs = await nftService.getAllNFTsForWallets(wallets);
      
      const assigned = db.prepare(
        'SELECT assigned_nft_mint FROM mission_participants WHERE participant_id = ?'
      ).all(discordId);
      const assignedMints = new Set(assigned.map(a => a.assigned_nft_mint));

      return allNFTs.filter(nft => {
        const roleAttr = nft.attributes.find(a => a.trait_type === 'Role');
        return roleAttr && 
               roleAttr.value === requiredRole && 
               !assignedMints.has(nft.mint);
      });
    } catch (error) {
      logger.error('Error getting eligible NFTs:', error);
      return [];
    }
  }

  signupForMission(missionId, participantId, walletAddress, nftMint, nftName, assignedRole) {
    try {
      const mission = this.getMission(missionId);
      if (!mission) {
        return { success: false, message: 'Mission not found' };
      }

      if (mission.status !== 'recruiting') {
        return { success: false, message: 'Mission is not accepting signups' };
      }

      // Wrap slot check + INSERT in a transaction to prevent race conditions
      const signupTransaction = db.transaction(() => {
        const current = db.prepare('SELECT filled_slots, total_slots FROM missions WHERE mission_id = ?').get(missionId);
        if (current.filled_slots >= current.total_slots) {
          throw new Error('Mission is full');
        }

        const existing = db.prepare(
          'SELECT * FROM mission_participants WHERE mission_id = ? AND participant_id = ?'
        ).get(missionId, participantId);

        if (existing) {
          throw new Error('You are already signed up for this mission');
        }

        db.prepare(`
          INSERT INTO mission_participants
          (mission_id, participant_id, wallet_address, assigned_nft_mint, assigned_nft_name, assigned_role)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(missionId, participantId, walletAddress, nftMint, nftName, assignedRole);

        db.prepare(
          'UPDATE missions SET filled_slots = filled_slots + 1 WHERE mission_id = ?'
        ).run(missionId);

        const updatedMission = db.prepare('SELECT filled_slots, total_slots FROM missions WHERE mission_id = ?').get(missionId);
        if (updatedMission.filled_slots >= updatedMission.total_slots) {
          db.prepare('UPDATE missions SET status = ? WHERE mission_id = ?').run('ready', missionId);
        }
      });

      try {
        signupTransaction();
      } catch (txErr) {
        return { success: false, message: txErr.message };
      }

      logger.log(`User ${participantId} signed up for mission ${missionId} with NFT ${nftMint}`);
      return { success: true };
    } catch (error) {
      logger.error('Error signing up for mission:', error);
      return { success: false, message: 'Failed to sign up' };
    }
  }

  getUserMissions(participantId) {
    try {
      const missions = db.prepare(`
        SELECT m.*, mp.assigned_nft_name, mp.assigned_role, mp.points_awarded, mp.joined_at
        FROM missions m
        JOIN mission_participants mp ON m.mission_id = mp.mission_id
        WHERE mp.participant_id = ?
        ORDER BY mp.joined_at DESC
      `).all(participantId);

      return missions.map(m => {
        if (m.required_roles) {
          m.required_roles = JSON.parse(m.required_roles);
        }
        return m;
      });
    } catch (error) {
      logger.error('Error fetching user missions:', error);
      return [];
    }
  }

  getMissionParticipants(missionId) {
    try {
      return db.prepare(`
        SELECT * FROM mission_participants WHERE mission_id = ?
      `).all(missionId);
    } catch (error) {
      logger.error('Error fetching mission participants:', error);
      return [];
    }
  }
}

module.exports = new MissionService();
