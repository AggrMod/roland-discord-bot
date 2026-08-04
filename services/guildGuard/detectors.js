const net = require('net');
const { resolveSafeUrl, toHttpUrl, isPrivateHostname, SHORTENER_HOSTS } = require('./urlSafety');
const { classifyAttachment, isScannableImage, scanQrAttachment } = require('./attachmentSafety');
const { extractUrls } = require('./normalizer');

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

const scamLanguageDetector = {
  name: 'wallet_drainer_language',
  detect(event, { config, domainRegistry }) {
    if (event.eventType !== 'message_create' || !enabled(config, 'scamLanguage') || !event.normalizedContent) return null;
    const content = event.normalizedContent;
    const safetyWarning = /\b(never|do not|don't|will never)\b.{0,35}\b(share|send|enter|submit|import|paste|provide)\b.{0,45}\b(seed phrase|recovery phrase|secret phrase|private key)\b/.test(content);
    const secretRequest = !safetyWarning && /\b(seed phrase|recovery phrase|secret phrase|private key)\b/.test(content)
      && /\b(send|share|enter|submit|verify|validate|import|paste|provide)\b/.test(content);
    if (secretRequest) {
      return {
        detector: this.name,
        severity: 'critical',
        score: numberSetting(config, 'scamLanguage', 'secretRequestScore', 100, 1),
        metadata: { category: 'secret_request', explanation: 'Message asks a member to disclose wallet recovery credentials' }
      };
    }
    const walletReference = /\b(wallet|metamask|phantom|ledger|trezor)\b/.test(content);
    const walletAction = /\b(connect|verify|validate|sync|restore|migrate|rectify|authenticate|reconnect)\b/.test(content);
    const pressureOrLure = /\b(urgent|immediately|airdrop|claim|mint|support|suspended|compromised|security|reward|refund|giveaway|whitelist)\b/.test(content);
    const carriesDestination = (event.urls || []).length > 0 || (event.attachments || []).length > 0;
    const allowedDomains = domainRegistry?.getLists?.(event.guildId)?.allow || [];
    const allLinkedDomainsAllowed = Boolean(domainRegistry && event.urls?.length > 0
      && event.urls.every(url => allowedDomains.includes(domainRegistry.normalizeDomain(url))));
    if (allLinkedDomainsAllowed) return null;
    if (!walletReference || !walletAction || (!pressureOrLure && !carriesDestination)) return null;
    return {
      detector: this.name,
      severity: carriesDestination ? 'high' : 'medium',
      score: numberSetting(config, 'scamLanguage', 'score', carriesDestination ? 55 : 40, 1),
      metadata: { category: 'wallet_lure', hasDestination: carriesDestination, explanation: 'Message combines wallet instructions with pressure, rewards, or an external destination' }
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
    const markdownLinks = String(event.rawContent || '').matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)\s]+)\)/gi);
    for (const match of markdownLinks) {
      const displayedDomain = domainRegistry.normalizeDomain(match[1]);
      const destinationDomain = domainRegistry.normalizeDomain(match[2]);
      if (displayedDomain && destinationDomain && displayedDomain !== destinationDomain
        && (references.includes(displayedDomain) || lists.block.includes(destinationDomain))) {
        signals.push({
          detector: 'link_deception',
          severity: 'critical',
          score: numberSetting(config, 'links', 'deceptionScore', 80, 1),
          metadata: { category: 'masked_destination', displayedDomain, destinationDomain, url: match[2] }
        });
      }
    }
    for (const rawUrl of event.urls) {
      let analyzedUrl = rawUrl;
      let urlAnalysis = null;
      try {
        const parsed = toHttpUrl(rawUrl);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        const explicitlyAllowed = lists.allow.includes(domainRegistry.normalizeDomain(parsed.toString()));
        if (!explicitlyAllowed && (parsed.username || parsed.password)) {
          signals.push({ detector: 'link_deception', severity: 'critical', score: numberSetting(config, 'links', 'deceptionScore', 80, 1), metadata: { category: 'embedded_credentials', domain: host, url: rawUrl } });
        }
        if (!explicitlyAllowed && host.includes('xn--')) {
          signals.push({ detector: 'link_deception', severity: 'high', score: numberSetting(config, 'links', 'punycodeScore', 60, 1), metadata: { category: 'internationalized_domain', domain: host, url: rawUrl } });
        }
        if (!explicitlyAllowed && net.isIP(parsed.hostname)) {
          signals.push({ detector: 'link_deception', severity: 'high', score: numberSetting(config, 'links', 'ipAddressScore', 55, 1), metadata: { category: 'ip_address_link', domain: host, url: rawUrl } });
        }
        if (!explicitlyAllowed && parsed.port && !['80', '443'].includes(parsed.port)) {
          signals.push({ detector: 'link_deception', severity: 'medium', score: numberSetting(config, 'links', 'unusualPortScore', 40, 1), metadata: { category: 'unusual_port', domain: host, port: parsed.port, url: rawUrl } });
        }
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

const attachmentThreatDetector = {
  name: 'dangerous_attachment',
  async detect(event, context) {
    const { config } = context;
    if (event.eventType !== 'message_create' || !enabled(config, 'attachments') || !event.attachments?.length) return null;
    const signals = [];
    const attachmentConfig = config.detectors.attachments || {};
    const qrScanner = context.scanQrAttachment || scanQrAttachment;
    const scanLimit = Math.max(0, Math.min(3, Number(attachmentConfig.maxImagesPerMessage) || 2));
    let scannedImages = 0;
    for (const attachment of event.attachments) {
      for (const finding of classifyAttachment(attachment)) {
        signals.push({
          detector: this.name,
          severity: finding.severity,
          score: finding.score,
          metadata: { ...finding, attachmentName: attachment.name, contentType: attachment.contentType, size: attachment.size }
        });
      }
      if (attachmentConfig.scanQrCodes === false || scannedImages >= scanLimit || !isScannableImage(attachment)) continue;
      scannedImages += 1;
      try {
        const decoded = await qrScanner(attachment, {
          maxBytes: attachmentConfig.maxScanBytes,
          timeoutMs: attachmentConfig.scanTimeoutMs
        });
        if (!decoded) continue;
        const qrUrls = extractUrls(decoded);
        if (!qrUrls.length) continue;
        signals.push({
          detector: 'qr_code_link',
          severity: 'medium',
          score: numberSetting(config, 'attachments', 'qrCodeScore', 35, 1),
          metadata: { category: 'qr_destination', attachmentName: attachment.name, decodedUrls: qrUrls }
        });
        const linkSignals = await linkProtectionDetector.detect({ ...event, rawContent: '', urls: qrUrls }, context);
        if (Array.isArray(linkSignals)) {
          signals.push(...linkSignals.map(signal => ({
            ...signal,
            metadata: { ...(signal.metadata || {}), source: 'qr_code', attachmentName: attachment.name }
          })));
        }
      } catch (_) {
        // A transient CDN or image decoding failure is not itself evidence of malicious content.
      }
    }
    return signals.length ? signals : null;
  }
};

const coordinatedCampaignDetector = {
  name: 'coordinated_link_campaign',
  detect(event, { config, eventWindow, domainRegistry }) {
    if (event.eventType !== 'message_create' || !enabled(config, 'campaigns') || !eventWindow) return null;
    const windowSeconds = numberSetting(config, 'campaigns', 'windowSeconds', 90, 10);
    const userThreshold = numberSetting(config, 'campaigns', 'userThreshold', 3, 2);
    const recent = eventWindow.getRecentGuild(event.guildId, windowSeconds * 1000, event.timestamp)
      .filter(item => item.eventType === 'message_create' && item.userId);
    const allowedDomains = new Set(domainRegistry?.getLists?.(event.guildId)?.allow || []);
    const normalizedCurrentDomains = [...new Set((event.urls || [])
      .map(url => domainRegistry?.normalizeDomain?.(url)).filter(Boolean))];
    const trustedOnlyDestination = normalizedCurrentDomains.length > 0
      && normalizedCurrentDomains.every(domain => allowedDomains.has(domain));
    const currentDomains = normalizedCurrentDomains.filter(domain => !allowedDomains.has(domain));
    const signals = [];

    for (const domain of currentDomains) {
      const matching = recent.filter(item => (item.urls || []).some(url => domainRegistry?.normalizeDomain?.(url) === domain));
      const userIds = [...new Set(matching.map(item => item.userId).filter(Boolean))];
      if (userIds.length < userThreshold) continue;
      const channelIds = [...new Set(matching.map(item => item.channelId).filter(Boolean))];
      signals.push({
        detector: this.name,
        severity: userIds.length >= userThreshold + 2 ? 'critical' : 'high',
        score: Math.min(100, numberSetting(config, 'campaigns', 'linkScore', 75, 1) + Math.max(0, userIds.length - userThreshold) * 5),
        metadata: {
          category: 'multi_account_link_campaign',
          domain,
          userCount: userIds.length,
          channelCount: channelIds.length,
          windowSeconds
        }
      });
    }

    const normalizedContent = String(event.normalizedContent || '');
    const messageThreshold = numberSetting(config, 'campaigns', 'messageThreshold', userThreshold, 2);
    if (normalizedContent.length >= 20 && !trustedOnlyDestination) {
      const copied = recent.filter(item => item.normalizedContent === normalizedContent);
      const copiedUsers = [...new Set(copied.map(item => item.userId).filter(Boolean))];
      if (copiedUsers.length >= messageThreshold) {
        signals.push({
          detector: 'coordinated_message_campaign',
          severity: copiedUsers.length >= messageThreshold + 2 ? 'high' : 'medium',
          score: Math.min(65, numberSetting(config, 'campaigns', 'messageScore', 45, 1) + Math.max(0, copiedUsers.length - messageThreshold) * 5),
          metadata: {
            category: 'multi_account_message_campaign',
            userCount: copiedUsers.length,
            channelCount: [...new Set(copied.map(item => item.channelId).filter(Boolean))].length,
            windowSeconds,
            contentHash: normalizedContent.slice(0, 120)
          }
        });
      }
    }

    return signals.length ? signals : null;
  }
};

const accountTrustDetector = {
  name: 'low_trust_destination',
  detect(event, { config, eventWindow, domainRegistry }) {
    if (event.eventType !== 'message_create' || !enabled(config, 'accountTrust') || !eventWindow || !domainRegistry) return null;
    const lists = domainRegistry.getLists(event.guildId);
    const untrustedDomains = [...new Set((event.urls || [])
      .map(domainRegistry.normalizeDomain)
      .filter(domain => domain && !lists.allow.includes(domain)))];
    const hasDestination = untrustedDomains.length > 0;
    if (!hasDestination) return null;

    const maxAccountAgeHours = numberSetting(config, 'accountTrust', 'maxAccountAgeHours', 72, 1);
    const maxMemberAgeHours = numberSetting(config, 'accountTrust', 'maxMemberAgeHours', 24, 1);
    const youngAccount = Number.isFinite(event.accountAgeHours) && event.accountAgeHours <= maxAccountAgeHours;
    const newMember = Number.isFinite(event.memberAgeHours) && event.memberAgeHours <= maxMemberAgeHours;
    const walletCue = /\b(wallet|metamask|phantom|ledger|trezor|seed phrase|private key)\b/.test(event.normalizedContent || '');
    const actionCue = /\b(connect|verify|validate|sync|restore|migrate|claim|mint|support|urgent)\b/.test(event.normalizedContent || '');
    const signals = [];

    if (youngAccount || (newMember && walletCue && actionCue)) {
      signals.push({
        detector: this.name,
        severity: youngAccount && event.accountAgeHours <= 6 ? 'high' : 'medium',
        score: numberSetting(config, 'accountTrust', 'lowTrustScore', youngAccount ? 30 : 25, 1),
        metadata: {
          category: 'low_trust_destination',
          accountAgeHours: event.accountAgeHours,
          memberAgeHours: event.memberAgeHours,
          youngAccount,
          newMember,
          domains: untrustedDomains
        }
      });
    }

    const burstWindowSeconds = numberSetting(config, 'accountTrust', 'burstWindowSeconds', 120, 10);
    const channelThreshold = numberSetting(config, 'accountTrust', 'channelThreshold', 3, 2);
    const recent = eventWindow.getRecent(event.guildId, event.userId, burstWindowSeconds * 1000, event.timestamp)
      .filter(item => item.eventType === 'message_create' && (item.urls || []).some(url => {
        const domain = domainRegistry.normalizeDomain(url);
        return domain && !lists.allow.includes(domain);
      }));
    const channelIds = [...new Set(recent.map(item => item.channelId).filter(Boolean))];
    if (channelIds.length >= channelThreshold) {
      const domains = [...new Set(recent.flatMap(item => item.urls || []).map(domainRegistry.normalizeDomain).filter(Boolean))];
      signals.push({
        detector: 'account_link_burst',
        severity: channelIds.length >= channelThreshold + 2 ? 'critical' : 'high',
        score: Math.min(100, numberSetting(config, 'accountTrust', 'burstScore', 65, 1) + Math.max(0, channelIds.length - channelThreshold) * 5),
        metadata: {
          category: 'cross_channel_link_burst',
          channelCount: channelIds.length,
          channelThreshold,
          windowSeconds: burstWindowSeconds,
          domains
        }
      });
    }

    return signals.length ? signals : null;
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
  scamLanguageDetector,
  linkProtectionDetector,
  attachmentThreatDetector,
  coordinatedCampaignDetector,
  accountTrustDetector,
  raidBurstDetector,
  levenshtein
};
