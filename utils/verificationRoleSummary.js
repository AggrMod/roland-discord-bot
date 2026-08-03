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

  if (grant.kind === 'wallet') {
    return 'Wallet ownership verified';
  }
  const heading = grant.kind === 'token'
    ? ([chainName, assetName].filter(Boolean).join(' · ') || 'Verified token')
    : (assetName || 'NFT collection');
  if (grant.kind === 'trait') {
    const trait = String(grant.trait || '').trim() || 'Required NFT trait';
    return `${heading}: Owns an NFT with ${trait}`;
  }

  const balance = formatNumber(grant.balance);
  const unit = String(grant.unit || (grant.kind === 'token' ? 'tokens' : 'NFTs')).trim();
  const heldUnit = Number(grant.balance) === 1 && unit === 'NFTs' ? 'NFT' : unit;
  return `${heading}: Holds ${balance} ${heldUnit} · ${formatRequirement(grant.min, grant.max, unit)}`;
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
    const name = (entry.roleId ? `<@&${entry.roleId}>` : `@${entry.roleName}`).slice(0, 256);
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

function buildVerificationRoleMessage(grants, { incomplete = false, maxCharacters = 1900 } = {}) {
  const lines = [
    incomplete ? '**Role Check Incomplete**' : '**Your Verified Roles**',
    incomplete
      ? 'Some holdings could not be checked. Existing roles were preserved where provider data was unavailable.'
      : 'These are the roles you currently qualify for and the rule behind each one.',
  ];
  const fields = buildVerificationRoleFields(grants, { maxRoles: 20, maxCharacters: Math.max(600, maxCharacters - 300) });

  for (const field of fields) {
    const block = `\n${field.name}\n${field.value}`;
    if (lines.join('\n').length + block.length > maxCharacters) {
      lines.push('\n_Additional verified roles matched._');
      break;
    }
    lines.push(block);
  }
  return lines.join('\n').slice(0, maxCharacters);
}

module.exports = {
  buildVerificationRoleFields,
  buildVerificationRoleMessage,
  formatGrantReason,
  formatRequirement,
};
