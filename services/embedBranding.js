const tenantService = require('./tenantService');
const { Colors } = require('discord.js');

const NAMED_COLOR_LOOKUP = (() => {
  const map = Object.create(null);
  for (const [name, value] of Object.entries(Colors || {})) {
    const lower = String(name || '').toLowerCase();
    if (!lower) continue;
    map[lower] = value;
    map[lower.replace(/[\s_-]+/g, '')] = value;
  }
  return map;
})();

function resolveEmbedColor(rawColor, fallbackColor = '#6366f1') {
  const fallback = rawColor === fallbackColor ? '#6366f1' : fallbackColor;
  const value = String(rawColor || '').trim();
  if (!value) return fallback;

  // #RRGGBB / RRGGBB
  if (/^#?[0-9a-f]{6}$/i.test(value)) {
    return value.startsWith('#') ? value : `#${value}`;
  }

  // #RGB / RGB
  if (/^#?[0-9a-f]{3}$/i.test(value)) {
    return value.startsWith('#') ? value : `#${value}`;
  }

  // Decimal number string
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0 && n <= 0xFFFFFF) {
      return n;
    }
  }

  // Discord named colors, case-insensitive and tolerant of spaces/_/-
  const key = value.toLowerCase();
  const compact = key.replace(/[\s_-]+/g, '');
  if (NAMED_COLOR_LOOKUP[key] !== undefined) return NAMED_COLOR_LOOKUP[key];
  if (NAMED_COLOR_LOOKUP[compact] !== undefined) return NAMED_COLOR_LOOKUP[compact];

  return fallback;
}

function moduleColorKey(moduleKey) {
  if (moduleKey === 'ticketing') return 'ticketing_color';
  if (moduleKey === 'selfserve') return 'selfserve_color';
  if (moduleKey === 'nfttracker') return 'nfttracker_color';
  return null;
}

function getBranding(guildId, moduleKey) {
  try {
    const ctx = tenantService.getTenantContext(guildId);
    const b = ctx?.branding || {};
    const brandingEnabled = !!ctx?.modules?.branding;
    const mk = moduleColorKey(moduleKey);
    const color = (brandingEnabled && mk && b[mk]) || b.brand_color || b.primary_color || null;
    const logo = (brandingEnabled && (b.logo_url || b.icon_url)) || null;
    const footer = (brandingEnabled && b.footer_text) || null;
    const brandName = (brandingEnabled && (b.bot_display_name || b.display_name)) || 'Guild Pilot';
    return { brandingEnabled, color, logo, footer, brandName };
  } catch {
    return { brandingEnabled: false, color: null, logo: null, footer: null };
  }
}

function applyEmbedBranding(embed, {
  guildId,
  moduleKey,
  defaultColor = '#6366f1',
  defaultFooter = 'Powered by Guild Pilot',
  fallbackLogoUrl = null,
  footerPrefix = null,
  useThumbnail = true,
} = {}) {
  const br = getBranding(guildId, moduleKey);
  const requestedColor = br.color || defaultColor;
  const safeColor = resolveEmbedColor(requestedColor, defaultColor);
  try {
    embed.setColor(safeColor);
  } catch {
    embed.setColor(resolveEmbedColor(defaultColor, '#6366f1'));
  }

  const logo = br.logo || fallbackLogoUrl || null;
  if (typeof embed.setThumbnail === 'function') {
    if (useThumbnail && logo) {
      try { embed.setThumbnail(logo); } catch {}
    } else if (!useThumbnail) {
      // Explicitly clear thumbnail so edited messages don't retain old right-side logo
      try { embed.setThumbnail(null); } catch {}
    }
  }

  const baseFooter = br.footer || defaultFooter;
  const finalFooter = footerPrefix ? `${footerPrefix} • ${baseFooter}` : baseFooter;
  try { embed.setFooter({ text: finalFooter }); } catch {}

  return embed;
}

function createBrandedPanelEmbed({
  guildId,
  moduleKey,
  panelTitle,
  description,
  defaultColor = '#6366f1',
  defaultFooter = 'Powered by Guild Pilot',
  fallbackLogoUrl = null,
  useThumbnail = false,
}) {
  const { EmbedBuilder } = require('discord.js');
  const embed = new EmbedBuilder()
    .setDescription(String(description || '').trim() || 'No description provided.')
    .setTimestamp();

  const br = getBranding(guildId, moduleKey);
  const logo = br.logo || fallbackLogoUrl || null;
  const cleanedTitle = String(panelTitle || 'Panel')
    .replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\s]*/u, '')
    .trim() || 'Panel';
  const authorText = `${br.brandName || 'Guild Pilot'} | ${cleanedTitle}`;

  try {
    if (logo) embed.setAuthor({ name: authorText, iconURL: logo });
    else embed.setAuthor({ name: authorText });
  } catch {}

  applyEmbedBranding(embed, {
    guildId,
    moduleKey,
    defaultColor,
    defaultFooter,
    fallbackLogoUrl,
    useThumbnail,
  });

  return embed;
}

module.exports = { applyEmbedBranding, getBranding, createBrandedPanelEmbed };
