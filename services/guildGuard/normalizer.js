const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>]+/gi;
const MENTION_RE = /<@!?(\d+)>|<@&(\d+)>|<#(\d+)>/g;

function safeText(value, maxLength) {
  return String(value || '').slice(0, maxLength);
}

function normalizeContent(value) {
  return safeText(value, 4000)
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/[`*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeEvent(input, eventType = 'message_create') {
  const source = input || {};
  const author = source.author || source.user || {};
  const member = source.member || {};
  const guild = source.guild || {};
  const content = source.content || '';
  const rawContent = safeText(content, 4000);
  const normalizedContent = normalizeContent(content);
  const accountCreatedTimestamp = source.accountCreatedTimestamp
    || author.createdTimestamp
    || author.createdAt?.getTime?.()
    || source.user?.createdTimestamp
    || null;
  const mentions = [];
  for (const match of normalizedContent.matchAll(MENTION_RE)) {
    mentions.push(match[1] || match[2] || match[3]);
  }

  return {
    eventId: safeText(source.id || source.eventId || `${eventType}:${source.guildId || guild.id || 'unknown'}:${source.authorId || author.id || 'unknown'}:${Date.now()}`, 160),
    eventType,
    guildId: safeText(source.guildId || guild.id, 64),
    channelId: safeText(source.channelId || source.channel?.id, 64) || null,
    userId: safeText(source.authorId || author.id || member.id, 64) || null,
    username: safeText(source.username || author.username || author.tag, 128) || null,
    displayName: safeText(source.displayName || member.displayName || author.globalName, 128) || null,
    isBot: Boolean(source.isBot ?? author.bot ?? member.user?.bot),
    isWebhook: Boolean(source.isWebhook ?? source.webhookId),
    isOwner: Boolean(source.isOwner),
    roleIds: Array.isArray(source.roleIds) ? source.roleIds.map(id => String(id)) : (member.roles?.cache ? [...member.roles.cache.keys()] : []),
    rawContent,
    normalizedContent,
    urls: [...normalizedContent.matchAll(URL_RE)].map(match => match[0]).slice(0, 25),
    mentions: mentions.slice(0, 100),
    everyoneMention: /(^|\s)@(everyone|here)(?=\s|$)/i.test(rawContent),
    accountCreatedTimestamp: accountCreatedTimestamp ? Number(accountCreatedTimestamp) : null,
    accountAgeHours: accountCreatedTimestamp ? Math.max(0, (Date.now() - Number(accountCreatedTimestamp)) / 3600000) : null,
    timestamp: source.createdTimestamp || source.createdAt?.getTime?.() || Date.now()
  };
}

module.exports = { normalizeEvent, normalizeContent };
