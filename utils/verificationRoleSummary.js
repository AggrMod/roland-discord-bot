function formatNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return number.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function formatRequirement(minValue, maxValue, unit) {
  const min = Number(minValue || 0);
  const max = maxValue === null || maxValue === undefined ? Number.POSITIVE_INFINITY : Number(maxValue);
  const normalizedUnit = String(unit || '').trim();
  const suffix = normalizedUnit ? ` ${normalizedUnit}` : '';

  if (!Number.isFinite(max) || max >= 999999) {
    return `Requires ${formatNumber(min)}+${suffix}`;
  }
  if (min === max) {
    return `Requires exactly ${formatNumber(min)}${suffix}`;
  }
  return `Requires ${formatNumber(min)}–${formatNumber(max)}${suffix}`;
}

function formatGrantReason(grant = {}) {
  const chainName = String(grant.chainName || '').trim();
  const assetName = String(grant.assetName || '').trim();
  const heading = [chainName, assetName].filter(Boolean).join(' · ') || 'Verified wallet';

  if (grant.kind === 'wallet') {
    return `${heading}\nWallet ownership verified`;
  }
  if (grant.kind === 'trait') {
    const trait = String(grant.trait || '').trim() || 'Required NFT trait';
    return `${heading}\nOwns an NFT with ${trait}`;
  }

  const balance = formatNumber(grant.balance);
  const unit = String(grant.unit || (grant.kind === 'token' ? 'tokens' : 'NFTs')).trim();
  const heldUnit = Number(grant.balance) === 1 && unit === 'NFTs' ? 'NFT' : unit;
  return `${heading}\nHolds ${balance} ${heldUnit} · ${formatRequirement(grant.min, grant.max, unit)}`;
}

function buildVerificationRoleFields(grants, { maxRoles = 20, maxCharacters = 5000 } = {}) {
  const grouped = new Map();
  for (const grant of Array.isArray(grants) ? grants : []) {
    const roleId = String(grant?.roleId || '').trim();
    const roleName = String(grant?.roleName || '').trim();
    if (!roleId && !roleName) continue;
    const key = roleId || roleName.toLowerCase();
    const entry = grouped.get(key) || { roleId, roleName: roleName || 'Verified role', reasons: [] };
    const reason = formatGrantReason(grant);
    if (reason && !entry.reasons.includes(reason)) entry.reasons.push(reason);
    grouped.set(key, entry);
  }

  const entries = [...grouped.values()];
  if (!entries.length) {
    return [{
      name: 'No holding-based roles matched',
      value: 'Your verified wallets do not currently satisfy a configured role rule.',
      inline: false,
    }];
  }

  const fields = [];
  let characterCount = 0;
  for (const entry of entries.slice(0, Math.max(1, maxRoles))) {
    const name = `@${entry.roleName}`.slice(0, 256);
    const value = entry.reasons.join('\n').slice(0, 1024);
    if (fields.length && characterCount + name.length + value.length > maxCharacters) break;
    fields.push({ name, value, inline: false });
    characterCount += name.length + value.length;
  }
  if (entries.length > fields.length) {
    fields.push({
      name: 'More verified roles',
      value: `${entries.length - fields.length} additional role${entries.length - fields.length === 1 ? '' : 's'} matched.`,
      inline: false,
    });
  }
  return fields;
}

module.exports = {
  buildVerificationRoleFields,
  formatGrantReason,
  formatRequirement,
};
