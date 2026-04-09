#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const commandsRoot = path.join(repoRoot, 'commands');

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function flattenSlashCommands(commandJson) {
  const root = `/${String(commandJson?.name || '').toLowerCase()}`;
  if (!root || root === '/') return [];

  const options = Array.isArray(commandJson.options) ? commandJson.options : [];
  const hasSubcommands = options.some(option => option.type === 1 || option.type === 2);
  if (!hasSubcommands) return [root];

  const out = [];
  for (const option of options) {
    if (option.type === 1) {
      out.push(`${root} ${String(option.name || '').toLowerCase()}`.trim());
      continue;
    }
    if (option.type === 2) {
      const group = String(option.name || '').toLowerCase();
      for (const sub of Array.isArray(option.options) ? option.options : []) {
        if (sub.type !== 1) continue;
        out.push(`${root} ${group} ${String(sub.name || '').toLowerCase()}`.trim());
      }
    }
  }
  return out;
}

function loadExpectedCommands() {
  const files = walkFiles(commandsRoot).filter(file => file.endsWith('.js'));
  const expected = new Set();
  const roots = new Set();

  for (const file of files) {
    let command;
    try {
      command = require(file);
    } catch (_error) {
      continue;
    }
    if (!command?.data || typeof command.data.toJSON !== 'function') continue;

    const json = command.data.toJSON();
    const flattened = flattenSlashCommands(json);
    for (const slash of flattened) {
      expected.add(slash);
      roots.add(`/${slash.slice(1).split(/\s+/)[0]}`);
    }
  }

  return { expected, roots };
}

function cleanToken(token) {
  if (!token) return '';
  return token
    .toLowerCase()
    .replace(/^[\s"'`([{<]+/, '')
    .replace(/[\s"'`)\]}>.,;:!?]+$/, '')
    .trim();
}

function cartesianExpand(tokens) {
  let combos = [''];
  for (const rawToken of tokens) {
    const options = String(rawToken)
      .split('|')
      .map(cleanToken)
      .filter(Boolean);
    if (options.length === 0) continue;

    const next = [];
    for (const combo of combos) {
      for (const option of options) {
        next.push(`${combo} ${option}`.trim());
      }
    }
    combos = next;
  }
  return combos.map(entry => entry.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function canonicalizeObservedCommand(command, expectedSet) {
  const tokens = String(command || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  for (let len = Math.min(3, tokens.length); len >= 1; len -= 1) {
    const candidate = tokens.slice(0, len).join(' ');
    if (expectedSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function extractCommandsFromContent(content, commandRoots, expectedSet) {
  const observed = new Set();
  const text = String(content || '')
    .replace(/\r/g, '\n')
    .replace(/<[^>]*>/g, ' ');

  // Handle compact notation: "/battle create|start, admin list|force-end"
  const groupedAdminRegex = /\/([a-z0-9-]+)\s+([a-z0-9-|]+)\s*,?\s*admin\s+([a-z0-9-|]+)/gi;
  for (const match of text.matchAll(groupedAdminRegex)) {
    const moduleName = cleanToken(match[1]);
    if (!moduleName) continue;
    const root = `/${moduleName}`;
    if (!commandRoots.has(root)) continue;

    const rootCommands = cartesianExpand([root, match[2]]);
    const adminCommands = cartesianExpand([root, 'admin', match[3]]);
    for (const command of [...rootCommands, ...adminCommands]) {
      const canonical = canonicalizeObservedCommand(command, expectedSet);
      if (canonical) observed.add(canonical);
    }
  }

  // General slash command capture with pipe expansion
  const slashRegex = /\/[a-z0-9-]+(?:\s+[a-z0-9-|]+){0,2}/gi;
  for (const match of text.matchAll(slashRegex)) {
    const raw = cleanToken(match[0]);
    if (!raw.startsWith('/')) continue;
    const tokens = raw.split(/\s+/).map(cleanToken).filter(Boolean);
    if (tokens.length === 0) continue;
    const root = tokens[0];
    if (!commandRoots.has(root)) continue;

    const expanded = cartesianExpand(tokens);
    for (const command of expanded) {
      const canonical = canonicalizeObservedCommand(command, expectedSet);
      if (canonical) observed.add(canonical);
    }
  }

  return observed;
}

function tokenizeCount(command) {
  return String(command || '').trim().split(/\s+/).filter(Boolean).length;
}

function formatList(items) {
  return items.map(item => `  - ${item}`).join('\n');
}

function runParityCheck() {
  const { expected, roots } = loadExpectedCommands();
  const expectedAll = [...expected].sort();

  const specs = [
    {
      label: 'docs/ADMIN_HELP.md',
      file: path.join(repoRoot, 'docs', 'ADMIN_HELP.md'),
      filterExpected: slash => true
    },
    {
      label: 'docs/VERIFICATION_COMMANDS.md',
      file: path.join(repoRoot, 'docs', 'VERIFICATION_COMMANDS.md'),
      filterExpected: slash => slash.startsWith('/verification ')
    },
    {
      label: 'web/public/admin-help.html',
      file: path.join(repoRoot, 'web', 'public', 'admin-help.html'),
      filterExpected: slash => true
    },
    {
      label: 'web/public/portal.html',
      file: path.join(repoRoot, 'web', 'public', 'portal.html'),
      filterExpected: slash => true
    }
  ];

  let hasFailures = false;
  console.log('[help-parity] Loaded command surface:', expectedAll.length, 'commands');

  for (const spec of specs) {
    if (!fs.existsSync(spec.file)) {
      console.log(`[help-parity] SKIP ${spec.label} (file not found)`);
      continue;
    }

    const content = fs.readFileSync(spec.file, 'utf8');
    const expectedScoped = expectedAll.filter(spec.filterExpected);
    const expectedSet = new Set(expectedScoped);
    const observedRaw = extractCommandsFromContent(content, roots, expectedSet);
    const observed = [...observedRaw].sort();

    const missing = expectedScoped.filter(command => !observedRaw.has(command)).sort();
    const stale = observed
      .filter(command => tokenizeCount(command) > 1)
      .filter(command => !expectedSet.has(command))
      .sort();

    console.log(`\n[help-parity] ${spec.label}`);
    console.log(`  expected=${expectedScoped.length} observed=${observed.length} missing=${missing.length} stale=${stale.length}`);

    if (missing.length > 0) {
      hasFailures = true;
      console.log('  Missing commands:');
      console.log(formatList(missing));
    }

    if (stale.length > 0) {
      hasFailures = true;
      console.log('  Stale/unknown commands:');
      console.log(formatList(stale));
    }
  }

  if (hasFailures) {
    console.log('\n[help-parity] FAILED: command/help drift detected');
    process.exit(1);
  }

  console.log('\n[help-parity] OK: help files match live slash command surface');
}

runParityCheck();
