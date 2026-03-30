const tenantService = require('./tenantService');

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
  const color = br.color || defaultColor;
  embed.setColor(color);

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
