const express = require('express');

function createSuperadminOpsRouter({
  superadminGuard,
  battleService,
  nftActivityService,
  BATTLE_ERAS,
  db,
  os,
  exec,
  logger,
}) {
  const router = express.Router();

  router.get('/system-status', superadminGuard, async (_req, res) => {
    try {
      const cpus = os.cpus();
      const cpuModel = cpus[0]?.model || 'Unknown';
      const cpuCount = cpus.length;

      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memPct = Math.round((usedMem / totalMem) * 100);

      const uptimeSecs = os.uptime();
      const uptimeHours = Math.floor(uptimeSecs / 3600);
      const uptimeMins = Math.floor((uptimeSecs % 3600) / 60);

      const nodeMemory = process.memoryUsage();

      const getDisk = () => new Promise((resolve) => {
        exec('df -BM / | tail -1', (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          const parts = stdout.trim().split(/\s+/);
          resolve({ total: parts[1], used: parts[2], available: parts[3], pct: parts[4] });
        });
      });
      const getPm2 = () => new Promise((resolve) => {
        exec('pm2 jlist 2>/dev/null || echo []', (err, stdout) => {
          if (err) {
            resolve([]);
            return;
          }
          try {
            const pm2List = JSON.parse(stdout.trim());
            resolve(pm2List.map(p => ({
              name: p.name,
              status: p.pm2_env?.status || 'unknown',
              uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
              restarts: p.pm2_env?.restart_time || 0,
              memory: p.monit?.memory || 0,
              cpu: p.monit?.cpu || 0,
            })));
          } catch (_error) {
            resolve([]);
          }
        });
      });

      const [disk, pm2Processes] = await Promise.all([getDisk(), getPm2()]);

      res.json({
        cpu: { model: cpuModel, cores: cpuCount },
        memory: { total: totalMem, used: usedMem, free: freeMem, pct: memPct },
        node: { heapUsed: nodeMemory.heapUsed, heapTotal: nodeMemory.heapTotal, rss: nodeMemory.rss, version: process.version },
        uptime: { seconds: uptimeSecs, display: `${uptimeHours}h ${uptimeMins}m` },
        disk,
        pm2: pm2Processes,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[SystemStatus]', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/eras', superadminGuard, (_req, res) => {
    try {
      const eras = battleService.getAssignableEras();
      res.json({ success: true, eras });
    } catch (error) {
      logger.error('Error fetching eras:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch eras' });
    }
  });

  router.get('/era-assignments', superadminGuard, (_req, res) => {
    try {
      const assignments = db.prepare(`
        SELECT bea.*, t.guild_name
        FROM battle_era_assignments bea
        LEFT JOIN tenants t ON t.guild_id = bea.guild_id
        ORDER BY bea.assigned_at DESC
      `).all();
      res.json({ success: true, assignments });
    } catch (error) {
      logger.error('Error fetching era assignments:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch era assignments' });
    }
  });

  router.post('/era-assignments', superadminGuard, (req, res) => {
    try {
      const { guildId, eraKey } = req.body;
      if (!guildId || !eraKey) {
        return res.status(400).json({ success: false, message: 'guildId and eraKey are required' });
      }
      const normalizedEraKey = battleService.normalizeEraKey(eraKey);
      if (!BATTLE_ERAS[normalizedEraKey]) {
        return res.status(400).json({ success: false, message: 'Unknown era key' });
      }
      if (!battleService.isEraAssignable(normalizedEraKey)) {
        return res.status(400).json({ success: false, message: 'Era is not assignable via superadmin panel' });
      }
      db.prepare(`
        INSERT OR IGNORE INTO battle_era_assignments (guild_id, era_key, assigned_by)
        VALUES (?, ?, ?)
      `).run(guildId, normalizedEraKey, req.session.discordUser.id);
      res.json({ success: true, message: `Era "${normalizedEraKey}" assigned to guild ${guildId}` });
    } catch (error) {
      logger.error('Error assigning era:', error);
      res.status(500).json({ success: false, message: 'Failed to assign era' });
    }
  });

  router.delete('/era-assignments/:guildId/:eraKey', superadminGuard, (req, res) => {
    try {
      const { guildId, eraKey } = req.params;
      const normalizedEraKey = battleService.normalizeEraKey(eraKey);
      const result = db.prepare('DELETE FROM battle_era_assignments WHERE guild_id = ? AND era_key = ?').run(guildId, normalizedEraKey);
      if (result.changes === 0) {
        return res.status(404).json({ success: false, message: 'Assignment not found' });
      }
      res.json({ success: true, message: `Era "${normalizedEraKey}" revoked from guild ${guildId}` });
    } catch (error) {
      logger.error('Error revoking era:', error);
      res.status(500).json({ success: false, message: 'Failed to revoke era' });
    }
  });

  router.post('/nft-activity/replay', superadminGuard, async (req, res) => {
    try {
      const txSignature = String(req.body?.txSignature || req.body?.tx || '').trim();
      if (!txSignature) {
        return res.status(400).json({ success: false, message: 'txSignature is required' });
      }

      const result = await nftActivityService.replayEventByTx(txSignature);
      if (!result.success) {
        return res.status(404).json(result);
      }
      return res.json(result);
    } catch (error) {
      logger.error('Error replaying nft activity event:', error);
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  return router;
}

module.exports = createSuperadminOpsRouter;
