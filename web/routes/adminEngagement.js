const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');
const xProviderService = require('../../services/xProviderService');

function parseInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createAdminEngagementRouter({
  logger,
  adminAuthMiddleware,
  ensureEngagementModule,
}) {
  const router = express.Router();

  const loadService = () => require('../../services/engagementService');
  const guard = (req, res) => ensureEngagementModule(req, res);

  router.get('/api/admin/engagement/config', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      return res.json(toSuccessResponse({ config: eng.getConfig(req.guildId) }));
    } catch (error) {
      logger.error('Error loading engagement config:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.put('/api/admin/engagement/config', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const allowed = [
        'enabled',
        'points_message',
        'points_reaction',
        'points_reply',
        'cooldown_message_mins',
        'cooldown_reply_mins',
        'cooldown_reaction_daily',
        'leaderboard_channel',
        'currency_name_singular',
        'currency_name_plural',
        'currency_symbol',
        'currency_icon',
        'task_feed_channel_id',
        'social_log_channel_id',
        'purchase_log_channel_id',
        'achievement_channel_id',
        'fulfillment_ticket_category_id',
        'discord_messages_enabled',
        'discord_replies_enabled',
        'discord_reactions_enabled',
      ];
      const patch = {};
      for (const key of allowed) {
        if (req.body?.[key] !== undefined) patch[key] = req.body[key];
      }
      const updated = eng.setConfig(req.guildId, patch);
      return res.json(toSuccessResponse({ config: updated }));
    } catch (error) {
      logger.error('Error updating engagement config:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.get('/api/admin/engagement/providers', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      return res.json(toSuccessResponse({ providers: eng.getProviderCatalog() }));
    } catch (error) {
      logger.error('Error loading engagement providers:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.post('/api/admin/engagement/providers/x/sync', adminAuthMiddleware, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!xProviderService.isConfigured()) {
        return res.status(400).json(toErrorResponse('X provider is not configured', 'VALIDATION_ERROR'));
      }

      const eng = loadService();
      const mode = String(req.body?.mode || 'account').trim().toLowerCase();
      const maxResults = Math.max(5, Math.min(parseInteger(req.body?.max_results || req.body?.maxResults, 10), 100));
      const sinceId = String(req.body?.since_id || req.body?.sinceId || '').trim();
      let posts = [];

      if (mode === 'hashtag') {
        let hashtag = String(req.body?.hashtag || '').trim();
        if (!hashtag && req.body?.hashtag_monitor_id) {
          const monitor = eng.listHashtagMonitors(req.guildId).find(entry => Number(entry.id) === parseInteger(req.body.hashtag_monitor_id));
          hashtag = monitor?.hashtag || '';
        }
        if (!hashtag) {
          return res.status(400).json(toErrorResponse('hashtag is required', 'VALIDATION_ERROR'));
        }
        const query = `${hashtag.startsWith('#') ? hashtag : `#${hashtag}`} -is:retweet`;
        const searchResult = await xProviderService.searchRecentPosts(query, { sinceId, maxResults });
        posts = searchResult.posts || [];
      } else {
        let accountHandle = String(req.body?.account_handle || req.body?.accountHandle || '').trim();
        if (!accountHandle && req.body?.monitored_account_id) {
          const account = eng.listMonitoredAccounts(req.guildId, 'x').find(entry => Number(entry.id) === parseInteger(req.body.monitored_account_id));
          accountHandle = account?.account_handle || '';
        }
        if (!accountHandle) {
          return res.status(400).json(toErrorResponse('account_handle is required', 'VALIDATION_ERROR'));
        }
        const timelineResult = await xProviderService.getRecentPostsByHandle(accountHandle, { sinceId, maxResults, exclude: ['retweets'] });
        posts = timelineResult.posts || [];
      }

      const ingested = [];
      for (const post of posts) {
        const ingestResult = await eng.ingestProviderPost(req.guildId, 'x', {
          source_post_id: post.id,
          source_post_url: `https://x.com/i/web/status/${post.id}`,
          account_handle: req.body?.account_handle || req.body?.accountHandle || '',
          account_id: post.author_id || null,
          title: `X post ${post.id}`,
          body: post.text,
          raw: post.raw || post,
        });
        ingested.push({
          postId: post.id,
          matched: !!ingestResult?.matched,
          createdTasks: ingestResult?.createdTasks || [],
        });
      }

      return res.json(toSuccessResponse({
        mode,
        scanned: posts.length,
        ingested,
        newestId: posts[0]?.id || null,
      }));
    } catch (error) {
      logger.error('Error syncing X provider data:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.get('/api/admin/engagement/leaderboard', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const limit = Math.min(parseInteger(req.query.limit, 25), 100);
      return res.json(toSuccessResponse({ leaderboard: eng.getLeaderboard(req.guildId, limit) }));
    } catch (error) {
      logger.error('Error loading engagement leaderboard:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.get('/api/admin/engagement/shop', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      return res.json(toSuccessResponse({
        items: eng.getShopItems(req.guildId, { includeDisabled: req.query.includeDisabled === 'true' }),
      }));
    } catch (error) {
      logger.error('Error loading engagement shop:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.post('/api/admin/engagement/shop', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const { name, cost } = req.body || {};
      if (!name || cost === null || cost === undefined) {
        return res.status(400).json(toErrorResponse('name and cost are required', 'VALIDATION_ERROR'));
      }
      const result = eng.addShopItem(req.guildId, req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to create shop item', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error creating engagement shop item:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.put('/api/admin/engagement/shop/:id', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const result = eng.updateShopItem(req.guildId, parseInteger(req.params.id), req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to update shop item', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating engagement shop item:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.delete('/api/admin/engagement/shop/:id', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const result = eng.removeShopItem(req.guildId, parseInteger(req.params.id));
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to remove shop item', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error deleting engagement shop item:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.get('/api/admin/engagement/monitored-accounts', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      return res.json(toSuccessResponse({
        accounts: eng.listMonitoredAccounts(req.guildId, req.query.provider || ''),
      }));
    } catch (error) {
      logger.error('Error loading monitored engagement accounts:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.post('/api/admin/engagement/monitored-accounts', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const result = eng.upsertMonitoredAccount(req.guildId, req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to save monitored account', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error saving monitored engagement account:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.put('/api/admin/engagement/monitored-accounts/:id', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const result = eng.upsertMonitoredAccount(req.guildId, { ...(req.body || {}), id: parseInteger(req.params.id) });
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to update monitored account', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating monitored engagement account:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.delete('/api/admin/engagement/monitored-accounts/:id', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      return res.json(toSuccessResponse(eng.deleteMonitoredAccount(req.guildId, parseInteger(req.params.id))));
    } catch (error) {
      logger.error('Error deleting monitored engagement account:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.get('/api/admin/engagement/hashtags', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      return res.json(toSuccessResponse({
        hashtags: eng.listHashtagMonitors(req.guildId, req.query.provider || ''),
      }));
    } catch (error) {
      logger.error('Error loading hashtag monitors:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.post('/api/admin/engagement/hashtags', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const result = eng.upsertHashtagMonitor(req.guildId, req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to save hashtag monitor', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error saving hashtag monitor:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.put('/api/admin/engagement/hashtags/:id', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const result = eng.upsertHashtagMonitor(req.guildId, { ...(req.body || {}), id: parseInteger(req.params.id) });
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to update hashtag monitor', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating hashtag monitor:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.delete('/api/admin/engagement/hashtags/:id', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      return res.json(toSuccessResponse(eng.deleteHashtagMonitor(req.guildId, parseInteger(req.params.id))));
    } catch (error) {
      logger.error('Error deleting hashtag monitor:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.get('/api/admin/engagement/tasks', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const tasks = eng.listTasks(req.guildId, {
        provider: req.query.provider || '',
        status: req.query.status || '',
        userId: req.query.userId || null,
        limit: parseInteger(req.query.limit, 100),
      });
      const completions = eng.listTaskCompletions(req.guildId, { limit: 200 });
      return res.json(toSuccessResponse({ tasks, completions }));
    } catch (error) {
      logger.error('Error loading engagement tasks:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.post('/api/admin/engagement/tasks', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const result = eng.createTask(req.guildId, req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to create task', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error creating engagement task:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.post('/api/admin/engagement/tasks/ingest', adminAuthMiddleware, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const provider = req.body?.provider;
      const result = await eng.ingestProviderPost(req.guildId, provider, req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to ingest provider post', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error ingesting provider post:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.post('/api/admin/engagement/tasks/:id/complete', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const targetUserId = String(req.body?.user_id || req.body?.userId || '').trim();
      const username = String(req.body?.username || req.body?.displayName || targetUserId || 'user').trim();
      if (!targetUserId) {
        return res.status(400).json(toErrorResponse('user_id is required', 'VALIDATION_ERROR'));
      }
      const result = eng.recordTaskCompletion(req.guildId, parseInteger(req.params.id), targetUserId, username, req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to record task completion', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error recording engagement task completion:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.get('/api/admin/engagement/linked-accounts', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      return res.json(toSuccessResponse({
        accounts: eng.listLinkedAccounts(req.guildId, req.query.userId || null),
      }));
    } catch (error) {
      logger.error('Error loading linked engagement accounts:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.get('/api/admin/engagement/achievements', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      return res.json(toSuccessResponse({
        achievements: eng.getAchievements(req.guildId, { includeDisabled: req.query.includeDisabled === 'true' }),
      }));
    } catch (error) {
      logger.error('Error loading engagement achievements:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.post('/api/admin/engagement/achievements', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const result = eng.upsertAchievement(req.guildId, req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to save achievement', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error saving engagement achievement:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.put('/api/admin/engagement/achievements/:id', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      const result = eng.upsertAchievement(req.guildId, { ...(req.body || {}), id: parseInteger(req.params.id) });
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to update achievement', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating engagement achievement:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.delete('/api/admin/engagement/achievements/:id', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      return res.json(toSuccessResponse(eng.deleteAchievement(req.guildId, parseInteger(req.params.id))));
    } catch (error) {
      logger.error('Error deleting engagement achievement:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  router.get('/api/admin/engagement/redemptions', adminAuthMiddleware, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const eng = loadService();
      return res.json(toSuccessResponse({
        redemptions: eng.listRedemptions(req.guildId, {
          userId: req.query.userId || null,
          limit: parseInteger(req.query.limit, 100),
        }),
      }));
    } catch (error) {
      logger.error('Error loading engagement redemptions:', error);
      return res.status(500).json(toErrorResponse(error?.message || 'Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminEngagementRouter;
