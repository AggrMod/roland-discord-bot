#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const portalJs = fs.readFileSync(path.join(root, 'web', 'public', 'portal.js'), 'utf8');
const portalCss = fs.readFileSync(path.join(root, 'web', 'public', 'portal-style.css'), 'utf8');
const portalHtml = fs.readFileSync(path.join(root, 'web', 'public', 'portal.html'), 'utf8');
const previewServer = fs.readFileSync(path.join(root, 'scripts', 'preview-portal.mjs'), 'utf8');

const workspaces = ['overview', 'tenants', 'billing', 'security', 'integrations'];
for (const workspace of workspaces) {
  assert.match(
    portalJs,
    new RegExp(`${workspace}:\\s*\\{[\\s\\S]*?label:`),
    `superadmin workspace metadata should describe ${workspace}`
  );
  assert.match(
    portalJs,
    new RegExp(`tabButton\\('${workspace}'\\)`),
    `superadmin navigation should render ${workspace}`
  );
}

assert.match(portalJs, /Business operations/, 'overview should group tenant and billing operations');
assert.match(portalJs, /Platform control/, 'overview should group security and infrastructure operations');
assert.match(portalJs, /showAdminView\('monitor'\)/, 'system health should remain directly reachable');
assert.match(portalJs, /All platform data sources are available/, 'data health should use one readable status surface');
assert.match(portalJs, /workspace === 'overview' \? 'sa-v2-main--overview' : 'sa-v2-main--focused'/, 'focused workspaces should use full width');

assert.match(portalCss, /\.sa-v3-launch-card\s*\{/, 'large operation launch cards should be styled');
assert.match(portalCss, /\.sa-v2-shell \.btn-secondary\s*\{/, 'superadmin secondary actions should have an explicit high-contrast style');
assert.match(portalCss, /\.sa-v3-launch-card:focus-visible/, 'operation cards should expose keyboard focus');
assert.match(portalCss, /@media \(max-width: 760px\)[\s\S]*?\.sa-v2-tabs[\s\S]*?overflow-x: auto/, 'workspace navigation should remain usable on mobile');
assert.match(portalCss, /#section-admin\.superadmin-console-mode/, 'superadmin mode should remove duplicate generic admin chrome');

assert.match(portalHtml, /portal-style\.css\?v=4/, 'superadmin CSS changes should be cache-busted');
assert.match(portalHtml, /portal\.js\?v=4/, 'superadmin JavaScript changes should be cache-busted');
assert.match(previewServer, /\/api\/superadmin\/workspace\/tenants/, 'local preview should provide tenant workspace data');
assert.match(previewServer, /pendingReceiptsCount:\s*1/, 'local preview should demonstrate an actionable billing state');

console.log('superadmin portal UI contract assertions passed');
