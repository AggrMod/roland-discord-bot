/* GuildPilot public website interactions */
(function () {
  'use strict';

  let publicCustomCatalog = null;

  function escapePublicHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
  }

  function setMobileMenu(open) {
    const menu = document.getElementById('mobileMenu');
    if (!menu) return;
    menu.classList.toggle('active', open);
    menu.setAttribute('aria-hidden', open ? 'false' : 'true');
    document.body.classList.toggle('menu-open', open);
    document.querySelectorAll('[data-mobile-menu-toggle]').forEach((button) => {
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  function initializeReveal() {
    const revealItems = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      revealItems.forEach((item) => item.classList.add('visible'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -36px 0px' });
    revealItems.forEach((item) => observer.observe(item));
  }

  function toggleFaq(button) {
    const item = button.closest('.faq-item');
    if (!item) return;
    const shouldOpen = !item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach((openItem) => {
      openItem.classList.remove('open');
      openItem.querySelector('[data-faq-toggle]')?.setAttribute('aria-expanded', 'false');
    });
    if (shouldOpen) {
      item.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
    }
  }

  function updatePricingPeriod(toggle) {
    const annual = !!toggle?.checked;
    document.querySelectorAll('[data-monthly]').forEach((element) => {
      const monthly = Number.parseFloat(element.dataset.monthly);
      if (monthly === 0) { element.textContent = 'Free'; return; }
      if (!Number.isFinite(monthly)) { element.textContent = 'Custom'; return; }
      element.textContent = annual ? `$${(monthly * (10 / 12)).toFixed(2)}` : `$${monthly.toFixed(2)}`;
    });
    document.querySelectorAll('.price .period').forEach((element) => {
      element.textContent = annual ? '/mo · yearly' : '/mo';
    });
    if (document.getElementById('publicCustomPlanPrice')) updatePublicCustomPlanQuote();
  }

  async function loadPublicCustomPlanCatalog() {
    const host = document.getElementById('publicCustomPlanModules');
    if (!host) return;
    try {
      const response = await fetch('/api/plans/catalog', { credentials: 'same-origin' });
      const data = await response.json();
      const custom = (data?.plans || []).find((plan) => String(plan?.key || '').toLowerCase() === 'custom');
      publicCustomCatalog = custom?.customBuilder || null;
      if (!response.ok || !publicCustomCatalog) throw new Error('Custom plan catalog is unavailable');
      host.innerHTML = (publicCustomCatalog.modules || []).map((module) => `
        <div class="custom-plan-builder__module">
          <label>
            <input type="checkbox" data-public-custom-module="${escapePublicHtml(module.key)}">
            <span><strong>${escapePublicHtml(module.label || module.key)}</strong><small>From $${Number(module.monthlyUsd || 0).toFixed(2)} / month</small></span>
          </label>
          <select data-public-custom-capacity="${escapePublicHtml(module.key)}" aria-label="${escapePublicHtml(module.label || module.key)} capacity">
            ${(publicCustomCatalog.capacities || []).map((capacity) => `<option value="${escapePublicHtml(capacity.key)}">${escapePublicHtml(capacity.label || capacity.key)}</option>`).join('')}
          </select>
        </div>
      `).join('');
      host.querySelectorAll('input, select').forEach((input) => input.addEventListener('change', updatePublicCustomPlanQuote));
    } catch (error) {
      host.innerHTML = `<div class="custom-plan-builder__loading">${escapePublicHtml(error.message || 'Failed to load custom pricing.')}</div>`;
    }
  }

  function readPublicCustomPlan() {
    const modules = [];
    document.querySelectorAll('[data-public-custom-module]').forEach((input) => {
      if (!input.checked) return;
      const key = String(input.dataset.publicCustomModule || '');
      const selector = `[data-public-custom-capacity="${CSS.escape(key)}"]`;
      const capacity = document.querySelector(selector)?.value || 'growth';
      modules.push({ key, capacity });
    });
    return { version: 1, modules };
  }

  function calculatePublicCustomMonthly(config) {
    if (!publicCustomCatalog) return 0;
    const moduleMap = new Map((publicCustomCatalog.modules || []).map((module) => [String(module.key || ''), Number(module.monthlyUsd || 0)]));
    const capacityMap = new Map((publicCustomCatalog.capacities || []).map((capacity) => [String(capacity.key || ''), Number(capacity.multiplier || 1)]));
    const raw = (config?.modules || []).reduce((sum, module) => sum + ((moduleMap.get(module.key) || 0) * (capacityMap.get(module.capacity) || 1)), Number(publicCustomCatalog.platformBaseMonthlyUsd || 0));
    return Number(Math.max(Number(publicCustomCatalog.minimumMonthlyUsd || 0), raw).toFixed(2));
  }

  function updatePublicCustomPlanQuote() {
    const config = readPublicCustomPlan();
    const monthly = calculatePublicCustomMonthly(config);
    const annual = !!document.getElementById('billingToggle')?.checked;
    const price = document.getElementById('publicCustomPlanPrice');
    const annualNote = document.getElementById('publicCustomPlanAnnual');
    const continueButton = document.getElementById('publicCustomPlanContinue');
    if (price) price.textContent = config.modules.length ? (annual ? `$${(monthly * 10).toFixed(2)} / year` : `$${monthly.toFixed(2)} / month`) : 'Select a module';
    if (annualNote) annualNote.textContent = annual ? '12 months of access, billed as 10' : 'Switch to annual billing for 2 free months';
    if (continueButton) continueButton.disabled = config.modules.length === 0;
  }

  function openCustomPlanBuilder() {
    const builder = document.getElementById('customPlanBuilder');
    if (!builder) return;
    builder.hidden = false;
    builder.scrollIntoView({ behavior: 'smooth', block: 'start' });
    updatePublicCustomPlanQuote();
  }

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

  function continueCustomPlanCheckout() {
    const config = readPublicCustomPlan();
    if (!config.modules.length) return;
    continuePublicPlanCheckout('custom', config);
  }

  function updateNavState() {
    document.getElementById('publicNav')?.classList.toggle('is-scrolled', window.scrollY > 32);
  }

  document.addEventListener('DOMContentLoaded', () => {
    initializeReveal();
    updateNavState();
    loadPublicCustomPlanCatalog();

    document.querySelectorAll('[data-mobile-menu-toggle]').forEach((button) => {
      button.addEventListener('click', () => setMobileMenu(!document.getElementById('mobileMenu')?.classList.contains('active')));
    });
    document.querySelectorAll('#mobileMenu a').forEach((link) => link.addEventListener('click', () => setMobileMenu(false)));
    document.querySelectorAll('[data-faq-toggle]').forEach((button) => button.addEventListener('click', () => toggleFaq(button)));
    document.querySelectorAll('[data-pricing-toggle]').forEach((toggle) => toggle.addEventListener('change', () => updatePricingPeriod(toggle)));
    document.querySelectorAll('[data-open-custom-plan]').forEach((button) => button.addEventListener('click', openCustomPlanBuilder));
    document.querySelectorAll('[data-continue-custom-plan]').forEach((button) => button.addEventListener('click', continueCustomPlanCheckout));
    document.querySelectorAll('[data-plan-choice]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        continuePublicPlanCheckout(link.dataset.planChoice || 'starter');
      });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setMobileMenu(false);
    });
  });

  window.addEventListener('scroll', updateNavState, { passive: true });
})();
