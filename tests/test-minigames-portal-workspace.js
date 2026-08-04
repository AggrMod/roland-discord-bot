#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/public/portal.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'web/public/portal.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'web/public/portal-style.css'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'web/routes/adminTrackers.js'), 'utf8');

assert.match(html, /id="minigamesRosterGrid"/, 'portal should include the Game Night roster picker');
assert.match(html, /id="minigamesCommandPreview"/, 'portal should include a generated Discord command');
assert.match(html, /id="minigamesLiveSession"/, 'portal should include tenant live-session status');
assert.match(html, /id="battleModuleSettingsCard"/, "Pilot's Gauntlet settings should remain available in the Minigames workspace");
assert.match(html, /<h3>Pilot's Gauntlet<\/h3>/, "the signature game should use the Pilot's Gauntlet identity");
assert.match(html, /id="battleModulePauseMinInput"/, 'Gauntlet minimum round pause should be configurable');
assert.match(html, /id="battleModulePauseMaxInput"/, 'Gauntlet maximum round pause should be configurable');
assert.match(html, /id="battleModuleElitePrepInput"/, 'Gauntlet final-four preparation should be configurable');
assert.match(html, /id="battleModuleForcedEliminationIntervalInput"/, 'Gauntlet forced elimination should be configurable');
assert.match(html, /id="battleModuleDefaultEraSelect"/, 'Gauntlet default era should be configurable');
assert.match(html, /id="battleModuleEraAvailability"/, 'assigned era availability should be visible');

assert.match(script, /function updateGameNightCommandPreview\(/, 'portal should update the command when the lineup changes');
assert.match(script, /function copyGameNightCommand\(/, 'portal should offer one-click command copying');
assert.match(script, /key: 'codebreaker'/, 'portal fallback roster should include Codebreaker');
assert.match(script, /\/api\/admin\/minigames\/summary/, 'portal should load the tenant-scoped minigames summary');
assert.match(script, /loadMinigamesOverview\(\)/, 'opening the Minigames workspace should load its overview');
assert.match(script, /\/api\/superadmin\/era-assignments/, 'superadmin workspace should manage tenant era assignments');
assert.match(script, /renderWorkspaceEraAssignments\(/, 'superadmin workspace should render custom era assignments');
assert.match(script, /Game identities/, 'superadmin navigation should expose the era workspace');

assert.match(styles, /\.minigames-workspace\s*\{/, 'workspace layout styles should exist');
assert.match(styles, /@media \(max-width: 1050px\)/, 'workspace should define a tablet breakpoint');
assert.match(styles, /\.minigames-workspace \{ grid-template-columns: 1fr; \}/, 'workspace should collapse to one column on narrow screens');
assert.match(styles, /\.minigames-settings-section\s*\{/, 'Gauntlet settings should have clear visual grouping');
assert.match(styles, /@media \(max-width: 760px\)/, 'workspace should define a mobile breakpoint');
assert.match(routes, /router\.get\('\/api\/admin\/minigames\/summary'/, 'server should expose the admin summary endpoint');
assert.match(routes, /ensureMinigamesModule\(req, res\)/, 'summary endpoint should be entitlement protected');

console.log('minigames portal workspace assertions passed');
