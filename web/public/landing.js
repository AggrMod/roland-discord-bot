/* GuildPilot Public Website — Interactions */
(function () {
  'use strict';

  /* ---- Scroll reveal ---- */
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('visible'); observer.unobserve(e.target); } });
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  );
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));
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
        const discounted = (monthly * 0.85).toFixed(2);
        el.textContent = '$' + discounted;
      } else {
        el.textContent = '$' + monthly.toFixed(2);
      }
    });
    document.querySelectorAll('.price .period').forEach((el) => {
      el.textContent = annual ? '/mo (billed annually)' : '/mo';
    });
  };

  /* ---- Nav scroll effect ---- */
  let lastScroll = 0;
  window.addEventListener('scroll', () => {
    const nav = document.querySelector('.pub-nav');
    if (!nav) return;
    const scrollY = window.scrollY;
    if (scrollY > 100) { nav.style.background = 'rgba(7,10,18,0.95)'; }
    else { nav.style.background = 'rgba(7,10,18,0.85)'; }
    lastScroll = scrollY;
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
