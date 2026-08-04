#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'web', 'public');
const read = file => fs.readFileSync(path.join(publicDir, file), 'utf8');
const pages = ['index.html', 'features.html', 'use-cases.html', 'pricing.html'];

for (const page of pages) {
  const source = read(page);
  assert.match(source, /<link rel="stylesheet" href="\/landing\.css">/, `${page} should use the premium public design system`);
  assert.match(source, /<script src="\/landing\.js"><\/script>/, `${page} should use shared CSP-safe interactions`);
  assert.match(source, /data-mobile-menu-toggle/, `${page} should expose the accessible mobile menu control`);
  assert.match(source, /assets\/og-guildpilot\.png/, `${page} should use the branded social card`);
  assert.doesNotMatch(source, /\son(?:click|change|input|submit)=/i, `${page} should not depend on CSP-blocked inline event handlers`);
}

const home = read('index.html');
assert.match(home, /The operating system for <span class="gradient-text">Discord communities\.<\/span>/, 'homepage should explain GuildPilot immediately');
assert.match(home, /product-console/, 'homepage should show a premium product preview in the first viewport');
assert.match(home, /Wallet verification &amp; role automation/, 'homepage should lead with identity verification');
assert.match(home, /Guild Guard/, 'homepage should surface security');
assert.match(home, /AI community assistant/, 'homepage should surface AI support');
assert.match(home, /Pilot's Gauntlet/, 'homepage should use the owned entertainment identity');
assert.doesNotMatch(home, /EVM next|Battle games|Battle Royale|Rumble Royale/i, 'homepage should not use outdated platform or game language');

const features = read('features.html');
for (const section of ['identity', 'security', 'intelligence', 'operations', 'engagement']) {
  assert.ok(features.includes(`id="${section}"`), `features page should include the ${section} capability area`);
}
assert.match(features, /Ethereum, Base, and Robinhood Chain/, 'features page should describe current EVM support');

const useCases = read('use-cases.html');
assert.match(useCases, /persona-grid/, 'use cases should use the new outcome-led layout');
for (const audience of ['NFT projects', 'DAOs', 'Token communities', 'Founders &amp; moderators']) {
  assert.ok(useCases.includes(audience), `use cases should address ${audience}`);
}

const pricing = read('pricing.html');
for (const plan of ['Free', 'Growth', 'Pro', 'Custom plan', 'Enterprise']) {
  assert.ok(pricing.includes(plan), `pricing should present ${plan}`);
}
for (const id of ['billingToggle', 'customPlanBuilder', 'publicCustomPlanModules', 'publicCustomPlanPrice', 'publicCustomPlanContinue']) {
  assert.ok(pricing.includes(`id="${id}"`), `pricing should retain ${id} integration`);
}
assert.match(pricing, /data-open-custom-plan/, 'custom plan builder should use CSP-safe event binding');
assert.match(pricing, /data-faq-toggle/, 'pricing FAQ should use CSP-safe event binding');

const css = read('landing.css');
for (const selector of ['.product-console', '.bento-grid', '.feature-story', '.persona-grid', '.pricing-grid', '.cta-shell']) {
  assert.ok(css.includes(selector), `premium design system should define ${selector}`);
}
assert.match(css, /\.hero-visual\s*\{[^}]*position:\s*relative/, 'floating hero proof cards should be anchored to the product preview');
assert.match(css, /\.hero-proof\s*\{[^}]*grid-template-columns:\s*repeat\(2/, 'hero proof points should use a balanced two-column layout');
assert.match(css, /@media \(max-width: 780px\)/, 'landing design should include mobile behavior');
assert.match(css, /prefers-reduced-motion/, 'landing design should respect reduced motion');

const js = read('landing.js');
assert.match(js, /querySelectorAll\('\[data-mobile-menu-toggle\]'\)/, 'shared script should bind the mobile menu without inline handlers');
assert.match(js, /querySelectorAll\('\[data-faq-toggle\]'\)/, 'shared script should bind FAQs without inline handlers');
assert.match(js, /querySelectorAll\('\[data-open-custom-plan\]'\)/, 'shared script should bind custom pricing without inline handlers');

const previewServer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'preview-portal.mjs'), 'utf8');
for (const routePath of ['/features', '/use-cases', '/pricing', '/privacy-policy', '/terms-of-service']) {
  assert.ok(previewServer.includes(`['${routePath}',`), `local preview should serve the extensionless ${routePath} route`);
}
assert.match(previewServer, /app\.get\('\/docs'/, 'local preview should make the Help link available');
assert.match(previewServer, /app\.get\('\/auth\/discord\/login'/, 'local preview should make sign-in calls navigable');

const socialCard = path.join(publicDir, 'assets', 'og-guildpilot.png');
assert.ok(fs.existsSync(socialCard), 'premium social card should exist');
assert.ok(fs.statSync(socialCard).size > 100_000, 'premium social card should contain a real rendered asset');

console.log('premium public landing page assertions passed');
