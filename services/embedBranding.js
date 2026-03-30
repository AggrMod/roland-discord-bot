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

module.exports = { applyEmbedBranding, getBranding };
