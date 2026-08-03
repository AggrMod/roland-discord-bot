/* GuildPilot Public Website — Interactions */
(function () {
  'use strict';
  let publicCustomCatalog = null;

  /* ---- Scroll reveal ---- */
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('visible'); observer.unobserve(e.target); } });
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  );
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));
    document.querySelectorAll('[data-plan-choice]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        continuePublicPlanCheckout(link.dataset.planChoice || 'starter');
      });
    });
    loadPublicCustomPlanCatalog();
  });

  /* ---- Mobile menu ---- */
  window.toggleMobileMenu = function () {
    const menu = document.getElementById('mobileMenu');
    if (menu) menu.classList.toggle('active');
  };

  /* ---- FAQ accordion ---- */
  window.toggleFaq = function (btn) {
    const item = btn.closest('.faq-item');
    if (!item) return;
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach((i) => i.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  };

  /* ---- Pricing toggle ---- */
  window.togglePricingPeriod = function (toggle) {
    const annual = toggle.checked;
    document.querySelectorAll('[data-monthly]').forEach((el) => {
      const monthly = parseFloat(el.dataset.monthly);
      if (monthly === 0) { el.textContent = 'Free'; return; }
      if (isNaN(monthly)) { el.textContent = 'Custom'; return; }
      if (annual) {
        const discounted = (monthly * (10 / 12)).toFixed(2);
        el.textContent = '$' + discounted;
      } else {
        el.textContent = '$' + monthly.toFixed(2);
      }
    });
    document.querySelectorAll('.price .period').forEach((el) => {
      el.textContent = annual ? '/mo (billed annually)' : '/mo';
    });
    if (document.getElementById('publicCustomPlanPrice')) window.updatePublicCustomPlanQuote();
  };

  function escapePublicHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
  }

  async function loadPublicCustomPlanCatalog() {
    const host = document.getElementById('publicCustomPlanModules');
    if (!host) return;
    try {
      const response = await fetch('/api/plans/catalog', { credentials: 'same-origin' });
      const data = await response.json();
      const custom = (data?.plans || []).find(plan => String(plan?.key || '').toLowerCase() === 'custom');
      publicCustomCatalog = custom?.customBuilder || null;
      if (!publicCustomCatalog) throw new Error('Custom plan catalog is unavailable');
      host.innerHTML = (publicCustomCatalog.modules || []).map(module => `
        <div class="custom-plan-builder__module">
          <label><input type="checkbox" data-public-custom-module="${escapePublicHtml(module.key)}" onchange="updatePublicCustomPlanQuote()"><span><strong>${escapePublicHtml(module.label || module.key)}</strong><small>From $${Number(module.monthlyUsd || 0).toFixed(2)} / month</small></span></label>
          <select data-public-custom-capacity="${escapePublicHtml(module.key)}" onchange="updatePublicCustomPlanQuote()">
            ${(publicCustomCatalog.capacities || []).map(capacity => `<option value="${escapePublicHtml(capacity.key)}">${escapePublicHtml(capacity.label || capacity.key)}</option>`).join('')}
          </select>
        </div>
      `).join('');
    } catch (error) {
      host.innerHTML = `<div class="custom-plan-builder__loading">${escapePublicHtml(error.message || 'Failed to load custom pricing.')}</div>`;
    }
  }

  function readPublicCustomPlan() {
    const modules = [];
    document.querySelectorAll('[data-public-custom-module]').forEach(input => {
      if (!input.checked) return;
      const key = String(input.dataset.publicCustomModule || '');
      const capacity = document.querySelector(`[data-public-custom-capacity="${key}"]`)?.value || 'growth';
      modules.push({ key, capacity });
    });
    return { version: 1, modules };
  }

  function calculatePublicCustomMonthly(config) {
    if (!publicCustomCatalog) return 0;
    const moduleMap = new Map((publicCustomCatalog.modules || []).map(module => [String(module.key || ''), Number(module.monthlyUsd || 0)]));
    const capacityMap = new Map((publicCustomCatalog.capacities || []).map(capacity => [String(capacity.key || ''), Number(capacity.multiplier || 1)]));
    const raw = (config?.modules || []).reduce((sum, module) => sum + ((moduleMap.get(module.key) || 0) * (capacityMap.get(module.capacity) || 1)), Number(publicCustomCatalog.platformBaseMonthlyUsd || 0));
    return Number(Math.max(Number(publicCustomCatalog.minimumMonthlyUsd || 0), raw).toFixed(2));
  }

  window.openCustomPlanBuilder = function () {
    const builder = document.getElementById('customPlanBuilder');
    if (!builder) return;
    builder.hidden = false;
    builder.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.updatePublicCustomPlanQuote();
  };

  window.updatePublicCustomPlanQuote = function () {
    const config = readPublicCustomPlan();
    const monthly = calculatePublicCustomMonthly(config);
    const annual = !!document.getElementById('billingToggle')?.checked;
    const price = document.getElementById('publicCustomPlanPrice');
    const annualNote = document.getElementById('publicCustomPlanAnnual');
    const continueButton = document.getElementById('publicCustomPlanContinue');
    if (price) price.textContent = config.modules.length ? (annual ? `$${(monthly * 10).toFixed(2)} / year` : `$${monthly.toFixed(2)} / month`) : 'Select a module';
    if (annualNote) annualNote.textContent = annual ? '12 months of access, billed as 10' : 'Switch to annual billing for 2 free months';
    if (continueButton) continueButton.disabled = config.modules.length === 0;
  };

  function continuePublicPlanCheckout(planKey, customPlan = null) {
    const interval = document.getElementById('billingToggle')?.checked ? 'yearly' : 'monthly';
    try {
      localStorage.setItem('guildpilotPlanIntent', JSON.stringify({
        planKey,
        billingInterval: interval,
        customPlan,
        createdAt: new Date().toISOString(),
      }));
    } catch (_error) {}
    window.location.href = `/auth/discord/login?returnTo=${encodeURIComponent('/app?section=plans')}`;
  }

  window.continueCustomPlanCheckout = function () {
    const config = readPublicCustomPlan();
    if (!config.modules.length) return;
    continuePublicPlanCheckout('custom', config);
  };

  /* ---- Nav scroll effect ---- */
  window.addEventListener('scroll', () => {
    const nav = document.querySelector('.pub-nav');
    if (!nav) return;
    const scrollY = window.scrollY;
    if (scrollY > 100) { nav.style.background = 'rgba(7,10,18,0.95)'; }
    else { nav.style.background = 'rgba(7,10,18,0.85)'; }
  }, { passive: true });

  /* ---- Smooth scroll for anchor links ---- */
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="#"]');
    if (!link) return;
    const target = document.querySelector(link.getAttribute('href'));
    if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth' }); }
    const menu = document.getElementById('mobileMenu');
    if (menu && menu.classList.contains('active')) menu.classList.remove('active');
  });
})();
