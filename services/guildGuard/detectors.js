const { resolveSafeUrl, toHttpUrl, isPrivateHostname, SHORTENER_HOSTS } = require('./urlSafety');

function numberSetting(config, detectorName, key, fallback, minimum = 0) {
  const value = Number(config?.detectors?.[detectorName]?.[key]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function enabled(config, detectorName) {
  return config?.detectors?.[detectorName]?.enabled === true;
}

function levenshtein(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

const spamFloodDetector = {
  name: 'spam_flood',
  detect(event, { config, eventWindow }) {
    if (event.eventType !== 'message_create' || !enabled(config, 'spam') || !eventWindow) return null;
    const windowMs = numberSetting(config, 'spam', 'windowMs', 10000, 1000);
    const maxMessages = numberSetting(config, 'spam', 'maxMessages', 5, 1);
    const recent = eventWindow.getRecent(event.guildId, event.userId, windowMs, event.timestamp);
    if (recent.length <= maxMessages) return null;
    return {
      detector: this.name,
      severity: recent.length >= maxMessages * 2 ? 'high' : 'medium',
      score: Math.min(55, numberSetting(config, 'spam', 'score', 30, 1) + (recent.length - maxMessages) * 5),
      metadata: { count: recent.length, maxMessages, windowMs }
    };
  }
};

const duplicateMessageDetector = {
  name: 'duplicate_message',
  detect(event, { config, eventWindow }) {
    if (event.eventType !== 'message_create' || !enabled(config, 'duplicateMessages') || !eventWindow || !event.normalizedContent) return null;
    const windowMs = numberSetting(config, 'duplicateMessages', 'windowMs', 30000, 1000);
    const threshold = numberSetting(config, 'duplicateMessages', 'threshold', 3, 2);
    const recent = eventWindow.getRecent(event.guildId, event.userId, windowMs, event.timestamp)
      .filter(item => item.eventId !== event.eventId && item.normalizedContent === event.normalizedContent);
    const count = recent.length + 1;
    if (count < threshold) return null;
    return {
      detector: this.name,
      severity: count >= threshold + 2 ? 'high' : 'medium',
      score: Math.min(50, numberSetting(config, 'duplicateMessages', 'score', 25, 1) + (count - threshold) * 5),
      metadata: { count, threshold, windowMs, contentHash: event.normalizedContent.slice(0, 120) }
    };
  }
};

const massMentionDetector = {
  name: 'mass_mention',
  detect(event, { config }) {
    if (event.eventType !== 'message_create' || !enabled(config, 'massMention')) return null;
    const threshold = numberSetting(config, 'massMention', 'threshold', 5, 1);
    const everyone = event.everyoneMention === true;
    if (!everyone && event.mentions.length < threshold) return null;
    const count = everyone ? Math.max(event.mentions.length, threshold) : event.mentions.length;
    return {
      detector: this.name,
      severity: everyone || count >= threshold * 2 ? 'high' : 'medium',
      score: Math.min(60, numberSetting(config, 'massMention', 'score', 35, 1) + Math.max(0, count - threshold) * 3),
      metadata: { count, threshold, everyone }
    };
  }
};

const suspiciousAccountDetector = {
  name: 'suspicious_account',
  detect(event, { config }) {
    if (event.eventType !== 'member_join' || !enabled(config, 'suspiciousAccount')) return null;
    const thresholdHours = numberSetting(config, 'suspiciousAccount', 'maxAccountAgeHours', 24, 1);
    if (!Number.isFinite(event.accountAgeHours) || event.accountAgeHours > thresholdHours) return null;
    const score = event.accountAgeHours <= 1 ? 45 : numberSetting(config, 'suspiciousAccount', 'score', 25, 1);
    return {
      detector: this.name,
      severity: event.accountAgeHours <= 1 ? 'high' : 'medium',
      score,
      metadata: { accountAgeHours: event.accountAgeHours, thresholdHours }
    };
  }
};

const impersonationDetector = {
  name: 'staff_impersonation',
  detect(event, { config, identityRegistry }) {
    if (!enabled(config, 'impersonation') || !identityRegistry || !event.userId) return null;
    const match = identityRegistry.findImpersonationMatch(event.guildId, event);
    if (!match) return null;
    return {
      detector: this.name,
      severity: 'high',
      score: numberSetting(config, 'impersonation', 'score', 70, 1),
      metadata: {
        matchedStaffUserId: match.user_id,
        matchedUsername: match.username,
        matchedDisplayName: match.display_name
      }
    };
  }
};

const linkProtectionDetector = {
  name: 'link_protection',
  async detect(event, { config, domainRegistry }) {
    if (event.eventType !== 'message_create' || !enabled(config, 'links') || !domainRegistry || event.urls.length === 0) return null;
    const lists = domainRegistry.getLists(event.guildId);
    const protectedDomains = (config.detectors.links.protectedDomains || [])
      .map(domainRegistry.normalizeDomain)
      .filter(Boolean);
    const references = [...new Set([...lists.allow, ...protectedDomains])];
    const signals = [];
    for (const rawUrl of event.urls) {
      let analyzedUrl = rawUrl;
      let urlAnalysis = null;
      try {
        const parsed = toHttpUrl(rawUrl);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        if (isPrivateHostname(parsed.hostname) || (config.detectors.links.inspectShortenedUrls !== false && SHORTENER_HOSTS.has(host))) {
          urlAnalysis = await resolveSafeUrl(rawUrl, {
            maxRedirects: config.detectors.links.redirectMaxHops,
            timeoutMs: config.detectors.links.urlTimeoutMs
          });
          if (!urlAnalysis.safe) {
            signals.push({
              detector: this.name,
              severity: 'critical',
              score: numberSetting(config, 'links', 'unsafeDestinationScore', 100, 1),
              metadata: { domain: host, category: 'unsafe_destination', url: rawUrl, reason: urlAnalysis.reason, redirects: urlAnalysis.redirects }
            });
            continue;
          }
          analyzedUrl = urlAnalysis.finalUrl || rawUrl;
        }
      } catch (error) {
        signals.push({
          detector: this.name,
          severity: 'critical',
          score: numberSetting(config, 'links', 'unsafeDestinationScore', 100, 1),
          metadata: { category: 'unsafe_destination', url: rawUrl, reason: error?.message || 'invalid_url' }
        });
        continue;
      }
      const domain = domainRegistry.normalizeDomain(analyzedUrl);
      if (!domain) continue;
      if (lists.block.includes(domain)) {
        signals.push({
          detector: this.name,
          severity: 'high',
          score: numberSetting(config, 'links', 'score', 65, 1),
          metadata: { domain, category: 'blocklisted', url: rawUrl, finalUrl: urlAnalysis?.finalUrl || null, redirects: urlAnalysis?.redirects || [] }
        });
        continue;
      }
      if (lists.allow.includes(domain)) continue;
      const lookalike = references.find(reference => reference !== domain && levenshtein(reference, domain) <= 2);
      if (lookalike) {
        signals.push({
          detector: 'lookalike_domain',
          severity: 'high',
          score: numberSetting(config, 'links', 'lookalikeScore', 45, 1),
          metadata: { domain, lookalikeOf: lookalike, category: 'lookalike', url: rawUrl, finalUrl: urlAnalysis?.finalUrl || null, redirects: urlAnalysis?.redirects || [] }
        });
        continue;
      }
      if (config.detectors.links.requireAllowlist) {
        signals.push({
          detector: this.name,
          severity: 'medium',
          score: Math.min(50, numberSetting(config, 'links', 'unlistedScore', 25, 1)),
          metadata: { domain, category: 'unlisted', url: rawUrl, finalUrl: urlAnalysis?.finalUrl || null, redirects: urlAnalysis?.redirects || [] }
        });
      }
    }
    return signals.length > 0 ? signals : null;
  }
};

const raidBurstDetector = {
  name: 'raid_burst',
  detect(event, { config, eventWindow }) {
    if (event.eventType !== 'member_join' || !enabled(config, 'raids') || !eventWindow) return null;
    const windowSeconds = numberSetting(config, 'raids', 'windowSeconds', 60, 5);
    const joinThreshold = numberSetting(config, 'raids', 'joinThreshold', 8, 2);
    const recent = eventWindow.getRecentGuild(event.guildId, windowSeconds * 1000, event.timestamp)
      .filter(item => item.eventType === 'member_join');
    if (recent.length < joinThreshold) return null;
    return {
      detector: this.name,
      severity: 'high',
      score: Math.min(100, numberSetting(config, 'raids', 'score', 80, 1) + Math.max(0, recent.length - joinThreshold) * 2),
      metadata: { joinCount: recent.length, joinThreshold, windowSeconds }
    };
  }
};

module.exports = {
  spamFloodDetector,
  duplicateMessageDetector,
  massMentionDetector,
  suspiciousAccountDetector,
  impersonationDetector,
  linkProtectionDetector,
  raidBurstDetector,
  levenshtein
};
