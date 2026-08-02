#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const portalPath = path.join(process.cwd(), 'web', 'public', 'portal.js');
const source = fs.readFileSync(portalPath, 'utf8');
const lines = source.split(/\r?\n/);

const violations = [];

const dashboardSecurityRules = [
  {
    pattern: /\$\{server\.name\s*\|\|\s*['"]Web3 Community['"]\}/,
    message: 'dashboard server names must be HTML-escaped before interpolation',
  },
  {
    pattern: /src="\$\{server\.icon\s*\|\|/,
    message: 'dashboard server icons must pass through sanitizeImageUrl before interpolation',
  },
  {
    pattern: /<p>\$\{data\.error\s*\|\|/,
    message: 'dashboard API errors must be HTML-escaped before interpolation',
  },
];

for (const rule of dashboardSecurityRules) {
  if (rule.pattern.test(source)) {
    violations.push({ line: 'dashboard', expression: rule.message, snippet: String(rule.pattern) });
  }
}

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!line.includes('onclick=') || !line.includes('${')) continue;

  // Explicitly allow controlled command string assembly used by internal rule-table actions.
  if (line.includes('onclick="${editFn}"') || line.includes('onclick="${deleteFn}"')) {
    continue;
  }

  const dynamicQuotedArgs = [...line.matchAll(/'\$\{([^}]+)\}'/g)];
  for (const match of dynamicQuotedArgs) {
    const expression = String(match[1] || '').trim();
    if (!expression.includes('escapeJsString(')) {
      violations.push({
        line: i + 1,
        expression,
        snippet: line.trim(),
      });
    }
  }
}

if (violations.length > 0) {
  console.error('[portal-inline-js-safety] Found unsafe dynamic onclick interpolation:');
  for (const violation of violations) {
    console.error(`  line ${violation.line}: ${violation.expression}`);
    console.error(`    ${violation.snippet}`);
  }
  process.exit(1);
}

console.log('[portal-inline-js-safety] OK: dynamic onclick args are JS-escaped');
