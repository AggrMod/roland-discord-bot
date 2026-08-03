#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const portalPath = path.join(process.cwd(), 'web', 'public', 'portal.js');
const portalHtmlPath = path.join(process.cwd(), 'web', 'public', 'portal.html');
const serverPath = path.join(process.cwd(), 'web', 'server.js');
const source = fs.readFileSync(portalPath, 'utf8');
const portalHtml = fs.readFileSync(portalHtmlPath, 'utf8');
const serverSource = fs.readFileSync(serverPath, 'utf8');
const lines = source.split(/\r?\n/);

const violations = [];

const inlineHandlerCount = [source, portalHtml]
  .reduce((total, fileSource) => total + (fileSource.match(/\bon(?:click|change|input|keyup|keydown|submit)\s*=/gi) || []).length, 0);
const allowsInlineHandlerAttributes = /['"]script-src-attr['"]\s*:\s*\[[^\]]*unsafe-inline[^\]]*\]/s.test(serverSource);
if (inlineHandlerCount > 0 && !allowsInlineHandlerAttributes) {
  violations.push({
    line: 'csp',
    expression: `portal contains ${inlineHandlerCount} inline event handlers but script-src-attr does not allow them`,
    snippet: "Configure script-src-attr 'unsafe-inline' until all inline handlers are migrated to addEventListener.",
  });
}

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

console.log(`[portal-inline-js-safety] OK: ${inlineHandlerCount} inline handlers are CSP-compatible and dynamic onclick args are JS-escaped`);
