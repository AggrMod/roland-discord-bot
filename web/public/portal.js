// ==================== PORTAL STATE MANAGEMENT ====================
let userData = null;
let isAdmin = false;
let isSuperadmin = false;
let heistEnabled = false;
let confirmCallback = null;
let activeGuildId = localStorage.getItem('activeGuildId') || '';
let serverAccessData = { managedServers: [], unmanagedServers: [], isSuperadmin: false };
let originalFetch = window.fetch.bind(window);
let _csrfToken = '';
let currentPlanSnapshot = null;
const _portalMultiSelectRegistry = new Map();
let _portalMultiSelectAutoId = 0;
let _portalMultiSelectPickerState = null;
const PORTAL_PAGE_EXPECTATIONS = Object.freeze({
  sections: [
    'landing',
    'dashboard',
    'servers',
    'governance',
    'wallets',
    'heist',
    'nft-activity',
    'token-activity',
    'battle',
    'engagement',
    'self-serve-roles',
    'ticketing',
    'treasury',
    'help',
    'admin',
    'plans',
    'settings'
  ],
  adminCards: [
    'adminStatsCard',
    'adminUsersCard',
    'adminProposalsCard',
    'adminSettingsCard',
    'adminSuperadminCard',
    'adminSystemMonitorCard',
    'adminVotingPowerCard',
    'adminNftTrackerCard',
    'adminInviteTrackerCard',
    'adminSelfServeRolesCard',
    'adminAnalyticsCard',
    'adminHelpCard',
    'adminActivityCard',
    'adminRolesCard',
    'adminApiRefCard',
    'adminTicketingCard',
    'adminEngagementCard'
  ],
  settingsTabs: [
    'general',
    'governance',
    'verification',
    'branding',
    'treasury',
    'invites',
    'nfttracker',
    'tokentracker',
    'battle',
    'heist',
    'selfserve',
    'ticketing',
    'engagement'
  ]
});
async function fetchCsrfToken() {
  try {
    const r = await originalFetch('/api/csrf-token', { credentials: 'include' });
    const d = await r.json();
    _csrfToken = d.token || '';
  } catch(_) {}
}

function normalizeGuildId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : '';
}

activeGuildId = normalizeGuildId(activeGuildId);
if (!activeGuildId) {
  localStorage.removeItem('activeGuildId');
}

// ── Auto-select guild from URL param (?guild=GUILDID) ──────────────────
// Lets Discord bot post links like /?guild=123&section=dashboard
// and the user lands with the right server already selected.
(function applyUrlGuildContext() {
  const up = new URLSearchParams(window.location.search);
  const urlGuild = normalizeGuildId(up.get('guild') || '');
  if (urlGuild && urlGuild !== activeGuildId) {
    activeGuildId = urlGuild;
    localStorage.setItem('activeGuildId', activeGuildId);
  }
})();

function requiresServerSelectionGate() {
  const managed = serverAccessData?.managedServers || [];
  const unmanaged = serverAccessData?.unmanagedServers || [];
  const hasAnyServerContext = (managed.length + unmanaged.length) > 0;
  return !!userData && hasAnyServerContext && !activeGuildId;
}

function isTenantSensitiveRequest(input) {
  const rawUrl = typeof input === 'string' ? input : (input?.url || '');
  try {
    const url = new URL(rawUrl, window.location.origin);
    return (
      url.pathname.startsWith('/api/admin/') ||
      url.pathname.startsWith('/api/user/') ||
      url.pathname === '/api/user/proposals' ||
      url.pathname === '/api/governance/proposals' ||
      /^\/api\/governance\/proposals\/[^/]+\/(submit|support|comments|veto)$/.test(url.pathname) ||
      url.pathname.startsWith('/api/public/v1/') ||
      url.pathname.startsWith('/api/verify/') ||
      url.pathname.startsWith('/api/micro-verify/') ||
      url.pathname.startsWith('/api/verification/admin/') ||
      url.pathname === '/api/user/is-admin'
    );
  } catch (error) {
    return false;
  }
}

function buildTenantRequestHeaders(initHeaders) {
  const headers = new Headers(initHeaders || {});
  if (activeGuildId && !headers.has('x-guild-id')) {
    headers.set('x-guild-id', activeGuildId);
  }
  return headers;
}

function buildPublicV1Url(pathname, { requireGuild = false } = {}) {
  const cleanPath = String(pathname || '').trim();
  if (!cleanPath.startsWith('/api/public/v1/')) {
    return cleanPath;
  }

  if (requireGuild && !activeGuildId) {
    return null;
  }

  const url = new URL(cleanPath, window.location.origin);
  if (activeGuildId && !url.searchParams.has('guildId')) {
    url.searchParams.set('guildId', activeGuildId);
  }
  return `${url.pathname}${url.search}`;
}

function ensurePortalMultiSelectId(select) {
  if (select.id) return select.id;
  _portalMultiSelectAutoId += 1;
  select.id = `gpMultiSelect_${_portalMultiSelectAutoId}`;
  return select.id;
}

function getPortalMultiSelectOptions(select) {
  return Array.from(select.options || [])
    .filter(opt => !!String(opt.value || '').trim())
    .map(opt => ({
      value: String(opt.value || '').trim(),
      label: String(opt.textContent || '').trim(),
      group: opt.parentElement && opt.parentElement.tagName === 'OPTGROUP'
        ? String(opt.parentElement.label || '').trim()
        : '',
      disabled: !!opt.disabled,
    }));
}

function getPortalMultiSelectValues(select) {
  return Array.from(select.selectedOptions || [])
    .map(opt => String(opt.value || '').trim())
    .filter(Boolean);
}

function setPortalMultiSelectValues(select, values) {
  const allowed = new Set((Array.isArray(values) ? values : []).map(v => String(v || '').trim()).filter(Boolean));
  Array.from(select.options || []).forEach(opt => {
    const value = String(opt.value || '').trim();
    opt.selected = !!value && allowed.has(value);
  });
}

function getPortalMultiSelectPlaceholder(select) {
  return String(select.dataset.msPlaceholder || '').trim() || 'Select one or more';
}

function getPortalMultiSelectTitle(select) {
  const explicit = String(select.dataset.msTitle || '').trim();
  if (explicit) return explicit;
  const labelEl = select.closest('div')?.querySelector('label');
  const labelText = String(labelEl?.textContent || '').trim();
  return labelText || 'Select options';
}

function refreshPortalMultiSelectControl(selectOrId) {
  const select = typeof selectOrId === 'string' ? document.getElementById(selectOrId) : selectOrId;
  if (!select) return;
  const id = ensurePortalMultiSelectId(select);
  const state = _portalMultiSelectRegistry.get(id);
  if (!state || !state.control || !state.trigger || !state.chips) return;

  const selected = getPortalMultiSelectValues(select);
  const optionMap = new Map(getPortalMultiSelectOptions(select).map(item => [item.value, item]));
  const labels = selected.map(value => optionMap.get(value)?.label || value);

  state.trigger.textContent = labels.length
    ? `${labels.length} selected`
    : getPortalMultiSelectPlaceholder(select);
  state.trigger.classList.toggle('is-empty', labels.length === 0);
  state.trigger.disabled = !!select.disabled;

  if (!labels.length) {
    state.chips.innerHTML = '';
    return;
  }

  const maxChips = 4;
  const visible = labels.slice(0, maxChips);
  const extra = labels.length - visible.length;
  const chipsHtml = visible.map(label => `<span class="gp-ms-chip">${escapeHtml(label)}</span>`).join('');
  state.chips.innerHTML = chipsHtml + (extra > 0 ? `<span class="gp-ms-chip muted">+${extra} more</span>` : '');
}

function closePortalMultiSelectPicker(applyChanges = false) {
  const state = _portalMultiSelectPickerState;
  if (!state) return;

  if (applyChanges && state.select) {
    setPortalMultiSelectValues(state.select, Array.from(state.selected || []));
    state.select.dispatchEvent(new Event('change', { bubbles: true }));
    refreshPortalMultiSelectControl(state.select);
  }

  state.overlay?.remove();
  _portalMultiSelectPickerState = null;
}

function openPortalMultiSelectPicker(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;

  const options = getPortalMultiSelectOptions(select).filter(item => !item.disabled);
  const selected = new Set(getPortalMultiSelectValues(select));

  closePortalMultiSelectPicker(false);

  const overlay = document.createElement('div');
  overlay.className = 'gp-ms-overlay';
  overlay.innerHTML = `
    <div class="gp-ms-modal" role="dialog" aria-modal="true">
      <div class="gp-ms-header">
        <h3 class="gp-ms-title">${escapeHtml(getPortalMultiSelectTitle(select))}</h3>
        <button type="button" class="gp-ms-close" aria-label="Close">×</button>
      </div>
      <div class="gp-ms-toolbar">
        <input type="text" class="gp-ms-search" placeholder="Search..." />
        <button type="button" class="gp-ms-ghost" data-action="select-all">Select All</button>
        <button type="button" class="gp-ms-ghost" data-action="clear">Clear</button>
      </div>
      <div class="gp-ms-list"></div>
      <div class="gp-ms-footer">
        <span class="gp-ms-count">0 selected</span>
        <div class="gp-ms-actions">
          <button type="button" class="btn-secondary gp-ms-cancel">Cancel</button>
          <button type="button" class="btn-primary gp-ms-apply">Done</button>
        </div>
      </div>
    </div>
  `;

  const modal = overlay.querySelector('.gp-ms-modal');
  const searchEl = overlay.querySelector('.gp-ms-search');
  const listEl = overlay.querySelector('.gp-ms-list');
  const countEl = overlay.querySelector('.gp-ms-count');

  const updateCount = () => {
    const amount = selected.size;
    countEl.textContent = `${amount} selected`;
  };

  const renderList = (query = '') => {
    const q = String(query || '').trim().toLowerCase();
    const filtered = options.filter(item => {
      if (!q) return true;
      const hay = `${item.label} ${item.group}`.toLowerCase();
      return hay.includes(q);
    });

    if (!filtered.length) {
      listEl.innerHTML = '<div class="gp-ms-empty">No matches found.</div>';
      return;
    }

    listEl.innerHTML = filtered.map(item => `
      <label class="gp-ms-item">
        <input type="checkbox" value="${escapeHtml(item.value)}" ${selected.has(item.value) ? 'checked' : ''}>
        <div class="gp-ms-item-copy">
          <span class="gp-ms-item-label">${escapeHtml(item.label)}</span>
          ${item.group ? `<span class="gp-ms-item-group">${escapeHtml(item.group)}</span>` : ''}
        </div>
      </label>
    `).join('');

    listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(cb.value);
        else selected.delete(cb.value);
        updateCount();
      });
    });
  };

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closePortalMultiSelectPicker(false);
  });
  overlay.querySelector('.gp-ms-close')?.addEventListener('click', () => closePortalMultiSelectPicker(false));
  overlay.querySelector('.gp-ms-cancel')?.addEventListener('click', () => closePortalMultiSelectPicker(false));
  overlay.querySelector('.gp-ms-apply')?.addEventListener('click', () => closePortalMultiSelectPicker(true));
  overlay.querySelector('[data-action="clear"]')?.addEventListener('click', () => {
    selected.clear();
    renderList(searchEl.value);
    updateCount();
  });
  overlay.querySelector('[data-action="select-all"]')?.addEventListener('click', () => {
    const q = String(searchEl.value || '').trim().toLowerCase();
    options.forEach(item => {
      const hay = `${item.label} ${item.group}`.toLowerCase();
      if (!q || hay.includes(q)) selected.add(item.value);
    });
    renderList(searchEl.value);
    updateCount();
  });
  searchEl?.addEventListener('input', () => renderList(searchEl.value));

  document.body.appendChild(overlay);
  _portalMultiSelectPickerState = { select, selected, overlay };
  renderList('');
  updateCount();
  setTimeout(() => searchEl?.focus(), 0);
}

function initializePortalMultiSelects(scope = document) {
  const root = (scope && typeof scope.querySelectorAll === 'function') ? scope : document;
  root.querySelectorAll('select[multiple]').forEach(select => {
    const id = ensurePortalMultiSelectId(select);
    const existing = _portalMultiSelectRegistry.get(id);

    if (existing && existing.select !== select) {
      existing.control?.remove();
      _portalMultiSelectRegistry.delete(id);
    }

    if (!_portalMultiSelectRegistry.has(id)) {
      const control = document.createElement('div');
      control.className = 'gp-ms-control';
      control.innerHTML = `
        <button type="button" class="gp-ms-trigger is-empty"></button>
        <div class="gp-ms-chips"></div>
      `;
      const trigger = control.querySelector('.gp-ms-trigger');
      const chips = control.querySelector('.gp-ms-chips');
      trigger?.addEventListener('click', () => openPortalMultiSelectPicker(id));

      select.insertAdjacentElement('afterend', control);
      _portalMultiSelectRegistry.set(id, { select, control, trigger, chips });

      select.addEventListener('change', () => refreshPortalMultiSelectControl(select));
      select.classList.add('gp-ms-native');
    }

    refreshPortalMultiSelectControl(select);
  });
}

window.fetch = async function(input, init = {}) {
  const headers = buildTenantRequestHeaders(init.headers || (input instanceof Request ? input.headers : undefined));

  // Attach CSRF headers to all state-changing requests
  const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers.set('X-Requested-With', 'XMLHttpRequest');
    if (_csrfToken) {
      headers.set('x-csrf-token', _csrfToken);
    }
  }

  const shouldAttachGuild = isTenantSensitiveRequest(input);
  if (!shouldAttachGuild && method === 'GET') {
    return originalFetch(input, init);
  }

  return originalFetch(input, { ...init, headers });
};

function initializePortalPages() {
  const missing = [];
  const existingSections = [];
  const existingAdminCards = [];
  const existingSettingsTabs = [];

  PORTAL_PAGE_EXPECTATIONS.sections.forEach(section => {
    const sectionId = `section-${section}`;
    const sectionEl = document.getElementById(sectionId);
    if (!sectionEl) {
      missing.push(sectionId);
      return;
    }
    sectionEl.dataset.page = section;
    existingSections.push(section);
  });

  PORTAL_PAGE_EXPECTATIONS.adminCards.forEach(cardId => {
    if (!document.getElementById(cardId)) {
      missing.push(cardId);
      return;
    }
    existingAdminCards.push(cardId);
  });

  PORTAL_PAGE_EXPECTATIONS.settingsTabs.forEach(tab => {
    const paneId = `settingsTab-${tab}`;
    if (!document.getElementById(paneId)) {
      missing.push(paneId);
      return;
    }
    existingSettingsTabs.push(tab);
  });

  window._portalPageInventory = {
    initializedAt: new Date().toISOString(),
    sections: existingSections,
    adminCards: existingAdminCards,
    settingsTabs: existingSettingsTabs
  };

  if (document.body) {
    document.body.setAttribute('data-portal-pages-initialized', 'true');
  }

  if (missing.length > 0) {
    console.warn('Portal page initialization missing expected elements:', missing.join(', '));
  }
}

function normalizePortalSectionName(sectionName) {
  const requested = String(sectionName || '').trim();
  if (!requested) return 'landing';
  return PORTAL_PAGE_EXPECTATIONS.sections.includes(requested) ? requested : 'landing';
}

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
  initializePortalPages();
  initializePortalMultiSelects();
  fetchCsrfToken();
  loadPortal();

  // Close mobile menu when clicking outside
  document.getElementById('mobileMenu')?.addEventListener('click', (e) => {
    if (e.target.id === 'mobileMenu') {
      toggleMobileMenu();
    }
  });

  // Close modal when clicking outside
  document.getElementById('confirmModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'confirmModal') {
      closeConfirmModal();
    }
  });

  document.getElementById('walletVerifyModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'walletVerifyModal') {
      closeWalletVerifyModal();
    }
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (_portalMultiSelectPickerState) {
        closePortalMultiSelectPicker(false);
        return;
      }

      const mobileMenu = document.getElementById('mobileMenu');
      const confirmModal = document.getElementById('confirmModal');
      const walletVerifyModal = document.getElementById('walletVerifyModal');
      
      if (mobileMenu && mobileMenu.style.display === 'block') {
        toggleMobileMenu();
      } else if (confirmModal && confirmModal.style.display !== 'none') {
        closeConfirmModal();
      } else if (walletVerifyModal && walletVerifyModal.style.display !== 'none') {
        closeWalletVerifyModal();
      }
    }
  });
});

// ==================== WALLET MANAGEMENT ====================
function showWalletAddForm() {
  if (!userData) {
    showError('Please log in first to verify a wallet');
    return;
  }

  const modal = document.getElementById('walletVerifyModal');
  if (!modal) return;

  const signBtn = document.getElementById('signVerifyBtn');
  if (signBtn) {
    signBtn.disabled = false;
    signBtn.innerHTML = '✓ Connect & Sign';
  }

  const microBtn = document.getElementById('microVerifyBtn');
  if (microBtn) {
    microBtn.disabled = false;
    microBtn.innerHTML = '🔑 Generate Proof Address';
  }

  const statusEl = document.getElementById('verifyStatus');
  if (statusEl) statusEl.innerHTML = '';

  const mobilePanel = document.getElementById('mobileWalletLaunchPanel');
  if (mobilePanel) mobilePanel.innerHTML = '';

  modal.style.display = 'flex';

  // Mobile helper for opening this page directly inside wallet apps
  renderMobileWalletLaunchPanel();

  // Auto-show any pending micro-verify request so user doesn't need to click again
  autoShowPendingMicroVerify();
}

function closeWalletVerifyModal() {
  const modal = document.getElementById('walletVerifyModal');
  if (!modal) return;
  modal.style.display = 'none';
}

function startWalletVerification(method = 'signature') {
  if (!userData) {
    showInfo('Login required. Redirecting to Discord...');
    login();
    return;
  }

  showWalletAddForm();

  // Let the verification cards render before triggering the selected flow.
  setTimeout(() => {
    if (method === 'micro') {
      verifyByMicroTx();
      return;
    }
    verifyBySignature();
  }, 40);
}

async function autoShowPendingMicroVerify() {
  try {
    const res = await fetch('/api/micro-verify/status', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.success || !data.request || data.request.status !== 'pending') return;

    const r = data.request;
    const expiryDisplay = r.expiresAt ? new Date(r.expiresAt).toLocaleTimeString() : `${r.timeLeftMinutes || 15} min`;
    const statusEl = document.getElementById('verifyStatus');
    if (!statusEl) return;

    statusEl.innerHTML = `
      <div style="margin-top:20px; padding:24px; background:rgba(99,102,241,0.08); border:2px solid rgba(99,102,241,0.35); border-radius:14px;">
        <h4 style="color:#e0e7ff; margin:0 0 4px 0; font-size:1.05em;">🔐 NFT Ownership Proof — Awaiting On-Chain Confirmation</h4>
        <p style="color:var(--text-secondary); font-size:0.82em; margin:0 0 14px 0;">Your unique proof amount has been generated. Complete the on-chain confirmation to verify NFT membership. We confirm wallet ownership only — no passwords or personal data collected. <a href="/privacy-policy" target="_blank" style="color:#a5b4fc;">Privacy Policy</a></p>

        <div style="margin-bottom:14px;">
          <p style="color:var(--text-secondary); font-size:0.82em; margin:0 0 6px 0; text-transform:uppercase; letter-spacing:0.05em;">Amount (exact)</p>
          <div style="display:flex; align-items:center; gap:10px; background:rgba(0,0,0,0.3); border:1px solid rgba(99,102,241,0.25); border-radius:8px; padding:12px 14px;">
            <span style="color:#fbbf24; font-size:1.2em; font-weight:700; font-family:monospace; flex:1;">${r.amount} SOL</span>
            <button onclick="navigator.clipboard.writeText('${escapeJsString(r.amount)}'); showSuccess('Amount copied!');" style="background:rgba(99,102,241,0.2); border:1px solid rgba(99,102,241,0.3); border-radius:6px; color:#a5b4fc; padding:6px 12px; cursor:pointer; font-size:0.8em;">Copy</button>
          </div>
        </div>

        <div style="margin-bottom:20px;">
          <p style="color:var(--text-secondary); font-size:0.82em; margin:0 0 6px 0; text-transform:uppercase; letter-spacing:0.05em;">Community Proof Address</p>
          <div style="display:flex; align-items:center; gap:10px; background:rgba(0,0,0,0.3); border:1px solid rgba(99,102,241,0.25); border-radius:8px; padding:12px 14px;">
            <span style="color:#c7d2fe; font-size:0.88em; font-family:monospace; flex:1; word-break:break-all;">${r.destinationWallet}</span>
            <button onclick="navigator.clipboard.writeText('${escapeJsString(r.destinationWallet)}'); showSuccess('Address copied!');" style="background:rgba(99,102,241,0.2); border:1px solid rgba(99,102,241,0.3); border-radius:6px; color:#a5b4fc; padding:6px 12px; cursor:pointer; font-size:0.8em;">Copy</button>
          </div>
        </div>

        <div style="background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.25); border-radius:8px; padding:12px 14px; margin-bottom:20px;">
          <p style="color:#c7d2fe; font-size:0.85em; margin:0;">ℹ️ Use the <strong>exact proof amount</strong> above — it's your unique membership identifier. Compatible with any Solana wallet. Proof expires at <strong>${expiryDisplay}</strong>.</p>
        </div>

        <div style="text-align:center;">
          <div style="display:flex; align-items:center; justify-content:center; gap:10px; color:var(--text-secondary); margin-bottom:12px;">
            <div class="spinner" style="width:18px; height:18px;"></div>
            <span style="font-size:0.9em;">Awaiting on-chain confirmation...</span>
          </div>
          <button onclick="manualCheckMicroVerify(document.getElementById('verifyStatus'))" style="background:none; border:1px solid rgba(99,102,241,0.3); border-radius:6px; color:#a5b4fc; padding:6px 14px; cursor:pointer; font-size:0.82em;">↻ Check status</button>
        </div>
      </div>`;

    pollMicroVerifyStatus(statusEl);
  } catch (e) { /* silent — user just won't see auto-loaded panel */ }
}

// Detect available Solana wallet provider
function getSolanaProvider() {
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solflare?.isSolflare) return window.solflare;
  if (window.solflare?.solana?.isSolflare) return window.solflare.solana;
  if (window.backpack?.isBackpack) return window.backpack;
  if (window.solana) return window.solana;
  return null;
}

function extractWalletAddress(provider, connectResp) {
  const candidates = [
    connectResp?.publicKey,
    provider?.publicKey,
    connectResp?.wallet?.publicKey,
    connectResp?.address,
    provider?.address
  ];

  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'string') return c;
    if (typeof c.toString === 'function') {
      const s = c.toString();
      if (s && s !== '[object Object]') return s;
    }
  }
  return null;
}

function isMobileWalletContext() {
  const ua = navigator.userAgent || '';
  const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches;
  const touchMac = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  return /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(ua) || !!coarsePointer || touchMac;
}

function getDetectedWalletProviderName(provider = getSolanaProvider()) {
  if (!provider) return '';
  if (provider.isPhantom || window.phantom?.solana === provider) return 'Phantom';
  if (provider.isSolflare || window.solflare === provider || window.solflare?.solana === provider) return 'Solflare';
  if (provider.isBackpack || window.backpack === provider) return 'Backpack';
  return 'Wallet';
}

function getWalletSectionUrl() {
  const url = new URL('/?section=wallets', window.location.origin);
  if (activeGuildId) url.searchParams.set('guild', activeGuildId);
  return url.toString();
}

function getWalletBrowseDeepLink(walletKey, targetUrl) {
  const encodedUrl = encodeURIComponent(targetUrl);
  const encodedRef = encodeURIComponent(window.location.origin);
  const routes = {
    phantom: `https://phantom.app/ul/browse/${encodedUrl}?ref=${encodedRef}`,
    solflare: `https://solflare.com/ul/v1/browse/${encodedUrl}?ref=${encodedRef}`,
    backpack: `https://backpack.app/ul/v1/browse/${encodedUrl}?ref=${encodedRef}`
  };
  return routes[walletKey] || '';
}

function launchWalletBrowser(walletKey) {
  const deepLink = getWalletBrowseDeepLink(walletKey, getWalletSectionUrl());
  if (!deepLink) {
    showError('Wallet launch link unavailable.');
    return;
  }
  window.location.href = deepLink;
}

function copyWalletVerifyLink() {
  const link = getWalletSectionUrl();
  if (!navigator.clipboard?.writeText) {
    showInfo(`Open this URL in your wallet app browser: ${link}`);
    return;
  }
  navigator.clipboard.writeText(link)
    .then(() => showSuccess('Verification link copied. Open it inside your wallet app browser.'))
    .catch(() => showInfo(`Open this URL in your wallet app browser: ${link}`));
}

function renderMobileWalletLaunchPanel() {
  const panel = document.getElementById('mobileWalletLaunchPanel');
  if (!panel) return;

  const isMobile = isMobileWalletContext();
  const provider = getSolanaProvider();
  const providerName = getDetectedWalletProviderName(provider);

  if (!isMobile) {
    panel.innerHTML = '';
    return;
  }

  if (provider) {
    panel.innerHTML = `
      <div style="padding:14px 16px; border-radius:12px; border:1px solid rgba(16,185,129,0.28); background:rgba(16,185,129,0.1); color:#bbf7d0;">
        Wallet detected in this browser: <strong>${escapeHtml(providerName)}</strong>. You can continue with Connect & Sign.
      </div>
    `;
    return;
  }

  panel.innerHTML = `
    <div style="padding:18px; border-radius:14px; border:1px solid rgba(245,158,11,0.38); background:rgba(245,158,11,0.1);">
      <h4 style="margin:0 0 8px 0; color:#fde68a;">Use your mobile wallet app</h4>
      <p style="margin:0 0 14px 0; color:#fef3c7; font-size:0.9em; line-height:1.55;">
        No wallet provider was detected in this browser. Tap your wallet below to open this exact verification page in its in-app browser.
      </p>
      <div style="display:grid; gap:10px; grid-template-columns:repeat(auto-fit,minmax(180px,1fr));">
        <button class="btn-primary" onclick="launchWalletBrowser('phantom')">Open in Phantom</button>
        <button class="btn-primary" onclick="launchWalletBrowser('solflare')">Open in Solflare</button>
        <button class="btn-primary" onclick="launchWalletBrowser('backpack')">Open in Backpack</button>
      </div>
      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn-secondary" onclick="copyWalletVerifyLink()">Copy Verification Link</button>
        <button class="btn-secondary" onclick="renderMobileWalletLaunchPanel()">Retry Detection</button>
      </div>
      <p style="margin:10px 0 0 0; color:var(--text-secondary); font-size:0.82em;">
        If signing still does not open, use On-Chain Proof below. It works without app/browser injection.
      </p>
    </div>
  `;
}

async function verifyBySignature() {
  const btn = document.getElementById('signVerifyBtn');

  const provider = getSolanaProvider();
  if (!provider) {
    if (isMobileWalletContext()) {
      renderMobileWalletLaunchPanel();
      showInfo('Open this page in your wallet app browser, then tap Connect & Sign again.');
    } else {
      showError('No Solana wallet detected. Please install Phantom, Solflare, or Backpack.');
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Connecting wallet...';
  }

  try {
    // 1. Connect wallet
    const resp = await provider.connect();
    const walletAddress = extractWalletAddress(provider, resp);
    if (!walletAddress) {
      throw new Error('Connected wallet but could not read public address. Please unlock wallet and try again.');
    }
    if (btn) btn.innerHTML = '⏳ Requesting challenge...';

    // 2. Get challenge from server
    const challengeRes = await fetch('/api/verify/challenge', { method: 'POST', credentials: 'include' });
    const challengeData = await challengeRes.json();
    if (!challengeData.success) throw new Error(challengeData.message || 'Failed to get challenge');

    if (btn) btn.innerHTML = '⏳ Sign the message in your wallet...';

    // 3. Sign the challenge message
    const encodedMessage = new TextEncoder().encode(challengeData.message);
    const signedMessage = await provider.signMessage(encodedMessage, 'utf8');
    
    // Extract signature bytes → base58
    const signatureBytes = signedMessage.signature || signedMessage;
    const sig58 = uint8ToBase58(new Uint8Array(signatureBytes));

    if (btn) btn.innerHTML = '⏳ Verifying on server...';

    // 4. Submit to server
    const verifyRes = await fetch('/api/verify/signature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, signature: sig58 })
    });
    const verifyData = await verifyRes.json();

    if (verifyData.success) {
      showSuccess(verifyData.message || 'Wallet verified!');
      closeWalletVerifyModal();
      await loadPortal(); // Refresh all data
    } else {
      showError(verifyData.message || 'Verification failed');
    }
  } catch (error) {
    if (error.code === 4001 || error.message?.includes('reject')) {
      showInfo('Signing cancelled. No changes made.');
    } else {
      showError('Verification failed: ' + (error.message || 'Unknown error'));
      console.error('Signature verification error:', error);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '✓ Connect & Sign';
    }
    renderMobileWalletLaunchPanel();
  }
}

async function verifyByMicroTx() {
  const btn = document.getElementById('microVerifyBtn');
  const statusEl = document.getElementById('verifyStatus');

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Generating proof address...';
  }

  try {
    // 1. Create micro-verify request on server — no wallet connection needed
    const reqRes = await fetch('/api/micro-verify/request', { method: 'POST', credentials: 'include' });
    const reqData = await reqRes.json();
    if (!reqData.success) throw new Error(reqData.message || 'Failed to create verification request');

    const { amount, destinationWallet, expiresAt, ttlMinutes } = reqData.request || reqData;
    const expiryDisplay = expiresAt ? new Date(expiresAt).toLocaleTimeString() : `~${ttlMinutes || 15} min`;

    // 2. Show the on-chain proof instruction UI — no wallet extension involved
    if (statusEl) {
      statusEl.innerHTML = `
        <div style="margin-top:20px; padding:24px; background:rgba(99,102,241,0.08); border:2px solid rgba(99,102,241,0.35); border-radius:14px;">
          <h4 style="color:#e0e7ff; margin:0 0 6px 0; font-size:1.05em;">🔐 NFT Ownership Proof — On-Chain Confirmation</h4>
          <p style="color:var(--text-secondary); font-size:0.82em; margin:0 0 16px 0; line-height:1.5;">This is a wallet ownership proof tool for NFT community membership. It does <strong>not</strong> collect passwords, seed phrases, or personal data. We only confirm that you control the wallet. <a href="/privacy-policy" target="_blank" style="color:#a5b4fc;">Privacy Policy</a></p>

          <div style="margin-bottom:14px;">
            <p style="color:var(--text-secondary); font-size:0.82em; margin:0 0 6px 0; text-transform:uppercase; letter-spacing:0.05em;">Unique Proof Amount</p>
            <div style="display:flex; align-items:center; gap:10px; background:rgba(0,0,0,0.3); border:1px solid rgba(99,102,241,0.25); border-radius:8px; padding:12px 14px;">
              <span id="microAmountDisplay" style="color:#fbbf24; font-size:1.2em; font-weight:700; font-family:monospace; flex:1;">${amount} SOL</span>
              <button onclick="navigator.clipboard.writeText('${escapeJsString(amount)}'); showSuccess('Amount copied!');" style="background:rgba(99,102,241,0.2); border:1px solid rgba(99,102,241,0.3); border-radius:6px; color:#a5b4fc; padding:6px 12px; cursor:pointer; font-size:0.8em; white-space:nowrap;">Copy</button>
            </div>
          </div>

          <div style="margin-bottom:20px;">
            <p style="color:var(--text-secondary); font-size:0.82em; margin:0 0 6px 0; text-transform:uppercase; letter-spacing:0.05em;">Community Proof Address</p>
            <div style="display:flex; align-items:center; gap:10px; background:rgba(0,0,0,0.3); border:1px solid rgba(99,102,241,0.25); border-radius:8px; padding:12px 14px;">
              <span style="color:#c7d2fe; font-size:0.88em; font-family:monospace; flex:1; word-break:break-all;">${destinationWallet}</span>
              <button onclick="navigator.clipboard.writeText('${escapeJsString(destinationWallet)}'); showSuccess('Address copied!');" style="background:rgba(99,102,241,0.2); border:1px solid rgba(99,102,241,0.3); border-radius:6px; color:#a5b4fc; padding:6px 12px; cursor:pointer; font-size:0.8em; white-space:nowrap;">Copy</button>
            </div>
          </div>

          <div style="background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.25); border-radius:8px; padding:12px 14px; margin-bottom:20px;">
            <p style="color:#c7d2fe; font-size:0.85em; margin:0; line-height:1.5;">
              ℹ️ Use the <strong>exact proof amount</strong> above — it's your unique wallet identifier used only for membership confirmation.<br>
              Compatible with any Solana wallet (Phantom, mobile, hardware wallet, etc.).<br>
              Proof expires at <strong>${expiryDisplay}</strong>.
            </p>
          </div>

          <div style="text-align:center;">
            <div style="display:flex; align-items:center; justify-content:center; gap:10px; color:var(--text-secondary); margin-bottom:12px;">
              <div class="spinner" style="width:18px; height:18px;"></div>
              <span style="font-size:0.9em;">Awaiting on-chain confirmation...</span>
            </div>
            <button onclick="manualCheckMicroVerify(document.getElementById('verifyStatus'))" style="background:none; border:1px solid rgba(99,102,241,0.3); border-radius:6px; color:#a5b4fc; padding:6px 14px; cursor:pointer; font-size:0.82em;">↻ Check status</button>
          </div>
        </div>
      `;
    }

    // 3. Start polling — server detects the transfer on-chain automatically
    pollMicroVerifyStatus(statusEl);

  } catch (error) {
    showError(error.message || 'Failed to start verification');
    console.error('Micro-tx verification error:', error);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🔑 Generate Proof Address';
    }
  }
}

async function pollMicroVerifyStatus(statusEl, attempts = 0) {
  if (attempts > 30) {
    if (statusEl) statusEl.innerHTML = `<div style="padding:12px; background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.3); border-radius:10px; text-align:center; color:#fcd34d;">Still processing. Click <strong>↻ Check status</strong> to scan the chain manually, or refresh the page.</div>`;
    return;
  }
  try {
    const res = await fetch('/api/micro-verify/status', { credentials: 'include' });
    const data = await res.json();
    if (data.success && data.request?.status === 'verified') {
      showSuccess('Wallet verified via micro-transaction!');
      closeWalletVerifyModal();
      await loadPortal();
      return;
    }
  } catch (e) { /* continue polling */ }
  setTimeout(() => pollMicroVerifyStatus(statusEl, attempts + 1), 5000);
}

async function manualCheckMicroVerify(statusEl) {
  const btn = document.querySelector('[onclick*="manualCheckMicroVerify"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning chain...'; }
  try {
    const res = await fetch('/api/micro-verify/check-now', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({})
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error(`Server returned ${res.status} (not JSON) — try restarting the bot`);
    }
    const data = await res.json();
    if (data.status === 'verified') {
      showSuccess('Wallet verified via micro-transaction!');
      closeWalletVerifyModal();
      await loadPortal();
    } else if (statusEl) {
      statusEl.innerHTML += `<div style="padding:8px 12px;background:rgba(245,158,11,0.1);border-radius:8px;color:#fcd34d;font-size:0.85em;margin-top:8px;">Transaction not yet detected on-chain. Sent the exact amount? It may take 10–30s to confirm — try again shortly.</div>`;
    }
  } catch (e) {
    if (statusEl) statusEl.innerHTML += `<div style="color:#fca5a5;font-size:0.85em;margin-top:8px;">Check failed: ${escapeHtml(e.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Check status'; }
  }
}


// Lightweight base58 encoder (Bitcoin/Solana alphabet)
function uint8ToBase58(bytes) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const d = [];
  let i, j, carry;
  for (i = 0; i < bytes.length; i++) {
    carry = bytes[i];
    for (j = 0; j < d.length; j++) {
      carry += d[j] << 8;
      d[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      d.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let output = '';
  for (i = 0; i < bytes.length && bytes[i] === 0; i++) output += ALPHABET[0];
  for (i = d.length - 1; i >= 0; i--) output += ALPHABET[d[i]];
  return output;
}

function getServerRecord(guildId) {
  const normalized = normalizeGuildId(guildId);
  if (!normalized) return null;

  return (
    serverAccessData.managedServers.find(server => server.guildId === normalized) ||
    serverAccessData.unmanagedServers.find(server => server.guildId === normalized) ||
    null
  );
}

function setActiveGuild(guildId, { persist = true, announce = true, goToSettings = false } = {}) {
  const normalized = normalizeGuildId(guildId);
  const previous = activeGuildId;
  activeGuildId = normalized;

  if (persist) {
    if (normalized) {
      localStorage.setItem('activeGuildId', normalized);
    } else {
      localStorage.removeItem('activeGuildId');
    }
  }

  updateActiveGuildBadge();

  if (announce && activeGuildId) {
    showInfo(`Active server set to ${getActiveServerLabel()}`);
  }

  // Refresh tenant-sensitive screens when switching active server context
  if (previous !== activeGuildId) {
    clearTicketingViewCache();
    refreshTenantScopedViews();
  }

  if (goToSettings && activeGuildId) {
    switchSection('admin');
    showAdminView('settings');
  }
}

function refreshTenantScopedViews() {
  syncTenantModuleNavVisibility();
  updateSidebarModuleNav();
  renderGeneralSection();

  // Always stale-clear any rendered collection/wallet lists so they can't
  // be edited under the wrong guild. They'll re-render when the user next
  // navigates to those cards. Also close any open collection/wallet modals.
  ['nftCollectionsTableWrap', 'nts_collectionsWrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.innerHTML.trim()) {
      el.innerHTML = '<div style="text-align:center;padding:var(--space-4);color:var(--text-secondary);"><div class="spinner"></div><p>Refreshing...</p></div>';
      renderNftCollectionsCard(id);
    }
  });
  ['nts_tokensWrap', 'tts_tokensWrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.innerHTML.trim()) {
      el.innerHTML = '<div style="text-align:center;padding:var(--space-4);color:var(--text-secondary);"><div class="spinner"></div><p>Refreshing...</p></div>';
      renderNftTrackedTokensCard(id);
    }
  });
  ['nts_tokenEventsWrap', 'tts_tokenEventsWrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.innerHTML.trim()) {
      el.innerHTML = '<div style="text-align:center;padding:var(--space-4);color:var(--text-secondary);"><div class="spinner"></div><p>Refreshing...</p></div>';
      renderNftTokenEventsCard(id);
    }
  });
  const addColModal = document.getElementById('addCollectionModal');
  if (addColModal && addColModal.style.display !== 'none') closeAddCollectionModal();
  const addWalModal = document.getElementById('addWalletModal');
  if (addWalModal && addWalModal.style.display !== 'none') closeAddWalletModal();
  const addTokenModal = document.getElementById('addTokenModal');
  if (addTokenModal && addTokenModal.style.display !== 'none' && typeof closeAddTokenModal === 'function') closeAddTokenModal();

  // Re-render wallet lists if already loaded
  const twContainer = document.getElementById('treasuryWalletTableContainer');
  if (twContainer && twContainer.innerHTML.trim()) loadTrackedWalletList();
  const swWrap = document.getElementById('settings_walletListWrap');
  if (swWrap && swWrap.innerHTML.trim()) renderSettingsWalletList();

  const activeSection = document.querySelector('.content-section.active')?.id || '';
  const activeAdminView = document.querySelector('.admin-sub-item.active')?.getAttribute('data-admin-nav');

  if (activeSection === 'section-admin' && activeAdminView) {
    showAdminView(activeAdminView);
    return;
  }

  if (activeSection === 'section-governance') {
    loadActiveVotes();
  } else if (activeSection === 'section-treasury') {
    loadTreasuryWalletTable();
    if (isAdmin) showAdminTreasuryElements();
  } else if (activeSection === 'section-nft-activity') {
    loadNFTActivityView();
    if (isAdmin) loadNFTActivityAdminView();
  } else if (activeSection === 'section-token-activity') {
    loadTokenActivityView();
  }
}

function getActiveServerLabel() {
  const record = getServerRecord(activeGuildId);
  if (record?.name) {
    return record.name;
  }

  return activeGuildId ? `Server ${activeGuildId}` : 'Select a server';
}

function getGuildIconUrl(server) {
  if (!server || !server.guildId || !server.icon) return '';
  return `https://cdn.discordapp.com/icons/${server.guildId}/${server.icon}.png?size=64`;
}

function getActiveBrandLogoUrl(server) {
  const configured = portalSettingsData?.tenantBranding?.logo_url || '';
  if (configured) return configured;
  return getGuildIconUrl(server);
}

function sanitizeImageUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed, window.location.origin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '';
    }

    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.href;
  } catch (_error) {
    return '';
  }
}

function setNavBrandTitle(brandTitle, iconUrl, label) {
  if (!brandTitle) return;
  brandTitle.textContent = '';

  if (iconUrl) {
    const img = document.createElement('img');
    img.src = iconUrl;
    img.alt = '';
    img.style.width = '22px';
    img.style.height = '22px';
    img.style.borderRadius = '50%';
    img.style.verticalAlign = 'middle';
    img.style.marginRight = '8px';
    img.style.objectFit = 'cover';
    brandTitle.appendChild(img);
  }

  brandTitle.appendChild(document.createTextNode(label || 'Portal'));
}

function updateActiveGuildBadge() {
  const badge = document.getElementById('activeGuildBadge');
  const brandTitle = document.getElementById('navBrandTitle');
  if (!badge) return;

  if (activeGuildId) {
    const record = getServerRecord(activeGuildId);
    badge.style.display = 'inline-flex';
    badge.textContent = record?.name ? `Active: ${record.name}` : `Active: ${activeGuildId}`;
    badge.title = activeGuildId;
    if (brandTitle) {
      const iconUrl = sanitizeImageUrl(getActiveBrandLogoUrl(record));
      setNavBrandTitle(brandTitle, iconUrl, record?.name || 'Portal');
    }
  } else {
    badge.style.display = 'inline-flex';
    badge.textContent = 'Select server';
    badge.title = 'No active server selected';
    setNavBrandTitle(brandTitle, '/assets/branding/guildpilot-logo.png', 'GuildPilot');
  }

  applyPreSelectionVisibility();
  refreshAdminEntryVisibility();
  updateSidebarServerContext();
}

function updateSidebarServerContext() {
  const ctx = document.getElementById('sidebarServerContext');
  if (!ctx) return;

  if (!activeGuildId) {
    ctx.style.display = 'none';
    return;
  }

  const record = getServerRecord(activeGuildId);
  const name = record?.name || activeGuildId;
  const iconUrl = record ? getGuildIconUrl(record) : '';

  const iconEl = document.getElementById('sidebarServerIcon');
  const initialsEl = document.getElementById('sidebarServerInitials');
  if (iconUrl) {
    iconEl.src = iconUrl;
    iconEl.style.display = 'block';
    initialsEl.style.display = 'none';
  } else {
    iconEl.style.display = 'none';
    initialsEl.textContent = name.slice(0, 2).toUpperCase();
    initialsEl.style.display = 'flex';
  }

  document.getElementById('sidebarServerName').textContent = name;
  ctx.style.display = 'block';
}


function setNavSectionVisibility(section, visible) {
  document.querySelectorAll(`[data-section="${section}"]`).forEach(el => {
    el.style.display = visible ? '' : 'none';
  });
}

function applyPreSelectionVisibility() {
  const locked = requiresServerSelectionGate();
  const tenantSections = ['governance', 'treasury', 'nft-activity', 'token-activity', 'heist'];

  tenantSections.forEach(section => {
    setNavSectionVisibility(section, !locked);
    const sectionEl = document.getElementById(`section-${section}`);
    if (sectionEl) sectionEl.style.display = locked ? 'none' : '';
  });

  // Keep module navigation hidden until a tenant context is selected.
  setNavSectionVisibility('wallets', !locked);
  setNavSectionVisibility('landing', true);

  const walletsSection = document.getElementById('section-wallets');
  if (walletsSection) walletsSection.style.display = '';

  updateSidebarModuleNav();
  renderGeneralSection();
}

function updateModuleVisibility() {
  const state = window._tenantModuleState || {};
  const moduleNav = [
    { id: 'sidebarNavTreasury', key: 'wallettracker' },
    { id: 'sidebarNavTokenActivity', key: 'tokentracker' },
    { id: 'sidebarNavSelfServe', key: 'selfserveroles' },
    { id: 'sidebarNavTicketing', key: 'ticketing' },
    { id: 'sidebarNavEngagement', key: 'engagement' },
    { id: 'sidebarNavHeist', key: 'heist' },
    { id: 'mobileNavTreasury', key: 'wallettracker' },
    { id: 'mobileNavTokenActivity', key: 'tokentracker' },
    { id: 'mobileNavSelfServe', key: 'selfserveroles' },
    { id: 'mobileNavTicketing', key: 'ticketing' },
    { id: 'mobileNavEngagement', key: 'engagement' },
    { id: 'mobileNavHeist', key: 'heist' },
  ];
  moduleNav.forEach(({ id, key }) => {
    const el = document.getElementById(id);
    if (!el) return;
    // Hide if no server selected OR if the module is explicitly disabled for this guild
    el.style.display = (!activeGuildId || state[key] === false) ? 'none' : '';
  });
}

// ==================== GENERAL HUB & SETTINGS ====================

function renderGeneralSection() {
  const preEl = document.getElementById('generalPreSelection');
  const postEl = document.getElementById('generalPostSelection');
  if (!preEl || !postEl) return;

  // Home should always show the main landing/marketing page.
  preEl.style.display = '';
  postEl.style.display = 'none';

  const primaryCta = document.getElementById('homePrimaryCta');
  if (primaryCta) {
    if (activeGuildId) {
      const record = getServerRecord(activeGuildId);
      const canManage = isAdmin || isSuperadmin;
      primaryCta.textContent = record?.name
        ? (canManage ? `Manage ${record.name}` : `Open ${record.name}`)
        : (canManage ? 'Manage Server' : 'Open Server');
      primaryCta.onclick = () => switchSection(canManage ? 'settings' : 'servers');
    } else {
      primaryCta.textContent = 'Get Started';
      primaryCta.onclick = () => switchSection('servers');
    }
  }

  const homeContext = document.getElementById('homeActiveContext');
  if (homeContext) {
    if (activeGuildId) {
      const activeRecord = getServerRecord(activeGuildId);
      const activeName = activeRecord?.name || activeGuildId;
      homeContext.style.display = '';
      homeContext.innerHTML = `
        Active server context: <strong>${escapeHtml(activeName)}</strong>.
        <button class="btn-secondary" style="margin-left:10px;padding:6px 12px;font-size:0.8em;min-height:32px;" onclick="switchSection('servers')">Switch</button>
      `;
    } else {
      homeContext.style.display = 'none';
      homeContext.innerHTML = '';
    }
  }

  const record = getServerRecord(activeGuildId);
  const name = record?.name || activeGuildId;
  const iconUrl = record ? getGuildIconUrl(record) : '';

  const infoEl = document.getElementById('generalServerInfo');
  if (infoEl) {
    infoEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:8px;">
        ${iconUrl
          ? `<img src="${iconUrl}" style="width:64px;height:64px;border-radius:14px;object-fit:cover;">`
          : `<div style="width:64px;height:64px;border-radius:14px;background:rgba(99,102,241,0.3);display:flex;align-items:center;justify-content:center;font-size:1.5em;font-weight:700;color:#e0e7ff;">${escapeHtml(name.slice(0, 2).toUpperCase())}</div>`}
        <div>
          <div style="font-size:1.4em;font-weight:700;color:#e0e7ff;">${escapeHtml(name)}</div>
          <div style="color:var(--text-secondary);font-size:0.85em;display:flex;align-items:center;gap:6px;">
            ID: ${escapeHtml(activeGuildId)}
            <button onclick="navigator.clipboard.writeText('${escapeJsString(activeGuildId)}');showSuccess('Server ID copied!')" style="background:none;border:1px solid rgba(99,102,241,0.2);border-radius:4px;color:var(--text-secondary);padding:2px 6px;cursor:pointer;font-size:0.8em;">Copy</button>
          </div>
        </div>
      </div>
    `;
  }

  const qaEl = document.getElementById('generalQuickActions');
  const state = window._tenantModuleState || {};
  if (qaEl) {
    const modules = [
      { key: 'governance', icon: '\ud83d\udcdc', label: 'Governance', section: 'governance' },
      { key: 'verification', icon: '\ud83d\udcbc', label: 'Verification', section: 'wallets' },
      { key: 'wallettracker', icon: '\ud83d\udcb0', label: 'Wallet Tracker', section: 'treasury' },
      { key: 'nfttracker', icon: '\ud83c\udfa8', label: 'NFT Tracker', section: 'nft-activity' },
      { key: 'tokentracker', icon: '\ud83e\ude99', label: 'Token Tracker', section: 'token-activity' },
      { key: 'heist', icon: '\ud83c\udfaf', label: 'Heist', section: 'heist' },
    ];
    const adminTile = (isAdmin || isSuperadmin) ? `
      <button class="quick-action-tile" onclick="switchSection('settings')">
        <span class="qa-icon">\u2699\ufe0f</span>
        <span class="qa-label">Settings</span>
      </button>` : '';

    qaEl.innerHTML = modules
      .filter(m => state[m.key] !== false)
      .map(m => `
        <button class="quick-action-tile" onclick="switchSection('${escapeJsString(m.section)}')">
          <span class="qa-icon">${m.icon}</span>
          <span class="qa-label">${m.label}</span>
        </button>
      `).join('') + adminTile;
  }
}

function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.querySelectorAll('.settings-tab-pane').forEach(p => {
    p.style.display = 'none';
  });
  const pane = document.getElementById('settingsTab-' + tab);
  if (pane) pane.style.display = '';

  // Load the appropriate admin card content into the pane
  const tabCardMap = {
    general:      'adminSettingsCard',
    governance:   'adminVotingPowerCard',
    verification: 'adminRolesCard',
    invites:      'adminInviteTrackerCard',
    selfserve:    'adminSelfServeRolesCard',
    ticketing:    'adminTicketingCard',
    engagement:   'adminEngagementCard',
  };
  const cardId = tabCardMap[tab];
  if (cardId && pane) {
    const card = document.getElementById(cardId);
    if (card) {
      // Move the actual card into the settings tab pane (preserves event handlers)
      if (!pane.contains(card)) {
        pane.innerHTML = '';
        pane.appendChild(card);
      }
      // Always ensure card is visible (hideAllAdminCards may have hidden it)
      card.style.display = '';
    }
  }

  // Trigger data loads for the relevant tab
  const tabLoaders = {
    general:      () => { if (typeof loadAdminSettingsView === 'function') loadAdminSettingsView(); },
    governance:   () => { if (typeof loadVotingPowerView === 'function') loadVotingPowerView(); },
    verification: () => {
      // Ensure verification settings container exists before the roles card
      const vPane = document.getElementById('settingsTab-verification');
      if (vPane && !document.getElementById('verificationSettingsCard')) {
        const div = document.createElement('div');
        div.id = 'verificationSettingsCard';
        vPane.insertBefore(div, vPane.firstChild);
      }
      if (typeof loadVerificationSettings === 'function') loadVerificationSettings();
      if (typeof loadAdminRoles === 'function') loadAdminRoles();
    },
    branding:     () => { if (typeof loadBrandingSettingsView === 'function') loadBrandingSettingsView(); },
    invites:      () => { if (typeof loadInviteTrackerSettingsView === 'function') loadInviteTrackerSettingsView(); },
    nfttracker:   () => { if (typeof loadNftTrackerSettingsView === 'function') loadNftTrackerSettingsView(); },
    tokentracker: () => { if (typeof loadTokenTrackerSettingsView === 'function') loadTokenTrackerSettingsView(); },
    selfserve:    () => { if (typeof loadSelfServeRolesView === 'function') loadSelfServeRolesView(); },
    ticketing:    () => { if (typeof loadTicketingView === 'function') loadTicketingView(); },
    engagement:   () => { loadEngagementSettingsTab(); },
    treasury:     () => { if (typeof loadTreasuryModuleSettings === 'function') loadTreasuryModuleSettings(); },
    battle:       () => loadBattleTimingSettings(),
  };
  const loader = tabLoaders[tab];
  if (loader) loader();
}

function updateSidebarModuleNav() {
  const hasServer = !!activeGuildId;
  const state = window._tenantModuleState || {};

  const moduleItems = [
    { id: 'sidebarNavGovernance', module: 'governance' },
    { id: 'mobileNavGovernance', module: 'governance' },
    { id: 'sidebarNavWallets', module: 'verification' },
    { id: 'mobileNavWallets', module: 'verification' },
    { id: 'sidebarNavTreasury', module: 'wallettracker' },
    { id: 'mobileNavTreasury', module: 'wallettracker' },
    { id: 'sidebarNavNftActivity', module: 'nfttracker' },
    { id: 'mobileNavNftActivity', module: 'nfttracker' },
    { id: 'sidebarNavTokenActivity', module: 'tokentracker' },
    { id: 'mobileNavTokenActivity', module: 'tokentracker' },
    { id: 'sidebarNavHeist', module: 'heist' },
    { id: 'mobileNavHeist', module: 'heist' },
    { id: 'sidebarNavEngagement', module: 'engagement' },
    // Plans nav handled separately (superadmin-only)
  ];

  // Module nav is only visible in active tenant context.
  const noServerRequired = new Set();

  moduleItems.forEach(({ id, module }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const enabled = module === null || state[module] !== false;
    const visibleWithoutServer = noServerRequired.has(module);
    el.style.display = ((hasServer || visibleWithoutServer) && enabled) ? '' : 'none';
  });

  // Force-hide Battle nav in portal (Discord-only runtime; settings still available)
  const battleNav = document.getElementById('sidebarNavBattle');
  if (battleNav) battleNav.style.display = 'none';
  const battleNavMobile = document.getElementById('mobileNavBattle');
  if (battleNavMobile) battleNavMobile.style.display = 'none';

  // Plans nav — superadmin only (not yet ready for general use)
  const plansNav = document.getElementById('sidebarNavPlans');
  if (plansNav) plansNav.style.display = (hasServer && isSuperadmin) ? '' : 'none';

  // Mobile plans nav — superadmin only
  const mobilePlans = document.getElementById('mobileNavPlans');
  if (mobilePlans) mobilePlans.style.display = (hasServer && isSuperadmin) ? '' : 'none';

  const sidebarSettings = document.getElementById('sidebarNavSettings');
  if (sidebarSettings) {
    sidebarSettings.style.display = (hasServer && (isAdmin || isSuperadmin)) ? '' : 'none';
  }
  const mobileSettings = document.getElementById('mobileNavSettings');
  if (mobileSettings) {
    mobileSettings.style.display = (hasServer && (isAdmin || isSuperadmin)) ? '' : 'none';
  }

  // Hide dividers that have no visible nav items between them
  document.querySelectorAll('.sidebar-section-divider').forEach(divider => {
    let hasPrev = false, hasNext = false;
    let el = divider.previousElementSibling;
    while (el) { if (el.style.display !== 'none' && !el.classList.contains('sidebar-section-divider')) { hasPrev = true; break; } el = el.previousElementSibling; }
    el = divider.nextElementSibling;
    while (el && !el.classList.contains('sidebar-section-divider')) { if (el.style.display !== 'none') { hasNext = true; break; } el = el.nextElementSibling; }
    divider.style.display = (hasPrev && hasNext) ? '' : 'none';
  });
}

function applyTenantModuleNavVisibility(settings = {}) {
  const minigamesEnabled = settings.moduleMinigamesEnabled !== undefined
    ? !!settings.moduleMinigamesEnabled
    : !!settings.moduleBattleEnabled;
  const moduleState = {
    governance: !!settings.moduleGovernanceEnabled,
    verification: !!settings.moduleVerificationEnabled,
    branding: !!settings.moduleBrandingEnabled,
    wallettracker: settings.moduleWalletTrackerEnabled !== undefined
      ? !!settings.moduleWalletTrackerEnabled
      : !!settings.moduleTreasuryEnabled,
    invites: settings.moduleInviteTrackerEnabled !== false,
    nfttracker: !!settings.moduleNftTrackerEnabled,
    tokentracker: !!settings.moduleTokenTrackerEnabled,
    heist: !!settings.moduleMissionsEnabled,
    ticketing: !!settings.moduleTicketingEnabled,
    engagement: !!settings.moduleEngagementEnabled,
    roleclaim: !!settings.moduleRoleClaimEnabled,
    minigames: minigamesEnabled,
    battle: minigamesEnabled,
    selfserveroles: !!settings.moduleRoleClaimEnabled
  };
  window._tenantModuleState = moduleState;

  const sectionMap = {
    governance: moduleState.governance,
    wallets: moduleState.verification,
    treasury: moduleState.wallettracker,
    'nft-activity': moduleState.nfttracker,
    'token-activity': moduleState.tokentracker,
    heist: moduleState.heist,
    battle: moduleState.minigames
  };

  Object.entries(sectionMap).forEach(([section, enabled]) => {
    setNavSectionVisibility(section, enabled);
    const sectionEl = document.getElementById(`section-${section}`);
    if (sectionEl) sectionEl.style.display = enabled ? '' : 'none';
  });

  // Update module-specific sidebar nav items with dedicated IDs
  updateModuleVisibility();
  updateSidebarModuleNav();

  const recentCard = document.getElementById('dashboardRecentActivityCard');
  if (recentCard) recentCard.style.display = (moduleState.governance || moduleState.heist) ? '' : 'none';

  const activeSection = document.querySelector('.content-section.active')?.id;
  const disabledActive = {
    'section-governance': !moduleState.governance,
    'section-wallets': !moduleState.verification,
    'section-treasury': !moduleState.wallettracker,
    'section-nft-activity': !moduleState.nfttracker,
    'section-token-activity': !moduleState.tokentracker,
    'section-heist': !moduleState.heist,
    'section-battle': !moduleState.minigames
  };
  if (activeSection && disabledActive[activeSection]) {
    switchSection('landing');
  }
}

// Settings tab -> module key mapping
const SETTINGS_TAB_MODULE_MAP = {
  governance:   'governance',
  verification: 'verification',
  branding:     'branding',
  treasury:     'wallettracker',
  invites:      'invites',
  nfttracker:   'nfttracker',
  tokentracker: 'tokentracker',
  battle:       'minigames',
  heist:        'heist',
  selfserve:    'selfserveroles',
  ticketing:    'ticketing',
  engagement:   'engagement',
};

function applySettingsTabVisibility(settings = {}) {
  // assignedModuleKeys is only present when multiTenant is on and a tenant exists.
  // null means all modules are available (single-tenant mode).
  const assigned = settings.assignedModuleKeys || null;
  const minigamesEnabled = settings.moduleMinigamesEnabled !== undefined
    ? !!settings.moduleMinigamesEnabled
    : !!settings.moduleBattleEnabled;
  const enabledByModule = {
    governance: !!settings.moduleGovernanceEnabled,
    verification: !!settings.moduleVerificationEnabled,
    // default visible unless explicitly disabled
    branding: settings.moduleBrandingEnabled !== false,
    wallettracker: settings.moduleWalletTrackerEnabled !== undefined
      ? !!settings.moduleWalletTrackerEnabled
      : !!settings.moduleTreasuryEnabled,
    invites: settings.moduleInviteTrackerEnabled !== false,
    nfttracker: !!settings.moduleNftTrackerEnabled,
    tokentracker: !!settings.moduleTokenTrackerEnabled,
    minigames: minigamesEnabled,
    heist: !!settings.moduleMissionsEnabled,
    selfserveroles: !!settings.moduleRoleClaimEnabled,
    ticketing: !!settings.moduleTicketingEnabled,
    engagement: !!settings.moduleEngagementEnabled,
  };

  document.querySelectorAll('#section-settings .settings-tabs .settings-tab[data-tab]').forEach(btn => {
    const tab = btn.dataset.tab;
    const moduleKey = SETTINGS_TAB_MODULE_MAP[tab];
    if (!moduleKey) return; // 'general' has no module key — always visible

    const assignedOk = (assigned === null) ? true : assigned.includes(moduleKey);
    const enabledOk = enabledByModule[moduleKey] !== false;
    btn.style.display = (assignedOk && enabledOk) ? '' : 'none';
  });
}

async function syncTenantModuleNavVisibility() {
  if (!isAdmin || !activeGuildId) return;
  try {
    const res = await fetch('/api/admin/settings', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const data = await res.json();
    if (data.success && data.settings) {
      // keep tenant-scoped settings/branding in sync with active guild context
      portalSettingsData = data.settings;
      applyTenantModuleNavVisibility(data.settings);
      applySettingsTabVisibility(data.settings);
      updateActiveGuildBadge();
    }
  } catch (e) {
    console.warn('Could not sync tenant module nav visibility:', e.message);
  }
}

function renderServerCard(server, { managed = true } = {}) {
  const isActive = server.guildId === activeGuildId;
  const iconUrl = getGuildIconUrl(server);
  const name = server.name || server.guildId;
  const initials = name.slice(0, 2).toUpperCase();
  const iconHtml = iconUrl
    ? `<img class="server-card__icon" src="${escapeHtml(iconUrl)}" alt="">`
    : `<div class="server-card__initials">${escapeHtml(initials)}</div>`;

  const onclick = managed
    ? `onclick="setActiveGuild('${escapeJsString(server.guildId)}', { goToSettings: true })"`
    : `onclick="openGuildInvite('${escapeJsString(server.guildId)}')"`;

  const borderStyle = isActive ? 'border-color:rgba(16,185,129,0.4);background:rgba(16,185,129,0.08);' : '';

  return `
    <div class="server-card" ${onclick} style="${borderStyle}">
      ${iconHtml}
      <div style="min-width:0;overflow:hidden;">
        <div class="server-card__title" style="font-size:0.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(name)}</div>
        <div class="server-card__meta" style="font-size:0.75em;">${isActive ? 'Active' : (managed ? 'Managed' : 'Invite needed')}</div>
      </div>
    </div>
  `;
}

async function openGuildInvite(guildId) {
  const normalized = normalizeGuildId(guildId || '');
  const qs = normalized ? `?guildId=${encodeURIComponent(normalized)}` : '';
  window.location.href = `/api/servers/invite-link${qs}`;
}

async function refreshServerAccess() {
  await loadServerAccess();
}

async function loadServerAccess() {
  try {
    const response = await fetch('/api/servers/me', { credentials: 'include' });
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.message || 'Unable to load server access');
    }

    serverAccessData = {
      isSuperadmin: !!data.isSuperadmin,
      managedServers: Array.isArray(data.managedServers) ? data.managedServers : [],
      unmanagedServers: Array.isArray(data.unmanagedServers) ? data.unmanagedServers : []
    };

    const knownIds = new Set([
      ...serverAccessData.managedServers.map(server => server.guildId),
      ...serverAccessData.unmanagedServers.map(server => server.guildId)
    ]);

    const totalServerCount = serverAccessData.managedServers.length + serverAccessData.unmanagedServers.length;
    if ((!activeGuildId || !knownIds.has(activeGuildId)) && totalServerCount === 1 && serverAccessData.managedServers.length === 1) {
      activeGuildId = serverAccessData.managedServers[0].guildId;
      localStorage.setItem('activeGuildId', activeGuildId);
    }

    updateActiveGuildBadge();
    renderServerAccessView();
  } catch (error) {
    console.error('Error loading server access:', error);
    renderServerAccessView(error.message);
  }
}

function renderServerAccessView(errorMessage = '') {
  const activeStatus = document.getElementById('activeServerStatus');
  const managedList = document.getElementById('managedServersList');
  const unmanagedList = document.getElementById('unmanagedServersList');

  if (activeStatus) {
    if (errorMessage) {
      activeStatus.innerHTML = `<div class="error-state"><div class="error-message">${escapeHtml(errorMessage)}</div></div>`;
    } else if (!activeGuildId) {
      activeStatus.innerHTML = `
        <div style="padding:16px; border-radius:12px; border:1px solid rgba(245,158,11,0.22); background:rgba(245,158,11,0.08); color:#fcd34d;">
          Select a managed server to continue with tenant-aware actions.
        </div>
      `;
    } else {
      const record = getServerRecord(activeGuildId);
      activeStatus.innerHTML = `
        <div class="server-card">
          <div>
            <div class="server-card__title">${escapeHtml(record?.name || activeGuildId)}</div>
            <div class="server-card__meta">Active guild context for admin and tenant-sensitive requests.</div>
          </div>
          <div class="server-card__actions">
            <span class="server-status-badge active">Active</span>
            <button class="btn-secondary" onclick="setActiveGuild('', { announce: false })">Clear</button>
          </div>
        </div>
      `;
    }
  }

  if (managedList) {
    managedList.innerHTML = serverAccessData.managedServers.length > 0
      ? serverAccessData.managedServers.map(server => renderServerCard(server, { managed: true })).join('')
      : '<p style="color:var(--text-secondary); text-align:center; padding:20px;">No managed servers found.</p>';
  }

  if (unmanagedList) {
    unmanagedList.innerHTML = serverAccessData.unmanagedServers.length > 0
      ? serverAccessData.unmanagedServers.map(server => renderServerCard(server, { managed: false })).join('')
      : '<p style="color:var(--text-secondary); text-align:center; padding:20px;">No unmanaged servers found.</p>';
  }
}

// ==================== PORTAL LOADING ====================
function enforceInitialServerSelection() {
  const managed = serverAccessData?.managedServers || [];
  const unmanaged = serverAccessData?.unmanagedServers || [];

  // Auto-select only when there's exactly one total visible server
  if ((managed.length + unmanaged.length) === 1 && managed.length === 1 && !activeGuildId) {
    setActiveGuild(managed[0].guildId, { announce: false });
    return true;
  }

  // For multi-server users, always require explicit server pick on each fresh login
  if (managed.length > 1) {
    setActiveGuild('', { announce: false });
    switchSection('landing');
    return false;
  }

  if ((managed.length + unmanaged.length) > 0 && !activeGuildId) {
    setActiveGuild('', { announce: false });
    switchSection('landing');
    return false;
  }

  return true;
}

async function loadPortal() {
  try {
    // Check feature flags
    const flagsResponse = await fetch('/api/features', { credentials: 'include' });
    if (flagsResponse.ok) {
      const flags = await flagsResponse.json();
      heistEnabled = flags.heistEnabled || false;

      // Nav/module visibility is handled by tenant-aware gating helpers.
      const heistPointsCard = document.getElementById('heistPointsCard');
      if (heistPointsCard) {
        heistPointsCard.style.display = heistEnabled ? 'block' : 'none';
      }
    }

    // Try to load user data (credentials CRITICAL for session cookies)
    const response = await fetch('/api/user/me', { credentials: 'include' });
    const data = await response.json();

    if (data.success) {
      userData = data;
      showAuthenticatedState();
      await loadServerAccess();
      applyPreSelectionVisibility();
      await checkSuperadminStatus();
      await checkAdminStatus();

      const canProceed = enforceInitialServerSelection();
      const hardGate = requiresServerSelectionGate();
      if (hardGate) {
        switchSection('landing');
        return;
      }

      if (canProceed) {
        await syncTenantModuleNavVisibility();
        loadDashboardData();
      }
    } else {
      showUnauthenticatedState();
    }

    // Navigate to section from URL after admin check is complete
    const urlParams = new URLSearchParams(window.location.search);
    const sectionParam = urlParams.get('section');
    const adminView = urlParams.get('adminView');
    if (sectionParam) {
      const section = normalizePortalSectionName(sectionParam);
      if (section === 'admin' && adminView) {
        showAdminView(adminView);
      } else {
        switchSection(section); // switchSection itself gates non-public sections if needed
      }
    } else if (userData && requiresServerSelectionGate()) {
      switchSection('landing');
    } else if (userData) {
      switchSection('landing', { updateUrl: false });
    }
  } catch (error) {
    console.error('Error loading portal:', error);
    showUnauthenticatedState();
  }
}

// ==================== AUTHENTICATION STATE ====================
function showAuthenticatedState() {
  // Update nav bar
  const avatarUrl = userData.user.avatar 
    ? `https://cdn.discordapp.com/avatars/${userData.user.discordId}/${userData.user.avatar}.png`
    : 'https://cdn.discordapp.com/embed/avatars/0.png';
  
  const navAvatar = document.getElementById('navAvatar');
  const navUsername = document.getElementById('navUsername');
  const navAuthBtn = document.getElementById('navAuthBtn');
  
  navAvatar.src = avatarUrl;
  navAvatar.style.display = 'block';
  navUsername.textContent = userData.user.username;
  navAuthBtn.textContent = 'Logout';
  navAuthBtn.onclick = logout;
  navAuthBtn.classList.remove('btn-secondary');
  navAuthBtn.classList.add('btn-secondary');

  updateActiveGuildBadge();

  // Show dashboard content
  document.getElementById('loginPrompt').style.display = 'none';
  document.getElementById('dashboardContent').style.display = 'block';
}

function showUnauthenticatedState() {
  const navAvatar = document.getElementById('navAvatar');
  const navUsername = document.getElementById('navUsername');
  const navAuthBtn = document.getElementById('navAuthBtn');
  
  navAvatar.style.display = 'none';
  navUsername.textContent = '';
  const activeGuildBadge = document.getElementById('activeGuildBadge');
  if (activeGuildBadge) activeGuildBadge.style.display = 'none';
  navAuthBtn.textContent = 'Login';
  navAuthBtn.onclick = login;
  navAuthBtn.classList.remove('btn-secondary');
  navAuthBtn.classList.add('btn-primary');

  document.getElementById('loginPrompt').style.display = 'block';
  document.getElementById('dashboardContent').style.display = 'none';
}

function refreshAdminEntryVisibility() {
  // Superadmin controls are only visible for superadmin users
  const canShowSuperadminEntry = !!isSuperadmin;
  const superadminSidebarGroup = document.getElementById('adminSuperadminSidebarGroup');
  const mobileNavAdmin = document.getElementById('mobileNavAdmin');
  const topNav = document.getElementById('topNavAdmin');

  if (superadminSidebarGroup) superadminSidebarGroup.style.display = canShowSuperadminEntry ? 'block' : 'none';
  if (mobileNavAdmin) mobileNavAdmin.style.display = canShowSuperadminEntry ? 'block' : 'none';
  if (topNav) topNav.style.display = canShowSuperadminEntry ? '' : 'none';
}

async function checkAdminStatus() {
  try {
    const response = await fetch('/api/user/is-admin', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const data = await response.json();

    isAdmin = !!data.isAdmin || isSuperadmin;
    refreshAdminEntryVisibility();

    if (isAdmin) {
      // Load treasury data for admin
      await loadTreasuryPublicView();
    } else {
      isAdmin = false;
      refreshAdminEntryVisibility();

      // If user navigated directly to admin section, redirect to landing
      const params = new URLSearchParams(window.location.search);
      if (params.get('section') === 'admin') {
        switchSection('landing');
        showError('Admin access required.');
      }
    }
  } catch (error) {
    isAdmin = false;
    refreshAdminEntryVisibility();
  }
}

async function checkSuperadminStatus() {
  try {
    const response = await fetch('/api/superadmin/me', { credentials: 'include' });
    const data = await response.json();
    isSuperadmin = !!data.isSuperadmin;

    const landingBtn = document.getElementById('landingSuperadminBtn');
    const landingHint = document.getElementById('landingSuperadminHint');
    if (landingBtn) {
      landingBtn.style.display = isSuperadmin ? 'inline-block' : 'none';
    }
    if (landingHint) {
      landingHint.style.display = isSuperadmin ? 'none' : 'inline';
    }

    if (!isSuperadmin) {
      const card = document.getElementById('adminSuperadminCard');
      if (card) card.style.display = 'none';
    }

    refreshAdminEntryVisibility();
  } catch (error) {
    isSuperadmin = false;
    const landingBtn = document.getElementById('landingSuperadminBtn');
    const landingHint = document.getElementById('landingSuperadminHint');
    if (landingBtn) landingBtn.style.display = 'none';
    if (landingHint) landingHint.style.display = 'inline';
    refreshAdminEntryVisibility();
  }
}

// ==================== DATA LOADING ====================
async function loadDashboardData() {
  let governanceEnabledForTenant = true;
  let verificationEnabledForTenant = true;
  let tierConfiguredForTenant = true;

  try {
    const missingTenantContext = (serverAccessData.managedServers.length > 0) && !activeGuildId;
    if (!missingTenantContext) {
      const headers = buildTenantRequestHeaders();

      // Tenant module state (for VP visibility)
      const settingsRes = await fetch('/api/admin/settings', { credentials: 'include', headers }).catch(() => null);
      if (settingsRes && settingsRes.ok) {
        const settingsJson = await settingsRes.json().catch(() => null);
        if (settingsJson?.success && settingsJson?.settings) {
          governanceEnabledForTenant = !!settingsJson.settings.moduleGovernanceEnabled;
          verificationEnabledForTenant = !!settingsJson.settings.moduleVerificationEnabled;
        }
      }

      // Tenant verification tiers state (for tier label validity)
      const rolesRes = await fetch('/api/admin/roles/config', { credentials: 'include', headers }).catch(() => null);
      if (rolesRes && rolesRes.ok) {
        const rolesJson = await rolesRes.json().catch(() => null);
        const tiers = rolesJson?.config?.tiers || [];
        tierConfiguredForTenant = Array.isArray(tiers) && tiers.length > 0;
      }
    } else {
      governanceEnabledForTenant = false;
      verificationEnabledForTenant = false;
      tierConfiguredForTenant = false;
    }
  } catch (e) {
    // Best-effort only; fallback to existing values
  }

  // Load stats
  const tierCard = document.getElementById('tierStatCard');
  const nftsCard = document.getElementById('nftsStatCard');
  const vpCard = document.getElementById('vpStatCard');

  if (tierCard) tierCard.style.display = verificationEnabledForTenant ? 'block' : 'none';
  if (nftsCard) nftsCard.style.display = verificationEnabledForTenant ? 'block' : 'none';
  if (vpCard) vpCard.style.display = governanceEnabledForTenant ? 'block' : 'none';

  document.getElementById('tierStat').textContent = tierConfiguredForTenant
    ? (userData.user.tier || 'None')
    : 'Unconfigured';

  const vpEl = document.getElementById('vpStat');
  if (vpEl) {
    vpEl.textContent = userData.user.votingPower || 0;
    vpEl.title = '';
  }

  document.getElementById('nftsStat').textContent = userData.user.totalNFTs || 0;
  
  if (heistEnabled) {
    document.getElementById('pointsStat').textContent = userData.user.totalPoints || 0;
  }

  // Load sections
  renderRecentActivity();
  renderProposals();
  renderWallets();
  loadTreasuryPublicView(); // Load public treasury data
  
  if (heistEnabled) {
    renderMissions();
  }
}

// ==================== RECENT ACTIVITY ====================
function renderRecentActivity() {
  const container = document.getElementById('recentActivity');
  const activities = [];

  // Combine proposals and missions into activity feed
  if (userData.proposals && userData.proposals.length > 0) {
    userData.proposals.forEach(p => {
      activities.push({
        type: 'proposal',
        title: p.title,
        date: new Date(p.created_at),
        status: p.status,
        id: p.proposal_id
      });
    });
  }

  if (heistEnabled && userData.missions && userData.missions.length > 0) {
    userData.missions.forEach(m => {
      activities.push({
        type: 'mission',
        title: m.title,
        date: new Date(m.joined_at || m.created_at),
        status: m.status,
        id: m.mission_id
      });
    });
  }

  // Sort by date
  activities.sort((a, b) => b.date - a.date);

  if (activities.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📊</div>
        <h4 class="empty-state-title">No Recent Activity</h4>
        <p class="empty-state-message">Your governance participation and mission activity will appear here.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '<div class="proposal-list">' + activities.slice(0, 5).map(activity => `
    <div class="${activity.type}-item">
      <div class="${activity.type}-header">
        <div class="${activity.type}-title">
          ${activity.type === 'proposal' ? '📜' : '🎯'} ${escapeHtml(activity.title)}
        </div>
        <span class="status-badge status-${activity.status}">${activity.status}</span>
      </div>
      <div class="${activity.type}-meta">
        ${activity.type === 'proposal' ? 'Proposal' : 'Mission'} #${activity.id} • ${formatDate(activity.date)}
      </div>
    </div>
  `).join('') + '</div>';
}

// ==================== GOVERNANCE ====================
function renderProposals() {
  const container = document.getElementById('myProposals');
  
  if (!userData.proposals || userData.proposals.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📜</div>
        <h4 class="empty-state-title">No Proposals Yet</h4>
        <p class="empty-state-message">You haven't created any proposals. Use the /governance propose command in Discord to submit your first proposal.</p>
        <div class="empty-state-action">
          <button class="btn-primary" onclick="showCreateProposalForm()">
            <span>➕</span>
            <span>Create Proposal</span>
          </button>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = '<div class="proposal-list">' + userData.proposals.map(proposal => `
    <div class="proposal-item">
      <div class="proposal-header">
        <div class="proposal-title">${escapeHtml(proposal.title)}</div>
        <div style="display:flex; gap:6px; align-items:center;">
          ${proposal.category ? `<span style="padding:2px 8px; border-radius:4px; font-size:0.8em; background:rgba(99,102,241,0.15); color:#818cf8; border:1px solid rgba(99,102,241,0.3);">${escapeHtml(proposal.category)}</span>` : ''}
          <span class="status-badge status-${proposal.status}">${proposal.status}</span>
        </div>
      </div>
      <div class="proposal-meta">
        Proposal #${proposal.proposal_id} • Created ${formatDate(new Date(proposal.created_at))}
        ${proposal.cost_indication ? ` • Cost: ${escapeHtml(proposal.cost_indication)}` : ''}
      </div>
      ${proposal.description ? `<p style="color: var(--text-secondary); margin-top: var(--space-3); line-height: 1.6;">${escapeHtml(proposal.description)}</p>` : ''}
      ${proposal.status === 'draft' ? `<button onclick="submitProposalForReview('${escapeJsString(proposal.proposal_id)}')" style="margin-top:8px; padding:6px 14px; background:#6366f1; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">Submit for Review</button>` : ''}
    </div>
  `).join('') + '</div>';

  // Also load active votes
  loadActiveVotes();
}

async function submitProposalForReview(proposalId) {
  showConfirmModal('Submit for Review?', 'Once submitted, an admin will review your proposal before it moves to the support phase.', async () => {
    try {
      const response = await fetch(`/api/governance/proposals/${proposalId}/submit`, { method: 'POST', credentials: 'include' });
      const data = await response.json();
      if (data.success) {
        showSuccess('Proposal submitted for review!');
        await loadPortal();
        switchSection('governance');
      } else {
        showError(data.message || 'Failed to submit for review');
      }
    } catch (e) {
      showError('Error: ' + e.message);
    }
  }, 'Submit');
}

async function loadActiveVotes() {
  const container = document.getElementById('activeVotes');
  if (!activeGuildId) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🗳️</div>
        <h4 class="empty-state-title">Select a Server</h4>
        <p class="empty-state-message">Choose a server first to load active proposals for that community.</p>
      </div>
    `;
    return;
  }
  
  try {
    const endpoint = buildPublicV1Url('/api/public/v1/proposals/active', { requireGuild: true });
    if (!endpoint) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🗳️</div>
          <h4 class="empty-state-title">Select a Server</h4>
          <p class="empty-state-message">Choose a server first to load active proposals for that community.</p>
        </div>
      `;
      return;
    }
    const response = await fetch(endpoint, { credentials: 'include' });
    const data = await response.json();
    const proposals = data?.data?.proposals || data?.proposals || [];
    
    if (!data.success || proposals.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🗳️</div>
          <h4 class="empty-state-title">No Active Proposals</h4>
          <p class="empty-state-message">There are no proposals currently open for voting. Check back soon or create your own!</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '<div class="proposal-list">' + proposals.map(proposal => {
      const totalVP = (proposal.votes?.yes?.vp || 0) + (proposal.votes?.no?.vp || 0) + (proposal.votes?.abstain?.vp || 0);
      const yesPercent = totalVP > 0 ? Math.round((proposal.votes?.yes?.vp || 0) / totalVP * 100) : 0;
      const noPercent = totalVP > 0 ? Math.round((proposal.votes?.no?.vp || 0) / totalVP * 100) : 0;
      const quorumPercent = proposal.quorum?.current || 0;
      const quorumRequired = proposal.quorum?.required || 50;
      const quorumMet = quorumPercent >= quorumRequired;
      const proposalId = proposal.proposalId || proposal.proposal_id;
      const creator = proposal.creator || proposal.creatorId || 'Unknown';
      
      return `
        <div class="proposal-item">
          <div class="proposal-header">
            <div class="proposal-title">${escapeHtml(proposal.title)}</div>
            <span class="status-badge status-${proposal.status}">${proposal.status}</span>
          </div>
          <div class="proposal-meta" style="margin-bottom: var(--space-4);">
            Proposal #${proposalId} • Created by ${escapeHtml(creator)}
          </div>
          ${proposal.description ? `<p style="color: var(--text-secondary); margin-bottom: var(--space-4); line-height: 1.6;">${escapeHtml(proposal.description)}</p>` : ''}
          
          <div class="proposal-votes">
            <div class="vote-stat">
              <div class="vote-stat-label">Yes Votes</div>
              <div class="vote-stat-value">${proposal.votes?.yes?.vp || 0}</div>
              <div class="vote-stat-secondary">${proposal.votes?.yes?.count || 0} votes • ${yesPercent}%</div>
            </div>
            <div class="vote-stat">
              <div class="vote-stat-label">No Votes</div>
              <div class="vote-stat-value">${proposal.votes?.no?.vp || 0}</div>
              <div class="vote-stat-secondary">${proposal.votes?.no?.count || 0} votes • ${noPercent}%</div>
            </div>
            <div class="vote-stat">
              <div class="vote-stat-label">Abstain</div>
              <div class="vote-stat-value">${proposal.votes?.abstain?.vp || 0}</div>
              <div class="vote-stat-secondary">${proposal.votes?.abstain?.count || 0} votes</div>
            </div>
            <div class="vote-stat">
              <div class="vote-stat-label">Quorum</div>
              <div class="vote-stat-value" style="color: ${quorumMet ? 'var(--success)' : 'var(--warning)'};">${quorumPercent}%</div>
              <div class="vote-stat-secondary">Required: ${quorumRequired}%</div>
            </div>
          </div>
          
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${quorumPercent}%;"></div>
          </div>
          <div class="quorum-indicator">
            <span>Participation Progress</span>
            <span style="color: ${quorumMet ? 'var(--success)' : 'var(--text-muted)'};">${quorumMet ? '✓ Quorum Met' : 'Quorum Pending'}</span>
          </div>
          ${userData ? `
          <div style="display:flex; gap:8px; margin-top:16px; flex-wrap:wrap;">
            <button class="btn-success" onclick="castVote('${escapeJsString(proposalId)}','yes')" style="flex:1; min-width:80px;">👍 Yes</button>
            <button class="btn-danger" onclick="castVote('${escapeJsString(proposalId)}','no')" style="flex:1; min-width:80px;">👎 No</button>
            <button class="btn-secondary" onclick="castVote('${escapeJsString(proposalId)}','abstain')" style="flex:1; min-width:80px;">⏭️ Abstain</button>
          </div>
          ` : ''}
        </div>
      `;
    }).join('') + '</div>';
  } catch (error) {
    console.error('Error loading active votes:', error);
    container.innerHTML = `
      <div class="error-state">
        <div class="error-title">
          <span>⚠️</span>
          <span>Failed to Load Proposals</span>
        </div>
        <div class="error-message">Unable to fetch active proposals. Please try refreshing the page.</div>
      </div>
    `;
  }
}

// ==================== WALLETS ====================
function renderWallets() {
  const container = document.getElementById('walletsList');
  const identityOptOut = Number(userData?.user?.walletAlertIdentityOptOut || 0) === 1;
  const privacyCard = `
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;">
        <div>
          <div style="font-weight:700;color:#e0e7ff;">Privacy: Tracker Identity Display</div>
          <div style="color:var(--text-secondary);font-size:0.86em;margin-top:4px;">
            Enable this option to hide your Discord username in NFT and token tracker alerts. Leave it off to show your username.
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;color:#cbd5e1;font-size:0.86em;cursor:pointer;">
          <input id="walletIdentityOptOutToggle" type="checkbox" ${identityOptOut ? 'checked' : ''} onchange="setWalletIdentityOptOut(this.checked)">
          Hide Username In Alerts
        </label>
      </div>
    </div>
  `;

  if (!userData.wallets || userData.wallets.length === 0) {
    container.innerHTML = `
      ${privacyCard}
      <div class="empty-state">
        <div class="empty-state-icon">&#128188;</div>
        <h4 class="empty-state-title">No Wallets Connected</h4>
        <p class="empty-state-message">Link your Solana wallet to verify NFT ownership and unlock voting power.</p>
        <div class="empty-state-action">
          <button class="btn-primary" onclick="showWalletAddForm()">
            <span>&#10133;</span>
            <span>Add Your First Wallet</span>
          </button>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = privacyCard + '<div class="wallet-list">' + userData.wallets.map(wallet => {
    const verifiedAt = wallet.last_verified_at || userData?.user?.lastVerifiedAt || wallet.created_at || Date.now();
    return `
    <div class="wallet-item ${wallet.is_favorite ? 'favorite' : ''}">
      <div class="wallet-info">
        <div class="wallet-address">
          ${wallet.is_favorite ? '&#9733; ' : ''}${escapeHtml(wallet.wallet_address)}
        </div>
        <div class="wallet-meta">
          ${wallet.is_favorite ? '<span style="color: var(--gold);">Primary Wallet</span>' : '<span>Secondary Wallet</span>'}
          <span>Verified ${formatDate(new Date(verifiedAt))}</span>
        </div>
      </div>
      <div class="wallet-actions">
        ${!wallet.is_favorite ? `
          <button class="btn-secondary" onclick="setFavorite('${escapeJsString(wallet.wallet_address)}')">
            <span>&#9733;</span>
            <span>Set Primary</span>
          </button>
        ` : ''}
        <button class="btn-danger" onclick="confirmRemoveWallet('${escapeJsString(wallet.wallet_address)}')">
          <span>&#128465;</span>
          <span>Remove</span>
        </button>
      </div>
    </div>
  `;
  }).join('') + '</div>';
}

async function setWalletIdentityOptOut(optOut) {
  const checkbox = document.getElementById('walletIdentityOptOutToggle');
  if (checkbox) checkbox.disabled = true;

  try {
    const response = await fetch('/api/user/privacy/wallet-identity-opt-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optOut: !!optOut })
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
      if (checkbox) checkbox.checked = !optOut;
      showError(data.message || 'Failed to update privacy setting');
      return;
    }

    if (!userData.user) userData.user = {};
    userData.user.walletAlertIdentityOptOut = !!data.optOut;
    showSuccess(data.optOut ? 'Username hidden in tracker alerts' : 'Username visible in tracker alerts');
  } catch (error) {
    console.error('Error updating wallet identity privacy preference:', error);
    if (checkbox) checkbox.checked = !optOut;
    showError('Failed to update privacy setting');
  } finally {
    if (checkbox) checkbox.disabled = false;
  }
}

async function setFavorite(address) {
  try {
    const response = await fetch(`/api/user/wallets/${address}/favorite`, {
      method: 'POST'
    });
    const data = await response.json();

    if (data.success) {
      showSuccess('Primary wallet updated successfully');
      await loadPortal();
    } else {
      showError(data.message || 'Failed to set primary wallet');
    }
  } catch (error) {
    console.error('Error setting favorite:', error);
    showError('Failed to set primary wallet');
  }
}

function confirmRemoveWallet(address) {
  showConfirmModal(
    'Remove Wallet',
    `Are you sure you want to remove wallet ${address.substring(0, 8)}...${address.substring(address.length - 8)}? This action cannot be undone.`,
    () => removeWallet(address),
    'Remove Wallet'
  );
  
  // Update button text for this specific action
  const btn = document.getElementById('confirmButton');
  if (btn) btn.textContent = 'Remove Wallet';
}

async function removeWallet(address) {
  try {
    const response = await fetch(`/api/user/wallets/${address}`, {
      method: 'DELETE'
    });
    const data = await response.json();

    if (data.success) {
      showSuccess('Wallet removed successfully');
      await loadPortal();
    } else {
      showError(data.message || 'Failed to remove wallet');
    }
  } catch (error) {
    console.error('Error removing wallet:', error);
    showError('Failed to remove wallet');
  }
}

// ==================== MISSIONS (HEIST) ====================
function renderMissions() {
  const container = document.getElementById('myMissions');
  
  if (!userData.missions || userData.missions.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎯</div>
        <h4 class="empty-state-title">No Active Missions</h4>
        <p class="empty-state-message">You haven't joined any missions yet. Check available missions below to get started.</p>
      </div>
    `;
  } else {
    container.innerHTML = '<div class="mission-list">' + userData.missions.map(mission => `
      <div class="mission-item">
        <div class="mission-header">
          <div class="mission-title">${escapeHtml(mission.title)}</div>
          <span class="status-badge status-${mission.status}">${mission.status}</span>
        </div>
        <div class="mission-meta">
          Mission #${mission.mission_id} • Role: ${escapeHtml(mission.assigned_role || 'Pending')}
          ${mission.assigned_nft_name ? ` • NFT: ${escapeHtml(mission.assigned_nft_name)}` : ''}
          ${mission.points_awarded > 0 ? ` • <span style="color: var(--success);">+${mission.points_awarded} pts</span>` : ''}
        </div>
      </div>
    `).join('') + '</div>';
  }

  loadAvailableMissions();
}

async function loadAvailableMissions() {
  const container = document.getElementById('availableMissions');
  
  try {
    const endpoint = buildPublicV1Url('/api/public/v1/missions/active', { requireGuild: true });
    if (!endpoint) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🧭</div>
          <h4 class="empty-state-title">Select a Server</h4>
          <p class="empty-state-message">Pick your server first to view active missions.</p>
        </div>
      `;
      return;
    }

    const response = await fetch(endpoint, { credentials: 'include' });
    const data = await response.json();
    const missions = data?.data?.missions || data?.missions || [];
    
    if (!data.success || missions.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🗺️</div>
          <h4 class="empty-state-title">No Missions Available</h4>
          <p class="empty-state-message">Check back later for new mission opportunities.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '<div class="mission-list">' + missions.map(mission => `
      <div class="mission-item">
        <div class="mission-header">
          <div class="mission-title">${escapeHtml(mission.title)}</div>
          <span class="status-badge status-${mission.status}">${mission.status}</span>
        </div>
        <div class="mission-meta" style="margin-top: var(--space-3);">
          ${mission.description ? `<p style="color: var(--text-secondary); margin-bottom: var(--space-2);">${escapeHtml(mission.description)}</p>` : ''}
          <div style="display: flex; gap: var(--space-4); flex-wrap: wrap; margin-top: var(--space-2);">
            <span>🎯 Slots: ${mission.filledSlots || 0}/${mission.totalSlots}</span>
            <span>💎 Reward: ${mission.rewardPoints} points</span>
          </div>
        </div>
      </div>
    `).join('') + '</div>';
  } catch (error) {
    console.error('Error loading available missions:', error);
    container.innerHTML = `
      <div class="error-state">
        <div class="error-title">
          <span>⚠️</span>
          <span>Failed to Load Missions</span>
        </div>
        <div class="error-message">Unable to fetch available missions. Please try refreshing the page.</div>
      </div>
    `;
  }
}

// ==================== NAVIGATION ====================
function goHomePage() {
  switchSection('landing', { updateUrl: false });
}

function switchSection(sectionName, options = {}) {
  sectionName = normalizePortalSectionName(sectionName);

  if (requiresServerSelectionGate()) {
    const allowWithoutServer = ['landing', 'servers', 'wallets', 'dashboard', 'help', 'docs'];
    if (isSuperadmin && sectionName === 'admin') {
      // allow superadmin control plane without tenant selection
    } else if (!allowWithoutServer.includes(sectionName)) {
      sectionName = 'landing';
    }
  }

  // Gate settings section to admins only
  if (sectionName === 'settings' && !(isAdmin || isSuperadmin)) {
    showInfo('Admin access required for Settings.');
    sectionName = 'landing';
  }

  const moduleState = window._tenantModuleState || null;
  const sectionRequiresModule = {
    governance: 'governance',
    wallets: 'verification',
    treasury: 'wallettracker',
    'nft-activity': 'nfttracker',
    'token-activity': 'tokentracker',
    heist: 'heist',
    battle: 'minigames',
    'self-serve-roles': 'selfserveroles',
    ticketing: 'ticketing',
    engagement: 'engagement'
  };
  const required = sectionRequiresModule[sectionName];
  if (required && moduleState && moduleState[required] === false) {
    showInfo('This module is disabled for the selected server.');
    sectionName = 'landing';
  }

  // Update nav items (both sidebar and mobile)
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
  });
  document.querySelectorAll(`.nav-item[data-section="${sectionName}"]`).forEach(item => {
    item.classList.add('active');
  });

  // Update content sections
  document.querySelectorAll('.content-section').forEach(section => {
    section.classList.remove('active');
  });
  const targetSection = document.getElementById(`section-${sectionName}`);
  if (targetSection) {
    targetSection.classList.add('active');
    
    // Scroll to top of content area
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Load section-specific data
  if (sectionName === 'landing') {
    renderGeneralSection();
  } else if (sectionName === 'governance' && userData) {
    loadActiveVotes();
  } else if (sectionName === 'servers') {
    loadServerAccess();
  } else if (sectionName === 'wallets' && userData) {
    renderWallets();
  } else if (sectionName === 'treasury') {
    loadTreasuryWalletTable();
  } else if (sectionName === 'nft-activity') {
    loadNFTActivityView();
    if (isAdmin) loadNFTActivityAdminView();
  } else if (sectionName === 'token-activity') {
    loadTokenActivityView();
  } else if (sectionName === 'settings') {
    applySettingsTabVisibility(portalSettingsData || {});
    switchSettingsTab('general');
  } else if (sectionName === 'admin') {
    loadEnvStatusBar();
  } else if (sectionName === 'heist' && userData && heistEnabled) {
    loadAvailableMissions();
  } else if (sectionName === 'self-serve-roles') {
    loadSelfServeRolesPublic();
  } else if (sectionName === 'ticketing') {
    loadUserTicketOverview();
  } else if (sectionName === 'engagement') {
    loadEngagementSection();
  } else if (sectionName === 'plans') {
    updatePlanPrices();
    if (isAdmin) loadCurrentPlan();
  }

  // Toggle sidebar visibility — hide on landing/home, show on bot management sections
  const portalLayout = document.querySelector('.portal-layout');
  if (portalLayout) {
    if (sectionName === 'landing') {
      portalLayout.classList.add('sidebar-hidden');
    } else {
      portalLayout.classList.remove('sidebar-hidden');
    }
  }

  // Update URL without reload
  const url = new URL(window.location);
  if (options.updateUrl === false) {
    url.searchParams.delete('section');
    url.searchParams.delete('adminView');
  } else {
    url.searchParams.set('section', sectionName);
  }
  window.history.pushState({}, '', url);
}

function toggleHelp(categoryId) {
  // Hide all help content
  document.querySelectorAll('.help-content').forEach(content => {
    content.style.display = 'none';
  });

  // Show selected help content
  const content = document.getElementById(`help-${categoryId}`);
  if (content) {
    const isVisible = content.style.display === 'block';
    content.style.display = isVisible ? 'none' : 'block';
    
    if (!isVisible) {
      // Smooth scroll to content
      setTimeout(() => {
        content.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);
    }
  }
}

async function loadTreasuryPublicView() {
  const content = document.getElementById('publicTreasuryView');
  if (!content) return;
  
  content.innerHTML = `<div style="text-align:center; padding: var(--space-5);"><div class="spinner"></div><p>Loading...</p></div>`;
  
  try {
    let data = null;
    let source = 'wallet-tracker';

    const trackerResponse = await fetch('/api/admin/wallet-tracker/balances', {
      credentials: 'include',
      headers: buildTenantRequestHeaders(),
    });

    if (trackerResponse.ok) {
      data = await trackerResponse.json();
    } else {
      source = 'treasury';
      const response = await fetch('/api/public/v1/treasury', { credentials: 'include', headers: buildTenantRequestHeaders() });
      data = await response.json();
    }

    if (data && data.success) {
      const payload = data.data || {};
      const t = source === 'wallet-tracker'
        ? {
            sol: Number(payload?.totals?.sol || 0).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
            usdc: Number(payload?.totals?.usdc || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            lastUpdated: payload?.lastUpdated || null,
            walletCount: Number(payload?.walletCount || 0),
          }
        : (payload || data.treasury || {});

      content.innerHTML = `
        <div style="display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr));">
          <div style="padding:16px; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.22); border-radius:10px;">
            <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:8px;">SOL Balance</div>
            <div style="font-size:2em; font-weight:700; color:#93c5fd;">${t.sol ?? t.sol_balance ?? '—'}</div>
          </div>
          <div style="padding:16px; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.22); border-radius:10px;">
            <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:8px;">USDC Balance</div>
            <div style="font-size:2em; font-weight:700; color:#86efac;">${t.usdc ?? t.usdc_balance ?? '—'}</div>
          </div>
          <div style="padding:16px; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.22); border-radius:10px;">
            <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:8px;">Last Updated</div>
            <div style="font-size:1.1em; font-weight:600; color:#e0e7ff;">${t.lastUpdated || t.last_updated ? new Date(t.lastUpdated || t.last_updated).toLocaleString() : '—'}</div>
          </div>
        </div>
        ${source === 'wallet-tracker'
          ? `<div style="margin-top:10px; color:var(--text-secondary); font-size:0.85em;">Across ${Number(t.walletCount || 0)} tracked wallet${Number(t.walletCount || 0) === 1 ? '' : 's'}.</div>`
          : ''}
      `;
    } else {
      content.innerHTML = `<div style="color:var(--text-secondary); text-align:center; padding:20px;">Treasury data unavailable</div>`;
    }
  } catch (e) {
    content.innerHTML = `<div style="color:#ef4444; text-align:center; padding:20px;">Error loading treasury: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadTreasuryTransactions() {
  const content = document.getElementById('publicTreasuryTransactions');
  if (!content) return;
  
  try {
    const response = await fetch('/api/public/v1/treasury/transactions?limit=10', { credentials: 'include' });
    const data = await response.json();
    const transactions = data.data?.transactions || data.transactions || [];
    
    if (data.success && transactions.length > 0) {
      const rows = transactions.map(tx => {
        const direction = tx.direction || (tx.type === 'in' ? 'in' : 'out');
        const label = direction === 'in' || direction === 'incoming' ? '➕ Incoming' : '➖ Outgoing';
        const amount = tx.deltaSol ?? tx.amount ?? '—';
        const hash = tx.signature || tx.tx_hash || '';
        const timestamp = tx.blockTime
          ? new Date(tx.blockTime * 1000)
          : (tx.timestamp ? new Date(tx.timestamp) : null);

        return `
        <div style="padding:12px; border-bottom:1px solid rgba(99,102,241,0.15); display:flex; justify-content:space-between; align-items:center;">
          <div style="flex:1;">
            <div style="color:#e0e7ff; font-weight:600;">${label}</div>
            <div style="color:var(--text-secondary); font-size:0.85em; font-family:monospace;">${hash ? `${hash.slice(0, 16)}...` : '—'}</div>
          </div>
          <div style="text-align:right;">
            <div style="color:#e0e7ff; font-weight:600;">${amount} SOL</div>
            <div style="color:var(--text-secondary); font-size:0.85em;">${timestamp ? timestamp.toLocaleDateString() : '—'}</div>
          </div>
        </div>
      `}).join('');
      
      content.innerHTML = `<div style="border:1px solid rgba(99,102,241,0.22); border-radius:10px; overflow:hidden;">${rows}</div>`;
    } else {
      content.innerHTML = `<div style="color:var(--text-secondary); text-align:center; padding:20px;">No transactions yet</div>`;
    }
  } catch (e) {
    content.innerHTML = `<div style="color:#ef4444; text-align:center; padding:20px;">Error loading transactions</div>`;
  }
}

// ==================== TREASURY TABS & WALLETS ====================

function showAdminTreasuryElements() {
  document.querySelectorAll('.admin-only-treasury').forEach(el => {
    el.style.display = '';
  });
  // Show wallet action buttons in card header
  const actions = document.getElementById('treasuryWalletActions');
  if (actions) actions.style.display = 'flex';
  // Show alerts card
  const alertsCard = document.getElementById('treasuryAlertsCard');
  if (alertsCard) alertsCard.style.display = '';
}

async function loadTreasuryWalletTable() {
  // Alias — now delegates to tracked wallets list
  if (isAdmin) showAdminTreasuryElements();
  await loadTrackedWalletList();
}

async function loadTrackedWalletList() {
  const container = document.getElementById('treasuryWalletTableContainer');
  if (!container) return;

  try {
    const res = await fetch('/api/admin/wallet-tracker/wallets', { credentials: 'include', headers: buildTenantRequestHeaders() });
    if (!res.ok) {
      container.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding:20px;">Admin access required to manage tracked wallets.</div>';
      return;
    }
    const data = await res.json();
    const wallets = data.wallets || [];
    document.getElementById('treasuryWalletCount').textContent = wallets.length;

    if (!wallets.length) {
      container.innerHTML = `
        <div style="text-align:center; padding:var(--space-5); color:var(--text-secondary);">
          <p style="margin-bottom:16px;">No wallets tracked yet. Add a wallet to start monitoring.</p>
          <button class="btn-primary" onclick="openAddWalletModal()">+ Add Wallet</button>
        </div>`;
      return;
    }

    const rows = wallets.map(w => {
      const addr = `${w.wallet_address.slice(0,6)}...${w.wallet_address.slice(-4)}`;
      const lbl = escapeHtml(w.label || '—');
      const alertCh = w.alert_channel_id ? `<code>#${w.alert_channel_id}</code>` : '<span style="color:var(--text-secondary);">—</span>';
      const panelCh = w.panel_channel_id ? `<code>#${w.panel_channel_id}</code>` : '<span style="color:var(--text-secondary);">—</span>';
      const status = w.enabled ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-paused">Paused</span>';
      return `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
          <td style="padding:10px 12px;">
            <span style="font-family:monospace;font-size:0.85em;" title="${escapeHtml(w.wallet_address)}">${addr}</span>
            <button class="tw-copy-btn" data-addr="${escapeHtml(w.wallet_address)}" title="Copy address" style="margin-left:4px;background:none;border:none;cursor:pointer;font-size:0.85em;">📋</button>
          </td>
          <td style="padding:10px 12px;color:#c9d6ff;">${lbl}</td>
          <td style="padding:10px 12px;">${alertCh}</td>
          <td style="padding:10px 12px;">${panelCh}</td>
          <td style="padding:10px 12px;">${status}</td>
          <td style="padding:10px 12px;">
            <div style="display:flex;gap:6px;">
              <button class="tw-panel-btn" data-id="${w.id}" title="Refresh Holdings Panel" style="font-size:0.8em;padding:4px 8px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;">📋 Panel</button>
              <button class="tw-edit-btn" data-id="${w.id}" data-addr="${escapeHtml(w.wallet_address)}" data-label="${escapeHtml(w.label||'')}" data-alertch="${w.alert_channel_id||''}" data-panelch="${w.panel_channel_id||''}" title="Edit" style="font-size:0.8em;padding:4px 8px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;">✏️</button>
              <button class="tw-remove-btn" data-id="${w.id}" title="Remove" style="font-size:0.8em;padding:4px 8px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
            </div>
          </td>
        </tr>`;
    }).join('');

    container.innerHTML = `
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="border-bottom:2px solid rgba(255,255,255,0.1);">
              <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Address</th>
              <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Label</th>
              <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">TX Alert Ch.</th>
              <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Watch Ch.</th>
              <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Status</th>
              <th style="padding:8px 12px;"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    attachTrackedWalletListeners(container);
  } catch (err) {
    console.error('[TrackedWallets] Load error:', err);
    container.innerHTML = '<div style="color:#ef4444;text-align:center;padding:20px;">Error loading wallets.</div>';
  }
}

async function refreshTrackedWalletPanel(id) {
  try {
    const res = await fetch(`/api/admin/wallet-tracker/wallets/${id}/panel`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() }
    });
    const d = await res.json();
    if (d.success) showSuccess('Holdings panel ' + (d.action === 'updated' ? 'updated!' : 'posted!'));
    else showError(d.message || 'Failed to post panel');
  } catch { showError('Error posting holdings panel'); }
}

async function removeTrackedWallet(id) {
  if (!confirm('Remove this tracked wallet?')) return;
  try {
    const res = await fetch('/api/admin/wallet-tracker/wallets/' + id, {
      method: 'DELETE',
      credentials: 'include',
      headers: buildTenantRequestHeaders()
    });
    const d = await res.json();
    if (d.success) {
      showSuccess('Wallet removed');
      loadTrackedWalletList();
      renderSettingsWalletList();
    } else showError(d.message || 'Failed to remove wallet');
  } catch { showError('Error removing wallet'); }
}

function attachTrackedWalletListeners(container) {
  container.querySelectorAll('.tw-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openAddWalletModal(
        btn.dataset.id,
        btn.dataset.addr,
        btn.dataset.label,
        btn.dataset.alertch,
        btn.dataset.panelch
      );
    });
  });
  container.querySelectorAll('.tw-panel-btn').forEach(btn => {
    btn.addEventListener('click', () => refreshTrackedWalletPanel(btn.dataset.id));
  });
  container.querySelectorAll('.tw-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeTrackedWallet(btn.dataset.id));
  });
  container.querySelectorAll('.tw-copy-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      navigator.clipboard.writeText(this.dataset.addr);
      this.textContent = '✓';
      setTimeout(() => this.textContent = '📋', 1200);
    });
  });
}




// ==================== ADD WALLET MODAL ====================
async function openAddWalletModal(existingId, existingAddr, existingLabel, existingAlertCh, existingPanelCh) {
  const modal = document.getElementById('addWalletModal');
  const isEdit = !!existingId;
  document.getElementById('addWalletModalTitle').textContent = isEdit ? 'Edit Tracked Wallet' : 'Add Tracked Wallet';
  document.getElementById('addWalletEditId').value = existingId || '';
  document.getElementById('addWalletAddress').value = existingAddr || '';
  document.getElementById('addWalletAddress').disabled = isEdit; // can't change address on edit
  document.getElementById('addWalletLabel').value = existingLabel || '';
  document.getElementById('addWalletError').style.display = 'none';
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Populate both channel dropdowns
  const alertSel = document.getElementById('addWalletChannel');
  const panelSel = document.getElementById('addWalletPanelChannel');
  alertSel.innerHTML = '<option value="">-- No TX alerts --</option>';
  panelSel.innerHTML = '<option value="">-- No holdings panel --</option>';

  try {
    const chRes = await fetch('/api/admin/discord/channels', { credentials: 'include' });
    if (chRes.ok) {
      const chData = await chRes.json();
      const channels = chData.channels || [];
      const grouped = {};
      channels.forEach(ch => {
        const parent = ch.parentName || 'Other';
        if (!grouped[parent]) grouped[parent] = [];
        grouped[parent].push(ch);
      });
      [alertSel, panelSel].forEach(sel => {
        Object.keys(grouped).sort().forEach(parent => {
          const og = document.createElement('optgroup');
          og.label = parent;
          grouped[parent].forEach(ch => {
            const opt = document.createElement('option');
            opt.value = ch.id;
            opt.textContent = '# ' + ch.name;
            og.appendChild(opt);
          });
          sel.appendChild(og.cloneNode(true));
        });
      });
    }
  } catch (e) { console.error('[AddWalletModal] Channel load error:', e); }

  if (existingAlertCh) alertSel.value = existingAlertCh;
  if (existingPanelCh) panelSel.value = existingPanelCh;
}

function closeAddWalletModal() {
  document.getElementById('addWalletModal').style.display = 'none';
  document.getElementById('addWalletAddress').disabled = false;
  document.body.style.overflow = '';
}

async function saveNewWallet() {
  const editId = document.getElementById('addWalletEditId').value;
  const addr = document.getElementById('addWalletAddress').value.trim();
  const label = document.getElementById('addWalletLabel').value.trim();
  const alertChannelId = document.getElementById('addWalletChannel').value.trim();
  const panelChannelId = document.getElementById('addWalletPanelChannel').value.trim();
  const errEl = document.getElementById('addWalletError');

  if (!editId && (!addr || addr.length < 32 || addr.length > 44)) {
    errEl.textContent = 'A valid Solana wallet address is required.';
    errEl.style.display = 'block';
    return;
  }

  const saveBtn = document.getElementById('addWalletSaveBtn');
  saveBtn.textContent = 'Saving...';
  saveBtn.disabled = true;

  try {
    let res, result;
    if (editId) {
      // Edit existing
      res = await fetch('/api/admin/wallet-tracker/wallets/' + editId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
        credentials: 'include',
        body: JSON.stringify({ label: label || null, alertChannelId: alertChannelId || null, panelChannelId: panelChannelId || null })
      });
    } else {
      // Add new
      res = await fetch('/api/admin/wallet-tracker/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
        credentials: 'include',
        body: JSON.stringify({ walletAddress: addr, label: label || null, alertChannelId: alertChannelId || null, panelChannelId: panelChannelId || null })
      });
    }
    result = await res.json();
    if (result.success) {
      closeAddWalletModal();
      const msg = panelChannelId
        ? (editId ? 'Wallet updated! Holdings panel refreshed.' : 'Wallet added! Holdings panel posted to watch channel.')
        : (editId ? 'Wallet updated.' : 'Wallet added.');
      showSuccess(msg);
      loadTrackedWalletList();
      renderSettingsWalletList();
    } else {
      errEl.textContent = result.message || 'Failed to save wallet.';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = 'Network error saving wallet.';
    errEl.style.display = 'block';
  } finally {
    saveBtn.textContent = 'Save Wallet';
    saveBtn.disabled = false;
  }
}

// ==================== TREASURY ALERTS CONFIG ====================
async function loadTreasuryAlertsConfig() {
  const container = document.getElementById('treasuryAlertsConfig');
  if (!container) return;

  try {
    const res = await fetch('/api/admin/treasury', { credentials: 'include' });
    if (!res.ok) { container.innerHTML = '<p style="color:var(--text-secondary);">Admin access required.</p>'; return; }
    const data = await res.json();
    const c = data.config || data;

    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:16px; max-width:500px;">
        <div>
          <label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">TX Alert Channel ID</label>
          <input id="alertsCfgChannel" type="text" value="${c.txAlertChannelId || ''}" placeholder="Discord channel ID" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; font-family:monospace; box-sizing:border-box;">
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <input id="alertsCfgIncoming" type="checkbox" ${c.txAlertIncomingOnly ? 'checked' : ''} style="width:18px; height:18px;">
          <label style="color:#e0e7ff; font-size:0.9em;">Incoming only — only alert on received SOL</label>
        </div>
        <div>
          <label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Minimum SOL Amount</label>
          <input id="alertsCfgMinSol" type="number" min="0" step="0.1" value="${c.txAlertMinSol || 0}" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; box-sizing:border-box;">
        </div>
        <div>
          <button class="btn-primary" onclick="saveTreasuryAlertsCfg()">Save Alert Settings</button>
          <span id="alertsCfgFeedback" style="margin-left:12px; font-size:0.85em; font-weight:600;"></span>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = '<p style="color:#ef4444;">Error loading alert config.</p>';
  }
}

async function saveTreasuryAlertsCfg() {
  const feedback = document.getElementById('alertsCfgFeedback');
  const payload = {
    txAlertsEnabled: true,
    txAlertChannelId: document.getElementById('alertsCfgChannel').value.trim(),
    txAlertIncomingOnly: document.getElementById('alertsCfgIncoming').checked,
    txAlertMinSol: parseFloat(document.getElementById('alertsCfgMinSol').value) || 0
  };
  if (!payload.txAlertChannelId) {
    payload.txAlertsEnabled = false;
  }
  try {
    const res = await fetch('/api/admin/treasury/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify(payload)
    });
    const result = await res.json();
    feedback.style.color = result.success ? '#4ade80' : '#ef4444';
    feedback.textContent = result.success ? '✓ Saved!' : (result.message || 'Save failed');
    setTimeout(() => { feedback.textContent = ''; }, 3000);
  } catch (err) {
    feedback.style.color = '#ef4444';
    feedback.textContent = 'Network error';
  }
}

function exportTreasuryCSV() {
  // TODO: multi-wallet export. For now, export single wallet info from visible table.
  const table = document.querySelector('#treasuryWalletTableContainer table');
  if (!table) { showSuccess('No wallet data to export.'); return; }
  let csv = 'Address,Channel,Status\n';
  table.querySelectorAll('tbody tr').forEach(row => {
    const cells = row.querySelectorAll('td');
    const addr = cells[0]?.textContent?.trim().replace(/[{}\n]/g, ' ').replace(/\s+/g, ' ') || '';
    const ch = cells[1]?.textContent?.trim() || '';
    const status = cells[3]?.textContent?.trim() || '';
    csv += `"${addr}","${ch}","${status}"\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'treasury-wallets.csv';
  a.click();
}

function toggleMobileMenu() {
  const menu = document.getElementById('mobileMenu');
  if (menu.style.display === 'block') {
    menu.style.display = 'none';
    document.body.style.overflow = '';
  } else {
    menu.style.display = 'block';
    document.body.style.overflow = 'hidden';
  }
}

// ==================== MODALS ====================
function showConfirmModal(title, message, callback, buttonText = 'Confirm') {
  const modal = document.getElementById('confirmModal');
  const modalTitle = document.getElementById('confirmTitle');
  const modalMessage = document.getElementById('confirmMessage');
  const btn = document.getElementById('confirmButton');
  
  modalTitle.textContent = title;
  modalMessage.textContent = message;
  confirmCallback = callback;
  
  if (btn) {
    btn.textContent = buttonText;
  }
  
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeConfirmModal() {
  closePortalMultiSelectPicker(false);
  const modal = document.getElementById('confirmModal');
  modal.style.display = 'none';
  document.body.style.overflow = '';
  confirmCallback = null;
  const btn = document.getElementById('confirmButton');
  if (btn) {
    btn.style.display = '';
    btn.textContent = 'Confirm'; // Reset text
  }
}

function confirmAction() {
  if (confirmCallback) {
    confirmCallback();
  }
  closeConfirmModal();
}

// ==================== NOTIFICATIONS ====================
function showSuccess(message) {
  showNotification(message, 'success');
}

function showError(message) {
  showNotification(message, 'error');
}

function showInfo(message) {
  showNotification(message, 'info');
}

function showNotification(message, type = 'info') {
  // Remove existing toast if any
  const existing = document.querySelector('.toast-notification');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  const colors = { success: '#10b981', error: '#ef4444', info: '#3b82f6', warning: '#f59e0b' };
  const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
  toast.style.cssText = `
    position:fixed; top:24px; right:24px; z-index:9999;
    padding:14px 20px; border-radius:10px; max-width:400px;
    background:rgba(14,23,44,0.95); border:1px solid ${colors[type] || colors.info};
    color:#e0e7ff; font-size:0.92em; display:flex; align-items:center; gap:10px;
    box-shadow:0 8px 24px rgba(0,0,0,0.5); animation:fadeInUp 0.3s ease;
  `;
  toast.innerHTML = `<span style="color:${colors[type] || colors.info}; font-size:1.3em;">${icons[type] || icons.info}</span><span>${escapeHtml(message)}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 4000);
}

// ==================== VOTING ====================
async function castVote(proposalId, choice) {
  if (!userData) {
    showError('Please log in to vote');
    return;
  }
  
  const labels = { yes: 'YES', no: 'NO', abstain: 'ABSTAIN' };
  showConfirmModal(`Vote ${labels[choice]}?`, `Cast your vote as "${labels[choice]}" on this proposal? This cannot be changed.`, async () => {
    try {
      const response = await fetch('/api/user/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, choice })
      });
      const data = await response.json();
      if (data.success) {
        showSuccess(`Vote cast: ${labels[choice]}`);
        await loadActiveVotes();
      } else {
        showError(data.message || 'Failed to cast vote');
      }
    } catch (e) {
      showError('Error casting vote: ' + e.message);
    }
  }, 'Cast Vote');
}

// ==================== CREATE PROPOSAL ====================
function showCreateProposalForm() {
  if (!userData) {
    showError('Please log in to create a proposal');
    return;
  }

  showConfirmModal('Create Proposal', '', null);
  // Override modal content with form
  const body = document.getElementById('confirmMessage');
  const btn = document.getElementById('confirmButton');
  const title = document.getElementById('confirmTitle');
  title.textContent = '📜 Create New Proposal';
  btn.textContent = 'Submit Proposal';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-primary');

  body.innerHTML = `
    <div style="display:grid; gap:16px;">
      <div>
        <label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Proposal Title *</label>
        <input id="proposalTitleInput" type="text" placeholder="Enter a clear, descriptive title" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;">
      </div>
      <div>
        <label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Category *</label>
        <select id="proposalCategoryInput" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;">
          <option value="Partnership">Partnership</option>
          <option value="Treasury Allocation">Treasury Allocation</option>
          <option value="Rule Change">Rule Change</option>
          <option value="Community Event">Community Event</option>
          <option value="Other" selected>Other</option>
        </select>
      </div>
      <div>
        <label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Cost Indication (optional)</label>
        <input id="proposalCostInput" type="text" placeholder="e.g. ~500 USDC" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;">
      </div>
      <div>
        <label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Description *</label>
        <textarea id="proposalDescInput" placeholder="Explain your proposal's purpose and impact" rows="4" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; resize:vertical;"></textarea>
      </div>
    </div>
  `;

  confirmCallback = async () => {
    const proposalTitle = document.getElementById('proposalTitleInput')?.value.trim();
    const proposalDesc = document.getElementById('proposalDescInput')?.value.trim();
    const proposalCategory = document.getElementById('proposalCategoryInput')?.value || 'Other';
    const proposalCost = document.getElementById('proposalCostInput')?.value.trim() || null;
    if (!proposalTitle || !proposalDesc) {
      showError('Please fill in both title and description');
      return;
    }
    try {
      const response = await fetch('/api/user/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: proposalTitle, description: proposalDesc, category: proposalCategory, costIndication: proposalCost })
      });
      const data = await response.json();
      if (data.success) {
        showSuccess('Proposal submitted! It will be reviewed by admins.');
        await loadPortal();
        switchSection('governance');
      } else {
        showError(data.message || 'Failed to create proposal');
      }
    } catch (e) {
      showError('Error creating proposal: ' + e.message);
    }
  };
}

// ==================== AUTH ====================
function login() {
  // Preserve guild + current section so user lands back in the right place
  const qs = new URLSearchParams();
  const currentSection = (document.querySelector('.nav-item.active') || {}).dataset?.section || '';
  if (activeGuildId) qs.set('guild', activeGuildId);
  if (currentSection && currentSection !== 'landing') qs.set('section', currentSection);
  const returnTo = '/' + (qs.toString() ? '?' + qs.toString() : '');
  window.location.href = '/auth/discord/login?returnTo=' + encodeURIComponent(returnTo);
}

function logout() {
  showConfirmModal(
    'Confirm Logout',
    'Are you sure you want to log out?',
    () => {
      setActiveGuild('', { persist: true, announce: false });
      window.location.href = '/auth/discord/logout';
    }
  );
}

function handleAuth() {
  if (userData) {
    logout();
  } else {
    login();
  }
}

// ==================== UTILITY FUNCTIONS ====================
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeJsString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/</g, '\\x3C')
    .replace(/>/g, '\\x3E');
}

function formatDate(date) {
  if (!date || !(date instanceof Date) || isNaN(date)) {
    return 'Unknown date';
  }
  
  const now = new Date();
  const diff = now - date;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (seconds < 60) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
  
  return date.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric' 
  });
}


// ==================== ERROR HANDLING ====================
window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

// ==================== INTEGRATED ADMIN WORKSPACE ====================
function hideAllAdminCards() {
  ['adminUsersCard', 'adminProposalsCard', 'adminSettingsCard', 'adminSuperadminCard', 'adminSystemMonitorCard', 'adminAnalyticsCard', 'adminHelpCard', 'adminRolesCard', 'adminActivityCard', 'adminStatsCard', 'adminNftTrackerCard', 'adminInviteTrackerCard', 'adminVotingPowerCard', 'adminSelfServeRolesCard', 'adminApiRefCard', 'adminTicketingCard']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
}

let _envStatusCache = null;
async function loadEnvStatusBar() {
  const bar = document.getElementById('adminEnvStatusBar');
  if (!bar) return;
  const useSuperadminEndpoint = !!isSuperadmin && !activeGuildId;
  const endpoint = useSuperadminEndpoint ? '/api/superadmin/env-status' : '/api/admin/env-status';
  const cacheKey = `${endpoint}:${activeGuildId || 'none'}`;
  if (_envStatusCache && _envStatusCache[cacheKey]?.nodeEnv) {
    renderEnvStatusBar(bar, _envStatusCache[cacheKey]);
    return;
  }
  try {
    const opts = { credentials: 'include' };
    if (!useSuperadminEndpoint) {
      opts.headers = buildTenantRequestHeaders();
    }
    const res = await fetch(endpoint, opts);
    const data = await res.json();
    if (!res.ok || data?.success === false) {
      throw new Error(data?.message || 'Failed to load environment status');
    }
    _envStatusCache = _envStatusCache || {};
    _envStatusCache[cacheKey] = data;
    renderEnvStatusBar(bar, data);
  } catch (e) {
    bar.innerHTML = '';
  }
}
function renderEnvStatusBar(bar, d) {
  const pill = (label, color) => `<span style="display:inline-block;background:${color};color:#fff;border-radius:20px;padding:4px 12px;font-size:0.75em;font-weight:600;margin:0 4px 4px 0;">${label}</span>`;
  bar.innerHTML = `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;">`
    + (d.mockMode ? pill('🟡 MOCK MODE', '#b8860b') : pill('🟢 LIVE MODE', '#2e7d32'))
    + (d.heliusConfigured ? pill('Helius ✓', '#2e7d32') : pill('Helius ✗', '#c62828'))
    + (d.webhookSecretConfigured ? pill('Webhook ✓', '#2e7d32') : pill('Webhook —', '#616161'))
    + pill('NODE_ENV: ' + (d.nodeEnv || 'development'), d.nodeEnv === 'production' ? '#1565c0' : '#616161')
    + `</div>`;
}


function isTenantSensitiveAdminView(view) {
  return [
    'stats',
    'users',
    'proposals',
    'settings',
    'analytics',
    'roles',
    'activity',
    'votingpower',
    'nfttracker',
    'invites',
    'selfserveroles',
    'ticketing'
  ].includes(view);
}

function showAdminView(view) {
  // Admin sidebar is only shown to admins — no need to re-check here
  // (prevents timing issues where isAdmin hasn't been set yet)

  if (requiresServerSelectionGate() && !(isSuperadmin && (view === 'superadmin' || view === 'monitor'))) {
    switchSection('landing');
    showInfo('Select a server first for tenant admin controls.');
    return;
  }

  switchSection('admin');
  hideAllAdminCards();

  const map = {
    stats: { card: 'adminStatsCard', load: loadAdminStats },
    users: { card: 'adminUsersCard', load: loadAdminUsers },
    proposals: { card: 'adminProposalsCard', load: loadAdminProposals },
    settings: { card: 'adminSettingsCard', load: loadAdminSettingsView },
    superadmin: { card: 'adminSuperadminCard', load: loadSuperadminView },
    monitor: { card: 'adminSystemMonitorCard', load: loadSystemStatus },
    analytics: { card: 'adminAnalyticsCard', load: loadAdminAnalyticsView },
    help: { card: 'adminHelpCard', load: loadAdminHelpView },
    roles: { card: 'adminRolesCard', load: loadAdminRoles },
    activity: { card: 'adminActivityCard', load: loadAdminActivity },
    votingpower: { card: 'adminVotingPowerCard', load: loadVotingPowerView },
    nfttracker: { card: 'adminNftTrackerCard', load: loadNftTrackerView },
    invites: { card: 'adminInviteTrackerCard', load: loadInviteTrackerSettingsView },
    selfserveroles: { card: 'adminSelfServeRolesCard', load: loadSelfServeRolesView },
    apiref: { card: 'adminApiRefCard', load: loadApiRefView },
    ticketing: { card: 'adminTicketingCard', load: loadTicketingView }
  };

  const target = map[view] || map.settings;
  const card = document.getElementById(target.card);
  if (card) card.style.display = 'block';

  if (isTenantSensitiveAdminView(view) && !activeGuildId) {
    if (card) {
      card.innerHTML = `
        <div style="padding:20px; border:1px solid rgba(245,158,11,0.22); border-radius:10px; background:rgba(245,158,11,0.08); color:#fcd34d;">
          Select a managed server from the <strong>Servers</strong> section before using tenant-aware admin controls.
        </div>
      `;
    }
    return;
  }

  if (typeof target.load === 'function') target.load();

  // Highlight active admin sub-item in sidebar
  document.querySelectorAll('.admin-sub-item').forEach(btn => {
    btn.classList.remove('active');
    if (btn.getAttribute('data-admin-nav') === view) {
      btn.classList.add('active');
    }
  });

  // Keep Admin submenu behavior isolated from standalone Superadmin nav item
  const submenu = document.getElementById('adminSubmenu');
  const chevron = document.getElementById('adminChevron');
  if (view === 'superadmin' || view === 'monitor') {
    if (submenu) submenu.style.display = 'none';
    if (chevron) chevron.textContent = '▶';
  } else {
    if (submenu) submenu.style.display = 'flex';
    if (chevron) chevron.textContent = '▼';
  }

  loadEnvStatusBar();

  setTimeout(() => card?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}


let superadminListCache = [];
let tenantListCache = [];
let selectedTenantGuildId = null;
let selectedTenantDetailCache = null;
let selectedTenantAuditCache = [];
let selectedTenantLimitsCache = null;
let selectedTenantTemplatePreview = null;
let superadminTemplateCatalog = [];
let superadminTenantSearch = '';
let superadminActiveTab = 'tenants';
let tenantDetailActiveTab = 'overview';
let superadminTenantDirectoryCollapsed = false;
let superadminTenantPage = 1;
let superadminTenantPageSize = 25;
let superadminTenantTotalPages = 1;
let superadminTenantTotalCount = 0;
let superadminTenantSearchTimer = null;
let superadminIdentitySearch = '';
let superadminIdentitySearchTimer = null;
let superadminIdentityCache = [];
let superadminIdentitySelectedUserId = '';
let superadminIdentityAuditCache = [];

const TENANT_PLAN_LABELS = {
  starter: 'Starter',
  growth: 'Growth',
  pro: 'Pro',
  enterprise: 'Enterprise'
};

const TENANT_MODULE_LABELS = {
  verification: 'Verification',
  governance: 'Governance',
  treasury: 'Treasury',
  wallettracker: 'Wallet Tracker',
  invites: 'Invite Tracker',
  minigames: 'Minigames',
  heist: 'Heist',
  ticketing: 'Ticketing',
  nfttracker: 'NFT Tracker',
  tokentracker: 'Token Tracker',
  selfserveroles: 'Self-Serve Roles',
  branding: 'Branding',
  analytics: 'Analytics',
  engagement: 'Engagement & Points'
};

function getTenantPlanLabel(planKey) {
  return TENANT_PLAN_LABELS[planKey] || planKey || 'Unknown';
}

function getTenantStatusBadge(status) {
  const normalized = String(status || 'active').toLowerCase();
  if (normalized === 'suspended') {
    return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:rgba(239,68,68,0.18);color:#fecaca;font-size:0.78em;font-weight:600;">Suspended</span>`;
  }
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:rgba(34,197,94,0.18);color:#bbf7d0;font-size:0.78em;font-weight:600;">Active</span>`;
}

function getTenantModuleLabel(moduleKey) {
  return TENANT_MODULE_LABELS[moduleKey] || moduleKey;
}

function formatDiscordIdentityLabel(discordId, displayName = null) {
  const normalizedId = String(discordId || '').trim();
  const normalizedDisplay = String(displayName || '').trim();
  if (!normalizedId && !normalizedDisplay) return 'system';
  if (!normalizedId) return normalizedDisplay;
  if (!normalizedDisplay) return normalizedId;
  if (normalizedDisplay === normalizedId) return normalizedId;
  return `${normalizedDisplay} (${normalizedId})`;
}

function renderSuperadminIdentityRows(users = []) {
  if (!Array.isArray(users) || users.length === 0) {
    return `<div style="padding:14px; text-align:center; color:var(--text-secondary); border:1px dashed rgba(99,102,241,0.18); border-radius:10px;">No users match this search.</div>`;
  }

  return users.map(user => {
    const selected = String(user.discordId || '') === String(superadminIdentitySelectedUserId || '');
    const badges = [
      user.trustedIdentity ? '<span style="display:inline-block;padding:2px 6px;border-radius:999px;background:rgba(16,185,129,0.18);color:#bbf7d0;font-size:0.7em;">Trusted</span>' : '',
      user.manualVerified ? '<span style="display:inline-block;padding:2px 6px;border-radius:999px;background:rgba(245,158,11,0.18);color:#fde68a;font-size:0.7em;">Manual</span>' : '',
    ].filter(Boolean).join(' ');

    return `
      <button type="button" onclick="selectSuperadminIdentityUser('${escapeJsString(String(user.discordId || ''))}')" style="width:100%; text-align:left; padding:10px 12px; border:1px solid rgba(99,102,241,0.15); border-radius:10px; background:${selected ? 'rgba(99,102,241,0.16)' : 'rgba(14,23,44,0.45)'}; color:inherit; cursor:pointer;">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
          <div style="min-width:0;">
            <div style="color:#e0e7ff; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(user.username || user.discordId || 'Unknown')}</div>
            <div style="color:var(--text-secondary); font-size:0.76em; font-family:monospace; word-break:break-all; margin-top:3px;">${escapeHtml(String(user.discordId || ''))}</div>
          </div>
          <div style="color:#c9d6ff; font-size:0.76em; white-space:nowrap;">${escapeHtml(String(user.walletCount || 0))} wallet(s)</div>
        </div>
        ${badges ? `<div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">${badges}</div>` : ''}
      </button>
    `;
  }).join('');
}

function renderSuperadminIdentityAudit(logs = []) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return `<div style="padding:12px; color:var(--text-secondary); text-align:center; border:1px dashed rgba(99,102,241,0.18); border-radius:10px;">No identity audit logs yet.</div>`;
  }

  return logs.map(log => {
    const walletText = log.walletAddress ? ` • ${escapeHtml(log.walletAddress.slice(0, 6))}...${escapeHtml(log.walletAddress.slice(-4))}` : '';
    const createdText = log?.createdAt ? new Date(log.createdAt).toLocaleString() : 'Unknown time';
    const actorText = formatDiscordIdentityLabel(log.actorId || 'system', log.actorDisplayName || null);
    return `
      <div style="padding:10px 12px; border:1px solid rgba(99,102,241,0.14); border-radius:10px; background:rgba(14,23,44,0.45);">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
          <div style="min-width:0;">
            <div style="color:#e0e7ff; font-weight:600; font-size:0.88em;">${escapeHtml(log.action || 'unknown')}${walletText}</div>
            <div style="color:var(--text-secondary); font-size:0.78em; margin-top:3px;">Actor: ${escapeHtml(actorText)}</div>
          </div>
          <div style="color:var(--text-secondary); font-size:0.74em; white-space:nowrap;">${escapeHtml(createdText)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderTenantRow(tenant) {
  const selected = tenant.guildId === selectedTenantGuildId;
  const statusColor = String(tenant.status || 'active').toLowerCase() === 'suspended'
    ? 'rgba(239,68,68,0.18)'
    : 'rgba(34,197,94,0.18)';

  return `
    <button type="button" onclick="selectTenantGuild('${escapeJsString(tenant.guildId)}')" style="width:100%; text-align:left; display:grid; grid-template-columns:minmax(0,1.6fr) repeat(3,minmax(0,1fr)); gap:12px; align-items:center; padding:12px 14px; border:none; border-bottom:1px solid rgba(99,102,241,0.15); background:${selected ? 'rgba(99,102,241,0.16)' : 'transparent'}; color:inherit; cursor:pointer;">
      <div style="min-width:0;">
        <div style="color:#e0e7ff; font-weight:600; word-break:break-word;">${escapeHtml(tenant.guildName || tenant.guildId)}</div>
        <div style="color:var(--text-secondary); font-size:0.8em; font-family:monospace; word-break:break-all;">${escapeHtml(tenant.guildId)}</div>
      </div>
      <div>
        <div style="color:#c9d6ff; font-weight:600;">${escapeHtml(getTenantPlanLabel(tenant.planKey))}</div>
        <div style="color:var(--text-secondary); font-size:0.8em;">${escapeHtml(tenant.planKey || 'starter')}</div>
      </div>
      <div>${getTenantStatusBadge(tenant.status)}</div>
      <div style="color:#c9d6ff; font-weight:600;">${escapeHtml(String(tenant.enabledModulesCount || 0))}/${escapeHtml(String(tenant.totalModulesCount || 0))}</div>
    </button>
  `;
}

function renderTenantAuditLog(logs) {
  if (!logs || logs.length === 0) {
    return `<div style="padding:14px; text-align:center; color:var(--text-secondary); border:1px dashed rgba(99,102,241,0.18); border-radius:10px;">No audit activity yet.</div>`;
  }

  return logs.map(log => {
    const actorText = formatDiscordIdentityLabel(
      log.actor_id || 'system',
      log.actor_display_name || log.actorDisplayName || null
    );
    return `
    <div style="padding:12px 14px; border:1px solid rgba(99,102,241,0.15); border-radius:10px; background:rgba(14,23,44,0.45);">
      <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
        <div style="min-width:0;">
          <div style="color:#e0e7ff; font-weight:600;">${escapeHtml(log.action)}</div>
          <div style="color:var(--text-secondary); font-size:0.8em; margin-top:4px; word-break:break-all;">Actor: ${escapeHtml(actorText)}</div>
        </div>
        <div style="color:var(--text-secondary); font-size:0.78em; white-space:nowrap;">${escapeHtml(new Date(log.created_at).toLocaleString())}</div>
      </div>
    </div>
  `;
  }).join('');
}

function renderTenantTemplatePreview(previewPayload) {
  if (!previewPayload?.diff) {
    return `<div style="color:var(--text-secondary);">Select a template and click Preview to see the plan/module/limit diff before applying.</div>`;
  }

  const diff = previewPayload.diff;
  const moduleChanges = Array.isArray(diff.modules) ? diff.modules : [];
  const effectiveChanges = Array.isArray(diff.effective) ? diff.effective : [];
  const planText = diff.planChanged
    ? `${escapeHtml(getTenantPlanLabel(diff.plan?.before))} → ${escapeHtml(getTenantPlanLabel(diff.plan?.after))}`
    : escapeHtml(getTenantPlanLabel(diff.plan?.after));

  const moduleRows = moduleChanges.length
    ? moduleChanges.slice(0, 8).map(change => {
        const state = change.after ? 'enabled' : 'disabled';
        return `<div><code>${escapeHtml(change.moduleKey)}</code> → <strong>${state}</strong></div>`;
      }).join('')
    : '<div style="color:var(--text-secondary);">No module toggle changes.</div>';

  const limitRows = effectiveChanges.length
    ? effectiveChanges.slice(0, 8).map(change => {
        const beforeText = change.before === null || change.before === undefined ? 'Unlimited' : String(change.before);
        const afterText = change.after === null || change.after === undefined ? 'Unlimited' : String(change.after);
        return `<div><code>${escapeHtml(change.moduleKey)}.${escapeHtml(change.limitKey)}</code>: ${escapeHtml(beforeText)} → <strong>${escapeHtml(afterText)}</strong></div>`;
      }).join('')
    : '<div style="color:var(--text-secondary);">No effective limit changes.</div>';

  const hiddenModuleCount = Math.max(0, moduleChanges.length - 8);
  const hiddenLimitCount = Math.max(0, effectiveChanges.length - 8);

  return `
    <div style="display:grid; gap:10px;">
      <div><strong>Plan:</strong> ${planText}</div>
      <div><strong>Module Changes (${moduleChanges.length}):</strong><div style="margin-top:6px; display:grid; gap:4px;">${moduleRows}</div>${hiddenModuleCount ? `<div style="margin-top:6px; color:var(--text-secondary);">+${hiddenModuleCount} more module changes</div>` : ''}</div>
      <div><strong>Effective Limit Changes (${effectiveChanges.length}):</strong><div style="margin-top:6px; display:grid; gap:4px;">${limitRows}</div>${hiddenLimitCount ? `<div style="margin-top:6px; color:var(--text-secondary);">+${hiddenLimitCount} more limit changes</div>` : ''}</div>
    </div>
  `;
}

function renderTenantDetailPanel(tenant, tenantLimits = null) {
  if (!tenant) {
    return `<div style="padding:18px; text-align:center; color:var(--text-secondary);">Select a tenant to manage plan, modules, branding, and status.</div>`;
  }

  const billing = tenant.billing || null;
  const billingStatus = String(billing?.subscriptionStatus || 'unknown').toLowerCase();
  const billingInterval = billing?.billingInterval === 'yearly' ? 'Yearly' : (billing?.billingInterval === 'monthly' ? 'Monthly' : 'Unknown');
  const billingProvider = billing?.provider ? String(billing.provider).toUpperCase() : 'N/A';
  const billingEnd = billing?.currentPeriodEnd ? new Date(billing.currentPeriodEnd).toLocaleString() : 'Not set';

  const planOptions = Object.entries(TENANT_PLAN_LABELS).map(([key, label]) => `
    <option value="${escapeHtml(key)}"${tenant.planKey === key ? ' selected' : ''}>${escapeHtml(label)}</option>
  `).join('');

  const templateOptions = (Array.isArray(superadminTemplateCatalog) ? superadminTemplateCatalog : []).map(template => `
    <option value="${escapeHtml(template.key)}">${escapeHtml(template.label || template.key)}${template.planKey ? ` (${escapeHtml(getTenantPlanLabel(template.planKey))})` : ''}</option>
  `).join('');

  const moduleToggles = Object.entries(TENANT_MODULE_LABELS).map(([moduleKey, label]) => {
    const isOn = !!tenant.modules?.[moduleKey];
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:10px 12px; border:1px solid rgba(99,102,241,0.14); border-radius:10px; background:rgba(14,23,44,0.45);">
        <span style="color:#e0e7ff; font-weight:600;">${escapeHtml(label)}</span>
        <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0;">
          <input type="checkbox" ${isOn ? 'checked' : ''} onchange="toggleTenantModule('${escapeHtml(moduleKey)}', this); this.parentElement.querySelector('.tenant-toggle-track').style.background=this.checked?'var(--gold)':'#555'; this.parentElement.querySelector('.tenant-toggle-knob').style.left=this.checked?'22px':'3px';" style="opacity:0;width:0;height:0;">
          <span class="tenant-toggle-track" style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${isOn ? 'var(--gold)' : '#555'};border-radius:24px;transition:.3s;"></span>
          <span class="tenant-toggle-knob" style="position:absolute;height:18px;width:18px;left:${isOn ? '22px' : '3px'};bottom:3px;background:#fff;border-radius:50%;transition:.3s;pointer-events:none;"></span>
        </label>
      </div>
    `;
  }).join('');

  const branding = tenant.branding || {};
  const limitDefinitions = tenantLimits?.definitions || {};
  const planModuleLimits = tenantLimits?.planLimits || {};
  const overrideModuleLimits = tenantLimits?.overrides || {};
  const effectiveModuleLimits = tenantLimits?.effective || {};
  const moduleLimitRows = (() => {
    const moduleKeys = [...new Set([
      ...Object.keys(limitDefinitions || {}),
      ...Object.keys(planModuleLimits || {}),
      ...Object.keys(effectiveModuleLimits || {}),
      ...Object.keys(overrideModuleLimits || {}),
    ])].sort();

    const rows = [];
    moduleKeys.forEach(moduleKey => {
      const perModuleDefs = limitDefinitions[moduleKey] || {};
      const perModulePlan = planModuleLimits[moduleKey] || {};
      const perModuleOverride = overrideModuleLimits[moduleKey] || {};
      const perModuleEffective = effectiveModuleLimits[moduleKey] || {};
      const limitKeys = [...new Set([
        ...Object.keys(perModuleDefs),
        ...Object.keys(perModulePlan),
        ...Object.keys(perModuleOverride),
        ...Object.keys(perModuleEffective),
      ])].sort();

      limitKeys.forEach(limitKey => {
        const hasOverride = Object.prototype.hasOwnProperty.call(perModuleOverride, limitKey);
        const overrideValue = hasOverride ? perModuleOverride[limitKey] : '';
        const defaultValue = perModulePlan[limitKey];
        const effectiveValue = perModuleEffective[limitKey];
        const placeholder = (defaultValue === null || defaultValue === undefined) ? 'Unlimited' : String(defaultValue);
        const effectiveText = (effectiveValue === null || effectiveValue === undefined) ? 'Unlimited' : String(effectiveValue);
        const valueText = (overrideValue === null || overrideValue === undefined || overrideValue === '') ? '' : String(overrideValue);
        const label = perModuleDefs?.[limitKey]?.label || limitKey;

        rows.push(`
          <div style="display:grid; grid-template-columns:minmax(0,1.4fr) minmax(0,0.8fr) minmax(140px,0.6fr) minmax(0,0.8fr); gap:10px; align-items:center; padding:10px 12px; border:1px solid rgba(99,102,241,0.15); border-radius:10px; background:rgba(14,23,44,0.45);">
            <div style="min-width:0;">
              <div style="color:#e0e7ff; font-weight:600;">${escapeHtml(label)}</div>
              <div style="color:var(--text-secondary); font-size:0.8em; margin-top:3px;">${escapeHtml(getTenantModuleLabel(moduleKey))} <span style="font-family:monospace;">(${escapeHtml(limitKey)})</span></div>
            </div>
            <div style="color:var(--text-secondary); font-size:0.82em;">Plan: <span style="color:#c9d6ff; font-weight:600;">${escapeHtml(placeholder)}</span></div>
            <input data-tenant-limit-input="1" data-module-key="${escapeHtml(moduleKey)}" data-limit-key="${escapeHtml(limitKey)}" type="number" min="0" step="1" value="${escapeHtml(valueText)}" placeholder="${escapeHtml(placeholder)}" style="padding:9px 10px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
            <div style="color:var(--text-secondary); font-size:0.82em;">Effective: <span style="color:#e2e8f0; font-weight:700;">${escapeHtml(effectiveText)}</span></div>
          </div>
        `);
      });
    });

    if (rows.length === 0) {
      return `<div style="padding:14px; border:1px dashed rgba(99,102,241,0.18); border-radius:10px; color:var(--text-secondary); text-align:center;">No module limits available for this tenant yet.</div>`;
    }
    return rows.join('');
  })();

  return `
    <div style="display:grid; gap:16px;">
      <div style="padding:10px 12px;border:1px solid rgba(99,102,241,0.2);border-radius:10px;background:rgba(30,41,59,0.45);color:#cbd5e1;font-size:0.82em;">
        <strong style="color:#e2e8f0;">You are editing tenant:</strong> ${escapeHtml(tenant.guildName || tenant.guildId)} <span style="font-family:monospace;opacity:.85;">(${escapeHtml(tenant.guildId)})</span>
      </div>

      <div id="tenantDetail-overview" style="display:grid; gap:14px; grid-template-columns:minmax(0,1.2fr) minmax(0,0.8fr);">
        <div style="padding:14px; border:1px solid rgba(99,102,241,0.18); border-radius:12px; background:rgba(10,16,30,0.35);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px;">
            <div>
              <h4 style="margin:0; color:#c9d6ff;">${escapeHtml(tenant.guildName || tenant.guildId)}</h4>
              <div style="color:var(--text-secondary); font-size:0.82em; font-family:monospace; word-break:break-all; margin-top:4px;">${escapeHtml(tenant.guildId)}</div>
            </div>
            ${getTenantStatusBadge(tenant.status)}
          </div>
          <div style="display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; color:#c9d6ff; font-size:0.88em;">
            <div style="padding:10px 12px; background:rgba(30,41,59,0.45); border-radius:10px;">
              <div style="color:var(--text-secondary); font-size:0.8em;">Plan</div>
              <div style="font-weight:600; margin-top:4px;">${escapeHtml(getTenantPlanLabel(tenant.planKey))}</div>
            </div>
            <div style="padding:10px 12px; background:rgba(30,41,59,0.45); border-radius:10px;">
              <div style="color:var(--text-secondary); font-size:0.8em;">Modules</div>
              <div style="font-weight:600; margin-top:4px;">${escapeHtml(String(tenant.enabledModulesCount || 0))}/${escapeHtml(String(tenant.totalModulesCount || 0))}</div>
            </div>
            <div style="padding:10px 12px; background:rgba(30,41,59,0.45); border-radius:10px;">
              <div style="color:var(--text-secondary); font-size:0.8em;">Managed</div>
              <div style="font-weight:600; margin-top:4px;">${tenant.readOnlyManaged ? 'Read only' : 'Editable'}</div>
            </div>
          </div>
        </div>
        <div style="padding:14px; border:1px solid rgba(99,102,241,0.18); border-radius:12px; background:rgba(10,16,30,0.35);">
          <div style="color:#c9d6ff; font-weight:600; margin-bottom:10px;">Recent Audit</div>
          <div id="tenantAuditLogList" style="display:grid; gap:10px;">${renderTenantAuditLog(selectedTenantAuditCache)}</div>
        </div>
      </div>

      <div id="tenantDetail-controls" style="display:none;gap:16px; grid-template-columns:minmax(0,0.8fr) minmax(0,1.2fr);">
        <div style="padding:14px; border:1px solid rgba(99,102,241,0.18); border-radius:12px; background:rgba(10,16,30,0.35);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Monetization Template</h4>
            <div style="display:flex; gap:8px; align-items:center;">
              <button class="btn-secondary" id="tenantTemplatePreviewBtn" onclick="previewTenantTemplate()" style="padding:8px 14px;">Preview</button>
              <button class="btn-secondary" id="tenantTemplateRollbackBtn" onclick="rollbackTenantTemplate()" style="padding:8px 14px;">Rollback Last</button>
              <button class="btn-primary" id="tenantTemplateApplyBtn" onclick="applyTenantTemplate()" style="padding:8px 14px;">Apply Template</button>
            </div>
          </div>
          <label style="display:grid; gap:8px; color:#e0e7ff; font-size:0.9em;">
            <span>Template</span>
            <select id="tenantTemplateSelect" onchange="updateTenantTemplateDescription()" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
              ${templateOptions || '<option value="">No templates available</option>'}
            </select>
          </label>
          <div id="tenantTemplateDescription" style="margin-top:12px; color:var(--text-secondary); font-size:0.82em; line-height:1.5;">
            ${escapeHtml(superadminTemplateCatalog?.[0]?.description || 'Apply a template to set plan, module toggles, and module limits in one action.')}
          </div>
          <div id="tenantTemplatePreview" style="margin-top:12px; padding:10px 12px; border:1px solid rgba(99,102,241,0.16); border-radius:10px; background:rgba(14,23,44,0.45); color:#cbd5ff; font-size:0.82em; line-height:1.5;">
            ${renderTenantTemplatePreview(selectedTenantTemplatePreview)}
          </div>
        </div>

        <div style="padding:14px; border:1px solid rgba(99,102,241,0.18); border-radius:12px; background:rgba(10,16,30,0.35);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Plan Assignment</h4>
            <button class="btn-primary" id="tenantPlanApplyBtn" onclick="applyTenantPlan()" style="padding:8px 14px;">Apply</button>
          </div>
          <label style="display:grid; gap:8px; color:#e0e7ff; font-size:0.9em;">
            <span>Plan</span>
            <select id="tenantPlanSelect" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
              ${planOptions}
            </select>
          </label>
          <div style="margin-top:12px; color:var(--text-secondary); font-size:0.82em; line-height:1.5;">
            ${escapeHtml(tenant.planDescription || '')}
          </div>
        </div>

        <div style="padding:14px; border:1px solid rgba(99,102,241,0.18); border-radius:12px; background:rgba(10,16,30,0.35);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Tenant Status</h4>
            <button class="btn-secondary" id="tenantStatusSaveBtn" onclick="saveTenantStatus()" style="padding:8px 14px;">Save</button>
          </div>
          <label style="display:grid; gap:8px; color:#e0e7ff; font-size:0.9em;">
            <span>Status</span>
            <select id="tenantStatusSelect" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
              <option value="active"${String(tenant.status || 'active') === 'active' ? ' selected' : ''}>Active</option>
              <option value="suspended"${String(tenant.status || 'active') === 'suspended' ? ' selected' : ''}>Suspended</option>
            </select>
          </label>
          <div style="display:flex; align-items:center; justify-content:space-between; margin-top:12px; padding:10px 12px; border:1px solid rgba(99,102,241,0.16); border-radius:10px; background:rgba(14,23,44,0.45);">
            <div style="color:#e0e7ff; font-size:0.9em; font-weight:600;">Tenant Mock Data</div>
            <label style="position:relative;display:inline-block;width:44px;height:24px;">
              <input id="tenantMockDataSwitch" type="checkbox" ${(tenant.limits?.mock_data_enabled ? 'checked' : '')} onchange="this.parentElement.querySelector('.track').style.background=this.checked?'var(--gold)':'#555'; this.parentElement.querySelector('.knob').style.left=this.checked?'22px':'3px';" style="opacity:0;width:0;height:0;">
              <span class="track" style="position:absolute;inset:0;background:${tenant.limits?.mock_data_enabled ? 'var(--gold)' : '#555'};border-radius:24px;transition:.25s;"></span>
              <span class="knob" style="position:absolute;width:18px;height:18px;left:${tenant.limits?.mock_data_enabled ? '22px' : '3px'};bottom:3px;background:#fff;border-radius:50%;transition:.25s;pointer-events:none;"></span>
            </label>
          </div>
          <div style="margin-top:8px; text-align:right;">
            <button class="btn-secondary" id="tenantMockDataSaveBtn" onclick="saveTenantMockData()" style="padding:8px 14px;">Save Mock Data</button>
          </div>
          <div style="margin-top:12px; padding:10px 12px; border:1px solid rgba(99,102,241,0.16); border-radius:10px; background:rgba(14,23,44,0.45); color:#c9d6ff; font-size:0.85em;">
            <div style="font-weight:600; margin-bottom:8px;">Billing Snapshot</div>
            <div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px;">
              <div><span style="color:var(--text-secondary);">Provider:</span> ${escapeHtml(billingProvider)}</div>
              <div><span style="color:var(--text-secondary);">Interval:</span> ${escapeHtml(billingInterval)}</div>
              <div><span style="color:var(--text-secondary);">Status:</span> ${escapeHtml(billingStatus)}</div>
              <div><span style="color:var(--text-secondary);">Until:</span> ${escapeHtml(billingEnd)}</div>
            </div>
          </div>
        </div>

        <div style="grid-column:1 / -1; padding:14px; border:1px solid rgba(99,102,241,0.18); border-radius:12px; background:rgba(10,16,30,0.35);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px; flex-wrap:wrap;">
            <h4 style="margin:0; color:#c9d6ff;">Module Limits</h4>
            <button class="btn-primary" id="tenantModuleLimitsSaveBtn" onclick="saveTenantModuleLimits()" style="padding:8px 14px;">Save Limits</button>
          </div>
          <div style="margin-bottom:10px; color:var(--text-secondary); font-size:0.82em;">Set tenant-specific overrides per module. Leave a value empty to use the plan default.</div>
          <div style="display:grid; gap:8px;">
            ${moduleLimitRows}
          </div>
        </div>
      </div>

      <div id="tenantDetail-branding" style="display:none;">
        <div style="padding:14px; border:1px solid rgba(99,102,241,0.18); border-radius:12px; background:rgba(10,16,30,0.35);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Branding</h4>
            <button class="btn-primary" id="tenantBrandSaveBtn" onclick="saveTenantBranding()" style="padding:8px 14px;">Save</button>
          </div>
          <div style="display:grid; gap:10px;">
            <label style="display:grid; gap:6px; color:#e0e7ff; font-size:0.9em;">
              <span>Bot display name</span>
              <input id="tenantBrandBotDisplayName" type="text" value="${escapeHtml(branding.bot_display_name || '')}" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
            </label>
            <label style="display:grid; gap:6px; color:#e0e7ff; font-size:0.9em;">
              <span>Brand emoji</span>
              <input id="tenantBrandEmoji" type="text" value="${escapeHtml(branding.brand_emoji || '')}" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
            </label>
            <label style="display:grid; gap:6px; color:#e0e7ff; font-size:0.9em;">
              <span>Brand color</span>
              <input id="tenantBrandColor" type="text" value="${escapeHtml(branding.brand_color || '')}" placeholder="#FFD700" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
            </label>
            <label style="display:grid; gap:6px; color:#e0e7ff; font-size:0.9em;">
              <span>Logo URL</span>
              <input id="tenantBrandLogoUrl" type="text" value="${escapeHtml(branding.logo_url || '')}" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
            </label>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <input id="tenantBrandLogoFile" type="file" accept="image/png,image/jpeg,image/webp" style="font-size:0.82em;color:#c7d2fe;">
              <button class="btn-secondary" id="tenantLogoUploadBtn" onclick="uploadTenantLogo()" style="padding:8px 12px;">Upload Logo</button>
            </div>
            <label style="display:grid; gap:6px; color:#e0e7ff; font-size:0.9em;">
              <span>Support URL</span>
              <input id="tenantBrandSupportUrl" type="text" value="${escapeHtml(branding.support_url || '')}" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
            </label>
            <label style="display:grid; gap:6px; color:#e0e7ff; font-size:0.9em;">
              <span>Server avatar URL</span>
              <input id="tenantBrandServerAvatarUrl" type="text" value="${escapeHtml(branding.bot_server_avatar_url || '')}" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
            </label>
            <label style="display:grid; gap:6px; color:#e0e7ff; font-size:0.9em;">
              <span>Server banner URL</span>
              <input id="tenantBrandServerBannerUrl" type="text" value="${escapeHtml(branding.bot_server_banner_url || '')}" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
            </label>
            <label style="display:grid; gap:6px; color:#e0e7ff; font-size:0.9em;">
              <span>Server bio</span>
              <textarea id="tenantBrandServerBio" rows="3" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; resize:vertical;">${escapeHtml(branding.bot_server_bio || '')}</textarea>
            </label>
          </div>
        </div>
      </div>

      <div id="tenantDetail-modules" style="display:none;">
        <div style="padding:14px; border:1px solid rgba(99,102,241,0.18); border-radius:12px; background:rgba(10,16,30,0.35);">
          <h4 style="margin:0 0 12px; color:#c9d6ff;">Module Bundle</h4>
          <div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px;">
            ${moduleToggles}
          </div>
        </div>
      </div>
    </div>
  `;
}

async function loadSuperadminView() {
  if (!isSuperadmin) return;

  const content = document.getElementById('adminSuperadminContent');
  if (!content) return;

  content.innerHTML = `<div style="text-align:center; padding:20px;"><div class="spinner"></div><p style="margin-top:10px;">Loading superadmin tenant controls...</p></div>`;

  try {
    const tenantQs = new URLSearchParams();
    if (superadminTenantSearch.trim()) tenantQs.set('q', superadminTenantSearch.trim());
    tenantQs.set('page', String(superadminTenantPage));
    tenantQs.set('pageSize', String(superadminTenantPageSize));

    const [adminsResponse, tenantsResponse, settingsResponse] = await Promise.all([
      fetch('/api/superadmin/admins', { credentials: 'include' }),
      fetch(`/api/superadmin/tenants?${tenantQs.toString()}`, { credentials: 'include' }),
      fetch('/api/superadmin/global-settings', { credentials: 'include' })
    ]);

    const [adminsData, tenantsData, settingsData] = await Promise.all([
      adminsResponse.json(),
      tenantsResponse.json(),
      settingsResponse.json()
    ]);

    if (!adminsData.success) {
      content.innerHTML = `<div style="color:#fca5a5; text-align:center; padding:20px;">${escapeHtml(adminsData.message || 'Unable to load superadmins')}</div>`;
      return;
    }

    if (!tenantsData.success) {
      content.innerHTML = `<div style="color:#fca5a5; text-align:center; padding:20px;">${escapeHtml(tenantsData.message || 'Unable to load tenants')}</div>`;
      return;
    }

    superadminListCache = adminsData.superadmins || [];
    tenantListCache = tenantsData.tenants || [];
    superadminTenantTotalPages = Number(tenantsData.pagination?.totalPages || 1);
    superadminTenantTotalCount = Number(tenantsData.pagination?.total || tenantListCache.length || 0);

    if (superadminTenantPage > superadminTenantTotalPages) {
      superadminTenantPage = superadminTenantTotalPages;
    }

    if (!selectedTenantGuildId || !tenantListCache.some(tenant => tenant.guildId === selectedTenantGuildId)) {
      selectedTenantGuildId = tenantListCache[0]?.guildId || selectedTenantGuildId || null;
    }
    // Scale UX: collapse long tenant directory by default once a tenant is selected
    if (selectedTenantGuildId && superadminTenantSearch.trim() === '') {
      superadminTenantDirectoryCollapsed = true;
    }

    const superadminRows = superadminListCache.length > 0
      ? superadminListCache.map(entry => {
          const removable = entry.source !== 'env';
          const sourceLabel = entry.source === 'env' ? 'Root env' : 'DB';
          return `
            <div style="display:flex; justify-content:space-between; gap:12px; align-items:center; padding:12px 14px; border-bottom:1px solid rgba(99,102,241,0.15);">
              <div style="min-width:0;">
                <div style="color:#e0e7ff; font-weight:600; font-family:monospace; word-break:break-all;">${escapeHtml(entry.userId)}</div>
                <div style="color:var(--text-secondary); font-size:0.82em; margin-top:4px;">
                  <span style="display:inline-block; padding:2px 8px; border-radius:999px; background:${entry.source === 'env' ? 'rgba(16,185,129,0.18)' : 'rgba(99,102,241,0.18)'}; color:#e0e7ff; margin-right:8px;">${sourceLabel}</span>
                  ${entry.addedBy ? `Added by ${escapeHtml(entry.addedBy)}` : 'Managed by environment'}
                </div>
              </div>
              <button class="btn-secondary" style="font-size:0.85em; padding:6px 12px; opacity:${removable ? 1 : 0.45};" ${removable ? `onclick="removeSuperadmin('${escapeJsString(entry.userId)}')"` : 'disabled'}>
                ${removable ? 'Remove' : 'Protected'}
              </button>
            </div>
          `;
        }).join('')
      : `<div style="padding:18px; text-align:center; color:var(--text-secondary);">No database superadmins configured.</div>`;

    const filteredTenants = tenantListCache.filter(t => {
      const q = String(superadminTenantSearch || '').trim().toLowerCase();
      if (!q) return true;
      return String(t.guildName || '').toLowerCase().includes(q)
        || String(t.guildId || '').toLowerCase().includes(q)
        || String(t.planKey || '').toLowerCase().includes(q);
    });

    const tenantRows = filteredTenants.length > 0
      ? filteredTenants.map(renderTenantRow).join('')
      : `<div style="padding:18px; text-align:center; color:var(--text-secondary);">No tenants match this search.</div>`;

    const activeTenant = tenantListCache.find(t => t.guildId === selectedTenantGuildId) || null;
    const activeTenantName = activeTenant?.guildName || selectedTenantGuildId || 'No tenant selected';
    const chainEmojiMap = settingsData?.settings?.chainEmojiMap || {};

    content.innerHTML = `
      <div style="display:grid; gap:16px;">
        <div style="padding:14px 16px;border:1px solid rgba(99,102,241,0.28);border-radius:12px;background:linear-gradient(135deg,rgba(99,102,241,0.16),rgba(30,41,59,0.52));display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="color:#c9d6ff;font-size:0.82em;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Active Tenant Context</div>
            <div style="color:#e0e7ff;font-size:1em;font-weight:700;margin-top:2px;">${escapeHtml(activeTenantName)}</div>
            <div style="color:var(--text-secondary);font-size:0.82em;font-family:monospace;margin-top:2px;">${escapeHtml(selectedTenantGuildId || '—')}</div>
          </div>
          <div style="color:#cbd5e1;font-size:0.82em;max-width:520px;">Tenant-scoped actions below (plan/modules/branding/status) apply to this server. Superadmin list + era catalog are global controls.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <button data-superadmin-tab-btn="tenants" class="btn-primary" onclick="showSuperadminTab('tenants')" style="padding:8px 12px;">Tenants</button>
          <button data-superadmin-tab-btn="superadmins" class="btn-secondary" onclick="showSuperadminTab('superadmins')" style="padding:8px 12px;">Superadmins</button>
          <button data-superadmin-tab-btn="identity" class="btn-secondary" onclick="showSuperadminTab('identity')" style="padding:8px 12px;">Identity</button>

          <span style="width:1px;height:24px;background:rgba(99,102,241,0.25);margin:0 4px;"></span>

          <div id="superadminTenantDetailTabGroup" style="display:flex;gap:8px;flex-wrap:wrap;">
            <button data-tenant-detail-tab="overview" class="btn-primary" onclick="showTenantDetailTab('overview')" style="padding:8px 12px;">Overview</button>
            <button data-tenant-detail-tab="controls" class="btn-secondary" onclick="showTenantDetailTab('controls')" style="padding:8px 12px;">Plan & Status</button>
            <button data-tenant-detail-tab="branding" class="btn-secondary" onclick="showTenantDetailTab('branding')" style="padding:8px 12px;">Branding</button>
            <button data-tenant-detail-tab="modules" class="btn-secondary" onclick="showTenantDetailTab('modules')" style="padding:8px 12px;">Modules</button>
            <button data-tenant-detail-tab="eras" class="btn-secondary" onclick="showTenantDetailTab('eras')" style="padding:8px 12px;">Era Assignments</button>
          </div>
        </div>

        <div id="superadminSection-superadminsInput" style="display:grid; gap:12px; grid-template-columns:minmax(0,1fr) auto;">
          <input id="adminSuperadminUserIdInput" type="text" placeholder="Discord ID" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; width:100%;">
          <button id="adminSuperadminAddBtn" class="btn-primary" onclick="addSuperadminFromInput()" style="padding:10px 16px;">Add</button>
        </div>

        <div id="superadminSection-superadmins" style="padding:14px; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.45);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Current superadmins <span style="margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(16,185,129,0.18);font-size:0.72em;vertical-align:middle;">Global</span></h4>
            <span style="color:var(--text-secondary); font-size:0.85em;">Env roots cannot be removed</span>
          </div>
          <div style="border:1px solid rgba(99,102,241,0.15); border-radius:10px; overflow:hidden;">
            ${superadminRows}
          </div>
        </div>

        <div id="superadminSection-chainEmojis" style="padding:14px; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.45);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Chain Emoji Map <span style="margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(16,185,129,0.18);font-size:0.72em;vertical-align:middle;">Global</span></h4>
            <span style="color:var(--text-secondary); font-size:0.85em;">Used by NFT tracker price display</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;">
            ${['solana','usdc','ethereum','base','polygon','arbitrum','optimism','bsc','avalanche'].map(chain => `
              <label style="display:grid;gap:6px;">
                <span style="font-size:0.82em;color:var(--text-secondary);text-transform:capitalize;">${chain}</span>
                <input id="sa_chainEmoji_${chain}" type="text" value="${escapeHtml(chainEmojiMap[chain] || '')}" placeholder="<:emoji:123...> or unicode" style="padding:9px 10px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;">
              </label>
            `).join('')}
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">
            <button class="btn-secondary" onclick="loadSuperadminView()" style="padding:8px 12px;">Reset</button>
            <button class="btn-primary" onclick="saveChainEmojiMap()" style="padding:8px 12px;">Save Chain Emojis</button>
          </div>

          <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(99,102,241,0.18);display:grid;gap:8px;">
            <div style="color:#c9d6ff;font-weight:600;">Replay NFT Event by Tx <span style="margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(16,185,129,0.18);font-size:0.72em;vertical-align:middle;">Global</span></div>
            <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;">
              <input id="sa_nftReplayTx" type="text" placeholder="Paste tx signature to replay alerts" style="padding:9px 10px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;">
              <button class="btn-primary" onclick="replayNftActivityTx()" style="padding:8px 12px;">Replay Tx</button>
            </div>
          </div>
        </div>

        <div id="superadminSection-microVerify" style="padding:14px; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.45);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px;">
            <h4 style="margin:0; color:#c9d6ff;">💸 Micro-Transaction Verification <span style="margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(16,185,129,0.18);font-size:0.72em;vertical-align:middle;">Global</span></h4>
            <span style="color:var(--text-secondary); font-size:0.85em;">Wallet-extension-free verification</span>
          </div>
          <div style="display:grid; gap:12px;">
            <label style="display:flex; align-items:center; gap:10px; color:#c9d6ff; font-size:0.9em; cursor:pointer;">
              <input type="checkbox" id="sa_microVerifyEnabled" ${settingsData?.settings?.moduleMicroVerifyEnabled ? 'checked' : ''}
                style="width:16px;height:16px;accent-color:#6366f1;">
              <span>Enable micro-transaction verification</span>
            </label>
            <label style="display:grid; gap:6px;">
              <span style="font-size:0.82em; color:var(--text-secondary);">Receive Wallet Address <span style="color:#f87171;">(superadmin only)</span></span>
              <input id="sa_verificationReceiveWallet" type="text"
                value="${escapeHtml(settingsData?.settings?.verificationReceiveWallet || '')}"
                placeholder="Solana wallet address that receives micro-payments"
                style="padding:9px 10px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-family:monospace; font-size:0.88em;">
            </label>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
              <label style="display:grid; gap:6px;">
                <span style="font-size:0.82em; color:var(--text-secondary);">Request TTL (minutes)</span>
                <input id="sa_verifyTtlMinutes" type="number" min="1" max="60"
                  value="${escapeHtml(String(settingsData?.settings?.verifyRequestTtlMinutes || 15))}"
                  style="padding:9px 10px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
              </label>
              <label style="display:grid; gap:6px;">
                <span style="font-size:0.82em; color:var(--text-secondary);">Poll Interval (seconds)</span>
                <input id="sa_pollIntervalSeconds" type="number" min="10" max="300"
                  value="${escapeHtml(String(settingsData?.settings?.pollIntervalSeconds || 30))}"
                  style="padding:9px 10px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff;">
              </label>
            </div>
            <div style="background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.2); border-radius:8px; padding:10px 12px;">
              <p style="color:#fcd34d; font-size:0.82em; margin:0; line-height:1.5;">
                ⚠️ The receive wallet collects small SOL payments used to identify users. Keep it secure — only this superadmin panel can change it.
              </p>
            </div>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:12px;">
            <button class="btn-secondary" onclick="loadSuperadminView()" style="padding:8px 12px;">Reset</button>
            <button class="btn-primary" onclick="saveMicroVerifySettings()" style="padding:8px 12px;">Save Micro-Verify Settings</button>
          </div>
        </div>

        <div id="superadminSection-identity" style="padding:14px; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.45);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px; flex-wrap:wrap;">
            <h4 style="margin:0; color:#c9d6ff;">Identity Overrides <span style="margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(16,185,129,0.18);font-size:0.72em;vertical-align:middle;">Global</span></h4>
            <button class="btn-secondary" onclick="loadSuperadminIdentityView()" style="padding:8px 12px;">Refresh</button>
          </div>
          <div style="color:var(--text-secondary); font-size:0.82em; margin-bottom:12px;">
            Link wallets to Discord users from superadmin, apply trusted/manual verification flags, and keep an immutable audit trail.
          </div>
          <div style="padding:12px; border:1px solid rgba(99,102,241,0.18); border-radius:10px; background:rgba(10,16,30,0.45); margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap;">
              <div style="color:#e0e7ff; font-weight:600;">Quick Add Identity</div>
              <button class="btn-primary" id="superadminIdentityQuickAddBtn" onclick="quickAddSuperadminIdentity()" style="padding:7px 12px; font-size:0.82em;">Create / Link</button>
            </div>
            <div style="color:var(--text-secondary); font-size:0.78em; margin-bottom:10px;">
              Create a user profile and optionally link a wallet even if the user has never verified before.
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:8px; align-items:center;">
              <input id="superadminIdentityNewDiscordId" type="text" placeholder="Discord User ID" style="padding:9px 10px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-family:monospace; font-size:0.84em;">
              <input id="superadminIdentityNewUsername" type="text" placeholder="Username (optional)" style="padding:9px 10px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.84em;">
              <input id="superadminIdentityNewWallet" type="text" placeholder="Wallet address (optional)" style="padding:9px 10px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-family:monospace; font-size:0.84em;">
              <label style="display:flex; align-items:center; gap:6px; color:#c9d6ff; font-size:0.78em;">
                <input id="superadminIdentityNewPrimary" type="checkbox"> Primary
              </label>
              <label style="display:flex; align-items:center; gap:6px; color:#c9d6ff; font-size:0.78em;">
                <input id="superadminIdentityNewFavorite" type="checkbox"> Favorite
              </label>
            </div>
          </div>
          <div style="display:grid; grid-template-columns:minmax(220px,0.7fr) auto; gap:8px; margin-bottom:12px;">
            <input id="superadminIdentitySearchInput" type="text" value="${escapeHtml(superadminIdentitySearch)}" placeholder="Search by Discord ID, username, or wallet..." oninput="applySuperadminIdentityFilter(this.value)" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;">
            <button class="btn-secondary" onclick="loadSuperadminIdentityView()" style="padding:8px 12px;">Search</button>
          </div>
          <div style="display:grid; gap:12px; grid-template-columns:minmax(260px,0.85fr) minmax(0,1.15fr);">
            <div id="superadminIdentityList" style="display:grid; gap:8px; max-height:520px; overflow:auto;">
              ${renderSuperadminIdentityRows(superadminIdentityCache)}
            </div>
            <div id="superadminIdentityDetail" style="padding:14px; border:1px solid rgba(99,102,241,0.16); border-radius:10px; background:rgba(10,16,30,0.4); color:var(--text-secondary);">
              Select a user from the list to manage identity overrides.
            </div>
          </div>
        </div>

        <div id="superadminSection-tenants" style="padding:14px; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.45);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Tenant Management <span style="margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(99,102,241,0.2);font-size:0.72em;vertical-align:middle;">Tenant Scoped</span></h4>
            <div style="display:flex;gap:8px;">
              <button id="superadminTenantDirectoryToggleBtn" class="btn-secondary" onclick="toggleSuperadminTenantDirectory()" style="padding:8px 12px;">${superadminTenantDirectoryCollapsed ? 'Show Directory' : 'Hide Directory'}</button>
              <button class="btn-secondary" onclick="loadSuperadminView()" style="padding:8px 12px;">Refresh</button>
            </div>
          </div>

          <div style="display:grid; grid-template-columns:minmax(240px,0.45fr) minmax(220px,0.35fr) auto; gap:10px; margin-bottom:12px; align-items:center;">
            <input id="superadminTenantSearch" type="text" value="${escapeHtml(superadminTenantSearch)}" placeholder="Search tenant by name, id, or plan..." oninput="applySuperadminTenantFilter(this.value)" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; width:100%;">
            <select id="superadminTenantSelect" onchange="selectTenantGuild(this.value)" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; width:100%;">
              ${tenantListCache.map(t => `<option value="${escapeHtml(t.guildId)}"${t.guildId === selectedTenantGuildId ? ' selected' : ''}>${escapeHtml(t.guildName || t.guildId)} (${escapeHtml(t.guildId)})</option>`).join('')}
            </select>
            <div style="color:var(--text-secondary);font-size:0.82em;text-align:right;">Page ${superadminTenantPage}/${superadminTenantTotalPages} • ${filteredTenants.length} shown • ${superadminTenantTotalCount} total</div>
          </div>

          <div id="superadminTenantDirectoryBody" style="display:${superadminTenantDirectoryCollapsed ? 'none' : ''}; border:1px solid rgba(99,102,241,0.15); border-radius:10px; overflow:hidden;">
            <div style="display:grid; grid-template-columns:minmax(0,1.6fr) repeat(3,minmax(0,1fr)); gap:12px; padding:10px 14px; background:rgba(99,102,241,0.12); color:#c9d6ff; font-weight:600; font-size:0.82em;">
              <div>Guild</div>
              <div>Plan</div>
              <div>Status</div>
              <div>Modules</div>
            </div>
            <div style="max-height:320px; overflow:auto;">${tenantRows}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-top:1px solid rgba(99,102,241,0.12);background:rgba(30,41,59,0.35);">
              <button class="btn-secondary" onclick="superadminTenantPrevPage()" style="padding:6px 10px;" ${superadminTenantPage <= 1 ? 'disabled' : ''}>← Prev</button>
              <div style="color:var(--text-secondary);font-size:0.82em;">Page ${superadminTenantPage} of ${superadminTenantTotalPages}</div>
              <button class="btn-secondary" onclick="superadminTenantNextPage()" style="padding:6px 10px;" ${superadminTenantPage >= superadminTenantTotalPages ? 'disabled' : ''}>Next →</button>
            </div>
          </div>
        </div>

        <div id="superadminSection-detail" style="padding:14px; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.45);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Tenant Detail <span style="margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(99,102,241,0.2);font-size:0.72em;vertical-align:middle;">Tenant Scoped</span></h4>
            <span style="color:var(--text-secondary); font-size:0.85em;">Select a guild to edit plan, modules, branding, and status</span>
          </div>
          <div id="adminTenantDetailContent">${renderTenantDetailPanel(null)}</div>
        </div>

        <div id="superadminSection-eras" style="padding:14px; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.45);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Era Assignments <span style="margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(16,185,129,0.18);font-size:0.72em;vertical-align:middle;">Global Control</span></h4>
            <button class="btn-secondary" onclick="loadEraAssignments()" style="padding:8px 12px;">Refresh</button>
          </div>
          <div style="margin-bottom:10px;color:var(--text-secondary);font-size:0.82em;">Applying era assignment to active tenant context: <span style="color:#e2e8f0;font-weight:700;">${escapeHtml(activeTenantName)}</span> <span style="font-family:monospace;">${escapeHtml(selectedTenantGuildId || '—')}</span></div>
          <div style="display:grid; gap:10px; grid-template-columns:1fr auto; margin-bottom:14px;">
            <select id="eraAssignKey" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;">
              <option value="">Loading eras...</option>
            </select>
            <button class="btn-primary" onclick="assignEra()" style="padding:10px 16px;">Assign</button>
          </div>
          <div id="eraAssignmentsTable" style="border:1px solid rgba(99,102,241,0.15); border-radius:10px; overflow:hidden;">
            <div style="padding:18px; text-align:center; color:var(--text-secondary);">Loading era assignments...</div>
          </div>
        </div>
      </div>
    `;

    // Preserve search focus/caret across rerenders
    requestAnimationFrame(() => {
      const searchEl = document.getElementById('superadminTenantSearch');
      if (searchEl && superadminTenantSearch) {
        searchEl.focus();
        const len = searchEl.value.length;
        searchEl.setSelectionRange(len, len);
      }
    });

    if (selectedTenantGuildId) {
      await loadSelectedTenantDetail();
    }
    await loadSuperadminIdentityView();
    loadEraAssignments();
    showSuperadminTab(superadminActiveTab || 'tenants');
  } catch (error) {
    content.innerHTML = `<div style="color:#fca5a5; text-align:center; padding:20px;">Error loading superadmin view: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

async function loadSelectedTenantDetail() {
  const content = document.getElementById('adminTenantDetailContent');
  if (!content) return;

  if (!selectedTenantGuildId) {
    selectedTenantLimitsCache = null;
    selectedTenantTemplatePreview = null;
    superadminTemplateCatalog = [];
    content.innerHTML = renderTenantDetailPanel(null);
    return;
  }

  content.innerHTML = `<div style="text-align:center; padding:20px;"><div class="spinner"></div><p style="margin-top:10px;">Loading tenant details...</p></div>`;

  try {
    const [tenantResponse, auditResponse, limitsResponse, templateResponse] = await Promise.all([
      fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}`, { credentials: 'include' }),
      fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/audit?limit=10`, { credentials: 'include' }),
      fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/limits`, { credentials: 'include' }),
      fetch('/api/superadmin/monetization/templates', { credentials: 'include' })
    ]);

    const [tenantData, auditData, limitsData, templateData] = await Promise.all([
      tenantResponse.json(),
      auditResponse.json(),
      limitsResponse.json(),
      templateResponse.json()
    ]);

    if (!tenantData.success) {
      content.innerHTML = `<div style="color:#fca5a5; text-align:center; padding:20px;">${escapeHtml(tenantData.message || 'Unable to load tenant')}</div>`;
      return;
    }

    if (!auditData.success) {
      content.innerHTML = `<div style="color:#fca5a5; text-align:center; padding:20px;">${escapeHtml(auditData.message || 'Unable to load audit log')}</div>`;
      return;
    }

    selectedTenantDetailCache = tenantData.tenant || null;
    selectedTenantAuditCache = auditData.auditLogs || [];
    selectedTenantLimitsCache = limitsData?.success ? limitsData.limits : null;
    selectedTenantTemplatePreview = null;
    superadminTemplateCatalog = templateData?.success && Array.isArray(templateData.templates) ? templateData.templates : [];
    content.innerHTML = renderTenantDetailPanel(selectedTenantDetailCache, selectedTenantLimitsCache);
    showTenantDetailTab(tenantDetailActiveTab || 'overview');
    updateTenantTemplateDescription();
  } catch (error) {
    content.innerHTML = `<div style="color:#fca5a5; text-align:center; padding:20px;">Error loading tenant details: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

async function loadEraAssignments() {
  const table = document.getElementById('eraAssignmentsTable');
  const select = document.getElementById('eraAssignKey');
  try {
    const [erasRes, assignRes] = await Promise.all([
      fetch('/api/superadmin/eras', { credentials: 'include', headers: buildTenantRequestHeaders() }),
      fetch('/api/superadmin/era-assignments', { credentials: 'include', headers: buildTenantRequestHeaders() })
    ]);
    const [erasData, assignData] = await Promise.all([erasRes.json(), assignRes.json()]);

    // Populate era dropdown
    if (select && erasData.success && erasData.eras) {
      select.innerHTML = erasData.eras.map(e =>
        `<option value="${escapeHtml(e.key)}">${escapeHtml(e.name)} — ${escapeHtml(e.description)}</option>`
      ).join('');
      if (erasData.eras.length === 0) {
        select.innerHTML = '<option value="">No assignable eras</option>';
      }
    }

    // Populate assignments table
    if (table && assignData.success) {
      const rows = (assignData.assignments || []).filter(a => !selectedTenantGuildId || a.guild_id === selectedTenantGuildId);
      if (rows.length === 0) {
        table.innerHTML = '<div style="padding:18px; text-align:center; color:var(--text-secondary);">No era assignments yet.</div>';
      } else {
        table.innerHTML = `
          <div style="display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) auto; gap:12px; padding:10px 14px; background:rgba(99,102,241,0.12); color:#c9d6ff; font-weight:600; font-size:0.82em;">
            <div>Guild</div><div>Era</div><div>Assigned By</div><div></div>
          </div>
        ` + rows.map(a => `
          <div style="display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) auto; gap:12px; padding:10px 14px; border-top:1px solid rgba(99,102,241,0.12); align-items:center;">
            <div style="color:#e0e7ff; font-family:monospace; font-size:0.88em; word-break:break-all;">${escapeHtml(a.guild_name || a.guild_id)}<br><span style="color:var(--text-secondary); font-size:0.82em;">${escapeHtml(a.guild_id)}</span></div>
            <div style="color:#c9d6ff;">${escapeHtml(a.era_key)}</div>
            <div style="color:var(--text-secondary); font-size:0.88em;">${escapeHtml(formatDiscordIdentityLabel(a.assigned_by || '—', a.assigned_by_display_name || null))}</div>
            <button class="btn-secondary" style="font-size:0.85em; padding:6px 12px;" onclick="revokeEra('${escapeJsString(a.guild_id)}', '${escapeJsString(a.era_key)}')">Revoke</button>
          </div>
        `).join('');
      }
    }
  } catch (error) {
    if (table) table.innerHTML = `<div style="padding:18px; text-align:center; color:#fca5a5;">Error: ${escapeHtml(error.message)}</div>`;
  }
}

async function assignEra() {
  const guildId = String(selectedTenantGuildId || '').trim();
  const eraKey = document.getElementById('eraAssignKey')?.value;
  if (!guildId || !eraKey) return alert('Please select an active tenant context and an era.');

  try {
    const res = await fetch('/api/superadmin/era-assignments', {
      method: 'POST',
      credentials: 'include',
      headers: { ...Object.fromEntries(buildTenantRequestHeaders().entries()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildId, eraKey })
    });
    const data = await res.json();
    if (!data.success) return alert(data.message || 'Failed to assign era');
    loadEraAssignments();
  } catch (error) {
    alert('Error assigning era: ' + error.message);
  }
}

async function revokeEra(guildId, eraKey) {
  if (!confirm(`Revoke era "${eraKey}" from guild ${guildId}?`)) return;

  try {
    const res = await fetch(`/api/superadmin/era-assignments/${encodeURIComponent(guildId)}/${encodeURIComponent(eraKey)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: buildTenantRequestHeaders()
    });
    const data = await res.json();
    if (!data.success) return alert(data.message || 'Failed to revoke era');
    loadEraAssignments();
  } catch (error) {
    alert('Error revoking era: ' + error.message);
  }
}

function renderSuperadminIdentityDetail(profile) {
  if (!profile?.user) {
    return `<div style="color:var(--text-secondary);">Select a user from the list to manage identity overrides.</div>`;
  }

  const user = profile.user;
  const flags = profile.flags || {};
  const wallets = Array.isArray(profile.wallets) ? profile.wallets : [];
  const walletRows = wallets.length > 0
    ? wallets.map(wallet => `
      <div style="display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; padding:8px 10px; border:1px solid rgba(99,102,241,0.15); border-radius:10px; background:rgba(14,23,44,0.45);">
        <div style="min-width:0;">
          <div style="color:#e0e7ff; font-family:monospace; font-size:0.84em; word-break:break-all;">${escapeHtml(wallet.walletAddress || '')}</div>
          <div style="margin-top:4px; display:flex; gap:6px; flex-wrap:wrap;">
            ${wallet.primaryWallet ? '<span style="padding:2px 7px;border-radius:999px;background:rgba(16,185,129,0.18);color:#bbf7d0;font-size:0.72em;">Primary</span>' : ''}
            ${wallet.favoriteWallet ? '<span style="padding:2px 7px;border-radius:999px;background:rgba(251,191,36,0.18);color:#fde68a;font-size:0.72em;">Favorite</span>' : ''}
          </div>
        </div>
        <button class="btn-secondary" onclick="removeSuperadminIdentityWallet('${escapeJsString(user.discordId)}', '${escapeJsString(wallet.walletAddress || '')}')" style="padding:6px 10px; font-size:0.82em;">Unlink</button>
      </div>
    `).join('')
    : `<div style="padding:10px; text-align:center; color:var(--text-secondary); border:1px dashed rgba(99,102,241,0.18); border-radius:10px;">No wallets linked yet.</div>`;

  return `
    <div style="display:grid; gap:12px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
        <div>
          <div style="color:#e0e7ff; font-size:1.02em; font-weight:700;">${escapeHtml(user.username || user.discordId)}</div>
          <div style="color:var(--text-secondary); font-size:0.8em; font-family:monospace; margin-top:3px; word-break:break-all;">${escapeHtml(user.discordId)}</div>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
          ${flags.trustedIdentity ? '<span style="padding:2px 8px;border-radius:999px;background:rgba(16,185,129,0.18);color:#bbf7d0;font-size:0.72em;">Trusted</span>' : ''}
          ${flags.manualVerified ? '<span style="padding:2px 8px;border-radius:999px;background:rgba(245,158,11,0.18);color:#fde68a;font-size:0.72em;">Manual</span>' : ''}
        </div>
      </div>

      <div style="display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; font-size:0.82em;">
        <div style="padding:10px; border:1px solid rgba(99,102,241,0.14); border-radius:10px; background:rgba(30,41,59,0.45);">
          <div style="color:var(--text-secondary);">Wallets</div>
          <div style="color:#e0e7ff; font-weight:700; margin-top:3px;">${escapeHtml(String(wallets.length))}</div>
        </div>
        <div style="padding:10px; border:1px solid rgba(99,102,241,0.14); border-radius:10px; background:rgba(30,41,59,0.45);">
          <div style="color:var(--text-secondary);">NFTs</div>
          <div style="color:#e0e7ff; font-weight:700; margin-top:3px;">${escapeHtml(String(user.totalNfts || 0))}</div>
        </div>
        <div style="padding:10px; border:1px solid rgba(99,102,241,0.14); border-radius:10px; background:rgba(30,41,59,0.45);">
          <div style="color:var(--text-secondary);">Voting Power</div>
          <div style="color:#e0e7ff; font-weight:700; margin-top:3px;">${escapeHtml(String(user.votingPower || 0))}</div>
        </div>
      </div>

      <div style="padding:12px; border:1px solid rgba(99,102,241,0.15); border-radius:10px; background:rgba(14,23,44,0.45);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; gap:10px;">
          <h5 style="margin:0; color:#c9d6ff;">Identity Flags</h5>
          <button id="superadminIdentityFlagsSaveBtn" class="btn-primary" onclick="saveSuperadminIdentityFlags()" style="padding:6px 12px; font-size:0.82em;">Save Flags</button>
        </div>
        <div style="display:flex; gap:16px; flex-wrap:wrap; margin-bottom:10px;">
          <label style="display:flex; align-items:center; gap:8px; color:#e0e7ff; font-size:0.88em; cursor:pointer;">
            <input id="superadminIdentityTrustedInput" type="checkbox" ${flags.trustedIdentity ? 'checked' : ''}>
            <span>Trusted Identity</span>
          </label>
          <label style="display:flex; align-items:center; gap:8px; color:#e0e7ff; font-size:0.88em; cursor:pointer;">
            <input id="superadminIdentityManualInput" type="checkbox" ${flags.manualVerified ? 'checked' : ''}>
            <span>Manual Verified</span>
          </label>
        </div>
        <label style="display:grid; gap:6px;">
          <span style="font-size:0.8em; color:var(--text-secondary);">Notes (internal)</span>
          <textarea id="superadminIdentityNotesInput" rows="3" maxlength="2000" style="padding:9px 10px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; resize:vertical;">${escapeHtml(flags.notes || '')}</textarea>
        </label>
      </div>

      <div style="padding:12px; border:1px solid rgba(99,102,241,0.15); border-radius:10px; background:rgba(14,23,44,0.45);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; gap:10px;">
          <h5 style="margin:0; color:#c9d6ff;">Linked Wallets</h5>
          <button id="superadminIdentityWalletAddBtn" class="btn-primary" onclick="addSuperadminIdentityWallet()" style="padding:6px 12px; font-size:0.82em;">Link Wallet</button>
        </div>
        <div style="display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:8px; margin-bottom:10px;">
          <input id="superadminIdentityWalletInput" type="text" placeholder="Solana wallet address" style="padding:9px 10px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-family:monospace; font-size:0.84em;">
          <label style="display:flex; align-items:center; gap:6px; color:#c9d6ff; font-size:0.8em;">
            <input id="superadminIdentityWalletPrimaryInput" type="checkbox">
            Primary
          </label>
          <label style="display:flex; align-items:center; gap:6px; color:#c9d6ff; font-size:0.8em;">
            <input id="superadminIdentityWalletFavoriteInput" type="checkbox">
            Favorite
          </label>
        </div>
        <div style="display:grid; gap:8px;">${walletRows}</div>
      </div>

      <div style="padding:12px; border:1px solid rgba(99,102,241,0.15); border-radius:10px; background:rgba(14,23,44,0.45);">
        <h5 style="margin:0 0 10px; color:#c9d6ff;">Identity Audit</h5>
        <div id="superadminIdentityAuditList" style="display:grid; gap:8px;">${renderSuperadminIdentityAudit(superadminIdentityAuditCache)}</div>
      </div>
    </div>
  `;
}

async function loadSuperadminIdentityView() {
  const listEl = document.getElementById('superadminIdentityList');
  const detailEl = document.getElementById('superadminIdentityDetail');
  if (!listEl || !detailEl) return;

  listEl.innerHTML = `<div style="padding:16px; text-align:center;"><div class="spinner"></div><div style="margin-top:8px; color:var(--text-secondary); font-size:0.85em;">Loading users...</div></div>`;

  try {
    const query = new URLSearchParams();
    if (superadminIdentitySearch.trim()) query.set('q', superadminIdentitySearch.trim());
    query.set('limit', '40');
    query.set('offset', '0');

    const response = await fetch(`/api/superadmin/identity/users?${query.toString()}`, { credentials: 'include' });
    const data = await response.json();
    if (!data.success) {
      listEl.innerHTML = `<div style="padding:14px; color:#fca5a5;">${escapeHtml(data.message || 'Failed to load users')}</div>`;
      return;
    }

    superadminIdentityCache = Array.isArray(data.users) ? data.users : [];
    if (!superadminIdentitySelectedUserId || !superadminIdentityCache.some(user => user.discordId === superadminIdentitySelectedUserId)) {
      superadminIdentitySelectedUserId = superadminIdentityCache[0]?.discordId || '';
    }

    listEl.innerHTML = renderSuperadminIdentityRows(superadminIdentityCache);

    const searchEl = document.getElementById('superadminIdentitySearchInput');
    if (searchEl && superadminIdentitySearch) {
      const len = searchEl.value.length;
      searchEl.focus();
      searchEl.setSelectionRange(len, len);
    }

    if (superadminIdentitySelectedUserId) {
      await loadSuperadminIdentityDetail(superadminIdentitySelectedUserId);
    } else {
      detailEl.innerHTML = renderSuperadminIdentityDetail(null);
    }
  } catch (error) {
    listEl.innerHTML = `<div style="padding:14px; color:#fca5a5;">Error loading identity users: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

function applySuperadminIdentityFilter(query) {
  superadminIdentitySearch = String(query || '');
  if (superadminIdentitySearchTimer) clearTimeout(superadminIdentitySearchTimer);
  superadminIdentitySearchTimer = setTimeout(() => {
    loadSuperadminIdentityView();
  }, 220);
}

function selectSuperadminIdentityUser(discordId) {
  superadminIdentitySelectedUserId = String(discordId || '').trim();
  if (!superadminIdentitySelectedUserId) return;
  loadSuperadminIdentityDetail(superadminIdentitySelectedUserId);
  const listEl = document.getElementById('superadminIdentityList');
  if (listEl) {
    listEl.innerHTML = renderSuperadminIdentityRows(superadminIdentityCache);
  }
}

async function loadSuperadminIdentityDetail(discordId) {
  const detailEl = document.getElementById('superadminIdentityDetail');
  if (!detailEl) return;

  const normalizedDiscordId = String(discordId || '').trim();
  if (!normalizedDiscordId) {
    detailEl.innerHTML = renderSuperadminIdentityDetail(null);
    return;
  }

  detailEl.innerHTML = `<div style="padding:16px; text-align:center;"><div class="spinner"></div><div style="margin-top:8px; color:var(--text-secondary); font-size:0.85em;">Loading profile...</div></div>`;

  try {
    const [profileRes, auditRes] = await Promise.all([
      fetch(`/api/superadmin/identity/users/${encodeURIComponent(normalizedDiscordId)}`, { credentials: 'include' }),
      fetch(`/api/superadmin/identity/audit?discordId=${encodeURIComponent(normalizedDiscordId)}&limit=25`, { credentials: 'include' }),
    ]);

    const [profileData, auditData] = await Promise.all([profileRes.json(), auditRes.json()]);

    if (!profileData.success) {
      detailEl.innerHTML = `<div style="padding:14px; color:#fca5a5;">${escapeHtml(profileData.message || 'Failed to load user profile')}</div>`;
      return;
    }

    superadminIdentitySelectedUserId = normalizedDiscordId;
    superadminIdentityAuditCache = auditData?.success && Array.isArray(auditData.auditLogs) ? auditData.auditLogs : [];

    detailEl.innerHTML = renderSuperadminIdentityDetail(profileData.profile);
    const listEl = document.getElementById('superadminIdentityList');
    if (listEl) {
      listEl.innerHTML = renderSuperadminIdentityRows(superadminIdentityCache);
    }
  } catch (error) {
    detailEl.innerHTML = `<div style="padding:14px; color:#fca5a5;">Error loading user detail: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

async function saveSuperadminIdentityFlags() {
  const discordId = String(superadminIdentitySelectedUserId || '').trim();
  if (!discordId) return;

  const btn = document.getElementById('superadminIdentityFlagsSaveBtn');
  const trustedInput = document.getElementById('superadminIdentityTrustedInput');
  const manualInput = document.getElementById('superadminIdentityManualInput');
  const notesInput = document.getElementById('superadminIdentityNotesInput');
  if (!trustedInput || !manualInput || !notesInput) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving...';
  }

  try {
    const response = await fetch(`/api/superadmin/identity/users/${encodeURIComponent(discordId)}/flags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        trustedIdentity: !!trustedInput.checked,
        manualVerified: !!manualInput.checked,
        notes: notesInput.value || '',
      }),
    });
    const data = await response.json();
    if (!data.success) {
      showError(data.message || 'Failed to save identity flags');
      return;
    }

    showSuccess('Identity flags saved');
    await loadSuperadminIdentityView();
  } catch (error) {
    showError(`Failed to save identity flags: ${error.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save Flags';
    }
  }
}

async function addSuperadminIdentityWallet() {
  const discordId = String(superadminIdentitySelectedUserId || '').trim();
  if (!discordId) return;

  const walletInput = document.getElementById('superadminIdentityWalletInput');
  const primaryInput = document.getElementById('superadminIdentityWalletPrimaryInput');
  const favoriteInput = document.getElementById('superadminIdentityWalletFavoriteInput');
  const btn = document.getElementById('superadminIdentityWalletAddBtn');
  if (!walletInput || !primaryInput || !favoriteInput || !btn) return;

  const walletAddress = String(walletInput.value || '').trim();
  if (!walletAddress) {
    showError('Wallet address is required');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Linking...';
  try {
    const response = await fetch(`/api/superadmin/identity/users/${encodeURIComponent(discordId)}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        walletAddress,
        primaryWallet: !!primaryInput.checked,
        favoriteWallet: !!favoriteInput.checked,
      }),
    });
    const data = await response.json();
    if (!data.success) {
      showError(data.message || 'Failed to link wallet');
      return;
    }

    walletInput.value = '';
    primaryInput.checked = false;
    favoriteInput.checked = false;
    showSuccess('Wallet linked');
    await loadSuperadminIdentityView();
  } catch (error) {
    showError(`Failed to link wallet: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Link Wallet';
  }
}

async function quickAddSuperadminIdentity() {
  const discordInput = document.getElementById('superadminIdentityNewDiscordId');
  const usernameInput = document.getElementById('superadminIdentityNewUsername');
  const walletInput = document.getElementById('superadminIdentityNewWallet');
  const primaryInput = document.getElementById('superadminIdentityNewPrimary');
  const favoriteInput = document.getElementById('superadminIdentityNewFavorite');
  const btn = document.getElementById('superadminIdentityQuickAddBtn');

  if (!discordInput || !usernameInput || !walletInput || !primaryInput || !favoriteInput || !btn) return;

  const discordId = String(discordInput.value || '').trim();
  const username = String(usernameInput.value || '').trim();
  const walletAddress = String(walletInput.value || '').trim();

  if (!discordId) {
    showError('Discord User ID is required.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    if (walletAddress) {
      const response = await fetch(`/api/superadmin/identity/users/${encodeURIComponent(discordId)}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          walletAddress,
          username: username || null,
          primaryWallet: !!primaryInput.checked,
          favoriteWallet: !!favoriteInput.checked,
        }),
      });
      const data = await response.json();
      if (!data.success) {
        showError(data.message || 'Failed to link wallet');
        return;
      }
      showSuccess('Identity created and wallet linked.');
    } else {
      const response = await fetch('/api/superadmin/identity/users/ensure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          discordId,
          username: username || null,
          reason: 'quick_add',
        }),
      });
      const data = await response.json();
      if (!data.success) {
        showError(data.message || 'Failed to create identity profile');
        return;
      }
      showSuccess('Identity profile created.');
    }

    discordInput.value = '';
    usernameInput.value = '';
    walletInput.value = '';
    primaryInput.checked = false;
    favoriteInput.checked = false;

    superadminIdentitySearch = discordId;
    superadminIdentitySelectedUserId = discordId;
    await loadSuperadminIdentityView();
  } catch (error) {
    showError(`Failed to save identity: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create / Link';
  }
}

function removeSuperadminIdentityWallet(discordId, walletAddress) {
  const normalizedDiscordId = String(discordId || '').trim();
  const normalizedWallet = String(walletAddress || '').trim();
  if (!normalizedDiscordId || !normalizedWallet) return;

  showConfirmModal(
    'Unlink Wallet?',
    `Unlink wallet ${normalizedWallet} from ${normalizedDiscordId}?`,
    async () => {
      try {
        const response = await fetch(`/api/superadmin/identity/users/${encodeURIComponent(normalizedDiscordId)}/wallets/${encodeURIComponent(normalizedWallet)}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        const data = await response.json();
        if (!data.success) {
          showError(data.message || 'Failed to unlink wallet');
          return;
        }
        showSuccess('Wallet unlinked');
        await loadSuperadminIdentityView();
      } catch (error) {
        showError(`Failed to unlink wallet: ${error.message}`);
      }
    },
    'Unlink'
  );
}

function showSuperadminTab(tab) {
  superadminActiveTab = tab;
  const sections = {
    superadmins: ['superadminSection-superadminsInput', 'superadminSection-superadmins', 'superadminSection-chainEmojis', 'superadminSection-microVerify'],
    identity: ['superadminSection-identity'],
    tenants: ['superadminSection-tenants', 'superadminSection-detail', 'superadminSection-eras'],
  };
  Object.entries(sections).forEach(([key, ids]) => {
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = (key === tab) ? '' : 'none';
    });
  });
  document.querySelectorAll('[data-superadmin-tab-btn]').forEach(btn => {
    btn.className = (btn.dataset.superadminTabBtn === tab) ? 'btn-primary' : 'btn-secondary';
  });
  const tenantDetailGroup = document.getElementById('superadminTenantDetailTabGroup');
  if (tenantDetailGroup) tenantDetailGroup.style.display = (tab === 'tenants') ? 'flex' : 'none';
  if (tab === 'tenants') {
    showTenantDetailTab(tenantDetailActiveTab || 'overview');
  } else if (tab === 'identity') {
    loadSuperadminIdentityView();
  }
}

function selectTenantGuild(guildId) {
  selectedTenantGuildId = guildId;
  loadSuperadminView();
}

function applySuperadminTenantFilter(query) {
  superadminTenantSearch = String(query || '');
  superadminTenantPage = 1;
  if (superadminTenantSearch.trim() !== '') superadminTenantDirectoryCollapsed = false;
  if (superadminTenantSearchTimer) clearTimeout(superadminTenantSearchTimer);
  superadminTenantSearchTimer = setTimeout(() => {
    loadSuperadminView();
  }, 220);
}

function superadminTenantPrevPage() {
  if (superadminTenantPage <= 1) return;
  superadminTenantPage -= 1;
  loadSuperadminView();
}

function superadminTenantNextPage() {
  if (superadminTenantPage >= superadminTenantTotalPages) return;
  superadminTenantPage += 1;
  loadSuperadminView();
}

function toggleSuperadminTenantDirectory() {
  superadminTenantDirectoryCollapsed = !superadminTenantDirectoryCollapsed;
  const body = document.getElementById('superadminTenantDirectoryBody');
  const btn = document.getElementById('superadminTenantDirectoryToggleBtn');
  if (body) body.style.display = superadminTenantDirectoryCollapsed ? 'none' : '';
  if (btn) btn.textContent = superadminTenantDirectoryCollapsed ? 'Show Directory' : 'Hide Directory';
}

function showTenantDetailTab(tab) {
  tenantDetailActiveTab = tab;
  const ids = {
    overview: ['tenantDetail-overview'],
    controls: ['tenantDetail-controls'],
    branding: ['tenantDetail-branding'],
    modules: ['tenantDetail-modules'],
    eras: ['superadminSection-eras'],
  };
  Object.entries(ids).forEach(([key, list]) => {
    list.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = (key === tab) ? '' : 'none';
    });
  });
  document.querySelectorAll('[data-tenant-detail-tab]').forEach(btn => {
    btn.className = (btn.dataset.tenantDetailTab === tab) ? 'btn-primary' : 'btn-secondary';
  });
}

function updateTenantTemplateDescription() {
  const select = document.getElementById('tenantTemplateSelect');
  const desc = document.getElementById('tenantTemplateDescription');
  if (!select || !desc) return;

  const templateKey = String(select.value || '').trim();
  const template = (superadminTemplateCatalog || []).find(item => item.key === templateKey);
  desc.textContent = template?.description || 'Apply a template to set plan, module toggles, and module limits in one action.';

  selectedTenantTemplatePreview = null;
  const previewEl = document.getElementById('tenantTemplatePreview');
  if (previewEl) {
    previewEl.innerHTML = renderTenantTemplatePreview(null);
  }
  previewTenantTemplate({ silent: true });
}

async function previewTenantTemplate(options = {}) {
  if (!selectedTenantGuildId) return;
  const { silent = false } = options;

  const select = document.getElementById('tenantTemplateSelect');
  const btn = document.getElementById('tenantTemplatePreviewBtn');
  const previewEl = document.getElementById('tenantTemplatePreview');
  if (!select || !btn || !previewEl) return;

  const templateKey = String(select.value || '').trim();
  if (!templateKey) {
    selectedTenantTemplatePreview = null;
    previewEl.innerHTML = renderTenantTemplatePreview(null);
    if (!silent) showError('Select a template first.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Previewing...';
  previewEl.innerHTML = '<div style="color:var(--text-secondary);">Loading template preview...</div>';

  try {
    const query = new URLSearchParams({ templateKey });
    const response = await fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/template-preview?${query.toString()}`, {
      credentials: 'include'
    });
    const data = await response.json();
    if (!data.success) {
      selectedTenantTemplatePreview = null;
      previewEl.innerHTML = renderTenantTemplatePreview(null);
      if (!silent) showError(data.message || 'Failed to preview template');
      return;
    }

    selectedTenantTemplatePreview = data.preview || null;
    previewEl.innerHTML = renderTenantTemplatePreview(selectedTenantTemplatePreview);
  } catch (error) {
    selectedTenantTemplatePreview = null;
    previewEl.innerHTML = renderTenantTemplatePreview(null);
    if (!silent) showError(`Failed to preview template: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Preview';
  }
}

async function applyTenantTemplate() {
  if (!selectedTenantGuildId) return;

  const select = document.getElementById('tenantTemplateSelect');
  const btn = document.getElementById('tenantTemplateApplyBtn');
  if (!select || !btn) return;

  const templateKey = String(select.value || '').trim();
  if (!templateKey) {
    showError('Select a template first.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Applying...';

  try {
    const response = await fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/apply-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ templateKey })
    });
    const data = await response.json();

    if (data.success) {
      showSuccess(`Template applied: ${data.template?.label || templateKey}`);
      selectedTenantTemplatePreview = null;
      await loadSuperadminView();
    } else {
      showError(data.message || 'Failed to apply template');
    }
  } catch (error) {
    showError(`Failed to apply template: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply Template';
  }
}

async function rollbackTenantTemplate() {
  if (!selectedTenantGuildId) return;

  const btn = document.getElementById('tenantTemplateRollbackBtn');
  if (!btn) return;

  showConfirmModal(
    'Rollback Template?',
    'This restores the tenant to the state before the last applied template (plan, module toggles, and module limit overrides).',
    async () => {
      btn.disabled = true;
      btn.textContent = 'Rolling Back...';
      try {
        const response = await fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/rollback-template`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await response.json();
        if (!data.success) {
          showError(data.message || 'Failed to rollback template');
          return;
        }

        showSuccess(`Template rollback completed (audit #${data.rolledBackFromAuditId || 'n/a'})`);
        selectedTenantTemplatePreview = null;
        await loadSuperadminView();
      } catch (error) {
        showError(`Failed to rollback template: ${error.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Rollback Last';
      }
    },
    'Rollback'
  );
}

async function applyTenantPlan() {
  if (!selectedTenantGuildId) return;

  const select = document.getElementById('tenantPlanSelect');
  const btn = document.getElementById('tenantPlanApplyBtn');
  if (!select || !btn) return;

  btn.disabled = true;
  btn.textContent = 'Applying...';

  try {
    const response = await fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ plan: select.value })
    });
    const data = await response.json();

    if (data.success) {
      showSuccess('Tenant plan updated');
      await loadSuperadminView();
    } else {
      showError(data.message || 'Failed to update tenant plan');
    }
  } catch (error) {
    showError(`Failed to update tenant plan: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply';
  }
}

async function toggleTenantModule(moduleKey, checkbox) {
  if (!selectedTenantGuildId || !checkbox) return;

  const previousValue = !checkbox.checked;

  try {
    const response = await fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/modules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ moduleKey, enabled: checkbox.checked })
    });
    const data = await response.json();

    if (data.success) {
      showSuccess(`${getTenantModuleLabel(moduleKey)} updated`);
      await loadSuperadminView();
    } else {
      checkbox.checked = previousValue;
      showError(`Failed to update module (${response.status}): ${data.message || data.error?.message || JSON.stringify(data)}`);
    }
  } catch (error) {
    checkbox.checked = previousValue;
    showError(`Failed to update tenant module: ${error.message}`);
  }
}

async function saveTenantStatus() {
  if (!selectedTenantGuildId) return;

  const select = document.getElementById('tenantStatusSelect');
  const btn = document.getElementById('tenantStatusSaveBtn');
  if (!select || !btn) return;

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const response = await fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ status: select.value })
    });
    const data = await response.json();

    if (data.success) {
      showSuccess('Tenant status updated');
      await loadSuperadminView();
    } else {
      showError(data.message || 'Failed to update tenant status');
    }
  } catch (error) {
    showError(`Failed to update tenant status: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function saveTenantMockData() {
  if (!selectedTenantGuildId) return;

  const input = document.getElementById('tenantMockDataSwitch');
  const btn = document.getElementById('tenantMockDataSaveBtn');
  if (!input || !btn) return;

  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    const response = await fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/mock-data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ enabled: !!input.checked })
    });
    const data = await response.json();
    if (data.success) {
      showSuccess(`Mock data ${input.checked ? 'enabled' : 'disabled'} for tenant`);
      await loadSuperadminView();
    } else {
      showError(data.message || 'Failed to update mock data setting');
    }
  } catch (error) {
    showError(`Failed to update mock data setting: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Mock Data';
  }
}

async function saveTenantModuleLimits() {
  if (!selectedTenantGuildId) return;

  const btn = document.getElementById('tenantModuleLimitsSaveBtn');
  const inputs = Array.from(document.querySelectorAll('[data-tenant-limit-input="1"]'));
  if (!btn || inputs.length === 0) return;

  const overrides = {};
  for (const input of inputs) {
    const moduleKey = String(input.dataset.moduleKey || '').trim();
    const limitKey = String(input.dataset.limitKey || '').trim();
    if (!moduleKey || !limitKey) continue;

    const raw = String(input.value || '').trim();
    if (!overrides[moduleKey]) overrides[moduleKey] = {};

    if (raw === '') {
      overrides[moduleKey][limitKey] = null;
      continue;
    }

    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < 0) {
      showError(`Invalid value for ${getTenantModuleLabel(moduleKey)} -> ${limitKey}. Use a non-negative number or leave empty.`);
      return;
    }

    overrides[moduleKey][limitKey] = Math.floor(numeric);
  }

  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    const response = await fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/limits`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ overrides }),
    });
    const data = await response.json();
    if (data.success) {
      selectedTenantLimitsCache = data.limits || null;
      showSuccess('Tenant module limits saved');
      await loadSelectedTenantDetail();
      showTenantDetailTab('controls');
    } else {
      showError(data.message || 'Failed to save module limits');
    }
  } catch (error) {
    showError(`Failed to save module limits: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Limits';
  }
}

async function uploadTenantLogo() {
  if (!selectedTenantGuildId) return;
  const input = document.getElementById('tenantBrandLogoFile');
  const btn = document.getElementById('tenantLogoUploadBtn');
  if (!input || !input.files || input.files.length === 0) {
    return showError('Select a logo file first.');
  }

  const file = input.files[0];
  const maxBytes = 2 * 1024 * 1024;
  if (file.size > maxBytes) {
    return showError('Logo too large (max 2MB).');
  }

  const reader = new FileReader();
  const dataUrl = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  }).catch(() => null);

  if (!dataUrl) return showError('Failed to read logo file.');

  btn.disabled = true;
  btn.textContent = 'Uploading...';
  try {
    const response = await fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/logo-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ dataUrl })
    });
    const data = await response.json();
    if (data.success) {
      const logoInput = document.getElementById('tenantBrandLogoUrl');
      if (logoInput) logoInput.value = data.logo_url || '';
      showSuccess('Logo uploaded');
      await loadSuperadminView();
    } else {
      showError(data.message || 'Failed to upload logo');
    }
  } catch (error) {
    showError(`Failed to upload logo: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Upload Logo';
  }
}

async function saveTenantBranding() {
  if (!selectedTenantGuildId) return;

  const btn = document.getElementById('tenantBrandSaveBtn');
  if (!btn) return;

  const payload = {
    bot_display_name: document.getElementById('tenantBrandBotDisplayName')?.value || '',
    brand_emoji: document.getElementById('tenantBrandEmoji')?.value || '',
    brand_color: document.getElementById('tenantBrandColor')?.value || '',
    logo_url: document.getElementById('tenantBrandLogoUrl')?.value || '',
    support_url: document.getElementById('tenantBrandSupportUrl')?.value || '',
    bot_server_avatar_url: document.getElementById('tenantBrandServerAvatarUrl')?.value || '',
    bot_server_banner_url: document.getElementById('tenantBrandServerBannerUrl')?.value || '',
    bot_server_bio: document.getElementById('tenantBrandServerBio')?.value || ''
  };

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const response = await fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/branding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    if (data.success) {
      showSuccess('Tenant branding saved');
      await loadSuperadminView();
    } else {
      showError(data.message || 'Failed to save tenant branding');
    }
  } catch (error) {
    showError(`Failed to save tenant branding: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function addSuperadminFromInput() {
  const input = document.getElementById('adminSuperadminUserIdInput');
  const btn = document.getElementById('adminSuperadminAddBtn');
  if (!input || !btn) return;

  const userId = input.value.trim();
  if (!userId) {
    showError('Discord ID is required');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Adding...';

  try {
    const response = await fetch('/api/superadmin/admins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId })
    });
    const data = await response.json();

    if (data.success) {
      input.value = '';
      showSuccess('Superadmin added');
      await loadSuperadminView();
    } else {
      showError(data.message || 'Failed to add superadmin');
    }
  } catch (error) {
    showError(`Failed to add superadmin: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}

function removeSuperadmin(userId) {
  showConfirmModal(
    'Remove Superadmin?',
    `Remove ${userId} from the database-managed superadmins list? Root env superadmins stay protected.`,
    async () => {
      try {
        const response = await fetch(`/api/superadmin/admins/${encodeURIComponent(userId)}`, {
          method: 'DELETE',
          credentials: 'include'
        });
        const data = await response.json();

        if (data.success) {
          showSuccess('Superadmin removed');
          await loadSuperadminView();
        } else {
          showError(data.message || 'Failed to remove superadmin');
        }
      } catch (error) {
        showError(`Failed to remove superadmin: ${error.message}`);
      }
    },
    'Remove'
  );
}

async function saveMicroVerifySettings() {
  const enabled = !!document.getElementById('sa_microVerifyEnabled')?.checked;
  const receiveWallet = document.getElementById('sa_verificationReceiveWallet')?.value?.trim() || '';
  const ttl = parseInt(document.getElementById('sa_verifyTtlMinutes')?.value) || 15;
  const pollInterval = parseInt(document.getElementById('sa_pollIntervalSeconds')?.value) || 30;

  try {
    // Use the dedicated global-settings endpoint — no guild context required
    const response = await fetch('/api/superadmin/global-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        moduleMicroVerifyEnabled: enabled,
        verificationReceiveWallet: receiveWallet,
        verifyRequestTtlMinutes: ttl,
        pollIntervalSeconds: pollInterval
      })
    });
    const data = await response.json();
    if (!data.success) {
      showError(data.message || 'Failed to save micro-verify settings');
      return;
    }
    showSuccess('Micro-verify settings saved ✅');
    await loadSuperadminView();
  } catch (error) {
    showError(`Failed to save micro-verify settings: ${error.message}`);
  }
}

async function saveChainEmojiMap() {
  const chains = ['solana', 'usdc', 'ethereum', 'base', 'polygon', 'arbitrum', 'optimism', 'bsc', 'avalanche'];
  const chainEmojiMap = {};
  chains.forEach(chain => {
    const el = document.getElementById(`sa_chainEmoji_${chain}`);
    if (el) chainEmojiMap[chain] = String(el.value || '').trim();
  });

  try {
    // chainEmojiMap is a global (superadmin) setting — use the superadmin endpoint
    // which does not require a guild/server to be selected.
    const response = await fetch('/api/superadmin/global-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ chainEmojiMap })
    });
    const data = await response.json();
    if (!data.success) {
      showError(data.message || 'Failed to save chain emoji map');
      return;
    }
    showSuccess('Chain emoji map saved');
    await loadSuperadminView();
  } catch (error) {
    showError(`Failed to save chain emoji map: ${error.message}`);
  }
}

async function replayNftActivityTx() {
  const el = document.getElementById('sa_nftReplayTx');
  const txSignature = String(el?.value || '').trim();
  if (!txSignature) {
    showError('Please paste a tx signature');
    return;
  }

  try {
    const response = await fetch('/api/superadmin/nft-activity/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ txSignature }),
    });
    const data = await response.json();
    if (!data.success) {
      showError(data.message || 'Failed to replay NFT activity tx');
      return;
    }
    showSuccess(`Replayed tx: ${txSignature}`);
    if (el) el.value = '';
  } catch (error) {
    showError(`Failed to replay tx: ${error.message}`);
  }
}

async function loadAdminHelpView() {
  if (!isAdmin) return;
  const content = document.getElementById('adminHelpContent');
  if (!content) return;

  const cmdSection = (title, icon, commands, note) => {
    const rows = commands.map(c => `
      <tr>
        <td style="padding:8px 10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#c7d2fe; font-family:monospace; font-size:0.85em; white-space:nowrap;">${escapeHtml(c.name)}</td>
        <td style="padding:8px 10px; border-bottom:1px solid rgba(99,102,241,0.15); color:var(--text-secondary); font-size:0.9em;">${escapeHtml(c.desc)}</td>
        <td style="padding:8px 10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#93c5fd; font-size:0.85em;">${escapeHtml(c.options || '—')}</td>
        <td style="padding:8px 10px; border-bottom:1px solid rgba(99,102,241,0.15); color:var(--text-secondary); font-family:monospace; font-size:0.8em;">${escapeHtml(c.example || '')}</td>
      </tr>`).join('');
    return `
      <h4 style="color:#c9d6ff; margin:20px 0 8px;">${icon} ${escapeHtml(title)}</h4>
      <div style="overflow:auto; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.5); margin-bottom:16px;">
        <table style="width:100%; border-collapse:collapse; font-size:0.9em;">
          <thead><tr style="background:rgba(99,102,241,0.12); text-align:left;">
            <th style="padding:8px 10px; color:#c9d6ff;">Command</th>
            <th style="padding:8px 10px; color:#c9d6ff;">Description</th>
            <th style="padding:8px 10px; color:#c9d6ff;">Options</th>
            <th style="padding:8px 10px; color:#c9d6ff;">Example</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${note ? `<div style="margin:-12px 0 16px;padding:7px 12px;border-radius:0 0 10px 10px;background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.12);border-top:none;color:#94a3b8;font-size:0.8em;">ℹ️ ${note}</div>` : ''}`;
  };

  content.innerHTML = `
    <div style="margin-bottom:16px;padding:12px 14px;border:1px solid rgba(99,102,241,0.18);border-radius:10px;background:rgba(99,102,241,0.08);color:var(--text-secondary);font-size:0.88em;line-height:1.6;">
      Full command inventory by category. This reflects currently shipped slash commands in the bot. Minigames are currently exposed as dedicated commands and all map to the <code>minigames</code> entitlement module.
    </div>
    ${cmdSection('Verification', 'VER', [
      { name: '/verification status', desc: 'Check wallet verification status and holdings', options: '-', example: '/verification status' },
      { name: '/verification wallets', desc: 'List linked wallets', options: '-', example: '/verification wallets' },
      { name: '/verification refresh', desc: 'Refresh roles from holdings', options: '-', example: '/verification refresh' },
      { name: '/verification quick', desc: 'Quick micro verification flow', options: '-', example: '/verification quick' },
      { name: '/verification admin panel', desc: 'Post verification panel', options: 'title, description, color', example: '/verification admin panel title:"Verify"' },
      { name: '/verification admin export-user', desc: 'Export member verification data', options: 'user (required)', example: '/verification admin export-user user:@member' },
      { name: '/verification admin remove-user', desc: 'Remove member verification record', options: 'user, confirm (required)', example: '/verification admin remove-user user:@member confirm:true' },
      { name: '/verification admin export-wallets', desc: 'Export verified wallets CSV', options: 'role, primary-only (optional)', example: '/verification admin export-wallets role:@Verified primary-only:true' },
      { name: '/verification admin token-role-add', desc: 'Add token balance role rule', options: 'mint, role, min_amount (required), symbol/max_amount (optional)', example: '/verification admin token-role-add mint:So1... role:@Holder min_amount:1' },
      { name: '/verification admin token-role-remove', desc: 'Remove token balance role rule', options: 'id (required)', example: '/verification admin token-role-remove id:3' },
      { name: '/verification admin token-role-list', desc: 'List token balance role rules', options: '-', example: '/verification admin token-role-list' },
      { name: '/verification admin role-config', desc: 'Manage tier/trait role mapping actions', options: 'action + optional trait/role fields', example: '/verification admin role-config action:view' },
      { name: '/verification admin actions', desc: 'View role assignment actions', options: '-', example: '/verification admin actions' },
      { name: '/verification admin og-view', desc: 'View OG role config', options: '-', example: '/verification admin og-view' },
      { name: '/verification admin og-enable', desc: 'Enable/disable OG role system', options: 'enabled (required)', example: '/verification admin og-enable enabled:true' },
      { name: '/verification admin og-role', desc: 'Set OG role', options: 'role (required)', example: '/verification admin og-role role:@OG' },
      { name: '/verification admin og-limit', desc: 'Set OG slot count', options: 'count (required)', example: '/verification admin og-limit count:50' },
      { name: '/verification admin og-sync', desc: 'Sync OG role assignment', options: 'full (optional)', example: '/verification admin og-sync full:true' }
    ])}
    ${cmdSection('Governance', 'GOV', [
      { name: '/governance propose', desc: 'Create proposal', options: 'title, description (required), category, cost', example: '/governance propose title:"Fund X" description:"..."' },
      { name: '/governance support', desc: 'Support draft proposal', options: 'proposal_id (required)', example: '/governance support proposal_id:P-001' },
      { name: '/governance vote', desc: 'Vote on active proposal', options: 'proposal_id, choice (required)', example: '/governance vote proposal_id:P-001 choice:yes' },
      { name: '/governance admin list', desc: 'List proposals', options: 'status (optional)', example: '/governance admin list status:voting' },
      { name: '/governance admin cancel', desc: 'Cancel proposal', options: 'proposal_id, confirm (required)', example: '/governance admin cancel proposal_id:P-001 confirm:true' },
      { name: '/governance admin settings', desc: 'View governance settings', options: '-', example: '/governance admin settings' }
    ])}
    ${cmdSection('Treasury', 'TRY', [
      { name: '/treasury view', desc: 'Public treasury snapshot', options: '-', example: '/treasury view' },
      { name: '/treasury admin status', desc: 'Admin treasury status', options: '-', example: '/treasury admin status' },
      { name: '/treasury admin refresh', desc: 'Refresh treasury balances', options: '-', example: '/treasury admin refresh' },
      { name: '/treasury admin enable', desc: 'Enable treasury monitoring', options: '-', example: '/treasury admin enable' },
      { name: '/treasury admin disable', desc: 'Disable treasury monitoring', options: '-', example: '/treasury admin disable' },
      { name: '/treasury admin set-wallet', desc: 'Set treasury wallet', options: 'address (required)', example: '/treasury admin set-wallet address:So1...' },
      { name: '/treasury admin set-interval', desc: 'Set refresh interval', options: 'hours (required)', example: '/treasury admin set-interval hours:6' },
      { name: '/treasury admin tx-history', desc: 'Show transaction history', options: 'limit (optional)', example: '/treasury admin tx-history limit:10' },
      { name: '/treasury admin tx-alerts', desc: 'Configure tx alerts', options: 'enabled, channel, incoming_only, min_sol', example: '/treasury admin tx-alerts enabled:true channel:#treasury' }
    ])}
    ${cmdSection('NFT Tracker', 'NFT', [
      { name: '/nft-tracker collection add', desc: 'Track collection events', options: 'address, name, channel (required), me_symbol', example: '/nft-tracker collection add address:... name:"Collection" channel:#alerts' },
      { name: '/nft-tracker collection remove', desc: 'Remove tracked collection', options: 'id (required)', example: '/nft-tracker collection remove id:3' },
      { name: '/nft-tracker collection list', desc: 'List tracked collections', options: '-', example: '/nft-tracker collection list' },
      { name: '/nft-tracker collection feed', desc: 'Show collection feed', options: 'limit (optional)', example: '/nft-tracker collection feed limit:15' }
    ])}
    ${cmdSection('Wallet Tracker', 'WLT', [
      { name: '/wallet-tracker add', desc: 'Track wallet', options: 'address (required), label, alert_channel, panel_channel', example: '/wallet-tracker add address:So1... label:"Whale"' },
      { name: '/wallet-tracker remove', desc: 'Remove tracked wallet', options: 'id (required)', example: '/wallet-tracker remove id:2' },
      { name: '/wallet-tracker list', desc: 'List tracked wallets', options: '-', example: '/wallet-tracker list' },
      { name: '/wallet-tracker edit', desc: 'Edit tracked wallet', options: 'id + optional label/channels/enabled', example: '/wallet-tracker edit id:2 enabled:false' },
      { name: '/wallet-tracker holdings', desc: 'Post/refresh holdings panel', options: 'id (required), channel', example: '/wallet-tracker holdings id:2' },
      { name: '/wallet-tracker refresh-all', desc: 'Refresh all holdings panels', options: '-', example: '/wallet-tracker refresh-all' }
    ])}
    ${cmdSection('Invite Tracker', 'INV', [
      { name: '/invites who', desc: 'Show who invited a member', options: 'user (required)', example: '/invites who user:@member' },
      { name: '/invites leaderboard', desc: 'Show invite leaderboard', options: 'period (optional), limit (optional), required_join_role (optional), verification_stats (optional)', example: '/invites leaderboard period:30 limit:20' },
      { name: '/invites panel', desc: 'Post/update leaderboard panel', options: 'channel, period, limit, required_join_role, create_link_button, verification_stats', example: '/invites panel channel:#leaderboard period:30' },
      { name: '/invites export', desc: 'Export invite events CSV (paid plans)', options: 'period (optional)', example: '/invites export period:all' }
    ])}
    ${cmdSection('Token Tracker', 'TOK', [
      { name: '/token-tracker add', desc: 'Track SPL token mint for balances + alerts', options: 'mint(required), symbol/name(optional), alert_channel, min_alert_amount, alert flags', example: '/token-tracker add mint:... symbol:CAT alert_channel:#token-alerts alert_buys:true' },
      { name: '/token-tracker edit', desc: 'Edit tracked token options', options: 'id(required) + optional mint/symbol/name/alert_channel/min_alert_amount/alert flags/enabled', example: '/token-tracker edit id:2 alert_transfers:true' },
      { name: '/token-tracker remove', desc: 'Remove tracked token mint', options: 'id(required)', example: '/token-tracker remove id:2' },
      { name: '/token-tracker list', desc: 'List tracked token mints', options: '-', example: '/token-tracker list' },
      { name: '/token-tracker feed', desc: 'Show recent tracked token events', options: 'limit(optional)', example: '/token-tracker feed limit:15' }
    ])}

    ${cmdSection('Points', 'PTS', [
      { name: '/points balance', desc: 'Show points balance', options: 'user (optional admin)', example: '/points balance' },
      { name: '/points leaderboard', desc: 'Show leaderboard', options: 'limit (optional)', example: '/points leaderboard limit:10' },
      { name: '/points history', desc: 'Show points history', options: 'user (optional admin)', example: '/points history' },
      { name: '/points shop', desc: 'Browse rewards shop', options: '-', example: '/points shop' },
      { name: '/points redeem', desc: 'Redeem item', options: 'item_id (required)', example: '/points redeem item_id:4' },
      { name: '/points admin', desc: 'Manage points and shop', options: 'action(required: grant/deduct/add-item/remove-item/config) + optional user/amount/reason/value/item_id', example: '/points admin action:grant user:@member amount:50 reason:"Event"' }
    ])}
    ${cmdSection('Heist', 'HEIST', [
      { name: '/heist view', desc: 'View available missions', options: '-', example: '/heist view' },
      { name: '/heist signup', desc: 'Sign up for mission', options: 'mission_id, role (required)', example: '/heist signup mission_id:H-001 role:hacker' },
      { name: '/heist status', desc: 'View mission status', options: '-', example: '/heist status' },
      { name: '/heist admin create', desc: 'Create mission', options: 'title, description, slots, reward (required)', example: '/heist admin create title:"Bank Job" description:"..." slots:4 reward:100' },
      { name: '/heist admin list', desc: 'List missions', options: '-', example: '/heist admin list' },
      { name: '/heist admin cancel', desc: 'Cancel mission', options: 'mission_id, confirm (required)', example: '/heist admin cancel mission_id:H-001 confirm:true' }
    ])}
    ${cmdSection('Battle and Games', 'GAMES', [
      { name: '/battle create', desc: 'Create battle lobby', options: 'max_players, required/excluded roles, era', example: '/battle create max_players:20 era:mafia' },
      { name: '/battle start', desc: 'Start battle', options: '-', example: '/battle start' },
      { name: '/battle cancel', desc: 'Cancel battle', options: '-', example: '/battle cancel' },
      { name: '/battle stats', desc: 'Battle stats', options: 'user (optional)', example: '/battle stats user:@member' },
      { name: '/battle admin list', desc: 'List active battles', options: '-', example: '/battle admin list' },
      { name: '/battle admin force-end', desc: 'Force end battle', options: 'battle_id, confirm (required)', example: '/battle admin force-end battle_id:b1 confirm:true' },
      { name: '/battle admin settings', desc: 'View battle settings', options: '-', example: '/battle admin settings' },
      { name: '/higherlower start', desc: 'Start Higher or Lower', options: 'join_time (optional)', example: '/higherlower start join_time:45' },
      { name: '/higherlower cancel', desc: 'Cancel Higher or Lower', options: '-', example: '/higherlower cancel' },
      { name: '/diceduel start', desc: 'Start Dice Duel', options: 'join_time (optional)', example: '/diceduel start join_time:60' },
      { name: '/diceduel cancel', desc: 'Cancel Dice Duel', options: '-', example: '/diceduel cancel' },
      { name: '/reactionrace start', desc: 'Start Reaction Race', options: 'join_time (optional)', example: '/reactionrace start' },
      { name: '/reactionrace cancel', desc: 'Cancel Reaction Race', options: '-', example: '/reactionrace cancel' },
      { name: '/numberguess start', desc: 'Start Number Guess', options: 'join_time (optional)', example: '/numberguess start' },
      { name: '/numberguess cancel', desc: 'Cancel Number Guess', options: '-', example: '/numberguess cancel' },
      { name: '/slots start', desc: 'Start Slots', options: 'join_time (optional)', example: '/slots start' },
      { name: '/slots cancel', desc: 'Cancel Slots', options: '-', example: '/slots cancel' },
      { name: '/trivia start', desc: 'Start Trivia', options: 'join_time (optional)', example: '/trivia start' },
      { name: '/trivia cancel', desc: 'Cancel Trivia', options: '-', example: '/trivia cancel' },
      { name: '/wordscramble start', desc: 'Start Word Scramble', options: 'join_time (optional)', example: '/wordscramble start' },
      { name: '/wordscramble cancel', desc: 'Cancel Word Scramble', options: '-', example: '/wordscramble cancel' },
      { name: '/rps start', desc: 'Start RPS Tournament', options: 'join_time (optional)', example: '/rps start' },
      { name: '/rps cancel', desc: 'Cancel RPS Tournament', options: '-', example: '/rps cancel' },
      { name: '/blackjack start', desc: 'Start Blackjack', options: 'join_time (optional)', example: '/blackjack start' },
      { name: '/blackjack cancel', desc: 'Cancel Blackjack', options: '-', example: '/blackjack cancel' },
      { name: '/gamenight start', desc: 'Start Game Night', options: 'join_time, games (optional)', example: '/gamenight start join_time:90 games:trivia,slots,rps' },
      { name: '/gamenight skip', desc: 'Skip Game Night round', options: '-', example: '/gamenight skip' },
      { name: '/gamenight cancel', desc: 'Cancel Game Night', options: '-', example: '/gamenight cancel' },
      { name: '/gamenight leaderboard', desc: 'Game Night standings', options: '-', example: '/gamenight leaderboard' }
    ], 'Most game start/cancel flows require admin or moderator permissions. Game Night requires Growth+ plan in tenant mode.')}
    ${cmdSection('Config', 'CFG', [
      { name: '/config modules', desc: 'View module toggles', options: '-', example: '/config modules' },
      { name: '/config toggle', desc: 'Toggle core module', options: 'module, enabled (required)', example: '/config toggle module:minigames enabled:true' },
      { name: '/config status', desc: 'System status overview', options: '-', example: '/config status' }
    ])}
  `;
}

async function loadAdminProposals() {
  if (!isAdmin) return;
  const content = document.getElementById('adminProposalsContent');
  if (!content) return;

  content.innerHTML = `<div style="text-align:center; padding: var(--space-5); color: var(--text-secondary);"><div class="spinner"></div><p>Loading proposals...</p></div>`;

  try {
    const response = await fetch('/api/admin/proposals', { credentials: 'include' });
    const data = await response.json();
    if (!data.success) throw new Error(data.message || 'Failed to load proposals');

    const proposals = data.proposals || [];
    if (!proposals.length) {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-title">No proposals found</div></div>`;
      return;
    }

    const statusOrder = ['pending_review', 'on_hold', 'supporting', 'voting', 'concluded', 'vetoed', 'draft', 'expired', 'passed', 'rejected', 'quorum_not_met'];
    const grouped = {};
    for (const p of proposals) {
      const s = p.status || 'draft';
      if (!grouped[s]) grouped[s] = [];
      grouped[s].push(p);
    }

    const statusLabels = {
      pending_review: 'Pending Review', on_hold: 'On Hold', supporting: 'Supporting',
      voting: 'Voting', concluded: 'Concluded', vetoed: 'Vetoed', draft: 'Draft',
      expired: 'Expired', passed: 'Passed', rejected: 'Rejected', quorum_not_met: 'Quorum Not Met'
    };

    const categoryColors = {
      'Partnership': '#3b82f6', 'Treasury Allocation': '#f59e0b',
      'Rule Change': '#ef4444', 'Community Event': '#10b981', 'Other': '#8b5cf6'
    };

    let html = '';
    for (const status of statusOrder) {
      const items = grouped[status];
      if (!items || !items.length) continue;

      html += `<div style="margin-bottom:20px;">
        <h4 style="color:var(--text-primary); margin-bottom:10px; font-size:1em; border-bottom:1px solid var(--border-default); padding-bottom:6px;">
          ${statusLabels[status] || status} (${items.length})
        </h4>
        <div style="display:grid; gap:10px;">`;

      for (const p of items) {
        const catColor = categoryColors[p.category] || '#8b5cf6';
        const commentCount = p.comment_count || 0;
        const vetoVotes = p.veto_votes ? JSON.parse(p.veto_votes || '[]').length : 0;

        let actions = '';
        if (status === 'pending_review') {
          actions = `<div style="display:flex; gap:8px; margin-top:8px;">
            <button onclick="adminProposalAction('${escapeJsString(p.proposal_id)}', 'approve')" style="padding:6px 14px; background:#10b981; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">Approve</button>
            <button onclick="adminProposalHold('${escapeJsString(p.proposal_id)}')" style="padding:6px 14px; background:#f59e0b; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">Hold</button>
          </div>`;
        } else if (status === 'on_hold') {
          actions = `<div style="display:flex; gap:8px; margin-top:8px;">
            <button onclick="adminProposalAction('${escapeJsString(p.proposal_id)}', 'approve')" style="padding:6px 14px; background:#10b981; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">Approve</button>
            ${p.on_hold_reason ? `<span style="color:var(--text-secondary); font-size:0.85em; align-self:center;">Reason: ${escapeHtml(p.on_hold_reason)}</span>` : ''}
          </div>`;
        } else if (status === 'supporting') {
          actions = `<div style="display:flex; gap:8px; margin-top:8px;">
            <button onclick="adminProposalAction('${escapeJsString(p.proposal_id)}', 'promote')" style="padding:6px 14px; background:#6366f1; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">Promote to Voting</button>
          </div>`;
        } else if (status === 'voting') {
          const totalVoted = (p.yes_vp || 0) + (p.no_vp || 0) + (p.abstain_vp || 0);
          const quorumPct = p.total_vp > 0 ? Math.round((totalVoted / p.total_vp) * 100) : 0;
          actions = `<div style="margin-top:8px;">
            <div style="font-size:0.85em; color:var(--text-secondary); margin-bottom:6px;">
              Yes: ${p.yes_vp || 0} VP | No: ${p.no_vp || 0} VP | Abstain: ${p.abstain_vp || 0} VP | Quorum: ${quorumPct}% / ${p.quorum_required || '?'} VP needed
              ${vetoVotes > 0 ? ` | Veto votes: ${vetoVotes}` : ''}
              ${p.paused ? ' | <span style="color:#ef4444;">PAUSED</span>' : ''}
            </div>
            <div style="display:flex; gap:8px;">
              <button onclick="adminProposalAction('${escapeJsString(p.proposal_id)}', 'conclude')" style="padding:6px 14px; background:#ef4444; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">Conclude</button>
              <button onclick="adminProposalAction('${escapeJsString(p.proposal_id)}', 'pause')" style="padding:6px 14px; background:#f59e0b; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">${p.paused ? 'Unpause' : 'Pause'}</button>
            </div>
          </div>`;
        } else if (status === 'vetoed') {
          actions = p.veto_reason ? `<div style="margin-top:6px; font-size:0.85em; color:#ef4444;">Veto reason: ${escapeHtml(p.veto_reason)}</div>` : '';
        }

        html += `<div style="padding:12px; border:1px solid var(--border-default); border-radius:10px; background: var(--bg-tertiary);">
          <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
            <strong>${escapeHtml(p.title || 'Untitled')}</strong>
            <div style="display:flex; gap:6px; align-items:center;">
              <span style="padding:2px 8px; border-radius:4px; font-size:0.8em; background:${catColor}20; color:${catColor}; border:1px solid ${catColor}40;">${escapeHtml(p.category || 'Other')}</span>
              <span class="status-badge status-${escapeHtml(p.status || 'draft')}">${escapeHtml(p.status || 'draft')}</span>
            </div>
          </div>
          <div style="color:var(--text-secondary); font-size:0.85em; margin-top:6px;">
            ID: ${escapeHtml(p.proposal_id || '')} • Creator: ${escapeHtml(p.creator_id || '')}
            ${p.cost_indication ? ` • Cost: ${escapeHtml(p.cost_indication)}` : ''}
          </div>
          ${actions}
        </div>`;
      }

      html += '</div></div>';
    }

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div class="error-state"><div class="error-message">${escapeHtml(e.message)}</div></div>`;
  }
}

async function adminProposalAction(proposalId, action) {
  const endpoints = {
    approve: `/api/admin/governance/proposals/${proposalId}/approve`,
    promote: `/api/admin/governance/proposals/${proposalId}/promote`,
    conclude: `/api/admin/governance/proposals/${proposalId}/conclude`,
    pause: `/api/admin/governance/proposals/${proposalId}/pause`
  };
  const labels = { approve: 'Approve', promote: 'Promote to Voting', conclude: 'Conclude Voting', pause: 'Toggle Pause' };

  showConfirmModal(`${labels[action]}?`, `Are you sure you want to ${labels[action].toLowerCase()} proposal ${proposalId}?`, async () => {
    try {
      const response = await fetch(endpoints[action], { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
      const data = await response.json();
      if (data.success) {
        showSuccess(`Proposal ${proposalId}: ${labels[action]} successful`);
        await loadAdminProposals();
      } else {
        showError(data.message || `Failed to ${action}`);
      }
    } catch (e) {
      showError('Error: ' + e.message);
    }
  }, labels[action]);
}

function adminProposalHold(proposalId) {
  showConfirmModal('Place on Hold', '', null);
  const body = document.getElementById('confirmMessage');
  const btn = document.getElementById('confirmButton');
  const title = document.getElementById('confirmTitle');
  title.textContent = 'Place Proposal on Hold';
  btn.textContent = 'Place on Hold';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-primary');

  body.innerHTML = `
    <div>
      <label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Reason (optional)</label>
      <input id="holdReasonInput" type="text" placeholder="Why is this on hold?" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;">
    </div>
  `;

  confirmCallback = async () => {
    const reason = document.getElementById('holdReasonInput')?.value.trim() || '';
    try {
      const response = await fetch(`/api/admin/governance/proposals/${proposalId}/hold`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ reason })
      });
      const data = await response.json();
      if (data.success) {
        showSuccess(`Proposal ${proposalId} placed on hold`);
        await loadAdminProposals();
      } else {
        showError(data.message || 'Failed to hold proposal');
      }
    } catch (e) {
      showError('Error: ' + e.message);
    }
  };
}

let portalSettingsData = null;

async function loadBattleTimingSettings() {
  try {
    const [settingsRes, erasRes] = await Promise.all([
      fetch('/api/admin/settings', { credentials: 'include', headers: buildTenantRequestHeaders() }),
      fetch('/api/admin/battle/eras', { credentials: 'include', headers: buildTenantRequestHeaders() }).catch(() => null),
    ]);
    const data = await settingsRes.json();
    const s = data.settings || {};
    const minEl = document.getElementById('battlePauseMinInput');
    const maxEl = document.getElementById('battlePauseMaxInput');
    const eliteEl = document.getElementById('battleElitePrepInput');
    const forcedEl = document.getElementById('battleForcedEliminationIntervalInput');
    if (minEl) minEl.value = s.battleRoundPauseMinSec ?? 5;
    if (maxEl) maxEl.value = s.battleRoundPauseMaxSec ?? 10;
    if (eliteEl) eliteEl.value = s.battleElitePrepSec ?? 12;
    if (forcedEl) forcedEl.value = s.battleForcedEliminationIntervalRounds ?? 3;

    // Inject era selector if not already present
    const battlePane = document.getElementById('settingsTab-battle');
    if (battlePane && !document.getElementById('battleDefaultEraWrap')) {
      let eras = [{ key: 'mafia', name: 'Mafia (default)' }];
      if (erasRes && erasRes.ok) {
        const eraData = await erasRes.json();
        if (eraData.eras && eraData.eras.length) eras = eraData.eras;
      }
      const currentEra = s.battleDefaultEra || 'mafia';
      const opts = eras.map(e => `<option style="background:rgba(30,41,59,1);color:#e0e7ff;" value="${escapeHtml(e.key)}"${e.key === currentEra ? ' selected' : ''}>${escapeHtml(e.name)}</option>`).join('');
      const eraWrap = document.createElement('div');
      eraWrap.id = 'battleDefaultEraWrap';
      eraWrap.style.cssText = 'margin-top:16px;border-top:1px solid rgba(99,102,241,0.15);padding-top:16px;position:relative;z-index:1;';
      eraWrap.innerHTML = `
        <label class="form-label">Default Battle Era</label>
        <select id="battleDefaultEraSelect" class="form-input" style="width:220px;background:rgba(30,41,59,0.95);color:#e0e7ff;border:1px solid rgba(99,102,241,0.22);">
          ${opts}
        </select>
        <p style="color:var(--text-secondary); font-size:0.82em; margin-top:4px;">Era used when no era is specified in /battle create. Custom eras must be assigned by a Superadmin.</p>
      `;
      // Insert before the save button div
      const saveBtn = battlePane.querySelector('button');
      const saveBtnContainer = saveBtn ? saveBtn.closest('div') : null;
      if (saveBtnContainer) {
        saveBtnContainer.parentElement.insertBefore(eraWrap, saveBtnContainer);
      } else {
        battlePane.querySelector('.card > div')?.appendChild(eraWrap);
      }
    } else if (document.getElementById('battleDefaultEraSelect')) {
      document.getElementById('battleDefaultEraSelect').value = s.battleDefaultEra || 'mafia';
    }
  } catch (e) {
    console.error('[Battle settings] load error:', e);
  }
}

async function saveBattleTimingSettings() {
  const minVal = parseFloat(document.getElementById('battlePauseMinInput')?.value);
  const maxVal = parseFloat(document.getElementById('battlePauseMaxInput')?.value);
  const eliteVal = parseFloat(document.getElementById('battleElitePrepInput')?.value);
  const forcedIntervalVal = parseInt(document.getElementById('battleForcedEliminationIntervalInput')?.value, 10);
  if (isNaN(minVal) || isNaN(maxVal) || isNaN(eliteVal) || isNaN(forcedIntervalVal)) return showError('Please enter valid numbers for all timing fields.');
  if (minVal > maxVal) return showError('Minimum pause cannot be greater than maximum pause.');
  if (forcedIntervalVal < 1 || forcedIntervalVal > 20) return showError('Forced elimination interval must be between 1 and 20 rounds.');
  const eraVal = document.getElementById('battleDefaultEraSelect')?.value || 'mafia';
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      body: JSON.stringify({
        battleRoundPauseMinSec: minVal,
        battleRoundPauseMaxSec: maxVal,
        battleElitePrepSec: eliteVal,
        battleForcedEliminationIntervalRounds: forcedIntervalVal,
        battleDefaultEra: eraVal
      })
    });
    const data = await res.json();
    if (data.success) showSuccess('Battle settings saved!');
    else showError(data.message || 'Failed to save battle settings.');
  } catch (e) {
    showError('Error saving battle settings.');
  }
}

async function loadAdminSettingsView() {
  if (!isAdmin) return;
  const content = document.getElementById('adminSettingsContent');
  if (!content) return;

  content.innerHTML = `<div style="text-align:center; padding: var(--space-5); color: var(--text-secondary);"><div class="spinner"></div><p>Loading settings...</p></div>`;

  // --- Shared inline-style constants ---
  const cardStyle = 'background:rgba(14,23,44,0.5);border:1px solid rgba(99,102,241,0.22);border-radius:10px;padding:var(--space-5);margin-bottom:var(--space-5);';
  const cardHeader = 'color:#c9d6ff;font-size:var(--font-lg);font-weight:700;margin:0 0 var(--space-4) 0;padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);';

  try {
    // Step 1: Fetch settings first
    const settingsRes = await fetch('/api/admin/settings', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const settingsJson = await settingsRes.json();
    if (!settingsJson.success) throw new Error(settingsJson.message || 'Failed to load settings');
    portalSettingsData = settingsJson.settings;
    const s = portalSettingsData;
    const tenantReadOnlyModules = !!(s.multiTenantEnabled && s.readOnlyManaged && !isSuperadmin);
    // assignedModuleKeys: null = single-tenant (all visible), array = multi-tenant assigned keys
    const assignedKeys = s.assignedModuleKeys || null;

    // Update settings tab visibility immediately (assigned-only filtering)
    applySettingsTabVisibility(s);

    // Module toggle mapping: settingsKey -> { label, icon, moduleKey (for assigned check) }
    const MODULE_TOGGLE_DEFS = [
      { id: 'moduleMinigamesEnabled',    label: 'Minigames',       icon: '🎮', moduleKey: 'minigames'     },
      { id: 'moduleGovernanceEnabled',   label: 'Governance',      icon: 'G',  moduleKey: 'governance'    },
      { id: 'moduleVerificationEnabled', label: 'Verification',    icon: 'V',  moduleKey: 'verification'  },
      { id: 'moduleBrandingEnabled',     label: 'Branding',        icon: 'BR', moduleKey: 'branding'      },
      { id: 'moduleMissionsEnabled',     label: 'Heist',           icon: 'H',  moduleKey: 'heist'         },
      { id: 'moduleWalletTrackerEnabled',label: 'Wallet Tracker',  icon: 'W',  moduleKey: 'wallettracker' },
      { id: 'moduleInviteTrackerEnabled',label: 'Invite Tracker',  icon: '📨', moduleKey: 'invites'       },
      { id: 'moduleTreasuryEnabled',     label: 'Treasury',        icon: '$',  moduleKey: 'treasury'      },
      { id: 'moduleNftTrackerEnabled',   label: 'NFT Tracker',     icon: 'N',  moduleKey: 'nfttracker'    },
      { id: 'moduleTokenTrackerEnabled', label: 'Token Tracker',   icon: '\ud83e\ude99',  moduleKey: 'tokentracker'  },
      { id: 'moduleRoleClaimEnabled',    label: 'Self-Serve Roles',icon: 'R',  moduleKey: 'selfserveroles'},
      { id: 'moduleTicketingEnabled',    label: 'Ticketing',       icon: 'TK', moduleKey: 'ticketing'     },
      { id: 'moduleEngagementEnabled',   label: 'Engagement',      icon: 'E',  moduleKey: 'engagement'    },
    ];

    // Build module toggle helper (styled toggle switch)
    const moduleToggle = (id, label, icon, defaultVal) => {
      const checked = (s[id] ?? defaultVal) ? ' checked' : '';
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:var(--space-3) var(--space-4);background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;transition:border-color .2s;">
        <label for="ps_${id}" style="cursor:pointer;font-weight:500;font-size:0.9em;color:#e0e7ff;display:flex;align-items:center;gap:var(--space-2);">
          <span style="font-size:1.25em;">${icon}</span> ${label}
        </label>
        <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0;">
          <input type="checkbox" id="ps_${id}"${checked} style="opacity:0;width:0;height:0;"
            onchange="this.parentElement.querySelector('span').style.background=this.checked?'var(--gold)':'#555';">
          <span style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${(s[id] ?? defaultVal) ? 'var(--gold)' : '#555'};border-radius:24px;transition:.3s;"></span>
          <span style="position:absolute;content:'';height:18px;width:18px;left:${(s[id] ?? defaultVal) ? '22px' : '3px'};bottom:3px;background:#fff;border-radius:50%;transition:.3s;pointer-events:none;"
            class="ps-toggle-knob"></span>
        </label>
      </div>`;
    };

    // Render only assigned + enabled modules in tenant settings
    const visibleToggles = MODULE_TOGGLE_DEFS
      .filter(m => assignedKeys === null || assignedKeys.includes(m.moduleKey))
      .filter(m => s[m.id] !== false)
      .map(m => moduleToggle(m.id, m.label, m.icon, true))
      .join('');

    // Attach toggle animation via event delegation (after HTML injected)
    const attachToggleListeners = () => {
      content.querySelectorAll('input[type="checkbox"][id^="ps_module"]').forEach(cb => {
        cb.addEventListener('change', function() {
          const knob = this.parentElement.querySelector('.ps-toggle-knob');
          if (knob) knob.style.left = this.checked ? '22px' : '3px';
        });
      });
    };


    // Step 2: Inject HTML skeleton
    content.innerHTML = `
      <!-- ENV STATUS BAR -->
      <div id="adminEnvStatusBar" style="margin-bottom:var(--space-4);"></div>

      <!-- MODULE CONTROL — always visible -->
      <div style="${cardStyle}">
        <h3 style="${cardHeader}">🎮 Module Control</h3>
        ${visibleToggles ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--space-3);">${visibleToggles}</div>` : '<p style="color:var(--text-secondary);font-size:0.9em;">No modules assigned. Contact your Superadmin to enable modules for this server.</p>'}
      </div>

      <!-- Action Buttons — always visible -->
      <div style="display:flex;gap:var(--space-3);justify-content:flex-end;padding-top:var(--space-4);border-top:1px solid rgba(99,102,241,0.15);">
        <button class="btn-danger" onclick="resetPortalSettings()" style="font-size:0.85em;padding:8px 16px;">🔄 Reset to Defaults</button>
        <button class="btn-primary" onclick="savePortalSettings()" style="font-size:0.85em;padding:8px 16px;">💾 Save All Settings</button>
      </div>
    `;

    // Step 3: Attach toggle listeners now that DOM is ready
    attachToggleListeners();

    // In multi-tenant mode, module entitlements are managed by Superadmin only
    if (tenantReadOnlyModules) {
      const moduleControlCard = content.querySelector('h3')?.closest('div');
      const allModuleToggles = content.querySelectorAll('input[type="checkbox"][id^="ps_module"]');
      allModuleToggles.forEach(cb => {
        cb.disabled = true;
        cb.title = 'Managed by Superadmin plan';
      });
      if (moduleControlCard) {
        const note = document.createElement('div');
        note.style.cssText = 'margin-top:10px;padding:8px 10px;border-radius:8px;background:rgba(245,158,11,0.14);border:1px solid rgba(245,158,11,0.35);color:#fde68a;font-size:0.82em;';
        note.textContent = '🔒 Module toggles are managed in Superadmin → Tenant Management.';
        moduleControlCard.appendChild(note);
      }
    }


    // Module-specific settings are now in their own tabs
  } catch (e) {
    const isAuthErr = e.message === 'Not authenticated' || e.message?.includes('authenticated') || e.message?.includes('Select a server');
    content.innerHTML = isAuthErr
      ? `<div style="text-align:center;padding:var(--space-5);">
           <p style="color:#fca5a5;font-size:0.9em;margin-bottom:16px;">⚠️ Your session has expired. Please log out and log back in.</p>
           <button class="btn-primary" onclick="logout()" style="font-size:0.9em;padding:10px 24px;">Log Out & Re-Login</button>
         </div>`
      : `<div class="error-state"><div class="error-message">${escapeHtml(e.message)}</div></div>`;
  }
}

function showSettingsSuccess(message) {
  const content = document.getElementById('adminSettingsContent');
  if (!content) return;
  const existing = content.querySelector('.settings-success-msg');
  if (existing) existing.remove();
  const msg = document.createElement('div');
  msg.className = 'settings-success-msg';
  msg.style.cssText = 'padding:var(--space-3) var(--space-4);background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);border-radius:var(--radius-md);color:#86efac;font-weight:600;margin-bottom:var(--space-4);';
  msg.textContent = message;
  content.prepend(msg);
  setTimeout(() => msg.remove(), 5000);
}

async function savePortalSettings() {
  if (!portalSettingsData) return;

  // Only save module toggles that are actually rendered (handles assigned-module filtering)
  const moduleIds = [
    'moduleMinigamesEnabled', 'moduleBattleEnabled', 'moduleGovernanceEnabled', 'moduleVerificationEnabled', 'moduleBrandingEnabled',
    'moduleMissionsEnabled', 'moduleWalletTrackerEnabled', 'moduleTreasuryEnabled', 'moduleNftTrackerEnabled', 'moduleTokenTrackerEnabled',
    'moduleRoleClaimEnabled', 'moduleTicketingEnabled', 'moduleEngagementEnabled',
  ];
  const newSettings = {};
  for (const id of moduleIds) {
    const el = document.getElementById('ps_' + id);
    if (el) newSettings[id] = el.checked; // only include rendered toggles
  }

  try {
    const response = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(newSettings)
    });
    const data = await response.json();
    if (!data.success) {
      showError(data.message || 'Failed to save settings');
      return;
    }

    showSettingsSuccess('Module toggles saved!');
    await loadAdminSettingsView();
  } catch (error) {
    console.error('Error saving settings:', error);
    showError('Failed to save settings');
  }
}

async function resetPortalSettings() {
  if (!confirm('Reset all settings to defaults? This cannot be undone.')) return;

  try {
    const response = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ reset: true })
    });
    const data = await response.json();
    if (data.success) {
      showSettingsSuccess('Settings reset to defaults!');
      await loadAdminSettingsView();
    } else {
      showError(data.message || 'Failed to reset settings');
    }
  } catch (error) {
    console.error('Error resetting settings:', error);
    showError('Failed to reset settings');
  }
}

async function loadAdminAnalyticsView() {
  if (!isAdmin) return;
  const content = document.getElementById('adminAnalyticsContent');
  if (!content) return;
  content.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-secondary);">Loading analytics...</div>';

  try {
    const [usersRes, proposalsRes, missionsRes, treasuryRes, leaderboardRes, statsRes] = await Promise.all([
      fetch('/api/admin/users', { credentials: 'include' }),
      fetch('/api/admin/proposals', { credentials: 'include' }),
      fetch('/api/admin/missions', { credentials: 'include' }),
      fetch(buildPublicV1Url('/api/public/v1/treasury') || '/api/public/v1/treasury').catch(() => null),
      (buildPublicV1Url('/api/public/v1/leaderboard', { requireGuild: true })
        ? fetch(buildPublicV1Url('/api/public/v1/leaderboard', { requireGuild: true }))
        : Promise.resolve(null)
      ).catch(() => null),
      (buildPublicV1Url('/api/public/v1/stats', { requireGuild: true })
        ? fetch(buildPublicV1Url('/api/public/v1/stats', { requireGuild: true }))
        : Promise.resolve(null)
      ).catch(() => null)
    ]);

    const usersData = await usersRes.json();
    const proposalsData = await proposalsRes.json();
    const missionsData = missionsRes.ok ? await missionsRes.json() : {};
    const treasuryData = treasuryRes && treasuryRes.ok ? await treasuryRes.json() : null;
    const leaderboardData = leaderboardRes && leaderboardRes.ok ? await leaderboardRes.json() : null;
    const statsData = statsRes && statsRes.ok ? await statsRes.json() : null;

    const users = usersData.users || [];
    const proposals = proposalsData.proposals || [];
    const missions = missionsData.missions || [];
    const verified = users.filter(u => u.walletAddress || u.verified).length;
    const pending = users.length - verified;
    const activeVotes = proposals.filter(p => ['supporting','voting','active'].includes((p.status || '').toLowerCase())).length;
    const concluded = proposals.filter(p => ['passed','concluded','closed','rejected','failed'].includes((p.status || '').toLowerCase()));
    const passed = concluded.filter(p => ['passed','concluded'].includes((p.status || '').toLowerCase())).length;
    const passRate = concluded.length > 0 ? Math.round((passed / concluded.length) * 100) : 0;
    const completedMissions = missions.filter(m => (m.status || '').toLowerCase() === 'completed');
    const totalPoints = completedMissions.reduce((sum, m) => sum + (m.pointsAwarded || m.points || 0), 0);

    const statCard = (label, value, color) => `
      <div style="padding:16px; background:rgba(${color},0.12); border:1px solid rgba(${color},0.22); border-radius:10px;">
        <div style="color:var(--text-secondary); font-size:0.82em; margin-bottom:6px;">${label}</div>
        <div style="font-size:1.8em; font-weight:700; color:#e0e7ff;">${value}</div>
      </div>`;

    // Treasury balance
    let treasuryBalance = '—';
    if (treasuryData) {
      const treasurySnapshot = treasuryData.data || treasuryData.treasury || treasuryData;
      const bal = treasurySnapshot.balance ?? treasurySnapshot.sol ?? treasurySnapshot.total ?? treasurySnapshot.sol_balance;
      if (bal !== undefined && bal !== null) treasuryBalance = typeof bal === 'number' ? bal.toFixed(2) + ' SOL' : bal;
    }

    // Leaderboard top 5
    const leaderboardSnapshot = leaderboardData?.data || leaderboardData || {};
    const leaders = (leaderboardSnapshot?.leaderboard || leaderboardSnapshot?.entries || []).slice(0, 5);
    let leaderboardHTML = '';
    if (leaders.length > 0) {
      const rows = leaders.map((l, i) => {
        const name = escapeHtml(l.displayName || l.username || l.discordId || 'Unknown');
        const points = l.points ?? l.score ?? 0;
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
        return `<tr style="border-bottom:1px solid rgba(99,102,241,0.1);">
          <td style="padding:8px 10px;font-size:0.9em;">${medal}</td>
          <td style="padding:8px 10px;color:#c7d2fe;font-size:0.9em;">${name}</td>
          <td style="padding:8px 10px;text-align:right;color:#86efac;font-weight:600;font-size:0.9em;">${points}</td>
        </tr>`;
      }).join('');
      leaderboardHTML = `
        <div style="margin-top:20px;">
          <h4 style="margin-bottom:10px;color:#e0e7ff;">🏆 Top 5 Leaderboard</h4>
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="border-bottom:2px solid rgba(99,102,241,0.2);">
              <th style="padding:8px 10px;text-align:left;color:var(--text-secondary);font-size:0.8em;">Rank</th>
              <th style="padding:8px 10px;text-align:left;color:var(--text-secondary);font-size:0.8em;">User</th>
              <th style="padding:8px 10px;text-align:right;color:var(--text-secondary);font-size:0.8em;">Points</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    // Recent activity from proposals + missions (last 10 events)
    const events = [];
    proposals.forEach(p => {
      const ts = p.createdAt || p.timestamp;
      if (ts) events.push({ time: new Date(ts), text: `Proposal "${escapeHtml(p.title || p.name || 'Untitled')}" — ${p.status || 'unknown'}`, icon: '📜' });
    });
    missions.forEach(m => {
      const ts = m.completedAt || m.createdAt || m.timestamp;
      if (ts) events.push({ time: new Date(ts), text: `Mission "${escapeHtml(m.name || m.title || 'Untitled')}" — ${m.status || 'unknown'}`, icon: '🎯' });
    });
    events.sort((a, b) => b.time - a.time);
    const recentEvents = events.slice(0, 10);

    let activityHTML = '';
    if (recentEvents.length > 0) {
      const rows = recentEvents.map(e => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(99,102,241,0.08);">
          <span style="font-size:1.1em;">${e.icon}</span>
          <span style="flex:1;color:#c7d2fe;font-size:0.88em;">${e.text}</span>
          <span style="color:var(--text-secondary);font-size:0.78em;white-space:nowrap;">${e.time.toLocaleDateString()}</span>
        </div>`).join('');
      activityHTML = `
        <div style="margin-top:20px;">
          <h4 style="margin-bottom:10px;color:#e0e7ff;">📋 Recent Activity</h4>
          ${rows}
        </div>`;
    }

    content.innerHTML = `
      <div style="display:grid; gap:12px; grid-template-columns: repeat(auto-fit,minmax(180px,1fr)); margin-bottom:8px;">
        ${statCard('Total Users', users.length, '99,102,241')}
        ${statCard('Verified', verified, '16,185,129')}
        ${statCard('Pending', pending, '245,158,11')}
        ${statCard('Total Proposals', proposals.length, '59,130,246')}
        ${statCard('Pass Rate', passRate + '%', '139,92,246')}
        ${statCard('Active Votes', activeVotes, '236,72,153')}
        ${statCard('Missions Done', completedMissions.length, '20,184,166')}
        ${statCard('Points Awarded', totalPoints.toLocaleString(), '251,146,60')}
        ${statCard('Treasury', treasuryBalance, '234,179,8')}
      </div>
      ${leaderboardHTML}
      ${activityHTML}
    `;
  } catch (e) {
    content.innerHTML = `<div class="error-state"><div class="error-message">Failed to load analytics: ${escapeHtml(e.message)}</div></div>`;
  }
}

let adminTiersCache = [];
let adminTraitsCache = [];
let adminTokenRulesCache = [];
let discordRolesCache = null;

async function fetchDiscordRoles() {
  if (discordRolesCache) return discordRolesCache;
  try {
    const res = await fetch('/api/admin/discord/roles', { credentials: 'include', headers: buildTenantRequestHeaders() });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        discordRolesCache = data.roles || [];
        return discordRolesCache;
      }
    }
  } catch (e) {
    console.error('Failed to fetch Discord roles:', e);
  }
  return [];
}

function roleSelectHTML(id, selectedValue, required = false) {
  return `<select id="${id}" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;">
    <option value="">-- Select Role --</option>
  </select>`;
}

async function populateRoleSelect(selectId, selectedValue) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const roles = await fetchDiscordRoles();
  sel.innerHTML = '<option value="">-- Select Role --</option>';
  roles.forEach(role => {
    const opt = document.createElement('option');
    opt.value = role.id;
    const colorDot = role.color && role.color !== '#000000' ? `\u25CF ` : '';
    opt.textContent = colorDot + role.name;
    if (role.color && role.color !== '#000000') {
      opt.style.color = role.color;
    }
    if (selectedValue && selectedValue === role.id) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ==================== NFT TRACKER TAB ====================
async function loadNftTrackerView() {
  if (!isAdmin) return;
  const content = document.getElementById('adminNftTrackerContent');
  if (!content) return;

  const cardStyle = 'background:var(--card-bg);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:var(--space-5);margin-bottom:var(--space-4);';
  const gridRow = 'display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);';
  const fieldLabel = 'display:block;font-weight:600;font-size:0.85em;color:#c9d6ff;margin-bottom:6px;';
  const fieldInput = 'width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;';
  const selectStyle = fieldInput;

  content.innerHTML = `
    <div style="${cardStyle}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);">
        <h3 style="color:#c9d6ff;font-size:var(--font-lg);font-weight:700;margin:0;">🎨 Tracked Collections</h3>
        <button class="btn-primary" onclick="openAddCollectionModal()" style="font-size:0.85em;padding:8px 16px;">+ Add Collection</button>
      </div>
      <div id="nftCollectionsTableWrap"></div>
    </div>
  `;

  await renderNftCollectionsCard('nftCollectionsTableWrap');
}

async function openAddCollectionModal(existingId, existingData) {
  const isEdit = !!existingId;
  document.getElementById('colEditId').value = existingId || '';
  document.getElementById('colName').value = (existingData && existingData.name) || '';
  const addrEl = document.getElementById('colAddress');
  addrEl.value = (existingData && existingData.address) || '';
  addrEl.disabled = isEdit;
  document.getElementById('colMeSymbol').value = (existingData && existingData.meSymbol) || '';
  document.getElementById('colMint').checked    = existingData ? !!existingData.trackMint     : true;
  document.getElementById('colSale').checked    = existingData ? !!existingData.trackSale     : true;
  document.getElementById('colBid').checked     = existingData ? !!existingData.trackBid      : true;
  document.getElementById('colList').checked    = existingData ? !!existingData.trackList     : false;
  document.getElementById('colDelist').checked  = existingData ? !!existingData.trackDelist   : false;
  document.getElementById('colTransfer').checked= existingData ? !!existingData.trackTransfer : false;
  document.getElementById('colError').style.display = 'none';
  const modal = document.getElementById('addCollectionModal');
  modal.querySelector('.modal-title').textContent = isEdit ? 'Edit Collection' : 'Add Tracked Collection';
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Populate channel dropdown
  const chSel = document.getElementById('colChannel');
  chSel.innerHTML = '<option value="">-- Select alert channel --</option>';
  try {
    const chRes = await fetch('/api/admin/discord/channels', { credentials: 'include', headers: buildTenantRequestHeaders() });
    if (chRes.ok) {
      const chData = await chRes.json();
      const channels = chData.channels || [];
      const grouped = {};
      channels.forEach(ch => {
        const parent = ch.parentName || 'Other';
        if (!grouped[parent]) grouped[parent] = [];
        grouped[parent].push(ch);
      });
      Object.keys(grouped).sort().forEach(parent => {
        const og = document.createElement('optgroup');
        og.label = parent;
        grouped[parent].forEach(ch => {
          const opt = document.createElement('option');
          opt.value = ch.id;
          opt.textContent = '# ' + ch.name;
          og.appendChild(opt);
        });
        chSel.appendChild(og);
      });
      if (existingData && existingData.channelId) chSel.value = existingData.channelId;
    }
  } catch (e) { console.error('[CollectionModal] Channel load error:', e); }
}

function closeAddCollectionModal() {
  document.getElementById('addCollectionModal').style.display = 'none';
  document.getElementById('colAddress').disabled = false;
  document.body.style.overflow = '';
}

async function saveCollection() {
  const editId = document.getElementById('colEditId').value;
  const name = document.getElementById('colName').value.trim();
  const address = document.getElementById('colAddress').value.trim();
  const channelId = document.getElementById('colChannel').value;
  const errEl = document.getElementById('colError');

  if (!name || (!editId && !address) || !channelId) {
    errEl.textContent = 'Collection name, address, and alert channel are required.';
    errEl.style.display = 'block';
    return;
  }

  const saveBtn = document.getElementById('colSaveBtn');
  saveBtn.textContent = 'Saving...';
  saveBtn.disabled = true;

  const payload = {
    collectionName: name,
    collectionAddress: address,
    channelId,
    meSymbol: document.getElementById('colMeSymbol').value.trim(),
    trackMint:     document.getElementById('colMint').checked,
    trackSale:     document.getElementById('colSale').checked,
    trackBid:      document.getElementById('colBid').checked,
    trackList:     document.getElementById('colList').checked,
    trackDelist:   document.getElementById('colDelist').checked,
    trackTransfer: document.getElementById('colTransfer').checked,
  };

  try {
    const url = editId
      ? '/api/admin/nft-tracker/collections/' + editId
      : '/api/admin/nft-tracker/collections';
    const res = await fetch(url, {
      method: editId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.success !== false) {
      closeAddCollectionModal();
      showSuccess(editId ? 'Collection updated!' : 'Collection added!');
      // Refresh whichever containers are present
      renderNftCollectionsCard('nftCollectionsTableWrap');
      renderNftCollectionsCard('nts_collectionsWrap');
    } else {
      errEl.textContent = data.message || 'Failed to save collection.';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = 'Network error saving collection.';
    errEl.style.display = 'block';
  } finally {
    saveBtn.textContent = 'Save Collection';
    saveBtn.disabled = false;
  }
}

// Shared render function — used by both main NFT tracker view and settings tab
async function renderNftCollectionsCard(wrapId) {
  const wrap = document.getElementById(wrapId || 'nftCollectionsTableWrap');
  if (!wrap) return;
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), 10000));
    const res = await Promise.race([
      fetch('/api/admin/nft-tracker/collections', { credentials: 'include', headers: buildTenantRequestHeaders() }),
      timeout
    ]);
    const data = await res.json();
    const collections = data.collections || [];

    const truncAddr = (a) => a && a.length > 12 ? a.slice(0, 6) + '...' + a.slice(-4) : (a || '—');
    const eventIcons = (c) => [
      c.track_mint && '🪙', c.track_sale && '💰', c.track_bid && '🤝',
      c.track_list && '📋', c.track_delist && '❌', c.track_transfer && '🔄',
    ].filter(Boolean).join(' ') || '—';

    if (!collections.length) {
      wrap.innerHTML = `<div style="text-align:center;padding:var(--space-5);color:var(--text-secondary);">
        <p style="margin-bottom:16px;">No tracked collections yet.</p>
        <button class="btn-primary" onclick="openAddCollectionModal()">+ Add Collection</button>
      </div>`;
      return;
    }

    const rows = collections.map(c => `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
        <td style="padding:10px 12px;color:var(--text-primary);font-size:0.9em;">${escapeHtml(c.collection_name)}</td>
        <td style="padding:10px 12px;color:var(--text-secondary);font-family:monospace;font-size:0.85em;" title="${escapeHtml(c.collection_address)}">${truncAddr(c.collection_address)}</td>
        <td style="padding:10px 12px;font-size:0.85em;">${eventIcons(c)}</td>
        <td style="padding:10px 12px;font-size:0.85em;color:${c.enabled ? '#86efac' : '#fca5a5'};">${c.enabled ? 'Yes' : 'No'}</td>
        <td style="padding:10px 12px;">
          <div style="display:flex;gap:6px;">
            <button class="nc-edit-btn"
              data-id="${c.id}"
              data-name="${escapeHtml(c.collection_name)}"
              data-addr="${escapeHtml(c.collection_address)}"
              data-channelid="${c.channel_id||''}"
              data-mesymbol="${escapeHtml(c.me_symbol||'')}"
              data-mint="${!!c.track_mint}"
              data-sale="${!!c.track_sale}"
              data-bid="${!!c.track_bid}"
              data-list="${!!c.track_list}"
              data-delist="${!!c.track_delist}"
              data-transfer="${!!c.track_transfer}"
              style="font-size:0.8em;padding:4px 10px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;">✏️ Edit</button>
            <button class="nc-remove-btn" data-id="${c.id}"
              style="font-size:0.8em;padding:4px 8px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
          </div>
        </td>
      </tr>`).join('');

    wrap.innerHTML = `<div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="border-bottom:2px solid rgba(255,255,255,0.1);">
          <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Name</th>
          <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Address</th>
          <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Events</th>
          <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">On</th>
          <th style="padding:8px 12px;"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
    // Event delegation — avoids inline onclick + escapeHtml quote issues
    wrap.querySelectorAll('.nc-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        openAddCollectionModal(btn.dataset.id, {
          name:          btn.dataset.name,
          address:       btn.dataset.addr,
          channelId:     btn.dataset.channelid,
          meSymbol:      btn.dataset.mesymbol,
          trackMint:     btn.dataset.mint === 'true',
          trackSale:     btn.dataset.sale === 'true',
          trackBid:      btn.dataset.bid  === 'true',
          trackList:     btn.dataset.list === 'true',
          trackDelist:   btn.dataset.delist === 'true',
          trackTransfer: btn.dataset.transfer === 'true',
        });
      });
    });
    wrap.querySelectorAll('.nc-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => removeNftCollection(btn.dataset.id));
    });
  } catch (e) {
    wrap.innerHTML = '<p style="color:#fca5a5;font-size:0.9em;padding:12px;">Failed to load tracked collections.</p>';
  }
}

async function removeNftCollection(id) {
  if (!confirm('Remove this tracked collection?')) return;
  try {
    await fetch('/api/admin/nft-tracker/collections/' + id, { method: 'DELETE', credentials: 'include', headers: buildTenantRequestHeaders() });
    renderNftCollectionsCard();
    renderNftCollectionsCard('nts_collectionsWrap');
  } catch (e) { showError('Error removing collection'); }
}

let nftTrackedTokensCache = [];

async function openAddTokenModal(existingId, existingData) {
  const isEdit = !!existingId;
  const modal = document.getElementById('addTokenModal');
  if (!modal) return;
  const selectedAlertChannelIds = Array.isArray(existingData?.alertChannelIds)
    ? existingData.alertChannelIds.map(id => String(id || '').trim()).filter(Boolean)
    : (existingData?.alertChannelId ? [String(existingData.alertChannelId).trim()] : []);

  document.getElementById('addTokenModalTitle').textContent = isEdit ? 'Edit Tracked Token' : 'Add Tracked Token';
  document.getElementById('tokenEditId').value = existingId || '';
  document.getElementById('tokenMint').value = (existingData && existingData.tokenMint) || '';
  document.getElementById('tokenSymbol').value = (existingData && existingData.tokenSymbol) || '';
  document.getElementById('tokenName').value = (existingData && existingData.tokenName) || '';
  document.getElementById('tokenMinAlertAmount').value = existingData ? String(Number(existingData.minAlertAmount || 0)) : '0';
  document.getElementById('tokenAlertBuys').checked = existingData ? !!existingData.alertBuys : true;
  document.getElementById('tokenAlertSells').checked = existingData ? !!existingData.alertSells : true;
  document.getElementById('tokenAlertTransfers').checked = existingData ? !!existingData.alertTransfers : false;
  document.getElementById('tokenEnabled').checked = existingData ? !!existingData.enabled : true;

  const errEl = document.getElementById('tokenError');
  errEl.style.display = 'none';

  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const channelSel = document.getElementById('tokenAlertChannels');
  if (!channelSel) return;
  channelSel.innerHTML = '';
  try {
    const chRes = await fetch('/api/admin/discord/channels', { credentials: 'include', headers: buildTenantRequestHeaders() });
    if (chRes.ok) {
      const chData = await chRes.json();
      const channels = chData.channels || [];
      if (!channels.length) {
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '-- No channels available --';
        emptyOpt.disabled = true;
        channelSel.appendChild(emptyOpt);
      } else {
        const grouped = {};
        channels.forEach(ch => {
          const parent = ch.parentName || 'Other';
          if (!grouped[parent]) grouped[parent] = [];
          grouped[parent].push(ch);
        });
        Object.keys(grouped).sort().forEach(parent => {
          const og = document.createElement('optgroup');
          og.label = parent;
          grouped[parent].forEach(ch => {
            const opt = document.createElement('option');
            opt.value = ch.id;
            opt.textContent = '# ' + ch.name;
            if (selectedAlertChannelIds.includes(String(ch.id))) opt.selected = true;
            og.appendChild(opt);
          });
          channelSel.appendChild(og);
        });
      }
    }
  } catch (e) {
    console.error('[TokenModal] Channel load error:', e);
    channelSel.innerHTML = '<option value="" disabled>-- Failed to load channels --</option>';
  } finally {
    initializePortalMultiSelects(modal);
  }
}

function closeAddTokenModal() {
  closePortalMultiSelectPicker(false);
  const modal = document.getElementById('addTokenModal');
  if (!modal) return;
  modal.style.display = 'none';
  document.body.style.overflow = '';
}

async function saveToken() {
  const editId = document.getElementById('tokenEditId').value;
  const tokenMint = document.getElementById('tokenMint').value.trim();
  const tokenSymbol = document.getElementById('tokenSymbol').value.trim();
  const tokenName = document.getElementById('tokenName').value.trim();
  const alertChannelIds = Array.from(document.getElementById('tokenAlertChannels')?.selectedOptions || [])
    .map(opt => String(opt.value || '').trim())
    .filter(Boolean);
  const minAlertAmount = Number(document.getElementById('tokenMinAlertAmount').value || '0');
  const alertBuys = document.getElementById('tokenAlertBuys').checked;
  const alertSells = document.getElementById('tokenAlertSells').checked;
  const alertTransfers = document.getElementById('tokenAlertTransfers').checked;
  const enabled = document.getElementById('tokenEnabled').checked;
  const errEl = document.getElementById('tokenError');

  if (!tokenMint) {
    errEl.textContent = 'Token mint is required.';
    errEl.style.display = 'block';
    return;
  }
  if (!Number.isFinite(minAlertAmount) || minAlertAmount < 0) {
    errEl.textContent = 'Min alert amount must be a valid non-negative number.';
    errEl.style.display = 'block';
    return;
  }

  const payload = {
    tokenMint,
    tokenSymbol: tokenSymbol || null,
    tokenName: tokenName || null,
    alertChannelIds,
    alertChannelId: alertChannelIds[0] || null,
    minAlertAmount,
    alertBuys,
    alertSells,
    alertTransfers,
    enabled,
  };

  const saveBtn = document.getElementById('tokenSaveBtn');
  saveBtn.textContent = 'Saving...';
  saveBtn.disabled = true;

  try {
    const endpoint = editId ? `/api/admin/token-tracker/tokens/${encodeURIComponent(editId)}` : '/api/admin/token-tracker/tokens';
    const method = editId ? 'PUT' : 'POST';
    const response = await fetch(endpoint, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || data.success === false) {
      errEl.textContent = data.message || 'Failed to save tracked token.';
      errEl.style.display = 'block';
      return;
    }
    closeAddTokenModal();
    showSuccess(editId ? 'Tracked token updated.' : 'Tracked token added.');
    await renderNftTrackedTokensCard('tts_tokensWrap');
    await renderNftTrackedTokensCard('nts_tokensWrap');
    await renderNftTokenEventsCard('tts_tokenEventsWrap');
    await renderNftTokenEventsCard('nts_tokenEventsWrap');
  } catch (_error) {
    errEl.textContent = 'Network error saving tracked token.';
    errEl.style.display = 'block';
  } finally {
    saveBtn.textContent = 'Save Token';
    saveBtn.disabled = false;
  }
}

async function removeNftTrackedToken(id) {
  if (!confirm('Remove this tracked token?')) return;
  try {
    const response = await fetch(`/api/admin/token-tracker/tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: buildTenantRequestHeaders()
    });
    const data = await response.json();
    if (!response.ok || data.success === false) return showError(data.message || 'Failed to remove tracked token.');
    showSuccess('Tracked token removed.');
    await renderNftTrackedTokensCard('tts_tokensWrap');
    await renderNftTrackedTokensCard('nts_tokensWrap');
    await renderNftTokenEventsCard('tts_tokenEventsWrap');
    await renderNftTokenEventsCard('nts_tokenEventsWrap');
  } catch (_error) {
    showError('Failed to remove tracked token.');
  }
}

async function renderNftTrackedTokensCard(wrapId = 'nts_tokensWrap') {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;

  try {
    const response = await fetch('/api/admin/token-tracker/tokens', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const data = await response.json();
    if (!response.ok || data.success === false) throw new Error(data.message || 'Failed to load tracked tokens');

    const tokens = Array.isArray(data.tokens) ? data.tokens : [];
    nftTrackedTokensCache = tokens;

    if (!tokens.length) {
      wrap.innerHTML = `<div style="text-align:center;padding:var(--space-5);color:var(--text-secondary);">
        <p style="margin-bottom:16px;">No tracked tokens yet.</p>
        <button class="btn-primary" onclick="openAddTokenModal()">+ Add Token</button>
      </div>`;
      return;
    }

    const rows = tokens.map(token => {
      const mint = String(token.token_mint || '');
      const mintShort = mint ? `${mint.slice(0, 6)}...${mint.slice(-4)}` : '—';
      const statusColor = token.enabled !== false ? '#86efac' : '#fca5a5';
      const statusText = token.enabled !== false ? 'On' : 'Off';
      const tokenAlertChannelIds = Array.isArray(token.alert_channel_ids)
        ? token.alert_channel_ids
        : (token.alert_channel_id ? [token.alert_channel_id] : []);
      const channelDisplay = tokenAlertChannelIds.length
        ? tokenAlertChannelIds.map(id => `<code>#${escapeHtml(id)}</code>`).join(' ')
        : '<span style="color:var(--text-secondary);">Wallet default</span>';
      return `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
          <td style="padding:8px 10px;color:#cbd5e1;font-family:monospace;font-size:0.82em;" title="${escapeHtml(mint)}">${escapeHtml(mintShort)}</td>
          <td style="padding:8px 10px;color:#e2e8f0;">${escapeHtml(token.token_symbol || '—')}</td>
          <td style="padding:8px 10px;color:#cbd5e1;">${escapeHtml(token.token_name || '—')}</td>
          <td style="padding:8px 10px;color:#cbd5e1;">${channelDisplay}</td>
          <td style="padding:8px 10px;color:#cbd5e1;">B:${token.alert_buys ? 'on' : 'off'} S:${token.alert_sells ? 'on' : 'off'} T:${token.alert_transfers ? 'on' : 'off'} Min:${Number(token.min_alert_amount || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
          <td style="padding:8px 10px;color:${statusColor};">${statusText}</td>
          <td style="padding:8px 10px;text-align:right;white-space:nowrap;">
            <button class="nt-edit-btn"
              data-id="${token.id}"
              data-mint="${escapeHtml(token.token_mint || '')}"
              data-symbol="${escapeHtml(token.token_symbol || '')}"
              data-name="${escapeHtml(token.token_name || '')}"
              data-alert-channel="${escapeHtml(token.alert_channel_id || '')}"
              data-alert-channels='${escapeHtml(JSON.stringify(tokenAlertChannelIds))}'
              data-alert-buys="${token.alert_buys ? 'true' : 'false'}"
              data-alert-sells="${token.alert_sells ? 'true' : 'false'}"
              data-alert-transfers="${token.alert_transfers ? 'true' : 'false'}"
              data-min-alert="${Number(token.min_alert_amount || 0)}"
              data-enabled="${token.enabled !== false ? 'true' : 'false'}"
              style="width:30px;height:30px;background:rgba(99,102,241,0.2);border:1px solid rgba(99,102,241,0.35);border-radius:6px;cursor:pointer;color:#818cf8;font-size:0.85em;">✏️</button>
            <button class="nt-remove-btn" data-id="${token.id}" style="width:30px;height:30px;background:rgba(239,68,68,0.2);border:1px solid rgba(239,68,68,0.35);border-radius:6px;cursor:pointer;color:#fca5a5;font-size:0.85em;margin-left:4px;">🗑️</button>
          </td>
        </tr>
      `;
    }).join('');

    wrap.innerHTML = `
      <div style="overflow-x:auto;border:1px solid rgba(99,102,241,0.18);border-radius:10px;background:rgba(14,23,44,0.35);">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="background:rgba(30,41,59,0.7);">
            <th style="text-align:left;padding:8px 10px;font-size:0.78em;color:var(--text-secondary);text-transform:uppercase;">Mint</th>
            <th style="text-align:left;padding:8px 10px;font-size:0.78em;color:var(--text-secondary);text-transform:uppercase;">Symbol</th>
            <th style="text-align:left;padding:8px 10px;font-size:0.78em;color:var(--text-secondary);text-transform:uppercase;">Name</th>
            <th style="text-align:left;padding:8px 10px;font-size:0.78em;color:var(--text-secondary);text-transform:uppercase;">Alert Channels</th>
            <th style="text-align:left;padding:8px 10px;font-size:0.78em;color:var(--text-secondary);text-transform:uppercase;">Alert Rules</th>
            <th style="text-align:left;padding:8px 10px;font-size:0.78em;color:var(--text-secondary);text-transform:uppercase;">Enabled</th>
            <th style="padding:8px 10px;"></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    wrap.querySelectorAll('.nt-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        let alertChannelIds = [];
        try {
          const parsed = JSON.parse(btn.dataset.alertChannels || '[]');
          alertChannelIds = Array.isArray(parsed) ? parsed : [];
        } catch (_error) {
          alertChannelIds = btn.dataset.alertChannel ? [btn.dataset.alertChannel] : [];
        }
        openAddTokenModal(btn.dataset.id, {
          tokenMint: btn.dataset.mint || '',
          tokenSymbol: btn.dataset.symbol || '',
          tokenName: btn.dataset.name || '',
          alertChannelId: btn.dataset.alertChannel || '',
          alertChannelIds,
          alertBuys: btn.dataset.alertBuys === 'true',
          alertSells: btn.dataset.alertSells === 'true',
          alertTransfers: btn.dataset.alertTransfers === 'true',
          minAlertAmount: Number(btn.dataset.minAlert || 0),
          enabled: btn.dataset.enabled === 'true',
        });
      });
    });
    wrap.querySelectorAll('.nt-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => removeNftTrackedToken(btn.dataset.id));
    });
  } catch (e) {
    wrap.innerHTML = '<p style="color:#fca5a5;font-size:0.85em;padding:10px;">Failed to load tracked tokens.</p>';
  }
}

async function renderNftTokenEventsCard(wrapId = 'nts_tokenEventsWrap') {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  try {
    const response = await fetch('/api/admin/token-tracker/token-events?limit=20', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const data = await response.json();
    if (!response.ok || data.success === false) throw new Error(data.message || 'Failed to load token events');
    const events = Array.isArray(data.events) ? data.events : [];
    if (!events.length) {
      wrap.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85em;padding:8px 0;">No token activity events yet.</p>';
      return;
    }

    const iconByType = {
      buy: '🟢',
      sell: '🔴',
      transfer_in: '📥',
      transfer_out: '📤',
      swap_in: '🟣',
      swap_out: '🟠',
    };

    const rows = events.map(evt => {
      const type = String(evt.event_type || 'activity').toLowerCase();
      const icon = iconByType[type] || '🧩';
      const tokenName = evt.token_symbol || evt.token_name || (evt.token_mint ? `${String(evt.token_mint).slice(0, 4)}...${String(evt.token_mint).slice(-4)}` : 'Token');
      const amount = Number(evt.amount_delta || 0).toLocaleString(undefined, { maximumFractionDigits: 6 });
      const wallet = String(evt.wallet_address || '');
      const walletShort = wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : '—';
      const when = evt.event_time ? new Date(evt.event_time).toLocaleString() : 'Unknown';
      const tx = String(evt.tx_signature || '');
      return `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
          <td style="padding:8px 10px;color:#cbd5e1;">${icon} ${escapeHtml(type.toUpperCase())}</td>
          <td style="padding:8px 10px;color:#e2e8f0;">${escapeHtml(tokenName)}</td>
          <td style="padding:8px 10px;color:#cbd5e1;">${amount}</td>
          <td style="padding:8px 10px;color:#cbd5e1;font-family:monospace;">${escapeHtml(walletShort)}</td>
          <td style="padding:8px 10px;color:#94a3b8;">${escapeHtml(when)}</td>
          <td style="padding:8px 10px;text-align:right;">
            ${tx ? `<a href="https://solscan.io/tx/${encodeURIComponent(tx)}" target="_blank" rel="noopener" style="color:#93c5fd;font-size:0.82em;">View Tx</a>` : '—'}
          </td>
        </tr>
      `;
    }).join('');

    wrap.innerHTML = `
      <div style="overflow-x:auto;border:1px solid rgba(99,102,241,0.18);border-radius:10px;background:rgba(14,23,44,0.35);">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="background:rgba(30,41,59,0.7);">
            <th style="text-align:left;padding:8px 10px;font-size:0.78em;color:var(--text-secondary);text-transform:uppercase;">Type</th>
            <th style="text-align:left;padding:8px 10px;font-size:0.78em;color:var(--text-secondary);text-transform:uppercase;">Token</th>
            <th style="text-align:left;padding:8px 10px;font-size:0.78em;color:var(--text-secondary);text-transform:uppercase;">Delta</th>
            <th style="text-align:left;padding:8px 10px;font-size:0.78em;color:var(--text-secondary);text-transform:uppercase;">Wallet</th>
            <th style="text-align:left;padding:8px 10px;font-size:0.78em;color:var(--text-secondary);text-transform:uppercase;">When</th>
            <th style="padding:8px 10px;"></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } catch (e) {
    wrap.innerHTML = '<p style="color:#fca5a5;font-size:0.85em;padding:10px;">Failed to load token activity feed.</p>';
  }
}

// ==================== SHARED CHANNEL SELECT HELPER ====================

function populateChannelSelects(selectIds, channels, settings, settingKeys) {
  const grouped = {};
  channels.forEach(ch => {
    const parent = ch.parentName || 'Other';
    if (!grouped[parent]) grouped[parent] = [];
    grouped[parent].push(ch);
  });
  selectIds.forEach((selId, i) => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    sel.innerHTML = '<option value="">— None —</option>';
    Object.keys(grouped).sort().forEach(parent => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = parent;
      grouped[parent].forEach(ch => {
        const opt = document.createElement('option');
        opt.value = ch.id;
        opt.textContent = '# ' + ch.name;
        optgroup.appendChild(opt);
      });
      sel.appendChild(optgroup);
    });
    const key = settingKeys ? settingKeys[i] : null;
    if (key && settings[key]) sel.value = settings[key];
  });
}

async function populateChannelSelect(selectId, selectedValue) {
  const sel = document.getElementById(selectId);
  if (!sel) return;

  sel.innerHTML = '<option value="">Loading channels...</option>';

  try {
    const chRes = await fetch('/api/admin/discord/channels', {
      credentials: 'include',
      headers: buildTenantRequestHeaders()
    });
    if (!chRes.ok) {
      throw new Error('Failed to fetch channels');
    }

    const chJson = await chRes.json();
    const channels = chJson.success ? (chJson.channels || []) : [];
    populateChannelSelects([selectId], channels, { selectedValue: selectedValue || '' }, ['selectedValue']);

    if (!channels.length) {
      sel.innerHTML = '<option value="">-- No channels available --</option>';
    }
  } catch (error) {
    console.error('[Channels] Failed to load channel select:', error);
    sel.innerHTML = '<option value="">-- Failed to load channels --</option>';
  }
}

// ==================== GOVERNANCE SETTINGS ====================

async function saveGovernanceSettings() {
  const payload = {
    quorumPercentage: parseFloat(document.getElementById('gov_quorumPercentage')?.value) || 0,
    supportThreshold: parseInt(document.getElementById('gov_supportThreshold')?.value) || 0,
    voteDurationDays: parseInt(document.getElementById('gov_voteDurationDays')?.value) || 0,
    proposalsChannelId: document.getElementById('gov_proposalsChannelId')?.value || '',
    votingChannelId: document.getElementById('gov_votingChannelId')?.value || '',
    resultsChannelId: document.getElementById('gov_resultsChannelId')?.value || '',
    governanceLogChannelId: document.getElementById('gov_governanceLogChannelId')?.value || '',
  };
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) showSuccess('Governance settings saved!');
    else showError(data.message || 'Failed to save governance settings');
  } catch (e) {
    console.error('[Governance] Save error:', e);
    showError('Failed to save governance settings');
  }
}

// ==================== VERIFICATION SETTINGS ====================

async function loadVerificationSettings() {
  const container = document.getElementById('verificationSettingsCard');
  if (!container) return;

  const cardStyle = 'background:rgba(14,23,44,0.5);border:1px solid rgba(99,102,241,0.22);border-radius:10px;padding:var(--space-5);margin-bottom:var(--space-5);';
  const cardHeader = 'color:#c9d6ff;font-size:var(--font-lg);font-weight:700;margin:0 0 var(--space-4) 0;padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);';
  const gridRow = 'display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);';
  const fieldLabel = 'display:block;color:#c9d6ff;font-size:0.9em;font-weight:600;margin-bottom:6px;';
  const fieldInput = 'width:100%;padding:10px 12px;border:1px solid rgba(99,102,241,0.22);border-radius:8px;background:rgba(30,41,59,0.8);color:#e0e7ff;font-size:0.9em;';

  try {
    const [settingsRes, panelRes] = await Promise.all([
      fetch('/api/admin/settings', { credentials: 'include', headers: buildTenantRequestHeaders() }),
      fetch('/api/admin/verification/panel', { credentials: 'include', headers: buildTenantRequestHeaders() })
    ]);

    let settingsJson = {};
    try {
      settingsJson = await settingsRes.json();
    } catch (_error) {
      settingsJson = {};
    }

    let panelJson = {};
    try {
      panelJson = await panelRes.json();
    } catch (_error) {
      panelJson = {};
    }

    if (!settingsRes.ok || !settingsJson.success) {
      throw new Error(settingsJson.message || 'Failed to load server settings');
    }

    const vs = settingsJson.success ? settingsJson.settings : {};
    const panel = panelJson.success ? (panelJson.panel || {}) : {};

    container.innerHTML = `
      <div style="${cardStyle}">
        <h3 style="${cardHeader}">Verification Settings</h3>
        <div>
          <label style="${fieldLabel}">Base Verified Role</label>
          <p style="color:var(--text-secondary);font-size:0.8em;margin:0 0 8px 0;">Assigned to all verified members regardless of NFT holdings</p>
          ${roleSelectHTML('ver_baseVerifiedRoleId', vs.baseVerifiedRoleId || '')}
        </div>
        <div style="${gridRow}margin-top:var(--space-4);">
          <div>
            <label style="${fieldLabel}">OG Role</label>
            ${roleSelectHTML('ver_ogRoleId', vs.ogRoleId || '')}
          </div>
          <div>
            <label style="${fieldLabel}">OG Role Limit (First N verifiers)</label>
            <input type="number" id="ver_ogRoleLimit" min="0" value="${vs.ogRoleLimit ?? ''}" style="${fieldInput}">
          </div>
        </div>
        <div style="margin-top:var(--space-4);padding-top:var(--space-3);border-top:1px solid rgba(99,102,241,0.12);">
          <label style="display:flex;align-items:center;gap:8px;color:#c9d6ff;font-size:0.9em;font-weight:600;cursor:pointer;">
            <input type="checkbox" id="ver_autoResyncEnabled"${(vs.moduleRoleResyncEnabled ?? true) ? ' checked' : ''}> Auto Role Resync
            <span style="font-size:0.8em;color:var(--text-secondary);">(periodically re-syncs holder roles)</span>
          </label>
        </div>

        <div style="display:flex;gap:var(--space-3);justify-content:flex-end;padding-top:var(--space-4);border-top:1px solid rgba(99,102,241,0.15);margin-top:var(--space-4);">
          <button class="btn-secondary" id="verOgSyncBtn" onclick="runOgSync()" style="font-size:0.85em;padding:8px 16px;">Run OG Sync</button>
          <button class="btn-primary" onclick="saveVerificationSettings()" style="font-size:0.85em;padding:8px 16px;">Save Verification Settings</button>
        </div>
      </div>

      <div style="${cardStyle}">
        <h3 style="${cardHeader}">Verification Panel</h3>
        <p style="color:var(--text-secondary);font-size:0.85em;margin:0 0 12px 0;">Post and update the Verify panel directly from the portal.</p>
        <div style="${gridRow}">
          <div>
            <label style="${fieldLabel}">Channel</label>
            <select id="ver_panelChannelId" style="${fieldInput}">
              <option value="">-- Select channel --</option>
            </select>
          </div>
          <div>
            <label style="${fieldLabel}">Embed Color</label>
            <input type="text" id="ver_panelColor" value="${escapeHtml(panel.color || '#FFD700')}" style="${fieldInput}" placeholder="#FFD700">
          </div>
        </div>
        <div style="margin-top:var(--space-4);">
          <label style="${fieldLabel}">Panel Title</label>
          <input type="text" id="ver_panelTitle" value="${escapeHtml(panel.title || '🔗 Verify your wallet!')}" style="${fieldInput}" placeholder="🔗 Verify your wallet!">
        </div>
        <div style="margin-top:var(--space-4);">
          <label style="${fieldLabel}">Panel Description</label>
          <textarea id="ver_panelDescription" style="${fieldInput};min-height:86px;resize:vertical;" placeholder="Panel description">${escapeHtml(panel.description || 'To get access to community roles, verify your wallet by clicking the button below.')}</textarea>
        </div>
        <div style="margin-top:12px;color:var(--text-secondary);font-size:0.82em;">
          Footer uses branding: <strong style="color:#c9d6ff;">Powered by Guild Pilot</strong> (or your custom branding footer text).
        </div>
        <div id="ver_panelStatus" style="margin-top:8px;color:#94a3b8;font-size:0.82em;">
          ${panel.messageId
            ? `Current panel message: <code>${escapeHtml(panel.messageId)}</code> in <code>${escapeHtml(panel.channelId || '')}</code>`
            : 'No verification panel posted yet.'}
        </div>
        <div style="display:flex;gap:var(--space-3);justify-content:flex-end;padding-top:var(--space-4);border-top:1px solid rgba(99,102,241,0.15);margin-top:var(--space-4);">
          <button class="btn-primary" id="verPanelPostBtn" onclick="postVerificationPanelFromSettings()" style="font-size:0.85em;padding:8px 16px;">Post / Update Panel</button>
        </div>
      </div>
    `;

    populateRoleSelect('ver_baseVerifiedRoleId', vs.baseVerifiedRoleId || '').then(() => {
      const sel = document.getElementById('ver_baseVerifiedRoleId');
      if (sel && sel.options.length > 0) sel.options[0].textContent = '-- None (disabled) --';
    });
    populateRoleSelect('ver_ogRoleId', vs.ogRoleId || '').then(() => {
      const sel = document.getElementById('ver_ogRoleId');
      if (sel && sel.options.length > 0) sel.options[0].textContent = '-- None --';
    });
    populateChannelSelect('ver_panelChannelId', panel.channelId || '');
  } catch (e) {
    console.error('[Verification] Settings load error:', e);
    container.innerHTML = '<p style="color:#fca5a5;font-size:0.85em;">Failed to load verification settings.</p>';
  }
}

async function saveVerificationSettings() {
  const payload = {
    baseVerifiedRoleId: document.getElementById('ver_baseVerifiedRoleId')?.value || '',
    ogRoleId: document.getElementById('ver_ogRoleId')?.value || '',
    ogRoleLimit: parseInt(document.getElementById('ver_ogRoleLimit')?.value) || 0,
    moduleRoleResyncEnabled: !!document.getElementById('ver_autoResyncEnabled')?.checked,
  };


  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) showSuccess('Verification settings saved!');
    else showError(data.message || 'Failed to save verification settings');
  } catch (e) {
    console.error('[Verification] Save error:', e);
    showError('Failed to save verification settings');
  }
}

async function postVerificationPanelFromSettings() {
  const btn = document.getElementById('verPanelPostBtn');
  const channelId = document.getElementById('ver_panelChannelId')?.value || '';
  const title = document.getElementById('ver_panelTitle')?.value?.trim() || '';
  const description = document.getElementById('ver_panelDescription')?.value?.trim() || '';
  const color = document.getElementById('ver_panelColor')?.value?.trim() || '#FFD700';

  if (!channelId) {
    showError('Select a channel first.');
    return;
  }

  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Posting...'; }
    const res = await fetch('/api/admin/verification/panel/post', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      body: JSON.stringify({ channelId, title, description, color })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showError(data.message || 'Failed to post verification panel');
      return;
    }

    const status = document.getElementById('ver_panelStatus');
    if (status) {
      status.innerHTML = `Current panel message: <code>${escapeHtml(data.messageId || '')}</code> in <code>${escapeHtml(data.channelId || '')}</code>`;
    }
    showSuccess(data.action === 'updated' ? 'Verification panel updated.' : 'Verification panel posted.');
  } catch (error) {
    console.error('[Verification] post panel error:', error);
    showError('Failed to post verification panel');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Post / Update Panel'; }
  }
}

async function runOgSync(fullSync = false) {
  const btn = document.getElementById('verOgSyncBtn');
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }
    const res = await fetch('/api/admin/og-role/sync', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      body: JSON.stringify({ fullSync })
    });
    const data = await res.json();
    if (data.success) {
      showSuccess(data.message || 'OG sync complete');
    } else {
      showError(data.message || 'OG sync failed');
    }
  } catch (e) {
    showError('Error running OG sync: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Run OG Sync'; }
  }
}

// ==================== BRANDING SETTINGS ====================

function showBrandingHelp(anchorEl, text) {
  const existing = document.getElementById('brandingHelpPopover');
  if (existing) existing.remove();
  const pop = document.createElement('div');
  pop.id = 'brandingHelpPopover';
  pop.style.cssText = 'position:fixed;z-index:10000;max-width:320px;padding:10px 12px;border:1px solid rgba(99,102,241,0.3);border-radius:8px;background:rgba(15,23,42,0.98);color:#e2e8f0;font-size:0.82em;line-height:1.35;box-shadow:0 8px 26px rgba(0,0,0,0.45);';
  pop.textContent = text;
  document.body.appendChild(pop);
  const rect = anchorEl.getBoundingClientRect();
  pop.style.left = `${Math.min(rect.left, window.innerWidth - pop.offsetWidth - 10)}px`;
  pop.style.top = `${rect.bottom + 8}px`;
  const close = (e) => {
    if (!pop.contains(e.target) && e.target !== anchorEl) {
      pop.remove();
      document.removeEventListener('mousedown', close);
    }
  };
  document.addEventListener('mousedown', close);
}

function brandHelp(label, helpText) {
  const safe = escapeHtml(helpText);
  const safeLabel = escapeHtml(label);
  return `<label style="display:block;color:#c9d6ff;font-size:0.9em;font-weight:600;margin-bottom:6px;">${safeLabel} <button type="button" onclick="showBrandingHelp(this,'${escapeJsString(safe)}')" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:999px;background:rgba(99,102,241,0.28);color:#e0e7ff;font-size:0.72em;cursor:pointer;vertical-align:middle;border:none;padding:0;">?</button></label>`;
}

async function loadBrandingSettingsView() {
  const pane = document.getElementById('settingsTab-branding');
  if (!pane) return;
  const cardStyle = 'background:rgba(14,23,44,0.5);border:1px solid rgba(99,102,241,0.22);border-radius:10px;padding:var(--space-5);margin-bottom:var(--space-5);';
  const cardHeader = 'color:#c9d6ff;font-size:var(--font-lg);font-weight:700;margin:0 0 var(--space-4) 0;padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);';
  const fieldInput = 'width:100%;padding:10px 12px;border:1px solid rgba(99,102,241,0.22);border-radius:8px;background:rgba(30,41,59,0.8);color:#e0e7ff;font-size:0.9em;';

  pane.innerHTML = `<div style="${cardStyle}"><div style="text-align:center;padding:var(--space-5);color:var(--text-secondary);"><div class="spinner"></div><p>Loading branding settings...</p></div></div>`;

  try {
    const res = await fetch('/api/admin/branding', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const data = await res.json();
    const b = data.branding || {};
    const profile = data.serverProfile || {};

    pane.innerHTML = `
      <div style="${cardStyle}">
        <h3 style="${cardHeader}">🎨 Branding Module</h3>
        <p style="color:var(--text-secondary);font-size:0.85em;margin-bottom:14px;">Tenant admins can configure how this server's bot/panels look and feel.</p>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div>
            ${brandHelp('Bot Display Name', 'Shown in panel titles and tenant-facing bot identity text.')}
            <input id="br_bot_display_name" type="text" value="${escapeHtml(b.bot_display_name || b.display_name || '')}" style="${fieldInput}">
          </div>
          <div>
            ${brandHelp('Brand Emoji', 'Used as visual prefix in embeds/panels where supported.')}
            <input id="br_brand_emoji" type="text" value="${escapeHtml(b.brand_emoji || '')}" style="${fieldInput}" placeholder="🚀">
          </div>
          <div>
            ${brandHelp('Brand Color', 'Primary color used in branded embeds and cards.')}
            <input id="br_brand_color" type="text" value="${escapeHtml(b.brand_color || b.primary_color || '#6366f1')}" style="${fieldInput}" placeholder="#6366f1">
          </div>
          <div>
            ${brandHelp('Support URL', 'Link shown in support/help references in tenant outputs.')}
            <input id="br_support_url" type="text" value="${escapeHtml(b.support_url || '')}" style="${fieldInput}" placeholder="https://...">
          </div>
          <div style="grid-column:1 / span 2;">
            ${brandHelp('Logo URL', 'Logo image used in branded embeds where applicable. Defaults to tenant server icon when empty.')}
            <input id="br_logo_url" type="text" value="${escapeHtml(b.logo_url || b.icon_url || '')}" style="${fieldInput}" placeholder="Defaults to server icon if empty">
          </div>
          <div style="grid-column:1 / span 2; margin-top:4px; padding:10px; border-radius:8px; border:1px solid rgba(99,102,241,0.15); background:rgba(10,16,30,0.35);">
            <div style="color:#c9d6ff; font-weight:600; margin-bottom:8px;">Discord Server Profile (Bot)</div>
            <div style="color:#94a3b8; font-size:0.8em; margin-bottom:10px;">These fields control the bot profile shown in this server only. Applied with Discord guild profile settings.</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                ${brandHelp('Server Avatar URL', 'Guild-specific bot avatar (optional). Leave empty to keep current/default avatar.')}
                <input id="br_bot_server_avatar_url" type="text" value="${escapeHtml(b.bot_server_avatar_url || '')}" style="${fieldInput}" placeholder="https://...">
              </div>
              <div>
                ${brandHelp('Server Banner URL', 'Guild-specific bot banner (optional). Leave empty to keep current/default banner.')}
                <input id="br_bot_server_banner_url" type="text" value="${escapeHtml(b.bot_server_banner_url || '')}" style="${fieldInput}" placeholder="https://...">
              </div>
              <div style="grid-column:1 / span 2;">
                ${brandHelp('Server Bio', 'Guild-specific bot profile bio (optional).')}
                <textarea id="br_bot_server_bio" rows="3" style="${fieldInput};min-height:82px;resize:vertical;" placeholder="About this bot in your server...">${escapeHtml(b.bot_server_bio || '')}</textarea>
              </div>
            </div>
            <div style="margin-top:8px;color:#94a3b8;font-size:0.78em;">
              Current profile:
              Nickname <strong style="color:#cbd5e1;">${escapeHtml(profile.nickname || 'default')}</strong> ·
              Avatar <strong style="color:#cbd5e1;">${profile.avatar_url ? 'custom' : 'default'}</strong> ·
              Banner <strong style="color:#cbd5e1;">${profile.banner_url ? 'custom' : 'default'}</strong>
            </div>
          </div>
        </div>

        <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(99,102,241,0.15);display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
          <div>
            ${brandHelp('Ticketing Color Override', 'Optional. If set, ticketing embeds/panels use this instead of global brand color.')}
            <input id="br_ticketing_color" type="text" value="${escapeHtml(b.ticketing_color || '')}" style="${fieldInput}" placeholder="(fallback to global)">
          </div>
          <div>
            ${brandHelp('Self-Serve Color Override', 'Optional. If set, self-serve role panels use this color.')}
            <input id="br_selfserve_color" type="text" value="${escapeHtml(b.selfserve_color || '')}" style="${fieldInput}" placeholder="(fallback to global)">
          </div>
          <div>
            ${brandHelp('NFT Tracker Color Override', 'Optional. If set, NFT tracker embeds/panels use this color.')}
            <input id="br_nfttracker_color" type="text" value="${escapeHtml(b.nfttracker_color || '')}" style="${fieldInput}" placeholder="(fallback to global)">
          </div>
        </div>

        <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(99,102,241,0.15);display:grid;grid-template-columns:1fr;gap:12px;">
          <div>
            ${brandHelp('Footer Text', 'Default embed footer text. If empty: Powered by Guild Pilot.')}
            <input id="br_footer_text" type="text" value="${escapeHtml(b.footer_text || '')}" style="${fieldInput}" placeholder="Powered by Guild Pilot">
          </div>
        </div>

        <div style="margin-top:14px;padding:12px;border:1px solid rgba(99,102,241,0.18);border-radius:10px;background:rgba(14,23,44,0.42);">
          <div style="color:#c9d6ff;font-weight:600;margin-bottom:8px;">Preview Variants</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
            <div id="brandingPreviewTicket" style="padding:10px;border-radius:8px;background:rgba(30,41,59,0.55);border-left:4px solid ${escapeHtml(b.ticketing_color || b.brand_color || b.primary_color || '#6366f1')};">
              <div style="color:#e2e8f0;font-weight:700;">${escapeHtml((b.brand_emoji || '🎟️') + ' Support Tickets')}</div>
              <div style="color:#94a3b8;font-size:0.8em;margin-top:4px;">Open a support ticket</div>
              <div style="color:#94a3b8;font-size:0.72em;margin-top:6px;">${escapeHtml(b.footer_text || 'Powered by Guild Pilot')}</div>
            </div>
            <div id="brandingPreviewSelfserve" style="padding:10px;border-radius:8px;background:rgba(30,41,59,0.55);border-left:4px solid ${escapeHtml(b.selfserve_color || b.brand_color || b.primary_color || '#6366f1')};">
              <div style="color:#e2e8f0;font-weight:700;">${escapeHtml((b.brand_emoji || '🎖️') + ' Get Your Roles')}</div>
              <div style="color:#94a3b8;font-size:0.8em;margin-top:4px;">Click to claim roles</div>
              <div style="color:#94a3b8;font-size:0.72em;margin-top:6px;">${escapeHtml(b.footer_text || 'Powered by Guild Pilot')}</div>
            </div>
            <div id="brandingPreviewNft" style="padding:10px;border-radius:8px;background:rgba(30,41,59,0.55);border-left:4px solid ${escapeHtml(b.nfttracker_color || b.brand_color || b.primary_color || '#6366f1')};">
              <div style="color:#e2e8f0;font-weight:700;">${escapeHtml((b.brand_emoji || '📡') + ' NFT Activity')}</div>
              <div style="color:#94a3b8;font-size:0.8em;margin-top:4px;">Collection updates</div>
              <div style="color:#94a3b8;font-size:0.72em;margin-top:6px;">${escapeHtml(b.footer_text || 'Powered by Guild Pilot')}</div>
            </div>
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;padding-top:var(--space-4);border-top:1px solid rgba(99,102,241,0.15);margin-top:var(--space-4);">
          <button class="btn-primary" onclick="saveBrandingSettingsView()" style="font-size:0.85em;padding:8px 16px;">💾 Save Branding</button>
        </div>
      </div>
    `;

    const updatePreview = () => {
      const emoji = document.getElementById('br_brand_emoji')?.value || '✨';
      const gColor = document.getElementById('br_brand_color')?.value || '#6366f1';
      const footer = document.getElementById('br_footer_text')?.value || 'Powered by Guild Pilot';
      const tColor = document.getElementById('br_ticketing_color')?.value || gColor;
      const sColor = document.getElementById('br_selfserve_color')?.value || gColor;
      const nColor = document.getElementById('br_nfttracker_color')?.value || gColor;
      const ticketCard = document.getElementById('brandingPreviewTicket');
      const selfCard = document.getElementById('brandingPreviewSelfserve');
      const nftCard = document.getElementById('brandingPreviewNft');
      if (ticketCard) { ticketCard.style.borderLeftColor = tColor; ticketCard.children[0].textContent = `${emoji} Support Tickets`; ticketCard.children[2].textContent = footer; }
      if (selfCard) { selfCard.style.borderLeftColor = sColor; selfCard.children[0].textContent = `${emoji} Get Your Roles`; selfCard.children[2].textContent = footer; }
      if (nftCard) { nftCard.style.borderLeftColor = nColor; nftCard.children[0].textContent = `${emoji} NFT Activity`; nftCard.children[2].textContent = footer; }
    };
    ['br_brand_emoji','br_brand_color','br_ticketing_color','br_selfserve_color','br_nfttracker_color','br_footer_text'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', updatePreview);
    });
  } catch (e) {
    pane.innerHTML = `<p style="color:#fca5a5;font-size:0.85em;padding:var(--space-4);">Failed to load branding settings.</p>`;
  }
}

async function saveBrandingSettingsView() {
  try {
    const payload = {
      bot_display_name: (document.getElementById('br_bot_display_name')?.value || '').trim(),
      brand_emoji: (document.getElementById('br_brand_emoji')?.value || '').trim(),
      brand_color: (document.getElementById('br_brand_color')?.value || '').trim(),
      logo_url: (document.getElementById('br_logo_url')?.value || '').trim(),
      support_url: (document.getElementById('br_support_url')?.value || '').trim(),
      display_name: (document.getElementById('br_bot_display_name')?.value || '').trim(),
      primary_color: (document.getElementById('br_brand_color')?.value || '').trim(),
      icon_url: (document.getElementById('br_logo_url')?.value || '').trim(),
      bot_server_avatar_url: (document.getElementById('br_bot_server_avatar_url')?.value || '').trim(),
      bot_server_banner_url: (document.getElementById('br_bot_server_banner_url')?.value || '').trim(),
      bot_server_bio: (document.getElementById('br_bot_server_bio')?.value || '').trim(),
      footer_text: (document.getElementById('br_footer_text')?.value || '').trim(),
      ticketing_color: (document.getElementById('br_ticketing_color')?.value || '').trim(),
      selfserve_color: (document.getElementById('br_selfserve_color')?.value || '').trim(),
      nfttracker_color: (document.getElementById('br_nfttracker_color')?.value || '').trim(),
    };
    const res = await fetch('/api/admin/branding', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) showSuccess('Branding saved');
    else showError(data.message || 'Failed to save branding');
  } catch (e) {
    showError('Error saving branding: ' + e.message);
  }
}

// ==================== TREASURY MODULE SETTINGS ====================

async function loadTreasuryModuleSettings() {
  const pane = document.getElementById('settingsTab-treasury');
  if (!pane) return;

  const cardStyle = 'background:rgba(14,23,44,0.5);border:1px solid rgba(99,102,241,0.22);border-radius:10px;padding:var(--space-5);margin-bottom:var(--space-5);';

  // Render same layout as sidebar Wallet Tracker
  pane.innerHTML = `
    <div style="${cardStyle}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);">
        <h3 style="color:#c9d6ff;font-size:var(--font-lg);font-weight:700;margin:0;">💼 Tracked Wallets</h3>
        <button class="btn-primary" onclick="openAddWalletModal()" style="font-size:0.85em;padding:8px 16px;">+ Add Wallet</button>
      </div>
      <div id="settings_walletListWrap"><div style="text-align:center;padding:var(--space-5);color:var(--text-secondary);"><div class="spinner"></div><p>Loading wallets...</p></div></div>
    </div>
  `;

  await renderSettingsWalletList();
}

async function renderSettingsWalletList() {
  const wrap = document.getElementById('settings_walletListWrap');
  if (!wrap) return;
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), 10000));
    const res = await Promise.race([
      fetch('/api/admin/wallet-tracker/wallets', { credentials: 'include', headers: buildTenantRequestHeaders() }),
      timeout
    ]);
    if (!res.ok) { wrap.innerHTML = '<p style="color:#fca5a5;font-size:0.85em;">Failed to load wallets.</p>'; return; }
    const data = await res.json();
    const wallets = data.wallets || [];

    if (!wallets.length) {
      wrap.innerHTML = `<div style="text-align:center;padding:var(--space-5);color:var(--text-secondary);">
        <p style="margin-bottom:16px;">No wallets tracked yet.</p>
        <button class="btn-primary" onclick="openAddWalletModal()">+ Add Wallet</button>
      </div>`;
      return;
    }

    const rows = wallets.map(w => {
      const addr = `${w.wallet_address.slice(0,6)}...${w.wallet_address.slice(-4)}`;
      const lbl = escapeHtml(w.label || '—');
      const alertCh = w.alert_channel_id ? `<code>#${w.alert_channel_id}</code>` : '<span style="color:var(--text-secondary);">—</span>';
      const panelCh = w.panel_channel_id ? `<code>#${w.panel_channel_id}</code>` : '<span style="color:var(--text-secondary);">—</span>';
      const status = w.enabled ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-paused">Paused</span>';
      return `<tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
        <td style="padding:10px 12px;"><span style="font-family:monospace;font-size:0.85em;" title="${escapeHtml(w.wallet_address)}">${addr}</span></td>
        <td style="padding:10px 12px;color:#c9d6ff;">${lbl}</td>
        <td style="padding:10px 12px;">${alertCh}</td>
        <td style="padding:10px 12px;">${panelCh}</td>
        <td style="padding:10px 12px;">${status}</td>
        <td style="padding:10px 12px;">
          <div style="display:flex;gap:6px;">
            <button class="tw-panel-btn" data-id="${w.id}" style="font-size:0.8em;padding:4px 8px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;">📋</button>
            <button class="tw-edit-btn" data-id="${w.id}" data-addr="${escapeHtml(w.wallet_address)}" data-label="${escapeHtml(w.label||'')}" data-alertch="${w.alert_channel_id||''}" data-panelch="${w.panel_channel_id||''}" style="font-size:0.8em;padding:4px 8px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;">✏️</button>
            <button class="tw-remove-btn" data-id="${w.id}" style="font-size:0.8em;padding:4px 8px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    wrap.innerHTML = `<div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="border-bottom:2px solid rgba(255,255,255,0.1);">
          <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Address</th>
          <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Label</th>
          <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">TX Alert Ch.</th>
          <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Watch Ch.</th>
          <th style="text-align:left;padding:8px 12px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Status</th>
          <th style="padding:8px 12px;"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
    attachTrackedWalletListeners(wrap);
  } catch (e) {
    if (wrap) wrap.innerHTML = `<p style="color:#fca5a5;font-size:0.85em;padding:12px;">Error: ${escapeHtml(e.message)}</p>`;
  }
}


async function saveTreasuryModuleSettings() {
  const payload = {
    enabled: true,
    solanaWallet: (document.getElementById('trs_walletAddress')?.value || '').trim(),
    refreshHours: parseInt(document.getElementById('trs_refreshInterval')?.value) || 6,
    watchChannelId: document.getElementById('trs_watchChannelId')?.value || '',
    txAlertsEnabled: !!document.getElementById('trs_txAlertEnabled')?.checked,
    txAlertChannelId: document.getElementById('trs_txAlertChannelId')?.value || '',
    txAlertIncomingOnly: !!document.getElementById('trs_txAlertIncomingOnly')?.checked,
    txAlertMinSol: parseFloat(document.getElementById('trs_txAlertMinSol')?.value) || 0,
  };
  try {
    const res = await fetch('/api/admin/treasury/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success !== false) showSuccess('Wallet tracker settings saved!');
    else showError(data.message || 'Failed to save wallet tracker settings');
  } catch (e) {
    console.error('[Treasury] Save error:', e);
    showError('Failed to save treasury settings');
  }
}

// ==================== NFT TRACKER SETTINGS ====================

async function loadNftTrackerSettingsView(targetPaneId = null) {
  if (!isAdmin) return;
  const pane = (targetPaneId && document.getElementById(targetPaneId))
    || document.getElementById('settingsTab-nfttracker')
    || document.getElementById('nftActivityTrackerSettingsPanel');
  if (!pane) return;

  const cardStyle = 'background:rgba(14,23,44,0.5);border:1px solid rgba(99,102,241,0.22);border-radius:10px;padding:var(--space-5);margin-bottom:var(--space-5);';
  const cardHeader = 'color:#c9d6ff;font-size:var(--font-lg);font-weight:700;margin:0 0 var(--space-4) 0;padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);';

  pane.innerHTML = `
    <div style="${cardStyle}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);">
        <h3 style="${cardHeader}margin:0;padding:0;border:none;">Tracked Collections</h3>
        <button class="btn-primary" onclick="openAddCollectionModal()" style="font-size:0.85em;padding:8px 16px;">+ Add Collection</button>
      </div>
      <div id="nts_collectionsWrap"><div style="text-align:center;padding:var(--space-5);color:var(--text-secondary);"><div class="spinner"></div><p>Loading collections...</p></div></div>
    </div>
  `;

  await renderNftCollectionsCard('nts_collectionsWrap');
}

async function loadTokenTrackerSettingsView(targetPaneId = null) {
  if (!isAdmin) return;
  const pane = (targetPaneId && document.getElementById(targetPaneId))
    || document.getElementById('settingsTab-tokentracker')
    || document.getElementById('tokenActivityTrackerSettingsPanel');
  if (!pane) return;

  const cardStyle = 'background:rgba(14,23,44,0.5);border:1px solid rgba(99,102,241,0.22);border-radius:10px;padding:var(--space-5);margin-bottom:var(--space-5);';
  const cardHeader = 'color:#c9d6ff;font-size:var(--font-lg);font-weight:700;margin:0 0 var(--space-4) 0;padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);';

  pane.innerHTML = `
    <div style="${cardStyle}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);">
        <h3 style="${cardHeader}margin:0;padding:0;border:none;">Tracked Tokens</h3>
        <button class="btn-primary" onclick="openAddTokenModal()" style="font-size:0.85em;padding:8px 16px;">+ Add Token</button>
      </div>
      <div id="tts_tokensWrap"><div style="text-align:center;padding:var(--space-5);color:var(--text-secondary);"><div class="spinner"></div><p>Loading tracked tokens...</p></div></div>
    </div>
    <div style="${cardStyle}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);">
        <h3 style="${cardHeader}margin:0;padding:0;border:none;">Token Activity Feed</h3>
        <button class="btn-secondary" onclick="renderNftTokenEventsCard('tts_tokenEventsWrap')" style="font-size:0.82em;padding:8px 14px;">Refresh</button>
      </div>
      <div id="tts_tokenEventsWrap"><div style="color:var(--text-secondary);font-size:0.85em;">Loading token activity...</div></div>
    </div>
  `;

  await renderNftTrackedTokensCard('tts_tokensWrap');
  await renderNftTokenEventsCard('tts_tokenEventsWrap');
}

// ==================== INVITE TRACKER SETTINGS ====================

function inviteTrackerPeriodToDays(raw) {
  const value = String(raw || 'all').trim().toLowerCase();
  if (value === 'all') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function loadInviteTrackerSettingsView(targetPaneId = null) {
  if (!isAdmin) return;
  const pane = (targetPaneId && document.getElementById(targetPaneId))
    || document.getElementById('settingsTab-invites')
    || document.getElementById('inviteTrackerSettingsPanel');
  if (!pane) return;

  const cardStyle = 'background:rgba(14,23,44,0.5);border:1px solid rgba(99,102,241,0.22);border-radius:10px;padding:var(--space-5);margin-bottom:var(--space-5);';

  pane.innerHTML = `
    <div style="${cardStyle}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
        <h3 style="margin:0;color:#c9d6ff;">📨 Invite Tracker</h3>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <select id="inviteTrackerPeriodSelect" style="padding:8px 10px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;">
            <option value="all">All-time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
          <button class="btn-secondary btn-sm" onclick="refreshInviteTrackerDashboard()">Refresh</button>
          <button class="btn-primary btn-sm" onclick="exportInviteTrackerCsv()">Export CSV</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
        <div>
          <label style="display:block;color:#c9d6ff;font-size:0.86em;font-weight:600;margin-bottom:6px;">Required Join Role (Leaderboard)</label>
          ${roleSelectHTML('inviteRequiredRoleSelect', '', false)}
          <div style="color:var(--text-secondary);font-size:0.75em;margin-top:4px;">Only count invites where joined members have this role. Leave empty for no role filter.</div>
        </div>
        <div>
          <label style="display:block;color:#c9d6ff;font-size:0.86em;font-weight:600;margin-bottom:6px;">Panel Channel</label>
          <select id="invitePanelChannelSelect" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
            <option value="">-- Select Channel --</option>
          </select>
          <div style="color:var(--text-secondary);font-size:0.75em;margin-top:4px;">Invite leaderboard panel target channel.</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px;">
        <div>
          <label style="display:block;color:#c9d6ff;font-size:0.86em;font-weight:600;margin-bottom:6px;">Panel Period</label>
          <select id="invitePanelPeriodSelect" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
            <option value="all">All-time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </div>
        <div>
          <label style="display:block;color:#c9d6ff;font-size:0.86em;font-weight:600;margin-bottom:6px;">Panel Rows</label>
          <input id="invitePanelLimitInput" type="number" min="1" max="50" value="10" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
        </div>
        <div style="display:flex;align-items:end;">
          <label style="display:flex;align-items:center;gap:8px;color:#cbd5e1;font-size:0.86em;cursor:pointer;">
            <input id="invitePanelCreateLinkToggle" type="checkbox" checked>
            Show Create-Link Button
          </label>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
        <label style="display:flex;align-items:center;gap:8px;color:#cbd5e1;font-size:0.86em;cursor:pointer;">
          <input id="inviteIncludeVerificationStatsToggle" type="checkbox">
          Include verification NFT holdings in leaderboard stats
        </label>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        <button class="btn-secondary btn-sm" onclick="saveInviteTrackerSettings()">Save Invite Settings</button>
        <button class="btn-primary btn-sm" onclick="postInviteTrackerLeaderboardPanel()">Post/Update Leaderboard Panel</button>
      </div>
      <div id="inviteTrackerSummaryWrap" style="margin-top:8px;color:var(--text-secondary);">Loading summary...</div>
      <div id="inviteTrackerLeaderboardWrap" style="margin-top:16px;color:var(--text-secondary);">Loading leaderboard...</div>
      <div id="inviteTrackerEventsWrap" style="margin-top:16px;color:var(--text-secondary);">Loading events...</div>
    </div>
  `;

  try {
    discordRolesCache = null;
    const settingsRes = await fetch('/api/admin/invites/settings', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const settingsJson = await settingsRes.json();
    const settings = settingsJson?.data?.settings || settingsJson?.settings || {};
    await populateRoleSelect('inviteRequiredRoleSelect', settings.requiredJoinRoleId || '');
    await populateChannelSelect('invitePanelChannelSelect', settings.panelChannelId || '');
    const panelPeriod = settings.panelPeriodDays ? String(settings.panelPeriodDays) : 'all';
    const periodSel = document.getElementById('invitePanelPeriodSelect');
    if (periodSel) periodSel.value = panelPeriod;
    const limitInput = document.getElementById('invitePanelLimitInput');
    if (limitInput) limitInput.value = String(Number(settings.panelLimit || 10));
    const createLinkToggle = document.getElementById('invitePanelCreateLinkToggle');
    if (createLinkToggle) createLinkToggle.checked = settings.panelEnableCreateLink !== false;
    const includeVerificationStatsToggle = document.getElementById('inviteIncludeVerificationStatsToggle');
    if (includeVerificationStatsToggle) includeVerificationStatsToggle.checked = !!settings.includeVerificationStats;
  } catch (_error) {
    await populateRoleSelect('inviteRequiredRoleSelect', '');
    await populateChannelSelect('invitePanelChannelSelect', '');
  }

  await refreshInviteTrackerDashboard();
}

function getInviteTrackerSettingsPayload() {
  const roleSelect = document.getElementById('inviteRequiredRoleSelect');
  const panelChannelSelect = document.getElementById('invitePanelChannelSelect');
  const panelPeriodSelect = document.getElementById('invitePanelPeriodSelect');
  const panelLimitInput = document.getElementById('invitePanelLimitInput');
  const createLinkToggle = document.getElementById('invitePanelCreateLinkToggle');
  const includeVerificationStatsToggle = document.getElementById('inviteIncludeVerificationStatsToggle');

  const panelPeriodDays = inviteTrackerPeriodToDays(panelPeriodSelect?.value || 'all');
  const panelLimit = Number(panelLimitInput?.value || 10);
  return {
    requiredJoinRoleId: roleSelect?.value || null,
    panelChannelId: panelChannelSelect?.value || null,
    panelPeriodDays,
    panelLimit: Number.isFinite(panelLimit) ? panelLimit : 10,
    panelEnableCreateLink: !!createLinkToggle?.checked,
    includeVerificationStats: !!includeVerificationStatsToggle?.checked,
  };
}

async function saveInviteTrackerSettings() {
  try {
    const payload = getInviteTrackerSettingsPayload();
    const res = await fetch('/api/admin/invites/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      showError(data?.message || data?.error?.message || 'Failed to save invite settings.');
      return;
    }
    showSuccess('Invite tracker settings saved.');
    await refreshInviteTrackerDashboard();
  } catch (error) {
    showError(`Failed to save invite settings: ${error?.message || 'unknown error'}`);
  }
}

async function postInviteTrackerLeaderboardPanel() {
  try {
    const payload = getInviteTrackerSettingsPayload();
    const saveRes = await fetch('/api/admin/invites/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      body: JSON.stringify(payload),
    });
    const saveJson = await saveRes.json().catch(() => ({}));
    if (!saveRes.ok || saveJson.success === false) {
      showError(saveJson?.message || saveJson?.error?.message || 'Failed to save invite panel settings.');
      return;
    }

    const panelRes = await fetch('/api/admin/invites/panel', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      body: JSON.stringify({
        channelId: payload.panelChannelId,
        days: payload.panelPeriodDays,
        limit: payload.panelLimit,
        requiredJoinRoleId: payload.requiredJoinRoleId,
        enableCreateLink: payload.panelEnableCreateLink,
        includeVerificationStats: payload.includeVerificationStats,
      }),
    });
    const panelJson = await panelRes.json().catch(() => ({}));
    if (!panelRes.ok || panelJson.success === false) {
      showError(panelJson?.message || panelJson?.error?.message || 'Failed to post leaderboard panel.');
      return;
    }
    showSuccess('Invite leaderboard panel posted/updated.');
    await loadInviteTrackerSettingsView();
  } catch (error) {
    showError(`Failed to post invite panel: ${error?.message || 'unknown error'}`);
  }
}

async function refreshInviteTrackerDashboard() {
  const summaryWrap = document.getElementById('inviteTrackerSummaryWrap');
  const leaderboardWrap = document.getElementById('inviteTrackerLeaderboardWrap');
  const eventsWrap = document.getElementById('inviteTrackerEventsWrap');
  if (!summaryWrap || !leaderboardWrap || !eventsWrap) return;

  const periodValue = document.getElementById('inviteTrackerPeriodSelect')?.value || 'all';
  const days = inviteTrackerPeriodToDays(periodValue);
  const requiredJoinRoleId = String(document.getElementById('inviteRequiredRoleSelect')?.value || '').trim();
  const includeVerificationStats = !!document.getElementById('inviteIncludeVerificationStatsToggle')?.checked;
  const queryParts = [];
  if (days) queryParts.push(`days=${encodeURIComponent(String(days))}`);
  if (requiredJoinRoleId) queryParts.push(`requiredJoinRoleId=${encodeURIComponent(requiredJoinRoleId)}`);
  if (includeVerificationStats) queryParts.push('includeVerificationStats=true');
  const qs = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

  summaryWrap.innerHTML = '<div class="spinner"></div><p>Loading summary...</p>';
  leaderboardWrap.innerHTML = '<div class="spinner"></div><p>Loading leaderboard...</p>';
  eventsWrap.innerHTML = '<div class="spinner"></div><p>Loading events...</p>';

  try {
    const headers = buildTenantRequestHeaders();
    const [summaryRes, boardRes, eventsRes] = await Promise.all([
      fetch('/api/admin/invites/summary', { credentials: 'include', headers }),
      fetch(`/api/admin/invites/leaderboard${qs}${qs ? '&' : '?'}limit=50`, { credentials: 'include', headers }),
      fetch(`/api/admin/invites/events${qs}${qs ? '&' : '?'}limit=30`, { credentials: 'include', headers }),
    ]);

    const summaryJson = await summaryRes.json();
    const boardJson = await boardRes.json();
    const eventsJson = await eventsRes.json();

    if (!summaryRes.ok || summaryJson.success === false) {
      summaryWrap.innerHTML = `<div style="color:#fca5a5;">${escapeHtml(summaryJson?.message || summaryJson?.error?.message || 'Failed to load summary')}</div>`;
    } else {
      const s = summaryJson.data?.summary || summaryJson.summary || {};
      summaryWrap.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;">
          <div style="padding:12px;border:1px solid rgba(99,102,241,0.2);border-radius:10px;background:rgba(30,41,59,0.45);"><div style="font-size:0.75em;color:var(--text-secondary);">Total Joins</div><div style="font-size:1.4em;font-weight:700;color:#e0e7ff;">${Number(s.totalJoins || 0)}</div></div>
          <div style="padding:12px;border:1px solid rgba(34,197,94,0.24);border-radius:10px;background:rgba(22,101,52,0.22);"><div style="font-size:0.75em;color:var(--text-secondary);">Resolved Invites</div><div style="font-size:1.4em;font-weight:700;color:#bbf7d0;">${Number(s.resolvedJoins || 0)}</div></div>
          <div style="padding:12px;border:1px solid rgba(245,158,11,0.24);border-radius:10px;background:rgba(146,64,14,0.22);"><div style="font-size:0.75em;color:var(--text-secondary);">Unknown Source</div><div style="font-size:1.4em;font-weight:700;color:#fde68a;">${Number(s.unknownJoins || 0)}</div></div>
          <div style="padding:12px;border:1px solid rgba(99,102,241,0.2);border-radius:10px;background:rgba(30,41,59,0.45);"><div style="font-size:0.75em;color:var(--text-secondary);">Unique Inviters</div><div style="font-size:1.4em;font-weight:700;color:#c7d2fe;">${Number(s.uniqueInviters || 0)}</div></div>
        </div>
      `;
    }

    if (!boardRes.ok || boardJson.success === false) {
      leaderboardWrap.innerHTML = `<div style="color:#fca5a5;">${escapeHtml(boardJson?.message || boardJson?.error?.message || 'Failed to load leaderboard')}</div>`;
    } else {
      const rows = boardJson.data?.rows || boardJson.rows || [];
      const limitedByPlan = !!(boardJson.data?.limitedByPlan ?? boardJson.limitedByPlan);
      const roleFiltered = !!(boardJson.data?.requiredJoinRoleId ?? boardJson.requiredJoinRoleId);
      const verificationStatsEnabled = !!(boardJson.data?.includeVerificationStats ?? boardJson.includeVerificationStats);
      const list = rows.length
        ? rows.map(row => {
            const nftCell = verificationStatsEnabled
              ? `<td style="padding:8px;text-align:right;color:#93c5fd;">${Number(row.inviteeNftsTotal || 0)}</td>`
              : '';
            return `<tr><td style="padding:8px;">#${row.rank}</td><td style="padding:8px;">${row.inviterUserId ? `<@${row.inviterUserId}>` : escapeHtml(row.inviterUsername || 'Unknown')}</td><td style="padding:8px;text-align:right;font-weight:700;color:#86efac;">${Number(row.inviteCount || 0)}</td>${nftCell}</tr>`;
          }).join('')
        : `<tr><td colspan="${verificationStatsEnabled ? 4 : 3}" style="padding:12px;color:var(--text-secondary);">No invite data yet.</td></tr>`;
      leaderboardWrap.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <h4 style="margin:0;color:#c9d6ff;">Leaderboard</h4>
          <div style="display:flex;gap:10px;align-items:center;">
            ${limitedByPlan ? '<span style="font-size:0.75em;color:#fcd34d;">Period filter limited by plan (showing all-time)</span>' : ''}
            ${roleFiltered ? '<span style="font-size:0.75em;color:#93c5fd;">Role-filtered</span>' : ''}
            ${verificationStatsEnabled ? '<span style="font-size:0.75em;color:#86efac;">Verification stats</span>' : ''}
          </div>
        </div>
        <div style="overflow-x:auto;border:1px solid rgba(99,102,241,0.18);border-radius:10px;">
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:rgba(30,41,59,0.55);"><th style="padding:8px;text-align:left;">Rank</th><th style="padding:8px;text-align:left;">Inviter</th><th style="padding:8px;text-align:right;">Invites</th>${verificationStatsEnabled ? '<th style="padding:8px;text-align:right;">Invitee NFTs</th>' : ''}</tr></thead>
            <tbody>${list}</tbody>
          </table>
        </div>
      `;
    }

    if (!eventsRes.ok || eventsJson.success === false) {
      eventsWrap.innerHTML = `<div style="color:#fca5a5;">${escapeHtml(eventsJson?.message || eventsJson?.error?.message || 'Failed to load events')}</div>`;
    } else {
      const rows = eventsJson.data?.events || eventsJson.events || [];
      const limitedByPlan = !!(eventsJson.data?.limitedByPlan ?? eventsJson.limitedByPlan);
      const list = rows.length
        ? rows.map(row => {
            const joined = row.joinedUserId ? `<@${row.joinedUserId}>` : escapeHtml(row.joinedUsername || 'Unknown');
            const inviter = row.inviterUserId ? `<@${row.inviterUserId}>` : '<span style="color:var(--text-secondary);">Unknown</span>';
            const code = row.inviteCode ? `<code>${escapeHtml(row.inviteCode)}</code>` : '—';
            const when = row.joinedAt ? new Date(row.joinedAt).toLocaleString() : 'Unknown';
            return `<tr><td style="padding:8px;">${joined}</td><td style="padding:8px;">${inviter}</td><td style="padding:8px;">${code}</td><td style="padding:8px;white-space:nowrap;">${escapeHtml(when)}</td></tr>`;
          }).join('')
        : '<tr><td colspan="4" style="padding:12px;color:var(--text-secondary);">No join events yet.</td></tr>';
      eventsWrap.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <h4 style="margin:0;color:#c9d6ff;">Recent Invite Events</h4>
          ${limitedByPlan ? '<span style="font-size:0.75em;color:#fcd34d;">Period filter limited by plan (showing all-time)</span>' : ''}
        </div>
        <div style="overflow-x:auto;border:1px solid rgba(99,102,241,0.18);border-radius:10px;">
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:rgba(30,41,59,0.55);"><th style="padding:8px;text-align:left;">Joined User</th><th style="padding:8px;text-align:left;">Inviter</th><th style="padding:8px;text-align:left;">Code</th><th style="padding:8px;text-align:left;">Joined At</th></tr></thead>
            <tbody>${list}</tbody>
          </table>
        </div>
      `;
    }
  } catch (error) {
    const message = escapeHtml(error?.message || 'Unknown error');
    summaryWrap.innerHTML = `<div style="color:#fca5a5;">${message}</div>`;
    leaderboardWrap.innerHTML = '';
    eventsWrap.innerHTML = '';
  }
}

async function exportInviteTrackerCsv() {
  const periodValue = document.getElementById('inviteTrackerPeriodSelect')?.value || 'all';
  const days = inviteTrackerPeriodToDays(periodValue);
  const qs = days ? `?days=${encodeURIComponent(String(days))}` : '';
  try {
    const res = await fetch(`/api/admin/invites/export${qs}`, {
      credentials: 'include',
      headers: buildTenantRequestHeaders(),
    });
    if (!res.ok) {
      const errorJson = await res.json().catch(() => null);
      showError(errorJson?.message || errorJson?.error?.message || 'Export unavailable on this plan.');
      return;
    }
    const blob = await res.blob();
    const filename = (res.headers.get('content-disposition') || '').match(/filename=\"?([^\";]+)\"?/i)?.[1] || 'invite-tracker.csv';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showSuccess('Invite CSV exported.');
  } catch (error) {
    showError(`Export failed: ${error?.message || 'unknown error'}`);
  }
}

// ==================== VP MAPPINGS ====================

async function loadVotingPowerView() {
  if (!isAdmin) return;
  const content = document.getElementById('adminVotingPowerContent');
  if (!content) return;

  content.innerHTML = `<div style="text-align:center; padding: var(--space-5); color: var(--text-secondary);"><div class="spinner"></div><p>Loading voting power mappings...</p></div>`;

  try {
    const roles = await fetchDiscordRoles();
    const rHTML = roleSelectHTML('vpRoleSelect', '', false);

    const res = await fetch('/api/admin/governance/vp-mappings', { credentials: 'include' });
    const data = await res.json();
    const mappings = (data.success && data.mappings) ? data.mappings : [];

    let tableHTML;
    if (mappings.length === 0) {
      tableHTML = '<p style="color:var(--text-secondary);font-size:0.85em;font-style:italic;padding:12px 0;">No VP mappings configured. Falling back to tier-based VP.</p>';
    } else {
      const rows = mappings.map(m => `<tr style="border-bottom:1px solid rgba(99,102,241,0.08);">
        <td style="padding:10px 12px;color:#e0e7ff;">${m.role_name || m.role_id}</td>
        <td style="padding:10px 12px;color:#a5b4fc;font-weight:600;">${m.voting_power}</td>
        <td style="padding:10px 12px;"><button onclick="removeVPMapping('${escapeJsString(m.role_id)}')" style="padding:4px 12px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);border-radius:6px;color:#fca5a5;font-size:0.82em;cursor:pointer;">Remove</button></td>
      </tr>`).join('');
      tableHTML = `<div style="overflow-x:auto;border-radius:10px;border:1px solid rgba(99,102,241,0.12);">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="background:rgba(30,41,59,0.7);">
            <th style="padding:10px 12px;text-align:left;color:#94a3b8;font-size:0.82em;font-weight:600;">Role</th>
            <th style="padding:10px 12px;text-align:left;color:#94a3b8;font-size:0.82em;font-weight:600;">Voting Power</th>
            <th style="padding:10px 12px;text-align:left;color:#94a3b8;font-size:0.82em;font-weight:600;">Actions</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }

    // --- Governance Settings Card (before VP mappings) ---
    const govCardStyle = 'background:rgba(14,23,44,0.5);border:1px solid rgba(99,102,241,0.22);border-radius:10px;padding:var(--space-5);margin-bottom:var(--space-5);';
    const govCardHeader = 'color:#c9d6ff;font-size:var(--font-lg);font-weight:700;margin:0 0 var(--space-4) 0;padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);';
    const govGridRow = 'display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);';
    const govFieldLabel = 'display:block;color:#c9d6ff;font-size:0.9em;font-weight:600;margin-bottom:6px;';
    const govFieldInput = 'width:100%;padding:10px 12px;border:1px solid rgba(99,102,241,0.22);border-radius:8px;background:rgba(30,41,59,0.8);color:#e0e7ff;font-size:0.9em;';
    const govSelectStyle = 'width:100%;padding:10px 12px;border:1px solid rgba(99,102,241,0.22);border-radius:8px;background:rgba(30,41,59,0.8);color:#e0e7ff;font-size:0.9em;';

    let govSettingsHTML = '';
    try {
      const settingsRes = await fetch('/api/admin/settings', { credentials: 'include' });
      const settingsJson = await settingsRes.json();
      const gs = settingsJson.success ? settingsJson.settings : {};

      govSettingsHTML = `
        <div style="${govCardStyle}">
          <h3 style="${govCardHeader}">🗳️ Governance Settings</h3>
          <div style="${govGridRow}">
            <div>
              <label style="${govFieldLabel}">Quorum Percentage (%)</label>
              <input type="number" id="gov_quorumPercentage" min="1" max="100" value="${gs.quorumPercentage ?? ''}" style="${govFieldInput}">
            </div>
            <div>
              <label style="${govFieldLabel}">Support Threshold</label>
              <input type="number" id="gov_supportThreshold" min="1" value="${gs.supportThreshold ?? ''}" style="${govFieldInput}">
            </div>
          </div>
          <div style="${govGridRow}margin-top:var(--space-3);">
            <div>
              <label style="${govFieldLabel}">Vote Duration (Days)</label>
              <input type="number" id="gov_voteDurationDays" min="1" max="30" value="${gs.voteDurationDays ?? ''}" style="${govFieldInput}">
            </div>
            <div></div>
          </div>
          <h4 style="color:#c9d6ff;font-size:0.95em;font-weight:600;margin:var(--space-4) 0 var(--space-3) 0;padding-top:var(--space-3);border-top:1px solid rgba(99,102,241,0.12);">🔗 Channel Overrides</h4>
          <p style="color:var(--text-secondary);font-size:0.85em;margin-bottom:12px;">Leave empty to use .env defaults.</p>
          <div style="${govGridRow}">
            <div>
              <label style="${govFieldLabel}">Proposals Channel</label>
              <select id="gov_proposalsChannelId" style="${govSelectStyle}"><option value="">Loading channels...</option></select>
            </div>
            <div>
              <label style="${govFieldLabel}">Voting Channel</label>
              <select id="gov_votingChannelId" style="${govSelectStyle}"><option value="">Loading channels...</option></select>
            </div>
          </div>
          <div style="${govGridRow}margin-top:var(--space-3);">
            <div>
              <label style="${govFieldLabel}">Results Channel</label>
              <select id="gov_resultsChannelId" style="${govSelectStyle}"><option value="">Loading channels...</option></select>
            </div>
            <div>
              <label style="${govFieldLabel}">Governance Log Channel</label>
              <select id="gov_governanceLogChannelId" style="${govSelectStyle}"><option value="">Loading channels...</option></select>
            </div>
          </div>
          <div style="display:flex;gap:var(--space-3);justify-content:flex-end;padding-top:var(--space-4);border-top:1px solid rgba(99,102,241,0.15);margin-top:var(--space-4);">
            <button class="btn-primary" onclick="saveGovernanceSettings()" style="font-size:0.85em;padding:8px 16px;">💾 Save Governance Settings</button>
          </div>
        </div>
      `;

      // Populate channel selects after DOM insertion (deferred below)
      setTimeout(async () => {
        try {
          const chRes = await fetch('/api/admin/discord/channels', { credentials: 'include' });
          if (!chRes.ok) return;
          const chJson = await chRes.json();
          const channels = chJson.success ? (chJson.channels || []) : [];
          const ids = ['proposalsChannelId', 'votingChannelId', 'resultsChannelId', 'governanceLogChannelId'];
          populateChannelSelects(ids.map(id => `gov_${id}`), channels, gs, ids);
        } catch (e) { console.error('[Governance] Channel load error:', e); }
      }, 0);
    } catch (e) {
      console.error('[Governance] Settings load error:', e);
      govSettingsHTML = '<p style="color:#fca5a5;font-size:0.85em;">Failed to load governance settings.</p>';
    }

    content.innerHTML = `
      ${govSettingsHTML}
      <p style="color:var(--text-secondary);font-size:0.85em;margin-bottom:16px;">Map Discord roles to voting power. Users get the highest VP among all their roles.</p>
      <div id="vpMappingsTableContainer" style="margin-bottom:16px;">${tableHTML}</div>
      <div style="background:rgba(30,41,59,0.5);border:1px solid rgba(99,102,241,0.15);border-radius:10px;padding:16px;margin-top:8px;">
        <h5 style="color:#c9d6ff;font-size:0.88em;font-weight:600;margin:0 0 12px 0;">➕ Add Mapping</h5>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);">
          <div>
            <label style="display:block;color:#c9d6ff;font-size:0.9em;font-weight:600;margin-bottom:6px;">Discord Role</label>
            ${rHTML}
          </div>
          <div>
            <label style="display:block;color:#c9d6ff;font-size:0.9em;font-weight:600;margin-bottom:6px;">Voting Power</label>
            <input type="number" id="vpAmountInput" min="1" max="1000" placeholder="e.g. 10" value="1" style="width:100%;padding:10px 14px;background:rgba(15,23,42,0.6);border:1px solid rgba(99,102,241,0.2);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
          </div>
        </div>
        <button onclick="addVPMapping()" style="margin-top:12px;padding:8px 20px;background:linear-gradient(135deg,rgba(99,102,241,0.7),rgba(139,92,246,0.7));border:1px solid rgba(99,102,241,0.3);border-radius:8px;color:#e0e7ff;font-size:0.88em;cursor:pointer;">Add Mapping</button>
      </div>
      <p style="color:var(--text-secondary);font-size:0.8em;font-style:italic;margin-top:16px;">Falls back to NFT tier-based VP if no mappings are configured.</p>
    `;

    populateRoleSelect('vpRoleSelect', roles);
  } catch (e) {
    console.error('Failed to load voting power view:', e);
    content.innerHTML = '<p style="color:#fca5a5;font-size:0.85em;">Failed to load voting power mappings.</p>';
  }
}


async function addVPMapping() {
  const sel = document.getElementById('vpRoleSelect') || document.getElementById('vpMappingRoleSelect');
  const vpInput = document.getElementById('vpAmountInput') || document.getElementById('vpMappingVPInput');
  if (!sel || !vpInput) return;
  const roleId = sel.value;
  const votingPower = parseInt(vpInput.value);
  if (!roleId) return showError('Please select a role.');
  if (!votingPower || votingPower < 1) return showError('Voting power must be at least 1.');
  const roleName = sel.options[sel.selectedIndex]?.textContent?.replace(/^\u25CF\s*/, '') || '';
  try {
    const res = await fetch('/api/admin/governance/vp-mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ roleId, roleName, votingPower })
    });
    const data = await res.json();
    if (data.success) {
      sel.value = '';
      vpInput.value = '1';
      await loadVotingPowerView();
    } else {
      showError(data.message || 'Failed to add mapping.');
    }
  } catch (e) {
    console.error('Failed to add VP mapping:', e);
    showError('Failed to add VP mapping.');
  }
}

async function removeVPMapping(roleId) {
  if (!confirm('Remove this VP mapping?')) return;
  try {
    const res = await fetch(`/api/admin/governance/vp-mappings/${roleId}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    const data = await res.json();
    if (data.success) {
      await loadVotingPowerView();
    } else {
      showError(data.message || 'Failed to remove mapping.');
    }
  } catch (e) {
    console.error('Failed to remove VP mapping:', e);
    showError('Failed to remove VP mapping.');
  }
}

async function loadAdminRoles() {
  if (!isAdmin) return;
  const content = document.getElementById('adminRolesContent');
  if (!content) return;

  content.innerHTML = `<div style="text-align:center; padding: var(--space-5); color: var(--text-secondary);"><div class="spinner"></div><p>Loading roles config...</p></div>`;

  // Pre-fetch Discord roles so dropdowns open instantly
  discordRolesCache = null;
  fetchDiscordRoles();

  try {
    const response = await fetch('/api/admin/roles/config', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const data = await response.json();
    if (!data.success) throw new Error(data.message || 'Failed to load roles');

    const config = data.config || {};
    const tiers = config.tiers || [];
    const traitRoles = config.traitRoles || [];
    const tokenRules = config.tokenRules || [];
    adminTiersCache = tiers;
    adminTraitsCache = traitRoles;
    adminTokenRulesCache = tokenRules;

    const allRules = [
      ...tiers.map((t, idx) => ({ ...t, _type: 'collection', _idx: idx })),
      ...traitRoles.map((t, idx) => ({ ...t, _type: 'trait', _idx: idx })),
      ...tokenRules.map((t, idx) => ({ ...t, _type: 'token', _idx: idx }))
    ];

    let html = '';
    html += `<div style="margin-bottom:12px;">
      <p style="color:var(--text-secondary); font-size:0.85em; margin:0;">Define NFT collection, NFT trait, and token-based rules for automatic Discord role assignment.</p>
    </div>`;

    if (allRules.length === 0) {
      html += `<div style="padding:24px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.15); border-radius:10px; color:var(--text-secondary); text-align:center;">No verification rules yet. Click <strong>+ Add Rule</strong> to create one.</div>`;
    } else {
      const truncId = (id) => id && id.length > 16 ? id.slice(0, 8) + '...' + id.slice(-4) : (id || '-');
      const ruleNeverRemove = (rule) => {
        const raw = rule?.neverRemove ?? rule?.never_remove ?? rule?.keepOnLoss ?? rule?.keep_on_loss;
        if (raw === null || raw === undefined) return false;
        if (typeof raw === 'boolean') return raw;
        if (typeof raw === 'number') return raw === 1;
        if (typeof raw === 'string') return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
        return false;
      };
      const resolveRole = (roleId) => {
        if (!roleId) return '<span style="color:var(--text-muted);">Not set</span>';
        const role = (discordRolesCache || []).find(r => r.id === roleId);
        if (role) {
          const dot = role.color && role.color !== '#000000' ? `<span style="color:${role.color};">\u25CF</span> ` : '';
          return dot + escapeHtml(role.name);
        }
        return `<span style="font-family:monospace;font-size:0.85em;">${escapeHtml(roleId)}</span>`;
      };

      const rows = allRules.map(rule => {
        const isCollection = rule._type === 'collection';
        const isTrait = rule._type === 'trait';
        const isToken = rule._type === 'token';
        const badge = isCollection
          ? '<span class="badge-collection">NFT Collection</span>'
          : isTrait
            ? '<span class="badge-trait">NFT Trait</span>'
            : '<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.75em;font-weight:600;color:#fef3c7;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.35);">Token</span>';
        const ruleName = isCollection
          ? escapeHtml(rule.name || 'Unnamed')
          : isTrait
            ? escapeHtml(rule.traitType || rule.trait_type || '')
            : escapeHtml(rule.tokenSymbol || 'Token Rule');
        const colId = isCollection
          ? (rule.collectionId || rule.collection_id || '')
          : isTrait
            ? (rule.collectionId || rule.trait_collection_id || '')
            : (rule.tokenMint || '');
        const roleId = rule.roleId || '';
        let details = '';
        if (isCollection) {
          const max = (rule.maxNFTs === Infinity || rule.maxNFTs >= 999999) ? 'INF' : rule.maxNFTs;
          details = `Min: ${rule.minNFTs}, Max: ${max} NFTs`;
        } else if (isTrait) {
          const vals = rule.traitValues || rule.trait_values || (rule.traitValue || rule.trait_value ? [rule.traitValue || rule.trait_value] : []);
          const valArr = Array.isArray(vals) ? vals : String(vals).split(',').map(v => v.trim()).filter(Boolean);
          details = valArr.length ? 'Values: ' + valArr.map(v => escapeHtml(v)).join(', ') : '-';
        } else {
          const min = Number(rule.minAmount || 0).toLocaleString(undefined, { maximumFractionDigits: 6 });
          const max = rule.maxAmount === null || rule.maxAmount === undefined
            ? 'INF'
            : Number(rule.maxAmount).toLocaleString(undefined, { maximumFractionDigits: 6 });
          details = `Balance: ${min} -> ${max}${rule.enabled === false ? ' (disabled)' : ''}`;
        }
        if (ruleNeverRemove(rule)) {
          details += ' | Keep role on loss';
        }
        const editFn = isCollection ? `editTier(${rule._idx})` : isTrait ? `editTraitRule(${rule._idx})` : `editTokenRule(${rule._idx})`;
        const deleteFn = isCollection ? `deleteTier(${rule._idx})` : isTrait ? `deleteTraitRule(${rule._idx})` : `deleteTokenRule(${rule._idx})`;

        return `<tr>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15);">${badge}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#e0e7ff; font-weight:600;">${ruleName}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); font-family:monospace; font-size:0.82em; color:#a5b4fc;" title="${escapeHtml(colId)}">
            <span style="cursor:pointer;" onclick="navigator.clipboard.writeText('${escapeJsString(colId)}');showSuccess('Copied!')">${escapeHtml(truncId(colId))}</span>
          </td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#93c5fd; font-size:0.85em;">${resolveRole(roleId)}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:var(--text-secondary); font-size:0.85em;">${details}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); text-align:right; white-space:nowrap;">
            <button onclick="${editFn}" style="padding:6px 10px; background:rgba(99,102,241,0.2); border:1px solid rgba(99,102,241,0.35); border-radius:6px; cursor:pointer; color:#818cf8; font-size:0.8em;">Edit</button>
            <button onclick="${deleteFn}" style="padding:6px 10px; background:rgba(239,68,68,0.2); border:1px solid rgba(239,68,68,0.35); border-radius:6px; cursor:pointer; color:#fca5a5; font-size:0.8em; margin-left:4px;">Delete</button>
          </td>
        </tr>`;
      }).join('');

      html += `
        <div style="overflow:auto; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.5); margin-bottom:16px;">
          <table style="width:100%; border-collapse:collapse; font-size:0.9em;">
            <thead><tr style="background:rgba(99,102,241,0.12); text-align:left;">
              <th style="padding:10px; color:#c9d6ff;">Type</th>
              <th style="padding:10px; color:#c9d6ff;">Rule Name</th>
              <th style="padding:10px; color:#c9d6ff;">Scope</th>
              <th style="padding:10px; color:#c9d6ff;">Discord Role</th>
              <th style="padding:10px; color:#c9d6ff;">Details</th>
              <th style="padding:10px; color:#c9d6ff; text-align:right;">Actions</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    html += `<div style="margin-top:8px; color:var(--text-secondary); font-size:0.9em;">Showing ${tiers.length} collection rule(s), ${traitRoles.length} trait rule(s), and ${tokenRules.length} token rule(s)</div>`;

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div class="error-state"><div class="error-message">${escapeHtml(e.message)}</div></div>`;
  }
}

// ==================== UNIFIED VERIFICATION RULE MODAL ====================
let _editingRuleType = null; // "tier" | "trait" | "token"
let _editingRuleIdx = null;
let _traitValues = [];

function _ensureAddRuleModal() {
  if (document.getElementById('addRuleModal')) return;
  const modal = document.createElement('div');
  modal.id = 'addRuleModal';
  modal.className = 'modal-overlay';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:520px;width:520px;min-height:620px;display:flex;flex-direction:column;">

      <div class="modal-header">
        <h3 id="addRuleModalTitle">Add Verification Rule</h3>
        <button onclick="closeAddRuleModal()" class="modal-close">\u2715</button>
      </div>
      <div class="modal-body" style="flex:1;overflow:auto;">
        <div style="margin-bottom:20px;">
          <label style="display:block;font-size:0.85em;color:var(--text-secondary);margin-bottom:8px;">Rule Type</label>
          <div style="display:flex;gap:12px;">
            <label class="rule-type-option" id="ruleTypeCollectionLabel">
              <input type="radio" name="ruleType" value="collection" id="ruleTypeCollection" onchange="onRuleTypeChange()" checked>
              <span>NFT Collection</span>
              <small>Min/max NFT count</small>
            </label>
            <label class="rule-type-option" id="ruleTypeTraitLabel">
              <input type="radio" name="ruleType" value="trait" id="ruleTypeTrait" onchange="onRuleTypeChange()">
              <span>NFT Trait</span>
              <small>Specific NFT traits</small>
            </label>
            <label class="rule-type-option" id="ruleTypeTokenLabel">
              <input type="radio" name="ruleType" value="token" id="ruleTypeToken" onchange="onRuleTypeChange()">
              <span>Token</span>
              <small>Balance range</small>
            </label>
          </div>
        </div>
        <div class="form-group" id="collectionIdField" style="margin-bottom:14px;">
          <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Collection ID <span style="color:#f87171;">*</span></label>
          <input type="text" id="ruleCollectionId" placeholder="Solana collection address" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
        </div>
        <div class="form-group" style="margin-bottom:14px;">
          <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Discord Role <span style="color:#f87171;">*</span></label>
          ${roleSelectHTML('ruleRoleId', '')}
        </div>
        <div class="form-group" style="margin-bottom:14px;">
          <label style="display:flex;align-items:center;gap:8px;color:#c9d6ff;font-size:0.9em;font-weight:600;cursor:pointer;">
            <input type="checkbox" id="ruleNeverRemove">
            Never remove this role automatically
          </label>
          <div style="margin-top:6px;color:var(--text-secondary);font-size:0.8em;">
            Keep this role even when the member no longer matches this rule.
          </div>
        </div>
        <div id="collectionFields">
          <div class="form-group" style="margin-bottom:14px;">
            <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Tier Name</label>
            <input type="text" id="ruleTierName" placeholder="e.g. Gold Holder" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
            <div class="form-group">
              <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Min NFTs</label>
              <input type="number" id="ruleMinNFTs" value="1" min="0" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
            </div>
            <div class="form-group">
              <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Max NFTs <small style="color:var(--text-secondary);">(blank = INF)</small></label>
              <input type="number" id="ruleMaxNFTs" placeholder="INF" min="0" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
            </div>
          </div>
        </div>
        <div id="traitFields" style="display:none;">
          <div class="form-group" style="margin-bottom:14px;">
            <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Trait Type <span style="color:#f87171;">*</span></label>
            <input type="text" id="ruleTraitType" placeholder="e.g. Background, Headwear, Eyes" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
          </div>
          <div class="form-group" style="margin-bottom:14px;">
            <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Trait Values <span style="color:#f87171;">*</span>
              <small style="color:var(--text-secondary); font-weight:normal;"> \u2014 press Enter or comma to add</small>
            </label>
            <div class="trait-values-container" onclick="document.getElementById('traitValueInput')?.focus()">
              <div id="traitValueTags" class="trait-value-tags"></div>
              <input type="text" id="traitValueInput" placeholder="e.g. Gold" class="trait-value-input"
                onkeydown="onTraitValueKeydown(event)">
            </div>
            <input type="hidden" id="ruleTraitValues">
          </div>
          <div class="form-group" style="margin-bottom:14px;">
            <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Description <small style="color:var(--text-secondary);">(optional)</small></label>
            <input type="text" id="ruleDescription" placeholder="e.g. Gold background holders" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
          </div>
        </div>
        <div id="tokenFields" style="display:none;">
          <div class="form-group" style="margin-bottom:14px;">
            <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Token Mint <span style="color:#f87171;">*</span></label>
            <input type="text" id="ruleTokenMint" placeholder="SPL token mint address" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;font-family:monospace;">
          </div>
          <div class="form-group" style="margin-bottom:14px;">
            <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Token Symbol (optional)</label>
            <input type="text" id="ruleTokenSymbol" placeholder="e.g. CATZ" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
            <div class="form-group">
              <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Minimum Balance</label>
              <input type="number" id="ruleTokenMinAmount" value="0" min="0" step="0.000001" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
            </div>
            <div class="form-group">
              <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Maximum Balance <small style="color:var(--text-secondary);">(blank = INF)</small></label>
              <input type="number" id="ruleTokenMaxAmount" min="0" step="0.000001" placeholder="INF" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
            </div>
          </div>
          <div class="form-group" style="margin-bottom:14px;">
            <label style="display:flex;align-items:center;gap:8px;color:#c9d6ff;font-size:0.9em;font-weight:600;cursor:pointer;">
              <input type="checkbox" id="ruleTokenEnabled" checked>
              Rule Enabled
            </label>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="closeAddRuleModal()">Cancel</button>
        <button class="btn-primary" onclick="saveRule()" id="saveRuleBtn">Save Rule</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function onRuleTypeChange() {
  const selected = document.querySelector('input[name="ruleType"]:checked')?.value || 'collection';
  const isTrait = selected === 'trait';
  const isToken = selected === 'token';
  const collectionIdField = document.getElementById('collectionIdField');
  const collectionFields = document.getElementById('collectionFields');
  const traitFields = document.getElementById('traitFields');
  const tokenFields = document.getElementById('tokenFields');
  if (collectionIdField) collectionIdField.style.display = isToken ? 'none' : '';
  if (collectionFields) collectionFields.style.display = (!isTrait && !isToken) ? '' : 'none';
  if (traitFields) traitFields.style.display = isTrait ? '' : 'none';
  if (tokenFields) tokenFields.style.display = isToken ? '' : 'none';
}

function onTraitValueKeydown(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = e.target.value.trim().replace(/,$/, '');
    if (val) addTraitValueTag(val);
    e.target.value = '';
  } else if (e.key === 'Backspace' && !e.target.value && _traitValues.length) {
    removeTraitValueTag(_traitValues.length - 1);
  }
}

function addTraitValueTag(val) {
  if (_traitValues.includes(val)) return;
  _traitValues.push(val);
  renderTraitValueTags();
}

function removeTraitValueTag(idx) {
  _traitValues.splice(idx, 1);
  renderTraitValueTags();
}

function renderTraitValueTags() {
  const container = document.getElementById('traitValueTags');
  if (!container) return;
  container.innerHTML = _traitValues.map((v, i) => `
    <span class="trait-value-tag">${escapeHtml(v)}<button onclick="removeTraitValueTag(${i})" type="button">\u00D7</button></span>
  `).join('');
  document.getElementById('ruleTraitValues').value = _traitValues.join(',');
  document.getElementById('traitValueInput')?.focus();
}

function openAddRuleModal(editData = null) {
  _ensureAddRuleModal();
  _traitValues = [];
  _editingRuleType = editData?._type || null;
  _editingRuleIdx = editData?._idx ?? null;

  // Reset form
  document.getElementById('ruleCollectionId').value = '';
  document.getElementById('ruleRoleId').value = '';
  document.getElementById('ruleTierName').value = '';
  document.getElementById('ruleMinNFTs').value = '1';
  document.getElementById('ruleMaxNFTs').value = '';
  document.getElementById('ruleTraitType').value = '';
  document.getElementById('ruleDescription').value = '';
  document.getElementById('ruleTokenMint').value = '';
  document.getElementById('ruleTokenSymbol').value = '';
  document.getElementById('ruleTokenMinAmount').value = '0';
  document.getElementById('ruleTokenMaxAmount').value = '';
  document.getElementById('ruleTokenEnabled').checked = true;
  document.getElementById('ruleNeverRemove').checked = false;
  document.getElementById('traitValueTags').innerHTML = '';
  document.getElementById('traitValueInput').value = '';
  document.getElementById('ruleTraitValues').value = '';

  // Set type radio
  let ruleType = 'collection';
  if (editData?._type === 'trait') ruleType = 'trait';
  if (editData?._type === 'token') ruleType = 'token';
  if (ruleType === 'token') document.getElementById('ruleTypeToken').checked = true;
  else if (ruleType === 'trait') document.getElementById('ruleTypeTrait').checked = true;
  else document.getElementById('ruleTypeCollection').checked = true;
  onRuleTypeChange();

  // Populate edit data
  if (editData) {
    const neverRemoveRaw = editData.neverRemove ?? editData.never_remove ?? editData.keepOnLoss ?? editData.keep_on_loss;
    const normalizedNeverRemove = String(neverRemoveRaw ?? '').trim().toLowerCase();
    const neverRemove = neverRemoveRaw === true || neverRemoveRaw === 1 || ['true', '1', 'yes', 'on'].includes(normalizedNeverRemove);
    document.getElementById('ruleNeverRemove').checked = !!neverRemove;
    document.getElementById('ruleRoleId').value = editData.roleId || '';
    document.getElementById('addRuleModalTitle').textContent = 'Edit Verification Rule';

    if (ruleType === 'token') {
      document.getElementById('ruleTokenMint').value = editData.tokenMint || '';
      document.getElementById('ruleTokenSymbol').value = editData.tokenSymbol || '';
      document.getElementById('ruleTokenMinAmount').value = Number(editData.minAmount || 0);
      document.getElementById('ruleTokenMaxAmount').value = editData.maxAmount === null || editData.maxAmount === undefined ? '' : Number(editData.maxAmount);
      document.getElementById('ruleTokenEnabled').checked = editData.enabled !== false;
    } else {
      document.getElementById('ruleCollectionId').value = editData.collectionId || editData.collection_id || editData.trait_collection_id || '';
      if (ruleType === 'trait') {
        document.getElementById('ruleTraitType').value = editData.traitType || editData.trait_type || '';
        document.getElementById('ruleDescription').value = editData.description || '';
        const vals = editData.traitValues || editData.trait_values || (editData.traitValue || editData.trait_value ? [editData.traitValue || editData.trait_value] : []);
        _traitValues = Array.isArray(vals) ? [...vals] : String(vals).split(',').map(v => v.trim()).filter(Boolean);
        renderTraitValueTags();
      } else {
        document.getElementById('ruleTierName').value = editData.name || '';
        document.getElementById('ruleMinNFTs').value = editData.minNFTs ?? 1;
        document.getElementById('ruleMaxNFTs').value = (editData.maxNFTs >= 999999 || editData.maxNFTs === Infinity) ? '' : (editData.maxNFTs ?? '');
      }
    }
  } else {
    document.getElementById('addRuleModalTitle').textContent = 'Add Verification Rule';
  }

  // Populate role dropdown
  populateRoleSelect('ruleRoleId', editData?.roleId || '');

  document.getElementById('addRuleModal').style.display = 'flex';
}

function closeAddRuleModal() {
  document.getElementById('addRuleModal').style.display = 'none';
}

async function saveRule() {
  const selectedType = document.querySelector('input[name="ruleType"]:checked')?.value || 'collection';
  const roleId = document.getElementById('ruleRoleId').value;
  const neverRemove = !!document.getElementById('ruleNeverRemove')?.checked;
  if (!roleId) { showError('Discord Role is required.'); return; }

  const btn = document.getElementById('saveRuleBtn');
  btn.disabled = true; btn.textContent = 'Saving...';

  try {
    if (selectedType === 'token') {
      const tokenMint = document.getElementById('ruleTokenMint').value.trim();
      const tokenSymbol = document.getElementById('ruleTokenSymbol').value.trim();
      const minAmount = Number(document.getElementById('ruleTokenMinAmount').value || '0');
      const maxRaw = document.getElementById('ruleTokenMaxAmount').value;
      const maxAmount = maxRaw === '' ? null : Number(maxRaw);
      const enabled = !!document.getElementById('ruleTokenEnabled').checked;
      if (!tokenMint) { showError('Token mint is required.'); btn.disabled = false; btn.textContent = 'Save Rule'; return; }
      if (!Number.isFinite(minAmount) || minAmount < 0) { showError('Minimum balance must be a valid non-negative number.'); btn.disabled = false; btn.textContent = 'Save Rule'; return; }
      if (maxAmount !== null && (!Number.isFinite(maxAmount) || maxAmount < minAmount)) { showError('Maximum balance must be empty or greater than/equal to minimum balance.'); btn.disabled = false; btn.textContent = 'Save Rule'; return; }

      if (_editingRuleIdx !== null && _editingRuleType === 'token') {
        const existing = adminTokenRulesCache[_editingRuleIdx];
        const response = await fetch(`/api/admin/roles/tokens/${encodeURIComponent(existing.id)}`, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
          body: JSON.stringify({ tokenMint, tokenSymbol: tokenSymbol || null, minAmount, maxAmount, roleId, enabled, neverRemove })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || 'Failed to update token rule');
      } else {
        const response = await fetch('/api/admin/roles/tokens', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
          body: JSON.stringify({ tokenMint, tokenSymbol: tokenSymbol || null, minAmount, maxAmount, roleId, enabled, neverRemove })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || 'Failed to create token rule');
      }
    } else if (selectedType === 'trait') {
      const collectionId = document.getElementById('ruleCollectionId').value.trim();
      if (!collectionId) { showError('Collection ID is required for NFT trait rules.'); btn.disabled = false; btn.textContent = 'Save Rule'; return; }
      const traitType = document.getElementById('ruleTraitType').value.trim();
      const traitValues = [..._traitValues];
      if (!traitType || !traitValues.length) { showError('Trait type and at least one trait value are required.'); btn.disabled = false; btn.textContent = 'Save Rule'; return; }
      const description = document.getElementById('ruleDescription').value.trim();
      const traitValue = traitValues[0];

      if (_editingRuleIdx !== null && _editingRuleType === 'trait') {
        const existing = adminTraitsCache[_editingRuleIdx];
        const origType = existing.traitType || existing.trait_type;
        const origValue = existing.traitValue || existing.trait_value;
        const response = await fetch(`/api/admin/roles/traits/${encodeURIComponent(origType)}/${encodeURIComponent(origValue)}`, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
          body: JSON.stringify({ traitType, traitValue, traitValues, collectionId, roleId, description, neverRemove })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || 'Failed to update trait rule');
      } else {
        const response = await fetch('/api/admin/roles/traits', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
          body: JSON.stringify({ traitType, traitValue, traitValues, collectionId, roleId, description, neverRemove })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || 'Failed to create trait rule');
      }
    } else {
      const collectionId = document.getElementById('ruleCollectionId').value.trim();
      if (!collectionId) { showError('Collection ID is required for NFT collection rules.'); btn.disabled = false; btn.textContent = 'Save Rule'; return; }
      const name = document.getElementById('ruleTierName').value.trim() || 'Tier';
      const minNFTs = parseInt(document.getElementById('ruleMinNFTs').value) || 1;
      const maxNFTsRaw = document.getElementById('ruleMaxNFTs').value;
      const maxNFTs = maxNFTsRaw === '' ? 999999 : parseInt(maxNFTsRaw);

      if (_editingRuleIdx !== null && _editingRuleType === 'tier') {
        const existing = adminTiersCache[_editingRuleIdx];
        const response = await fetch(`/api/admin/roles/tiers/${encodeURIComponent(existing.name)}`, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
          body: JSON.stringify({ name, minNFTs, maxNFTs, votingPower: 1, collectionId, roleId, neverRemove })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || 'Failed to update tier');
      } else {
        const response = await fetch('/api/admin/roles/tiers', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
          body: JSON.stringify({ name, minNFTs, maxNFTs, votingPower: 1, collectionId, roleId, neverRemove })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || 'Failed to create tier');
      }
    }
    closeAddRuleModal();
    await loadAdminRoles();
    showSuccess('Rule saved.');
  } catch(e) {
    showError('Failed to save rule: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Save Rule';
  }
}

function editTier(idx) {
  if (!isAdmin || !adminTiersCache[idx]) return;
  openAddRuleModal({ ...adminTiersCache[idx], _type: 'tier', _idx: idx });
}

function editTraitRule(idx) {
  if (!isAdmin || !adminTraitsCache[idx]) return;
  openAddRuleModal({ ...adminTraitsCache[idx], _type: 'trait', _idx: idx });
}

function editTokenRule(idx) {
  if (!isAdmin || !adminTokenRulesCache[idx]) return;
  openAddRuleModal({ ...adminTokenRulesCache[idx], _type: 'token', _idx: idx });
}

function deleteTier(idx) {
  if (!isAdmin || !adminTiersCache[idx]) return;
  const tier = adminTiersCache[idx];
  showConfirmModal('Delete Tier', `Are you sure you want to delete tier "${tier.name}"? This cannot be undone.`, async () => {
    try {
      const response = await fetch(`/api/admin/roles/tiers/${encodeURIComponent(tier.name)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: buildTenantRequestHeaders()
      });
      const data = await response.json();
      if (data.success) {
        showSuccess(`Tier "${tier.name}" deleted`);
        await loadAdminRoles();
      } else {
        showError(data.message || 'Failed to delete tier');
      }
    } catch (e) {
      showError('Error deleting tier: ' + e.message);
    }
  }, 'Delete');
}

function deleteTraitRule(idx) {
  if (!isAdmin || !adminTraitsCache[idx]) return;
  const tr = adminTraitsCache[idx];
  const traitType = tr.traitType || tr.trait_type;
  const traitValue = tr.traitValue || tr.trait_value;
  showConfirmModal('Delete Trait Rule', `Delete trait rule "${traitType}: ${traitValue}"? This cannot be undone.`, async () => {
    try {
      const response = await fetch(`/api/admin/roles/traits/${encodeURIComponent(traitType)}/${encodeURIComponent(traitValue)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: buildTenantRequestHeaders()
      });
      const data = await response.json();
      if (data.success) {
        showSuccess('Trait rule deleted');
        await loadAdminRoles();
      } else {
        showError(data.message || 'Failed to delete trait rule');
      }
    } catch (e) {
      showError('Error deleting trait rule: ' + e.message);
    }
  }, 'Delete');
}

function deleteTokenRule(idx) {
  if (!isAdmin || !adminTokenRulesCache[idx]) return;
  const rule = adminTokenRulesCache[idx];
  showConfirmModal('Delete Token Rule', `Delete token rule for mint "${rule.tokenMint}"? This cannot be undone.`, async () => {
    try {
      const response = await fetch(`/api/admin/roles/tokens/${encodeURIComponent(rule.id)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: buildTenantRequestHeaders()
      });
      const data = await response.json();
      if (data.success) {
        showSuccess('Token rule deleted');
        await loadAdminRoles();
      } else {
        showError(data.message || 'Failed to delete token rule');
      }
    } catch (e) {
      showError('Error deleting token rule: ' + e.message);
    }
  }, 'Delete');
}

function exportVerificationRoles() {
  if (!isAdmin) return;

  try {
    const content = document.getElementById('adminRolesContent');
    const table = content.querySelector('table');
    if (!table) {
      showError('No roles table found');
      return;
    }

    // Build CSV from table
    const rows = [];
    const headers = [];
    table.querySelectorAll('thead th').forEach(th => {
      headers.push(th.textContent.trim());
    });
    rows.push(headers.join(','));

    table.querySelectorAll('tbody tr').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('td').forEach((td, idx) => {
        if (idx < headers.length - 1) { // skip Actions column
          cells.push(`"${td.textContent.trim()}"`);
        }
      });
      rows.push(cells.join(','));
    });

    // Download CSV
    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `verification-roles-${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showSuccess('Roles exported to CSV');
  } catch (e) {
    showError('Error exporting roles: ' + e.message);
  }
}

function reverifyAllRoles() {
  if (!isAdmin) return;
  showConfirmModal('Reverify All Roles', 'Are you sure? This will re-sync all role assignments across the Discord server.', async () => {
    try {
      const btn = document.querySelector('[onclick="reverifyAllRoles()"]');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span>⏳</span><span>Syncing...</span>';
      }

      const response = await fetch('/api/admin/roles/sync', { method: 'POST', credentials: 'include' });
      const data = await response.json();

      if (data.success) {
        showSuccess(`Roles synced successfully (${data.usersProcessed || 0} users updated)`);
        await loadAdminRoles();
      } else {
        showError(data.message || 'Sync failed');
      }
    } catch (e) {
      showError('Error syncing roles: ' + e.message);
    } finally {
      const btn = document.querySelector('[onclick="reverifyAllRoles()"]');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span>🔄</span><span>Reverify All</span>';
      }
    }
  });
}



async function loadAdminStats() {
  if (!isAdmin) return;
  const content = document.getElementById('adminStatsContent');
  if (!content) return;

  try {
    const [usersRes, proposalsRes] = await Promise.all([
      fetch('/api/admin/users', { credentials: 'include' }),
      fetch('/api/admin/proposals', { credentials: 'include' })
    ]);
    const usersData = await usersRes.json();
    const proposalsData = await proposalsRes.json();

    const users = usersData.users || [];
    const proposals = proposalsData.proposals || [];
    const verified = users.filter(u => u.total_nfts > 0).length;
    const pending = users.length - verified;

    document.getElementById('statTotalUsers').textContent = users.length;
    document.getElementById('statVerified').textContent = verified;
    document.getElementById('statPending').textContent = pending;
    
    const now = new Date();
    document.getElementById('statLastSync').textContent = now.toLocaleTimeString();
  } catch (e) {
    console.error('Error loading stats:', e);
    document.getElementById('statTotalUsers').textContent = '—';
    document.getElementById('statVerified').textContent = '—';
    document.getElementById('statPending').textContent = '—';
  }
}

let adminUsersCache = [];

async function loadAdminUsers() {
  if (!isAdmin) return;

  const content = document.getElementById('adminUsersContent');
  const btn = document.getElementById('adminUsersRefreshBtn');
  if (!content) return;

  const originalBtn = btn ? btn.innerHTML : null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span><span>Loading...</span>';
  }

  content.innerHTML = `
    <div style="text-align:center; padding: var(--space-5); color: var(--text-secondary);">
      <div class="spinner"></div>
      <p>Loading users...</p>
    </div>
  `;

  try {
    const response = await fetch('/api/admin/users', { credentials: 'include' });
    const data = await response.json();

    if (!data.success) {
      content.innerHTML = `<div class="error-state"><div class="error-message">${escapeHtml(data.message || 'Failed to load users')}</div></div>`;
      return;
    }

    const users = data.users || [];
    adminUsersCache = users; // Cache for search/filter

    if (!users.length) {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-title">No users found</div></div>`;
      return;
    }

    renderAdminUsersTable(users);

    // Attach search listener
    const searchInput = document.getElementById('adminUsersSearchInput');
    if (searchInput) {
      searchInput.value = '';
      searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = adminUsersCache.filter(u => {
          const name = (u.username || u.discord_username || '').toLowerCase();
          const did = String(u.discord_id || u.discordId || '').toLowerCase();
          const tier = (u.tier || '').toLowerCase();
          return name.includes(query) || did.includes(query) || tier.includes(query);
        });
        renderAdminUsersTable(filtered);
      });
    }
  } catch (error) {
    console.error('Error loading admin users:', error);
    content.innerHTML = `<div class="error-state"><div class="error-message">Failed to load users: ${escapeHtml(error.message)}</div></div>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalBtn;
    }
  }
}

function renderAdminUsersTable(users) {
  const content = document.getElementById('adminUsersContent');
  if (!content) return;

  const rows = users.slice(0, 100).map(u => {
    const tier = u.tier || 'none';
    const vp = u.voting_power ?? u.votingPower ?? 0;
    const nfts = u.total_nfts ?? u.totalNFTs ?? 0;
    const name = u.username || u.discord_username || 'Unknown';
    const did = u.discord_id || u.discordId || '—';
    const safeDid = String(did || '');
    const safeNameEncoded = encodeURIComponent(String(name || 'Unknown'));

    return `
      <tr>
        <td style="padding:8px; border-bottom:1px solid var(--border-default);">${escapeHtml(name)}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-default); font-family:monospace; font-size:0.85em;">${escapeHtml(String(did))}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-default);">${escapeHtml(String(tier))}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-default);">${nfts}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-default);">${vp}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-default); text-align:right; white-space:nowrap;">
          <button class="admin-user-detail-btn" data-discord-id="${escapeHtml(safeDid)}" style="width:32px; height:28px; background:rgba(99,102,241,0.2); border:1px solid rgba(99,102,241,0.35); border-radius:6px; cursor:pointer; color:#818cf8; font-size:0.75em;" title="View Details">View</button>
          <button class="admin-user-remove-btn" data-discord-id="${escapeHtml(safeDid)}" data-username-enc="${escapeHtml(safeNameEncoded)}" style="width:32px; height:28px; background:rgba(239,68,68,0.2); border:1px solid rgba(239,68,68,0.35); border-radius:6px; cursor:pointer; color:#fca5a5; font-size:0.75em; margin-left:4px;" title="Remove User">Del</button>
        </td>
      </tr>
    `;
  }).join('');

  content.innerHTML = `
    <div style="margin-bottom:10px; color: var(--text-secondary); font-size: 0.9em;">Showing ${Math.min(users.length, 100)} of ${users.length} users</div>
    <div style="overflow:auto; border:1px solid var(--border-default); border-radius:8px;">
      <table style="width:100%; border-collapse:collapse; font-size: 0.92em;">
        <thead>
          <tr style="background: var(--bg-tertiary); text-align:left;">
            <th style="padding:8px;">Username</th>
            <th style="padding:8px;">Discord ID</th>
            <th style="padding:8px;">Tier</th>
            <th style="padding:8px;">NFTs</th>
            <th style="padding:8px;">VP</th>
            <th style="padding:8px; text-align:right;">Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  content.querySelectorAll('.admin-user-detail-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const discordId = String(btn.getAttribute('data-discord-id') || '').trim();
      if (!discordId) return;
      viewUserDetails(discordId);
    });
  });

  content.querySelectorAll('.admin-user-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const discordId = String(btn.getAttribute('data-discord-id') || '').trim();
      if (!discordId) return;
      const encodedName = String(btn.getAttribute('data-username-enc') || '').trim();
      const username = encodedName ? decodeURIComponent(encodedName) : 'User';
      confirmRemoveUser(discordId, username);
    });
  });
}

async function viewUserDetails(discordId) {
  if (!isAdmin) return;
  try {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(discordId)}`, { credentials: 'include' });
    const data = await response.json();
    if (!data.success) { showError(data.message || 'Failed to load user'); return; }

    const u = data.user || {};
    const wallets = data.wallets || [];
    const proposals = data.proposals || [];
    const votes = data.votes || [];

    showConfirmModal('User Details', '', null);
    document.getElementById('confirmTitle').textContent = `👤 ${u.username || 'User'} (${discordId})`;
    document.getElementById('confirmButton').style.display = 'none';
    document.getElementById('confirmMessage').innerHTML = `
      <div style="display:grid; gap:12px; font-size:0.9em;">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
          <div><strong style="color:#c9d6ff;">Tier:</strong> ${escapeHtml(u.tier || 'None')}</div>
          <div><strong style="color:#c9d6ff;">NFTs:</strong> ${u.total_nfts || 0}</div>
          <div><strong style="color:#c9d6ff;">Voting Power:</strong> ${u.voting_power || 0}</div>
          <div><strong style="color:#c9d6ff;">Wallets:</strong> ${wallets.length}</div>
        </div>
        ${wallets.length ? `<div><strong style="color:#c9d6ff;">Wallet Addresses:</strong><div style="font-family:monospace; font-size:0.85em; color:#93c5fd; margin-top:4px;">${wallets.map(w => escapeHtml(w.wallet_address)).join('<br>')}</div></div>` : ''}
        <div><strong style="color:#c9d6ff;">Proposals:</strong> ${proposals.length} | <strong style="color:#c9d6ff;">Votes:</strong> ${votes.length}</div>
      </div>`;
  } catch (e) {
    showError('Error loading user details: ' + e.message);
  }
}

function confirmRemoveUser(discordId, username) {
  if (!isAdmin) return;
  showConfirmModal('Remove User', `Are you sure you want to remove "${username}" (${discordId})? This will delete their data and cannot be undone.`, async () => {
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(discordId)}`, { method: 'DELETE', credentials: 'include' });
      const data = await response.json();
      if (data.success) {
        showSuccess(`User "${username}" removed`);
        await loadAdminUsers();
      } else {
        showError(data.message || 'Failed to remove user');
      }
    } catch (e) {
      showError('Error removing user: ' + e.message);
    }
  }, 'Remove User');
}

// ==================== TREASURY TRACKER ====================
async function loadTreasuryTrackerView() {
  const content = document.getElementById('treasuryTrackerView');
  if (!content) return;

  content.innerHTML = `<div style="text-align:center; padding: var(--space-5);"><div class="spinner"></div><p>Loading...</p></div>`;

  try {
    const response = await fetch('/api/admin/settings', { credentials: 'include' });
    const data = await response.json();
    
    // Try to get treasury-specific config
    let treasuryConfig = {};
    try {
      const tRes = await fetch('/api/public/v1/treasury', { credentials: 'include' });
      const tData = await tRes.json();
      if (tData.success) treasuryConfig = tData.treasury || {};
    } catch(e) {}

    const walletAddr = treasuryConfig.wallet_address || data?.settings?.treasuryWallet || 'Not configured';
    const refreshInterval = treasuryConfig.refresh_interval || data?.settings?.treasuryInterval || 'Unknown';
    const lastSync = treasuryConfig.last_updated ? new Date(treasuryConfig.last_updated).toLocaleString() : 'Never';
    const alertsEnabled = treasuryConfig.tx_alerts_enabled ?? data?.settings?.treasuryAlerts ?? false;
    const alertChannel = treasuryConfig.tx_alerts_channel || data?.settings?.treasuryAlertsChannel || 'Not set';

    let html = `
      <div style="display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(220px,1fr));">
        <div style="padding:16px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.18); border-radius:10px;">
          <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:6px;">Wallet Address</div>
          <div style="color:#e0e7ff; font-family:monospace; font-size:0.85em; word-break:break-all;">${escapeHtml(String(walletAddr))}</div>
        </div>
        <div style="padding:16px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.18); border-radius:10px;">
          <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:6px;">Refresh Interval</div>
          <div style="color:#e0e7ff; font-size:1.1em; font-weight:600;">${escapeHtml(String(refreshInterval))}</div>
        </div>
        <div style="padding:16px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.18); border-radius:10px;">
          <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:6px;">Last Sync</div>
          <div style="color:#e0e7ff; font-size:1em;">${escapeHtml(lastSync)}</div>
        </div>
        <div style="padding:16px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.18); border-radius:10px;">
          <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:6px;">Transaction Alerts</div>
          <div style="color:${alertsEnabled ? '#10b981' : '#ef4444'}; font-size:1.1em; font-weight:600;">${alertsEnabled ? '✅ Enabled' : '❌ Disabled'}</div>
          <div style="color:var(--text-secondary); font-size:0.8em; margin-top:4px;">Channel: ${escapeHtml(String(alertChannel))}</div>
        </div>
      </div>
    `;

    if (isAdmin) {
      html += `
        <div style="margin-top:16px;">
          <button class="btn-primary" onclick="openTreasuryConfigModal()" style="font-size:0.85em; padding:8px 16px;">⚙️ Edit Tracker Config</button>
        </div>
      `;
    }

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div style="color:var(--text-secondary); text-align:center; padding:20px;">Treasury tracker config unavailable — admin access may be required.</div>`;
  }
}

function openTreasuryConfigModal() {
  if (!isAdmin) return;
  showConfirmModal('Edit Treasury Config', '', null);
  const title = document.getElementById('confirmTitle');
  const body = document.getElementById('confirmMessage');
  const btn = document.getElementById('confirmButton');
  title.textContent = '⚙️ Treasury Tracker Configuration';
  btn.textContent = 'Save Config';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-primary');
  body.innerHTML = `
    <div style="display:grid; gap:14px;">
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Treasury Wallet Address</label>
        <input id="treasuryWalletInput" type="text" placeholder="Solana wallet address" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; font-family:monospace;"></div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Refresh Interval (hours)</label>
        <input id="treasuryIntervalInput" type="number" min="1" max="168" step="1" placeholder="6" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;"></div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Watch Channel ID</label>
        <input id="treasuryWatchChannelInput" type="text" placeholder="Discord channel ID for treasury panel updates" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; font-family:monospace;"></div>
      <div><label style="display:flex; align-items:center; gap:8px; color:#c9d6ff;">
        <input id="treasuryAlertsEnabledInput" type="checkbox" style="width:18px; height:18px;">
        <span>Enable transaction alerts</span>
      </label></div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Alert Channel ID</label>
        <input id="treasuryAlertChannelInput" type="text" placeholder="Discord channel ID for alerts" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; font-family:monospace;"></div>
      <div><label style="display:flex; align-items:center; gap:8px; color:#c9d6ff;">
        <input id="treasuryIncomingOnlyInput" type="checkbox" style="width:18px; height:18px;">
        <span>Incoming only</span>
      </label></div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Minimum SOL to alert on</label>
        <input id="treasuryMinSolInput" type="number" min="0" step="0.1" placeholder="0" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;"></div>
    </div>
    <p style="color:var(--text-secondary); font-size:0.8em; margin-top:12px;">💡 These settings are also configurable via Discord: /treasury admin set-wallet, set-interval, tx-alerts</p>
  `;
  confirmCallback = async () => {
    const wallet = document.getElementById('treasuryWalletInput')?.value.trim();
    const refreshHours = parseInt(document.getElementById('treasuryIntervalInput')?.value, 10);
    const watchChannelId = document.getElementById('treasuryWatchChannelInput')?.value.trim();
    const alertsEnabled = document.getElementById('treasuryAlertsEnabledInput')?.checked;
    const txAlertChannelId = document.getElementById('treasuryAlertChannelInput')?.value.trim();
    const txAlertIncomingOnly = document.getElementById('treasuryIncomingOnlyInput')?.checked;
    const txAlertMinSol = parseFloat(document.getElementById('treasuryMinSolInput')?.value || '0');
    try {
      const payload = {
        enabled: true,
        solanaWallet: wallet || undefined,
        refreshHours: Number.isFinite(refreshHours) ? refreshHours : undefined,
        watchChannelId: watchChannelId || undefined,
        txAlertsEnabled: alertsEnabled,
        txAlertChannelId: txAlertChannelId || undefined,
        txAlertIncomingOnly,
        txAlertMinSol: Number.isFinite(txAlertMinSol) ? txAlertMinSol : 0
      };

      await fetch('/api/admin/treasury/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      showSuccess('Treasury config updated. Changes may take a moment to apply.');
      loadTreasuryTrackerView();
    } catch (e) {
      showError('Error updating config: ' + e.message);
    }
  };
}

// ==================== NFT ACTIVITY TRACKER ====================
async function loadNFTActivityView() {
  const container = document.getElementById('nftActivityPublicView');
  if (!container) return;

  // Inject shared settings panel into tracker tab (same as Settings → NFT Tracker)
  if (isAdmin) {
    const settingsPanel = document.getElementById('nftActivityTrackerSettingsPanel');
    if (settingsPanel) {
      settingsPanel.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-secondary);"><div class="spinner"></div><p>Loading tracker settings...</p></div>`;
      await loadNftTrackerSettingsView('nftActivityTrackerSettingsPanel');
    }
  }

  container.innerHTML = `<div style="text-align:center; padding: var(--space-5);"><div class="spinner"></div><p>Loading...</p></div>`;

  try {
    const activityRes = await (isAdmin
      ? fetch('/api/admin/nft-activity/events?limit=20', { credentials: 'include', headers: buildTenantRequestHeaders() })
      : (() => {
          const endpoint = buildPublicV1Url('/api/public/v1/nft/activity?limit=20', { requireGuild: true });
          if (!endpoint) return Promise.resolve(null);
          return fetch(endpoint, { credentials: 'include' });
        })()
    ).catch(() => null);

    const activityData = activityRes ? await activityRes.json() : {};
    const events = activityData?.data?.events || activityData?.events || [];

    let html = '';
    if (events.length > 0) {
      html += `<div style="display:grid; gap:12px; margin-bottom:16px;">${events.slice(0, 10).map((event) => `
        <div style="padding:16px; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.22); border-radius:10px;">
          <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
            <div>
              <div style="color:#e0e7ff; font-weight:600; margin-bottom:4px;">${escapeHtml(event.eventType || event.event_type || 'activity')}</div>
              <div style="color:var(--text-secondary); font-size:0.85em;">${escapeHtml(event.collectionKey || event.collection_key || 'Unscoped')}</div>
              <div style="color:var(--text-secondary); font-size:0.82em; margin-top:4px;">${escapeHtml(event.tokenName || event.token_name || '')}</div>
            </div>
            <div style="color:var(--text-secondary); font-size:0.82em; white-space:nowrap;">${event.eventTime ? new Date(event.eventTime).toLocaleString() : ''}</div>
          </div>
        </div>
      `).join('')}</div>`;
    } else {
      html += '<p style="text-align:center; padding:20px; color:var(--text-secondary);">No recent NFT activity yet.</p>';
    }

    container.innerHTML = html;
  } catch (error) {
    console.error('Error loading NFT activity:', error);
    container.innerHTML = '<p style="color:#ef4444;">Failed to load NFT activity</p>';
  }
}

async function loadTokenActivityView() {
  const container = document.getElementById('tokenActivityPublicView');
  if (!container) return;

  if (isAdmin) {
    const settingsPanel = document.getElementById('tokenActivityTrackerSettingsPanel');
    if (settingsPanel) {
      settingsPanel.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-secondary);"><div class="spinner"></div><p>Loading token tracker settings...</p></div>`;
      await loadTokenTrackerSettingsView('tokenActivityTrackerSettingsPanel');
    }
  }

  if (!isAdmin) {
    container.innerHTML = '<p style="text-align:center; padding:20px; color:var(--text-secondary);">Token activity is available to server admins.</p>';
    return;
  }

  container.innerHTML = `<div style="text-align:center; padding: var(--space-5);"><div class="spinner"></div><p>Loading token activity...</p></div>`;

  try {
    const response = await fetch('/api/admin/token-tracker/token-events?limit=20', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const data = await response.json();
    const events = (response.ok && data.success !== false && Array.isArray(data.events)) ? data.events : [];

    if (!events.length) {
      container.innerHTML = '<p style="text-align:center; padding:20px; color:var(--text-secondary);">No recent token activity yet.</p>';
      return;
    }

    const rows = events.slice(0, 20).map(evt => {
      const type = String(evt.event_type || 'activity').toUpperCase();
      const tokenName = evt.token_symbol || evt.token_name || (evt.token_mint ? `${String(evt.token_mint).slice(0, 4)}...${String(evt.token_mint).slice(-4)}` : 'Token');
      const amount = Number(evt.amount_delta || 0).toLocaleString(undefined, { maximumFractionDigits: 6 });
      const when = evt.event_time ? new Date(evt.event_time).toLocaleString() : 'Unknown';
      const wallet = String(evt.wallet_address || '');
      const walletShort = wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : '—';
      return `
        <div style="padding:16px; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.22); border-radius:10px;">
          <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
            <div>
              <div style="color:#e0e7ff; font-weight:600; margin-bottom:4px;">${escapeHtml(type)} ${escapeHtml(tokenName)}</div>
              <div style="color:var(--text-secondary); font-size:0.85em;">Amount: ${escapeHtml(amount)} · Wallet: <span style="font-family:monospace;">${escapeHtml(walletShort)}</span></div>
            </div>
            <div style="color:var(--text-secondary); font-size:0.82em; white-space:nowrap;">${escapeHtml(when)}</div>
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = `<div style="display:grid; gap:12px; margin-bottom:16px;">${rows}</div>`;
  } catch (error) {
    console.error('Error loading token activity:', error);
    container.innerHTML = '<p style="color:#ef4444;">Failed to load token activity</p>';
  }
}

async function loadAdminActivity() {
  if (!isAdmin) return;
  const content = document.getElementById('adminActivityContent');
  if (!content) return;

  content.innerHTML = `<div style="text-align:center; padding: var(--space-5); color: var(--text-secondary);"><div class="spinner"></div><p>Loading activity...</p></div>`;

  try {
    // Build activity from real data (proposals + users)
    const [usersRes, proposalsRes] = await Promise.all([
      fetch('/api/admin/users', { credentials: 'include' }),
      fetch('/api/admin/proposals', { credentials: 'include' })
    ]);
    const usersData = await usersRes.json();
    const proposalsData = await proposalsRes.json();

    const activities = [];
    
    // Recent proposals
    (proposalsData.proposals || []).slice(0, 10).forEach(p => {
      activities.push({
        action: `Proposal ${p.status === 'voting' ? 'active' : p.status}: ${p.title || 'Untitled'}`,
        user: p.creator_id || 'Unknown',
        time: p.created_at ? formatDate(new Date(p.created_at)) : 'Unknown',
        type: 'proposal',
        date: new Date(p.created_at || 0)
      });
    });

    // Recent users (by wallet count as proxy for activity)
    (usersData.users || []).filter(u => u.total_nfts > 0).slice(0, 5).forEach(u => {
      activities.push({
        action: `Verified: ${u.username || 'User'} (${u.total_nfts} NFTs, ${u.tier || 'none'})`,
        user: u.discord_id || '',
        time: 'Active member',
        type: 'verify',
        date: new Date(0)
      });
    });

    activities.sort((a, b) => b.date - a.date);

    if (!activities.length) {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-title">No activity yet</div></div>`;
      return;
    }

    const rows = activities.slice(0, 15).map(a => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px; border-bottom:1px solid rgba(99,102,241,0.15); gap:12px;">
        <div style="display:flex; align-items:center; gap:12px; flex:1;">
          <div style="font-size:1.2em;">
            ${a.type === 'verify' ? '✓' : a.type === 'sync' ? '🔄' : a.type === 'proposal' ? '📜' : a.type === 'treasury' ? '💰' : '👤'}
          </div>
          <div>
            <div style="color:#e0e7ff; font-weight:600;">${escapeHtml(a.action)}</div>
            <div style="color:var(--text-secondary); font-size:0.85em;">${escapeHtml(a.user)}</div>
          </div>
        </div>
        <div style="color:var(--text-secondary); font-size:0.85em; white-space:nowrap;">${a.time}</div>
      </div>
    `).join('');

    content.innerHTML = `
      <div style="border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.5); overflow:hidden;">
        ${rows}
      </div>
      <div style="margin-top:12px; color:var(--text-secondary); font-size:0.9em;">Activity derived from proposals and verified users</div>
    `;
  } catch (e) {
    content.innerHTML = `<div class="error-state"><div class="error-message">${escapeHtml(e.message)}</div></div>`;
  }
}
async function loadNFTActivityAdminView(preloadedCollections = null) {
  if (!isAdmin) return;

  const container = document.getElementById('nftActivityAdminView');
  if (!container) return;

  try {
    let collections = preloadedCollections;
    if (!collections) {
      const response = await fetch('/api/admin/nft-tracker/collections', { credentials: 'include', headers: buildTenantRequestHeaders() });
      const data = await response.json();
      collections = data.success ? (data.collections || []) : [];
    }

    container.innerHTML = `
      <div style="display:grid; gap:12px;">
        <div style="display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr));">
          <button class="btn-primary" onclick="openNftActivityAddCollectionModal()" style="justify-content:center;">
            <span>➕</span>
            <span>Add Collection</span>
          </button>
        </div>
        <div id="nftActivityAdminList" style="margin-top:8px;"></div>
      </div>
    `;

    const listEl = document.getElementById('nftActivityAdminList');
    if (!collections.length) {
      listEl.innerHTML = `<div style="color:var(--text-secondary); text-align:center; padding:12px;">No watched collections. Add one above.</div>`;
      return;
    }

    const rows = collections.map(col => {
      const name = col.collection_name || col.collectionName || col.name || 'Unknown';
      const addr = col.collection_address || col.collectionAddress || '';
      const isEnabled = col.enabled !== 0 && col.enabled !== false;
      return `
        <div style="padding:10px 14px; border-bottom:1px solid rgba(99,102,241,0.12); display:flex; justify-content:space-between; align-items:center; gap:12px;">
          <div>
            <div style="color:#e0e7ff; font-weight:600;">${escapeHtml(name)}</div>
            <div style="color:var(--text-secondary); font-size:0.8em; font-family:monospace;">${escapeHtml(addr)}</div>
          </div>
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="color:${isEnabled ? '#10b981' : '#ef4444'}; font-size:0.85em;">${isEnabled ? '● Enabled' : '● Disabled'}</span>
            <button class="nft-activity-edit-btn" data-id="${escapeHtml(String(col.id))}" data-name="${escapeHtml(name)}" data-addr="${escapeHtml(addr)}" data-me="${escapeHtml(col.me_symbol||'')}" data-channel="${escapeHtml(col.channel_id||'')}" style="font-size:0.8em;padding:6px 12px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;">✏️ Edit</button>
            <button class="nft-activity-remove-btn btn-danger" data-id="${escapeHtml(String(col.id))}" data-name="${escapeHtml(name)}" style="font-size:0.8em; padding:6px 12px;">
              <span>🗑️</span><span>Remove</span>
            </button>
          </div>
        </div>
      `;
    }).join('');

    listEl.innerHTML = `<div style="border:1px solid rgba(99,102,241,0.22); border-radius:10px; overflow:hidden;">${rows}</div>`;
    listEl.querySelectorAll('.nft-activity-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => openEditCollectionModal(btn.dataset.id, btn.dataset.name, btn.dataset.addr, btn.dataset.me, btn.dataset.channel));
    });
    listEl.querySelectorAll('.nft-activity-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => removeWatchedCollection(btn.dataset.id, btn.dataset.name));
    });
  } catch (error) {
    console.error('Error loading NFT activity admin:', error);
    container.innerHTML = `<div style="color:#ef4444; padding:12px;">Error loading watchlist: ${escapeHtml(error.message)}</div>`;
  }
}

async function openEditCollectionModal(id, name, addr, meSymbol, channelId) {
  if (!isAdmin) return;
  const old = document.getElementById('collEditOverlay');
  if (old) old.remove();

  const fi = 'width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;';
  const lb = 'display:block;color:#c9d6ff;font-size:0.9em;font-weight:600;margin-bottom:6px;';

  const overlay = document.createElement('div');
  overlay.id = 'collEditOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:var(--card-bg,#1e293b);border:1px solid rgba(99,102,241,0.3);border-radius:12px;padding:24px;width:480px;max-width:95vw;max-height:90vh;overflow-y:auto;">
      <h3 style="margin:0 0 16px;color:var(--text-primary,#e0e7ff);">✏️ Edit Collection</h3>
      <div style="display:grid;gap:14px;">
        <div><label style="${lb}">Collection Name</label><input type="text" id="ceNameInput" value="${escapeHtml(name)}" style="${fi}"></div>
        <div><label style="${lb}">Alert Channel</label><select id="ceChannelInput" style="${fi}"><option value="">Loading...</option></select></div>
        <div><label style="${lb}">Magic Eden Symbol</label><input type="text" id="ceMeInput" value="${escapeHtml(meSymbol||'')}" placeholder="vault_runners" style="${fi}"></div>
        <div style="color:#94a3b8;font-size:0.8em;font-family:monospace;">${escapeHtml(addr)}</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:20px;">
        <button id="ceSaveBtn" style="padding:8px 18px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:0.85em;font-weight:600;cursor:pointer;">Save</button>
        <button id="ceCancelBtn" style="padding:8px 18px;background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,0.12);border-radius:8px;font-size:0.85em;cursor:pointer;">Cancel</button>
        <span id="ceFeedback" style="font-size:0.85em;font-weight:600;"></span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Populate channel dropdown
  const sel = document.getElementById('ceChannelInput');
  try {
    const chRes = await fetch('/api/admin/discord/channels', { credentials: 'include', headers: buildTenantRequestHeaders() });
    if (chRes.ok) {
      const chData = await chRes.json();
      const channels = chData.channels || [];
      const grouped = {};
      channels.forEach(ch => { const p = ch.parentName || 'Other'; if (!grouped[p]) grouped[p] = []; grouped[p].push(ch); });
      sel.innerHTML = '<option value="">-- Select channel --</option>';
      Object.keys(grouped).sort().forEach(parent => {
        const og = document.createElement('optgroup'); og.label = parent;
        grouped[parent].forEach(ch => { const o = document.createElement('option'); o.value = ch.id; o.textContent = '# ' + ch.name; og.appendChild(o); });
        sel.appendChild(og);
      });
    }
  } catch (e) { sel.innerHTML = '<option value="">-- Could not load channels --</option>'; }
  if (channelId) sel.value = channelId;

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('ceCancelBtn').addEventListener('click', () => overlay.remove());
  document.getElementById('ceSaveBtn').addEventListener('click', async () => {
    const saveBtn = document.getElementById('ceSaveBtn');
    const feedback = document.getElementById('ceFeedback');
    const newName = document.getElementById('ceNameInput').value.trim();
    const newChannel = document.getElementById('ceChannelInput').value;
    const newMe = document.getElementById('ceMeInput').value.trim();
    if (!newName) { if (feedback) { feedback.style.color='#fca5a5'; feedback.textContent='Name is required'; } return; }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
      const res = await fetch(`/api/admin/nft-tracker/collections/${encodeURIComponent(id)}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
        body: JSON.stringify({ collectionName: newName, channelId: newChannel, meSymbol: newMe })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        overlay.remove();
        showSuccess('Collection updated');
        loadNFTActivityView();
        loadNFTActivityAdminView();
      } else {
        if (feedback) { feedback.style.color = '#fca5a5'; feedback.textContent = data.message || 'Failed to save'; }
      }
    } catch (err) {
      if (feedback) { feedback.style.color = '#fca5a5'; feedback.textContent = 'Network error'; }
    }
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
  });
}

async function openNftActivityAddCollectionModal() {
  if (!isAdmin) return;
  const old = document.getElementById('collAddOverlay');
  if (old) old.remove();

  const fi = 'width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;';
  const lb = 'display:block;color:#c9d6ff;font-size:0.9em;font-weight:600;margin-bottom:6px;';

  const overlay = document.createElement('div');
  overlay.id = 'collAddOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:var(--card-bg,#1e293b);border:1px solid rgba(99,102,241,0.3);border-radius:12px;padding:24px;width:500px;max-width:95vw;max-height:90vh;overflow-y:auto;">
      <h3 style="margin:0 0 16px;color:var(--text-primary,#e0e7ff);">➕ Watch New Collection</h3>
      <div style="display:grid;gap:14px;">
        <div><label style="${lb}">Collection Address *</label><input type="text" id="caAddrInput" placeholder="Solana collection address" style="${fi}font-family:monospace;"></div>
        <div><label style="${lb}">Collection Name *</label><input type="text" id="caNameInput" placeholder="e.g. Vault Runners" style="${fi}"></div>
        <div><label style="${lb}">Alert Channel</label><select id="caChannelInput" style="${fi}"><option value="">Loading...</option></select></div>
        <div><label style="${lb}">Magic Eden Symbol <small style="color:#94a3b8;">(e.g. vault_runners)</small></label><input type="text" id="caMeInput" placeholder="vault_runners" style="${fi}"></div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;">
          <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="caMint" checked> 🪙 Mint</label>
          <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="caSale" checked> 💰 Sale</label>
          <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="caBid" checked> 🤝 Bid</label>
          <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="caList" checked> 📋 List</label>
          <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="caDelist" checked> ❌ Delist</label>
          <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="caTransfer"> 🔄 Transfer</label>
        </div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:20px;">
        <button id="caAddBtn" style="padding:8px 18px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:0.85em;font-weight:600;cursor:pointer;">Add Collection</button>
        <button id="caCancelBtn" style="padding:8px 18px;background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,0.12);border-radius:8px;font-size:0.85em;cursor:pointer;">Cancel</button>
        <span id="caFeedback" style="font-size:0.85em;font-weight:600;"></span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Populate channel dropdown
  const sel = document.getElementById('caChannelInput');
  try {
    const chRes = await fetch('/api/admin/discord/channels', { credentials: 'include', headers: buildTenantRequestHeaders() });
    if (chRes.ok) {
      const chData = await chRes.json();
      const channels = chData.channels || [];
      const grouped = {};
      channels.forEach(ch => { const p = ch.parentName || 'Other'; if (!grouped[p]) grouped[p] = []; grouped[p].push(ch); });
      sel.innerHTML = '<option value="">-- Select channel (optional) --</option>';
      Object.keys(grouped).sort().forEach(parent => {
        const og = document.createElement('optgroup'); og.label = parent;
        grouped[parent].forEach(ch => { const o = document.createElement('option'); o.value = ch.id; o.textContent = '# ' + ch.name; og.appendChild(o); });
        sel.appendChild(og);
      });
    }
  } catch (e) { sel.innerHTML = '<option value="">-- Could not load channels --</option>'; }

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('caCancelBtn').addEventListener('click', () => overlay.remove());
  document.getElementById('caAddBtn').addEventListener('click', async () => {
    const addBtn = document.getElementById('caAddBtn');
    const feedback = document.getElementById('caFeedback');
    const addr = document.getElementById('caAddrInput').value.trim();
    const name = document.getElementById('caNameInput').value.trim();
    const chId = document.getElementById('caChannelInput').value;
    if (!addr || !name) { if (feedback) { feedback.style.color='#fca5a5'; feedback.textContent='Address and name are required'; } return; }
    addBtn.disabled = true; addBtn.textContent = 'Adding...';
    try {
      const res = await fetch('/api/admin/nft-tracker/collections', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
        body: JSON.stringify({
          collectionAddress: addr, collectionName: name, channelId: chId,
          meSymbol: document.getElementById('caMeInput').value.trim(),
          trackMint: !!document.getElementById('caMint').checked,
          trackSale: !!document.getElementById('caSale').checked,
          trackBid: !!document.getElementById('caBid').checked,
          trackList: !!document.getElementById('caList').checked,
          trackDelist: !!document.getElementById('caDelist').checked,
          trackTransfer: !!document.getElementById('caTransfer').checked,
        })
      });
      const data = await res.json();
      if (res.ok && data.success !== false) {
        overlay.remove(); showSuccess('Collection added!');
        loadNFTActivityView(); loadNFTActivityAdminView();
      } else {
        if (feedback) { feedback.style.color='#fca5a5'; feedback.textContent = data.message || 'Failed to add'; }
      }
    } catch (err) { if (feedback) { feedback.style.color='#fca5a5'; feedback.textContent='Network error'; } }
    addBtn.disabled = false; addBtn.textContent = 'Add Collection';
  });
}

async function removeWatchedCollection(id, collectionName) {
  if (!isAdmin) return;

  showConfirmModal(
    'Remove Collection',
    `Are you sure you want to stop watching "${collectionName}"? This cannot be undone.`,
    async () => {
      try {
        const response = await fetch(`/api/admin/nft-tracker/collections/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          credentials: 'include',
          headers: buildTenantRequestHeaders()
        });
        const data = await response.json();
        if (data.success) {
          showSuccess('Collection removed from watchlist');
          loadNFTActivityView();
          loadNFTActivityAdminView();
        } else {
          showError(data.message || 'Failed to remove collection');
        }
      } catch (error) {
        showError(`Failed to remove collection: ${error.message}`);
      }
    }
  );
}

// ==================== TREASURY TRACKER ====================
async function loadTreasuryTrackerView() {
  const container = document.getElementById('treasuryTrackerView');
  if (!container) return;

  try {
    const response = await fetch('/api/admin/treasury', { credentials: 'include' });
    const data = await response.json();

    if (data.success && data.config) {
      const c = data.config;
      container.innerHTML = `
        <div style="display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr));">
          <div class="stat-card">
            <div class="stat-label">Treasury Wallet</div>
            <div class="stat-value" style="font-size:0.9em;">${c.solanaWallet ? `${c.solanaWallet.slice(0,8)}...${c.solanaWallet.slice(-8)}` : 'Not configured'}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Refresh Interval</div>
            <div class="stat-value">${c.refreshHours ?? '—'} hours</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">TX Alerts</div>
            <div class="stat-value">${c.txAlertsEnabled ? '✅ Enabled' : '❌ Disabled'}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Last Sync</div>
            <div class="stat-value" style="font-size:0.9em;">${c.lastUpdated ? new Date(c.lastUpdated).toLocaleString() : 'Never'}</div>
          </div>
        </div>
        ${isAdmin ? `
          <div style="margin-top:16px; padding:12px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.22); border-radius:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
              <span style="color:var(--text-secondary); font-size:0.9em;">Configure treasury settings via Discord: <code style="background:rgba(0,0,0,0.3); padding:4px 8px; border-radius:4px;">/treasury admin ...</code></span>
              <button class="btn-secondary" onclick="loadTreasuryTrackerView()" style="padding:8px 16px;">
                <span>🔄</span>
                <span>Refresh</span>
              </button>
            </div>
          </div>
        ` : ''}
      `;
    } else {
      container.innerHTML = '<p style="color:var(--text-secondary);">Treasury tracker not configured</p>';
    }
  } catch (error) {
    console.error('Error loading treasury tracker:', error);
    container.innerHTML = `<p style="color:#ef4444;">Failed to load tracker config: ${escapeHtml(error.message)}</p>`;
  }
}
// ==================== SELF-SERVE ROLES ====================
async function loadSelfServeRolesView() {
  if (!isAdmin) return;
  // Route to settings tab if in settings section, else admin panel content
  const pane = document.getElementById('settingsTab-selfserve');
  const content = pane || document.getElementById('adminSelfServeRolesContent');
  if (!content) return;
  content.innerHTML = '<p style="color:var(--text-secondary);">Loading panels...</p>';

  try {
    const [panelsRes, chRes] = await Promise.all([
      fetch('/api/admin/role-panels', { credentials: 'include' }),
      fetch('/api/admin/discord/channels', { credentials: 'include' }),
    ]);
    const panelsData = panelsRes.ok ? await panelsRes.json() : {};
    const panels = panelsData.panels || [];
    const channels = chRes.ok ? ((await chRes.json()).channels || []) : [];

    // Build grouped channel options
    const grouped = {};
    channels.forEach(ch => { const p = ch.parentName || 'Other'; if (!grouped[p]) grouped[p] = []; grouped[p].push(ch); });
    const chOpts = (selId) => {
      let h = '<option value="">-- Select channel --</option>';
      Object.keys(grouped).sort().forEach(parent => {
        h += `<optgroup label="${escapeHtml(parent)}">`;
        grouped[parent].forEach(ch => { h += `<option value="${ch.id}"${ch.id === selId ? ' selected' : ''}># ${escapeHtml(ch.name)}</option>`; });
        h += '</optgroup>';
      });
      return h;
    };

    const cardStyle = 'background:rgba(14,23,44,0.5);border:1px solid rgba(99,102,241,0.22);border-radius:10px;padding:20px;margin-bottom:16px;';
    const fi = 'width:100%;padding:8px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;';

    const panelCards = panels.map(p => {
      const roleRows = p.roles.length ? p.roles.map(r => `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
          <td style="padding:6px 10px;font-size:0.85em;color:#e0e7ff;">${escapeHtml(r.label || r.role_id)}</td>
          <td style="padding:6px 10px;font-size:0.8em;color:#94a3b8;font-family:monospace;">${escapeHtml(r.role_id)}</td>
          <td style="padding:6px 10px;">
            <label style="position:relative;display:inline-block;width:36px;height:20px;">
              <input type="checkbox" class="panel-role-toggle" data-panel="${p.id}" data-role="${escapeHtml(r.role_id)}" ${r.enabled ? 'checked' : ''} style="opacity:0;width:0;height:0;">
              <span style="position:absolute;cursor:pointer;inset:0;background:${r.enabled ? 'var(--gold,#f59e0b)' : '#555'};border-radius:20px;transition:.3s;"></span>
              <span style="position:absolute;height:14px;width:14px;left:${r.enabled ? '19px' : '3px'};bottom:3px;background:#fff;border-radius:50%;transition:.3s;pointer-events:none;"></span>
            </label>
          </td>
          <td style="padding:6px 10px;">
            <button class="panel-role-remove btn-danger" data-panel="${p.id}" data-role="${escapeHtml(r.role_id)}" style="font-size:0.78em;padding:3px 8px;">🗑️</button>
          </td>
        </tr>
      `).join('') : `<tr><td colspan="4" style="padding:10px;color:var(--text-secondary);font-size:0.85em;text-align:center;">No roles yet — add one below.</td></tr>`;

      return `
        <div style="${cardStyle}" data-panel-id="${p.id}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
            <div style="flex:1;min-width:200px;">
              <input type="text" class="panel-title-input" data-panel="${p.id}" value="${escapeHtml(p.title)}" style="${fi}font-weight:600;font-size:1em;margin-bottom:6px;">
              <textarea class="panel-desc-input" data-panel="${p.id}" rows="2" style="${fi}resize:vertical;font-size:0.88em;">${escapeHtml(p.description)}</textarea>
              <label style="display:flex;align-items:center;gap:8px;color:#c9d6ff;font-size:0.85em;margin-top:8px;cursor:pointer;">
                <input type="checkbox" class="panel-single-select" data-panel="${p.id}" ${p.single_select ? 'checked' : ''}> Single-select (user can hold only one role from this panel)
              </label>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start;">
              <button class="panel-save-meta btn-secondary" data-panel="${p.id}" style="font-size:0.8em;padding:6px 12px;">💾 Save</button>
              <button class="panel-delete btn-danger" data-panel="${p.id}" style="font-size:0.8em;padding:6px 12px;">🗑️ Delete Panel</button>
            </div>
          </div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
            <thead><tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
              <th style="text-align:left;padding:6px 10px;font-size:0.8em;color:var(--text-secondary);">Label</th>
              <th style="text-align:left;padding:6px 10px;font-size:0.8em;color:var(--text-secondary);">Role ID</th>
              <th style="padding:6px 10px;font-size:0.8em;color:var(--text-secondary);">On</th>
              <th style="padding:6px 10px;"></th>
            </tr></thead>
            <tbody class="panel-roles-tbody" data-panel="${p.id}">${roleRows}</tbody>
          </table>
          <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;padding-top:10px;border-top:1px solid rgba(99,102,241,0.12);">
            <div style="flex:1;min-width:160px;">
              <div style="font-size:0.8em;color:#94a3b8;margin-bottom:4px;">Add Role</div>
              <select class="panel-add-role-select" data-panel="${p.id}" style="${fi}"></select>
            </div>
            <div style="flex:1;min-width:120px;">
              <div style="font-size:0.8em;color:#94a3b8;margin-bottom:4px;">Button Label</div>
              <input type="text" class="panel-add-role-label" data-panel="${p.id}" placeholder="e.g. Artists" style="${fi}">
            </div>
            <button class="panel-add-role-btn btn-primary" data-panel="${p.id}" style="font-size:0.8em;padding:8px 14px;white-space:nowrap;">+ Add Role</button>
          </div>
          <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;padding-top:10px;margin-top:10px;border-top:1px solid rgba(99,102,241,0.12);">
            <div style="flex:1;min-width:180px;">
              <div style="font-size:0.8em;color:#94a3b8;margin-bottom:4px;">Post to Channel</div>
              <select class="panel-channel-select" data-panel="${p.id}" style="${fi}">${chOpts(p.channel_id || '')}</select>
            </div>
            <button class="panel-post-btn btn-primary" data-panel="${p.id}" style="font-size:0.8em;padding:8px 14px;">📢 ${p.message_id ? 'Update Panel' : 'Post Panel'}</button>
            <span class="panel-post-status" data-panel="${p.id}" style="font-size:0.82em;font-weight:600;"></span>
          </div>
        </div>
      `;
    }).join('');

    content.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:14px;">
        <button id="srCreatePanelBtn" class="btn-primary" style="font-size:0.85em;padding:8px 18px;">➕ New Panel</button>
      </div>
      ${panels.length ? panelCards : `<div style="${cardStyle}text-align:center;color:var(--text-secondary);"><p>No panels yet. Create your first panel above.</p></div>`}
    `;

    // Populate role dropdowns
    const discordRoles = (typeof fetchDiscordRoles === 'function') ? await fetchDiscordRoles() : [];
    content.querySelectorAll('.panel-add-role-select').forEach(sel => {
      sel.innerHTML = '<option value="">-- Select Role --</option>';
      discordRoles.filter(r => !r.everyone).forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.id; opt.textContent = r.name;
        sel.appendChild(opt);
      });
    });

    // Wire toggle role enabled/disabled
    content.querySelectorAll('.panel-role-toggle').forEach(cb => {
      cb.addEventListener('change', async function() {
        const knob = this.parentElement.querySelector('span:last-child');
        const track = this.parentElement.querySelector('span:first-of-type');
        if (knob) knob.style.left = this.checked ? '19px' : '3px';
        if (track) track.style.background = this.checked ? 'var(--gold,#f59e0b)' : '#555';
        await fetch(`/api/admin/role-panels/${this.dataset.panel}/roles/${encodeURIComponent(this.dataset.role)}`, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: this.checked })
        });
      });
    });

    // Wire remove role
    content.querySelectorAll('.panel-role-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this role from the panel?')) return;
        await fetch(`/api/admin/role-panels/${btn.dataset.panel}/roles/${encodeURIComponent(btn.dataset.role)}`, { method: 'DELETE', credentials: 'include' });
        loadSelfServeRolesView();
      });
    });

    // Wire save panel meta (title/desc)
    content.querySelectorAll('.panel-save-meta').forEach(btn => {
      btn.addEventListener('click', async () => {
        const panelId = btn.dataset.panel;
        const title = content.querySelector(`.panel-title-input[data-panel="${panelId}"]`)?.value.trim();
        const description = content.querySelector(`.panel-desc-input[data-panel="${panelId}"]`)?.value.trim();
        const singleSelect = !!content.querySelector(`.panel-single-select[data-panel="${panelId}"]`)?.checked;
        const r = await fetch(`/api/admin/role-panels/${panelId}`, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description, singleSelect })
        });
        const d = await r.json();
        if (d.success) showSuccess('Panel saved!');
        else showError(d.message || 'Failed to save');
      });
    });

    // Wire delete panel
    content.querySelectorAll('.panel-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this panel? This cannot be undone.')) return;
        await fetch(`/api/admin/role-panels/${btn.dataset.panel}`, { method: 'DELETE', credentials: 'include' });
        loadSelfServeRolesView();
      });
    });

    // Wire add role to panel
    content.querySelectorAll('.panel-add-role-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const panelId = btn.dataset.panel;
        const roleId = content.querySelector(`.panel-add-role-select[data-panel="${panelId}"]`)?.value;
        const label = content.querySelector(`.panel-add-role-label[data-panel="${panelId}"]`)?.value.trim();
        if (!roleId) return showError('Please select a role');
        btn.disabled = true;
        const r = await fetch(`/api/admin/role-panels/${panelId}/roles`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roleId, label })
        });
        const d = await r.json();
        btn.disabled = false;
        if (d.success) loadSelfServeRolesView();
        else showError(d.message || 'Failed to add role');
      });
    });

    // Wire post panel
    content.querySelectorAll('.panel-post-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const panelId = btn.dataset.panel;
        const channelId = content.querySelector(`.panel-channel-select[data-panel="${panelId}"]`)?.value;
        if (!channelId) return showError('Please select a channel');
        const statusEl = content.querySelector(`.panel-post-status[data-panel="${panelId}"]`);
        btn.disabled = true; btn.textContent = 'Posting...';
        if (statusEl) statusEl.textContent = '';
        try {
          const r = await fetch(`/api/admin/role-panels/${panelId}/post`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId })
          });
          const d = await r.json();
          if (d.success) {
            if (statusEl) { statusEl.style.color = '#22c55e'; statusEl.textContent = `✅ ${d.action === 'updated' ? 'Updated' : 'Posted'}!`; }
            loadSelfServeRolesView();
          } else {
            if (statusEl) { statusEl.style.color = '#fca5a5'; statusEl.textContent = '❌ ' + (d.message || 'Failed'); }
          }
        } catch { if (statusEl) { statusEl.style.color = '#fca5a5'; statusEl.textContent = '❌ Network error'; } }
        btn.disabled = false;
        btn.textContent = '📢 Post Panel';
      });
    });

    // Wire create new panel
    document.getElementById('srCreatePanelBtn')?.addEventListener('click', async () => {
      const r = await fetch('/api/admin/role-panels', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '🎖️ Get Your Roles', description: 'Click a button below to claim or unclaim a community role.' })
      });
      const d = await r.json();
      if (d.success) loadSelfServeRolesView();
      else showError(d.message || 'Failed to create panel');
    });

  } catch (error) {
    console.error('Error loading self-serve roles:', error);
    content.innerHTML = '<p style="color:#ef4444;">Failed to load self-serve roles.</p>';
  }
}



// ==================== API REFERENCE ====================
function loadApiRefView() {
  if (!isAdmin) return;
  const content = document.getElementById('adminApiRefContent');
  if (!content) return;

  const badge = (method) => {
    const colors = { GET: '#22c55e', POST: '#3b82f6', DELETE: '#ef4444' };
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.75em;font-weight:700;color:#fff;background:${colors[method] || '#6b7280'};font-family:monospace;">${method}</span>`;
  };
  const authBadge = (pub) => pub
    ? '<span style="font-size:0.8em;">🔓 Public</span>'
    : '<span style="font-size:0.8em;">🔐 Session required</span>';

  const endpoint = (method, path, desc, auth, example) => `
    <div style="background:var(--bg-secondary);border-radius:8px;padding:var(--space-3) var(--space-4);margin-bottom:var(--space-3);border:1px solid rgba(99,102,241,0.1);">
      <div style="display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap;">
        ${badge(method)}
        <code style="font-size:0.9em;color:var(--text-primary);">${path}</code>
        <span style="margin-left:auto;">${authBadge(auth)}</span>
      </div>
      <p style="margin:var(--space-2) 0 0;font-size:0.88em;color:var(--text-secondary);">${desc}</p>
      ${example ? `
        <details style="margin-top:var(--space-2);">
          <summary style="cursor:pointer;font-size:0.82em;color:var(--accent-primary);user-select:none;">Example Response</summary>
          <pre style="margin:var(--space-2) 0 0;padding:var(--space-3);background:rgba(0,0,0,0.3);border-radius:6px;overflow-x:auto;font-size:0.8em;color:#e2e8f0;line-height:1.5;">${example}</pre>
        </details>` : ''}
    </div>`;

  const section = (id, title, subtitle, endpoints) => `
    <h4 id="${id}" style="color:var(--text-primary);margin:0 0 var(--space-3);">${title} <span style="font-weight:400;font-size:0.8em;color:var(--text-secondary);">${subtitle}</span></h4>
    ${endpoints.join('')}
  `;

  const publicV1Example = JSON.stringify({
    success: true,
    data: {
      stats: {
        totalProposals: 12,
        passedProposals: 8,
        passRate: 67,
        totalVotes: 420,
        totalVPUsed: 980,
        activeVoters: 64
      }
    },
    error: null,
    meta: { version: '1.0.0', timestamp: '2026-03-27T10:00:00Z' }
  }, null, 2);

  const treasuryExample = JSON.stringify({
    success: true,
    data: {
      sol: '12.4500',
      usdc: '0.0000',
      lastUpdated: '2026-03-27T10:00:00Z',
      status: 'ok'
    },
    error: null,
    meta: { version: '1.0.0', timestamp: '2026-03-27T10:00:00Z' }
  }, null, 2);

  const proposalExample = JSON.stringify({
    success: true,
    data: {
      proposals: [
        {
          proposalId: 'P-001',
          title: 'Add new trait',
          status: 'voting',
          quorum: { required: 50, current: 72 }
        }
      ]
    },
    error: null,
    meta: { version: '1.0.0', timestamp: '2026-03-27T10:00:00Z' }
  }, null, 2);

  const leaderboardExample = JSON.stringify({
    success: true,
    data: {
      leaderboard: [
        { rank: 1, username: 'CryptoKing', tier: 'Don', totalPoints: 120 }
      ]
    },
    error: null,
    meta: { version: '1.0.0', timestamp: '2026-03-27T10:00:00Z' }
  }, null, 2);

  content.innerHTML = `
    <div style="position:sticky;top:0;z-index:10;background:var(--bg-primary);padding:var(--space-2) 0 var(--space-3);margin-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.1);display:flex;gap:var(--space-3);flex-wrap:wrap;">
      <a href="#apiref-public-v1" style="color:var(--accent-primary);font-size:0.85em;text-decoration:none;">Public v1</a>
      <a href="#apiref-auth" style="color:var(--accent-primary);font-size:0.85em;text-decoration:none;">Session / Auth</a>
      <a href="#apiref-flow" style="color:var(--accent-primary);font-size:0.85em;text-decoration:none;">Auth Flow</a>
    </div>

    <div style="margin-bottom:16px;padding:12px 14px;border:1px solid rgba(99,102,241,0.18);border-radius:10px;background:rgba(99,102,241,0.08);color:var(--text-secondary);font-size:0.88em;line-height:1.6;">
      Public routes use <code>/api/public/v1/*</code> and return the standard <code>{ success, data, error, meta }</code> envelope.
    </div>

    ${section('apiref-public-v1', 'Public v1 Endpoints', '(no auth required)', [
      endpoint('GET', '/api/public/v1/stats', 'Returns community statistics.', true, publicV1Example),
      endpoint('GET', '/api/public/v1/treasury', 'Returns the treasury snapshot used by the portal.', true, treasuryExample),
      endpoint('GET', '/api/public/v1/treasury/transactions?limit=20', 'Returns recent treasury transactions.', true, JSON.stringify({ success: true, data: { transactions: [{ signature: '5Zy...', direction: 'out', deltaSol: -0.25, feeSol: 0.000005, blockTime: 1774605600 }] }, error: null, meta: { version: '1.0.0', timestamp: '2026-03-27T10:00:00Z' } }, null, 2)),
      endpoint('GET', '/api/public/v1/proposals/active', 'Returns active proposals in supporting or voting state.', true, proposalExample),
      endpoint('GET', '/api/public/v1/proposals/concluded', 'Returns concluded proposals with pagination metadata.', true, null),
      endpoint('GET', '/api/public/v1/proposals/:id', 'Returns a single proposal by ID.', true, null),
      endpoint('GET', '/api/public/v1/nft/activity?limit=20', 'Returns recent NFT activity events for watched collections.', true, null),
      endpoint('GET', '/api/public/v1/missions/active', 'Returns active and recruiting missions.', true, null),
      endpoint('GET', '/api/public/v1/missions/completed?limit=50&offset=0', 'Returns completed missions with pagination metadata.', true, null),
      endpoint('GET', '/api/public/v1/missions/:id', 'Returns a single mission by ID.', true, null),
      endpoint('GET', '/api/public/v1/leaderboard?limit=100', 'Returns the mission leaderboard.', true, leaderboardExample),
      endpoint('GET', '/api/public/v1/leaderboard/:userId', 'Returns a single user leaderboard entry.', true, null)
    ])}

    ${section('apiref-auth', 'Session / Auth Endpoints', '(Discord OAuth session required)', [
      endpoint('GET', '/auth/discord/login', 'Starts the Discord OAuth flow.', false, null),
      endpoint('GET', '/auth/discord/callback?code=...', 'OAuth callback that stores the Discord session.', false, null),
      endpoint('GET', '/auth/discord/logout', 'Clears the session and returns to the portal.', false, null),
      endpoint('GET', '/api/user/me', 'Returns the logged-in user profile.', false, JSON.stringify({ success: true, user: { discordId: '123456789', username: 'CryptoKing', tier: 'Don', votingPower: 10 } }, null, 2)),
      endpoint('GET', '/api/user/is-admin', 'Checks whether the current session has Discord administrator access.', false, null),
      endpoint('POST', '/api/verify/challenge', 'Creates a wallet-signing challenge for the current session.', false, null),
      endpoint('POST', '/api/verify/signature', 'Verifies a signed wallet challenge. Body: <code>{ "walletAddress": "...", "signature": "..." }</code>', false, null),
      endpoint('POST', '/api/micro-verify/request', 'Creates a micro-transfer verification request.', false, null),
      endpoint('GET', '/api/micro-verify/status', 'Checks the current micro-transfer verification status.', false, null),
      endpoint('GET', '/api/micro-verify/config', 'Returns the current micro-transfer configuration.', false, null),
      endpoint('POST', '/api/user/vote', 'Casts a vote on a proposal. Body: <code>{ "proposalId": "...", "choice": "yes" }</code>', false, null),
      endpoint('POST', '/api/user/proposals', 'Creates a governance proposal. Body: <code>{ "title": "...", "description": "...", "category": "Other", "costIndication": "~500 USDC" }</code>', false, null),
      endpoint('POST', '/api/governance/proposals/:id/submit', 'Submits a draft proposal for review.', false, null),
      endpoint('POST', '/api/governance/proposals/:id/support', 'Adds support to a draft proposal.', false, null),
      endpoint('GET', '/api/governance/proposals/:id/comments', 'Returns proposal comments.', false, null),
      endpoint('POST', '/api/governance/proposals/:id/comments', 'Adds a proposal comment.', false, null),
      endpoint('POST', '/api/user/wallets/:address/favorite', 'Marks a linked wallet as primary.', false, null),
      endpoint('DELETE', '/api/user/wallets/:address', 'Deletes a linked wallet.', false, null),
      endpoint('GET', '/api/features', 'Returns feature flags used by the portal.', false, null)
    ])}

    <h4 id="apiref-flow" style="color:var(--text-primary);margin:var(--space-4) 0 var(--space-3);">Auth Flow</h4>
    <div style="background:var(--bg-secondary);border-radius:8px;padding:var(--space-4);border:1px solid rgba(99,102,241,0.1);font-size:0.88em;line-height:1.7;color:var(--text-secondary);">
      <p style="margin:0 0 var(--space-3);"><strong style="color:var(--text-primary);">How to implement Discord OAuth for an external website:</strong></p>
      <ol style="margin:0;padding-left:var(--space-4);">
        <li>Redirect the user to Discord OAuth2:<br>
          <code style="background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:4px;font-size:0.9em;word-break:break-all;">https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&amp;redirect_uri=REDIRECT_URI&amp;response_type=code&amp;scope=identify</code>
        </li>
        <li>Discord redirects back with <code style="background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:4px;">?code=...</code>.</li>
        <li>Send the code to <code style="background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:4px;">GET /auth/discord/callback?code=...</code> so the bot can exchange it and set the session cookie.</li>
        <li>Subsequent requests should include credentials automatically (<code style="background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:4px;">credentials: 'include'</code>).</li>
        <li>Use <code style="background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:4px;">GET /api/user/me</code> to confirm the session is live.</li>
      </ol>
    </div>

    <div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.25);border-radius:8px;padding:var(--space-3) var(--space-4);margin-top:var(--space-4);font-size:0.85em;color:#eab308;">
      <strong>CORS Note:</strong> Cross-origin callers must be on the allowlist configured by the server.
    </div>
  `;
}

// ==================== SELF-SERVE ROLES (PUBLIC WEB CLAIM) ====================

async function loadSelfServeRolesPublic() {
  const container = document.getElementById('selfServeRolesView');
  if (!container) return;
  container.innerHTML = `<div style="text-align:center; padding: var(--space-5);"><div class="spinner"></div><p>Loading claimable roles...</p></div>`;
  try {
    const res = await fetch('/api/user/role-panels', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || 'Failed to load role panels');
    const panels = json.panels || [];
    if (!panels.length) {
      container.innerHTML = `<p style="color:var(--text-secondary);">No self-serve role panels are configured for this server yet.</p>`;
      return;
    }
    container.innerHTML = panels.map(p => {
      const roles = (p.roles || []).filter(r => r.enabled !== 0);
      const buttons = roles.map(r => `<button class="btn-secondary" onclick="toggleWebClaimRole(${p.id}, '${escapeJsString(r.role_id)}', this)" style="font-size:0.85em;padding:8px 12px;">${escapeHtml(r.label || r.role_id)}</button>`).join(' ');
      return `
        <div style="padding:14px;border:1px solid rgba(99,102,241,0.2);border-radius:10px;background:rgba(14,23,44,0.5);margin-bottom:12px;">
          <div style="font-weight:700;color:#e0e7ff;margin-bottom:4px;">${escapeHtml(p.title || 'Role Panel')}</div>
          <div style="color:var(--text-secondary);font-size:0.85em;margin-bottom:10px;">${escapeHtml(p.description || '')}</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">${buttons || '<span style="color:var(--text-secondary);">No claimable roles</span>'}</div>
          ${p.single_select ? '<div style="margin-top:8px;color:#fbbf24;font-size:0.8em;">Single-select: choosing one role removes other roles from this panel.</div>' : ''}
        </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = `<p style="color:#ef4444;">${escapeHtml(e.message || 'Failed to load roles')}</p>`;
  }
}

async function toggleWebClaimRole(panelId, roleId, btn) {
  try {
    if (btn) { btn.disabled = true; }
    const res = await fetch('/api/user/roles/toggle', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      body: JSON.stringify({ panelId, roleId })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || 'Failed to toggle role');
    showSuccess(json.message || 'Role updated');
  } catch (e) {
    showError(e.message || 'Failed to toggle role');
  } finally {
    if (btn) { btn.disabled = false; }
  }
}

// ==================== TICKETING VIEW ====================

let _ticketCategories = [];
let _ticketChannelsList = [];
let _ticketRolesList = [];
let _ticketCacheGuildId = '';

function clearTicketingViewCache() {
  _ticketCategories = [];
  _ticketChannelsList = [];
  _ticketRolesList = [];
  _ticketCacheGuildId = '';
  window._ticketArchiveRows = [];
}

async function loadUserTicketOverview() {
  const section = document.querySelector('#section-ticketing .card');
  if (!section) return;
  section.innerHTML = `<div style="text-align:center; padding: var(--space-5);"><div class="spinner"></div><p>Loading your tickets...</p></div>`;
  try {
    const res = await fetch('/api/user/tickets', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || 'Failed to load tickets');
    const tickets = json.tickets || [];
    if (!tickets.length) {
      section.innerHTML = `<p style="color:var(--text-secondary);">No tickets found for this server yet.</p>`;
      return;
    }
    const rows = tickets.map(t => `
      <tr>
        <td style="padding:8px;">${escapeHtml(String(t.ticket_number || t.id))}</td>
        <td style="padding:8px;">${escapeHtml(t.status || '')}</td>
        <td style="padding:8px;">${escapeHtml(t.category_name || '')}</td>
        <td style="padding:8px;">${t.closed_at ? new Date(t.closed_at).toLocaleString() : '—'}</td>
        <td style="padding:8px;">${new Date(t.created_at).toLocaleString()}</td>
      </tr>
    `).join('');
    section.innerHTML = `
      <div style="margin-bottom:10px;color:var(--text-secondary);font-size:0.85em;">Showing all your tickets in this tenant context (including deleted/closed).</div>
      <div style="overflow:auto;border:1px solid rgba(99,102,241,0.2);border-radius:10px;">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="background:rgba(99,102,241,0.12);text-align:left;">
            <th style="padding:8px;">#</th>
            <th style="padding:8px;">Status</th>
            <th style="padding:8px;">Category</th>
            <th style="padding:8px;">Closed</th>
            <th style="padding:8px;">Created</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    section.innerHTML = `<p style="color:#ef4444;">${escapeHtml(e.message || 'Failed to load tickets')}</p>`;
  }
}

async function loadTicketingView() {
  const container = document.getElementById('adminTicketingContent');
  if (!container) return;

  container.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:var(--space-4);flex-wrap:wrap;">
      <button class="btn-primary" onclick="showTicketTab('categories')" id="ticketTabCategories" style="font-size:0.85em;">Categories</button>
      <button class="btn-secondary" onclick="showTicketTab('panel')" id="ticketTabPanel" style="font-size:0.85em;">Post Panel</button>
      <button class="btn-secondary" onclick="showTicketTab('tickets')" id="ticketTabTickets" style="font-size:0.85em;">Open Tickets</button>
      <button class="btn-secondary" onclick="showTicketTab('archive')" id="ticketTabArchive" style="font-size:0.85em;">Archive</button>
      <button class="btn-secondary" onclick="showTicketTab('settings')" id="ticketTabSettings" style="font-size:0.85em;">Settings</button>
    </div>
    <div id="ticketTabContent">Loading...</div>
  `;

  const currentGuildId = normalizeGuildId(activeGuildId);
  const cacheValid = (
    _ticketCacheGuildId === currentGuildId
    && _ticketChannelsList.length > 0
    && _ticketRolesList.length > 0
  );

  if (!cacheValid) {
    _ticketCategories = [];
    _ticketChannelsList = [];
    _ticketRolesList = [];

    try {
      const [channelsRes, rolesRes] = await Promise.all([
        fetch('/api/admin/discord/channels', { credentials: 'include', headers: buildTenantRequestHeaders() }),
        fetch('/api/admin/discord/roles', { credentials: 'include', headers: buildTenantRequestHeaders() })
      ]);
      const [channelsJson, rolesJson] = await Promise.all([channelsRes.json(), rolesRes.json()]);
      if (channelsJson?.success) _ticketChannelsList = channelsJson.channels || [];
      if (rolesJson?.success) _ticketRolesList = rolesJson.roles || [];
      _ticketCacheGuildId = currentGuildId;
    } catch (e) {
      _ticketCacheGuildId = currentGuildId;
    }
  }

  showTicketTab('categories');
}

function showTicketTab(tab) {
  ['categories', 'panel', 'tickets', 'archive', 'settings'].forEach(t => {
    const btn = document.getElementById('ticketTab' + t.charAt(0).toUpperCase() + t.slice(1));
    if (btn) btn.className = t === tab ? 'btn-primary' : 'btn-secondary';
  });

  if (tab === 'categories') loadTicketCategoriesTab();
  else if (tab === 'panel') loadTicketPanelTab();
  else if (tab === 'tickets') loadTicketOpenTab();
  else if (tab === 'archive') loadTicketArchiveTab();
  else if (tab === 'settings') loadTicketSettingsTab();
}

async function loadTicketSettingsTab() {
  const container = document.getElementById('ticketTabContent');
  if (!container) return;
  container.innerHTML = 'Loading ticket settings...';

  try {
    const res = await fetch('/api/admin/settings', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const json = await res.json();
    if (!json.success) {
      container.innerHTML = 'Failed to load ticket settings.';
      return;
    }

    const s = json.settings || {};
    const autoCloseEnabled = s.ticketAutoCloseEnabled !== false;
    const inactiveHours = Number.isFinite(Number(s.ticketAutoCloseInactiveHours)) ? Number(s.ticketAutoCloseInactiveHours) : 168;
    const warningHours = Number.isFinite(Number(s.ticketAutoCloseWarningHours)) ? Number(s.ticketAutoCloseWarningHours) : 24;
    const channelNameTemplate = String(s.ticketChannelNameTemplate || '{category}-{user}-{date}');

    container.innerHTML = `
      <div style="max-width:680px;display:flex;flex-direction:column;gap:12px;">
        <div style="padding:12px;border:1px solid rgba(99,102,241,0.2);border-radius:10px;background:rgba(14,23,44,0.5);">
          <h3 style="margin:0 0 6px 0;color:#e0e7ff;">Ticket Automation</h3>
          <p style="margin:0;color:var(--text-secondary);font-size:0.85em;">Configure inactivity warning and automatic close behavior for open tickets.</p>
        </div>

        <label style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-secondary);">
          <span style="font-weight:600;">Enable auto-close for inactive tickets</span>
          <input type="checkbox" id="ticketAutoCloseEnabled" ${autoCloseEnabled ? 'checked' : ''} />
        </label>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
          <div>
            <label style="font-size:0.85em;font-weight:600;">Auto-close after (hours)</label>
            <input type="number" id="ticketAutoCloseInactiveHours" min="1" max="8760" step="1" value="${Math.max(1, Math.round(inactiveHours))}" style="width:100%;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;" />
          </div>
          <div>
            <label style="font-size:0.85em;font-weight:600;">Warn before close (hours)</label>
            <input type="number" id="ticketAutoCloseWarningHours" min="0" max="8760" step="1" value="${Math.max(0, Math.round(warningHours))}" style="width:100%;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;" />
          </div>
        </div>

        <div style="padding:10px 12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-secondary);">
          <label style="font-size:0.85em;font-weight:600;">Ticket Channel Name Template</label>
          <input type="text" id="ticketChannelNameTemplate" value="${escapeHtml(channelNameTemplate)}" style="width:100%;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:6px;" />
          <div style="font-size:0.78em;color:var(--text-secondary);margin-top:6px;">
            Tokens: <code>{category}</code>, <code>{user}</code>, <code>{date}</code>, <code>{number}</code>. Example: <code>{number}-{category}-{user}</code>
          </div>
        </div>

        <div style="font-size:0.8em;color:var(--text-secondary);">The inactivity timer resets when anyone sends a new message in the ticket channel.</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn-primary" onclick="saveTicketSettingsTab()">Save Ticket Settings</button>
          <span id="ticketSettingsStatus" style="font-size:0.82em;color:var(--text-secondary);"></span>
        </div>
      </div>
    `;
  } catch (error) {
    container.innerHTML = 'Error loading ticket settings.';
  }
}

async function saveTicketSettingsTab() {
  const statusEl = document.getElementById('ticketSettingsStatus');
  if (statusEl) statusEl.textContent = 'Saving...';

  const autoCloseEnabled = !!document.getElementById('ticketAutoCloseEnabled')?.checked;
  const inactiveHours = parseInt(document.getElementById('ticketAutoCloseInactiveHours')?.value || '0', 10);
  const warningHours = parseInt(document.getElementById('ticketAutoCloseWarningHours')?.value || '0', 10);
  const channelNameTemplate = (document.getElementById('ticketChannelNameTemplate')?.value || '').trim();

  if (!Number.isFinite(inactiveHours) || inactiveHours < 1 || inactiveHours > 8760) {
    if (statusEl) statusEl.textContent = '';
    return showError('Auto-close inactivity must be between 1 and 8760 hours.');
  }
  if (!Number.isFinite(warningHours) || warningHours < 0 || warningHours > 8760) {
    if (statusEl) statusEl.textContent = '';
    return showError('Warning window must be between 0 and 8760 hours.');
  }
  if (warningHours > inactiveHours) {
    if (statusEl) statusEl.textContent = '';
    return showError('Warning window cannot be greater than auto-close inactivity.');
  }
  if (!channelNameTemplate) {
    if (statusEl) statusEl.textContent = '';
    return showError('Ticket channel name template cannot be empty.');
  }
  if (!/\{(category|user|date|number)\}/i.test(channelNameTemplate)) {
    if (statusEl) statusEl.textContent = '';
    return showError('Template must include at least one token: {category}, {user}, {date}, or {number}.');
  }

  try {
    const payload = {
      ticketAutoCloseEnabled: autoCloseEnabled,
      ticketAutoCloseInactiveHours: inactiveHours,
      ticketAutoCloseWarningHours: warningHours,
      ticketChannelNameTemplate: channelNameTemplate,
    };
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...Object.fromEntries(buildTenantRequestHeaders().entries()) },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!json.success) {
      if (statusEl) statusEl.textContent = '';
      return showError(json.message || 'Failed to save ticket settings.');
    }

    if (statusEl) {
      statusEl.style.color = '#57f287';
      statusEl.textContent = 'Saved.';
    }
    showSuccess('Ticket settings saved!');
  } catch (error) {
    if (statusEl) statusEl.textContent = '';
    showError('Error saving ticket settings.');
  }
}

async function loadTicketCategoriesTab() {
  const container = document.getElementById('ticketTabContent');
  container.innerHTML = 'Loading categories...';

  try {
    const res = await fetch('/api/admin/tickets/categories', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const json = await res.json();
    if (!json.success) { container.innerHTML = 'Failed to load categories.'; return; }

    _ticketCategories = json.categories || [];

    let html = `<div style="margin-bottom:var(--space-3);"><button class="btn-primary" onclick="showAddCategoryModal()" style="font-size:0.85em;">+ Add Category</button></div>`;

    if (_ticketCategories.length === 0) {
      html += '<p style="color:var(--text-secondary);">No categories yet. Add one to get started.</p>';
    } else {
      html += `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.85em;">
        <thead><tr style="border-bottom:1px solid var(--border-color);">
          <th style="text-align:left;padding:8px;">Emoji</th>
          <th style="text-align:left;padding:8px;">Name</th>
          <th style="text-align:left;padding:8px;">Description</th>
          <th style="text-align:center;padding:8px;">Fields</th>
          <th style="text-align:center;padding:8px;">Enabled</th>
          <th style="text-align:center;padding:8px;">Actions</th>
        </tr></thead><tbody>`;

      for (const cat of _ticketCategories) {
        const fields = safeJsonArray(cat.template_fields);
        html += `<tr style="border-bottom:1px solid var(--border-color);">
          <td style="padding:8px;">${escapeHtml(cat.emoji || '🎫')}</td>
          <td style="padding:8px;font-weight:600;">${escapeHtml(cat.name)}</td>
          <td style="padding:8px;color:var(--text-secondary);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(cat.description || '—')}</td>
          <td style="padding:8px;text-align:center;">${fields.length}</td>
          <td style="padding:8px;text-align:center;">
            <label style="cursor:pointer;">
              <input type="checkbox" ${cat.enabled ? 'checked' : ''} onchange="toggleTicketCategory(${cat.id}, this.checked)" />
            </label>
          </td>
          <td style="padding:8px;text-align:center;">
            <button class="btn-secondary" onclick="showEditCategoryModal(${cat.id})" style="font-size:0.8em;padding:4px 8px;">Edit</button>
            <button class="btn-danger" onclick="deleteTicketCategory(${cat.id})" style="font-size:0.8em;padding:4px 8px;">Delete</button>
          </td>
        </tr>`;
      }
      html += '</tbody></table></div>';
    }

    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = 'Error loading categories.';
  }
}

function showAddCategoryModal() {
  _showCategoryForm(null);
}

function showEditCategoryModal(id) {
  const cat = _ticketCategories.find(c => c.id === id);
  if (!cat) return;
  _showCategoryForm(cat);
}

function _showCategoryForm(cat) {
  const isEdit = !!cat;
  const fields = cat ? safeJsonArray(cat.template_fields) : [];
  const handlerRoles = cat ? safeJsonArray(cat.handler_role_ids || cat.allowed_role_ids) : [];
  const pingRoles = cat ? safeJsonArray(cat.ping_role_ids) : [];
  const textChannels = _ticketChannelsList.filter(c => c.kind === 'text');

  let fieldsHtml = '';
  const renderField = (f, idx) => `
    <div id="tmplField_${idx}" style="background:rgba(0,0,0,0.15);border-radius:6px;padding:8px;margin-bottom:6px;">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
        <input type="text" id="tmplLabel_${idx}" value="${escapeHtml(f.label || '')}" placeholder="Field label" style="flex:1;padding:4px 8px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);font-size:0.85em;" />
        <select id="tmplStyle_${idx}" style="padding:4px 8px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);font-size:0.85em;">
          <option value="short" ${f.style !== 'paragraph' ? 'selected' : ''}>Short</option>
          <option value="paragraph" ${f.style === 'paragraph' ? 'selected' : ''}>Paragraph</option>
        </select>
        <label style="font-size:0.8em;display:flex;align-items:center;gap:2px;">
          <input type="checkbox" id="tmplReq_${idx}" ${f.required !== false ? 'checked' : ''} /> Req
        </label>
        <button onclick="removeTemplateField(${idx})" style="background:none;border:none;color:#ed4245;cursor:pointer;font-size:1em;">✕</button>
      </div>
      <input type="text" id="tmplPlaceholder_${idx}" value="${escapeHtml(f.placeholder || '')}" placeholder="Placeholder text" style="width:100%;padding:4px 8px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);font-size:0.85em;" />
    </div>`;

  fields.forEach((f, i) => { fieldsHtml += renderField(f, i); });

  const modal = document.getElementById('confirmModal');
  const title = document.getElementById('confirmTitle');
  const body = document.getElementById('confirmMessage');
  const btn = document.getElementById('confirmButton');

  title.textContent = isEdit ? 'Edit Category' : 'Add Category';
  btn.textContent = 'Save';
  btn.className = 'btn-primary';

  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;text-align:left;">
      <div>
        <label style="font-size:0.85em;font-weight:600;">Name</label>
        <input type="text" id="catName" value="${isEdit ? escapeHtml(cat.name || '') : ''}" style="width:100%;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;" />
      </div>
      <div style="display:flex;gap:10px;">
        <div style="flex:0 0 140px;">
          <label style="font-size:0.85em;font-weight:600;">Emoji</label>
          <select id="catEmoji" style="width:100%;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;">
            ${['🎫','🛠️','🏆','🤝','💰','🚨','📦','🧾','❓','📣'].map(e => `<option value="${e}" ${(isEdit ? (cat.emoji || '🎫') : '🎫') === e ? 'selected' : ''}>${e}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1;">
          <label style="font-size:0.85em;font-weight:600;">Description</label>
          <input type="text" id="catDesc" value="${isEdit ? escapeHtml(cat.description || '') : ''}" style="width:100%;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;" />
        </div>
      </div>
      <div>
        <label style="font-size:0.85em;font-weight:600;">Open Tickets Category</label>
        <select id="catParentChannel" style="width:100%;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;">
          <option value="">— None —</option>
          ${_ticketChannelsList.filter(c => c.kind === 'category').map(c => `<option value="${c.id}" ${isEdit && cat.parent_channel_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label style="font-size:0.85em;font-weight:600;">Closed Tickets Category</label>
        <select id="catClosedParentChannel" style="width:100%;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;">
          <option value="">— Keep in same category —</option>
          ${_ticketChannelsList.filter(c => c.kind === 'category').map(c => `<option value="${c.id}" ${isEdit && cat.closed_parent_channel_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label style="font-size:0.85em;font-weight:600;">Handler Roles (Support Team)</label>
        <select id="catHandlerRoles" multiple data-ms-title="Handler Roles" data-ms-placeholder="No handler roles selected" style="width:100%;min-height:120px;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;">
          ${_ticketRolesList.map(r => `<option value="${r.id}" ${handlerRoles.includes(r.id) ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
        </select>
        <div style="font-size:0.78em;color:var(--text-secondary);margin-top:4px;">These roles can claim, close, and reopen tickets in this category.</div>
      </div>
      <div>
        <label style="font-size:0.85em;font-weight:600;">Roles to Ping on New Ticket</label>
        <select id="catPingRoles" multiple data-ms-title="Roles To Ping" data-ms-placeholder="No ping roles selected" style="width:100%;min-height:120px;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;">
          ${_ticketRolesList.map(r => `<option value="${r.id}" ${pingRoles.includes(r.id) ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label style="font-size:0.85em;font-weight:600;">Template Fields (max 5)</label>
        <div id="templateFieldsContainer">${fieldsHtml}</div>
        <button onclick="addTemplateField()" class="btn-secondary" style="font-size:0.8em;margin-top:4px;">+ Add Field</button>
      </div>
    </div>
  `;

  window._catEditId = isEdit ? cat.id : null;
  window._tmplFieldCount = fields.length;

  confirmCallback = async () => {
    await saveCategoryFromModal();
  };

  modal.style.display = 'flex';
  initializePortalMultiSelects(modal);
}

window.addTemplateField = function() {
  const container = document.getElementById('templateFieldsContainer');
  const count = container ? container.querySelectorAll('[id^="tmplField_"]').length : 0;
  if (count >= 5) return showError('Max 5 fields allowed (Discord limit)');

  const div = document.createElement('div');
  div.id = `tmplField_${count}`;
  div.style.cssText = 'background:rgba(0,0,0,0.15);border-radius:6px;padding:8px;margin-bottom:6px;';
  div.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
      <input type="text" id="tmplLabel_${count}" placeholder="Field label" style="flex:1;padding:4px 8px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);font-size:0.85em;" />
      <select id="tmplStyle_${count}" style="padding:4px 8px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);font-size:0.85em;">
        <option value="short">Short</option>
        <option value="paragraph">Paragraph</option>
      </select>
      <label style="font-size:0.8em;display:flex;align-items:center;gap:2px;">
        <input type="checkbox" id="tmplReq_${count}" checked /> Req
      </label>
      <button onclick="removeTemplateField(${count})" style="background:none;border:none;color:#ed4245;cursor:pointer;font-size:1em;">✕</button>
    </div>
    <input type="text" id="tmplPlaceholder_${count}" placeholder="Placeholder text" style="width:100%;padding:4px 8px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);font-size:0.85em;" />
  `;
  container.appendChild(div);
  window._tmplFieldCount = count + 1;
};

window.removeTemplateField = function(idx) {
  const el = document.getElementById(`tmplField_${idx}`);
  if (el) el.remove();
};

async function saveCategoryFromModal() {
  const name = document.getElementById('catName').value.trim();
  if (!name) return showError('Name is required');

  const emoji = document.getElementById('catEmoji').value.trim() || '🎫';
  const description = document.getElementById('catDesc').value.trim();
  const parentChannelId = document.getElementById('catParentChannel').value || '';
  const closedParentChannelId = document.getElementById('catClosedParentChannel')?.value || '';
  const roleSelect = document.getElementById('catHandlerRoles');
  const pingRoleSelect = document.getElementById('catPingRoles');
  const handlerRoleIds = roleSelect ? Array.from(roleSelect.selectedOptions || []).map(o => o.value).filter(Boolean) : [];
  const pingRoleIds = pingRoleSelect ? Array.from(pingRoleSelect.selectedOptions || []).map(o => o.value).filter(Boolean) : [];

  // Collect template fields
  const templateFields = [];
  for (let i = 0; i < (window._tmplFieldCount || 0); i++) {
    const labelEl = document.getElementById(`tmplLabel_${i}`);
    if (!labelEl) continue;
    const label = labelEl.value.trim();
    if (!label) continue;
    templateFields.push({
      label,
      placeholder: document.getElementById(`tmplPlaceholder_${i}`)?.value || '',
      required: document.getElementById(`tmplReq_${i}`)?.checked !== false,
      style: document.getElementById(`tmplStyle_${i}`)?.value || 'short'
    });
  }

  const payload = {
    name,
    emoji,
    description,
    parentChannelId,
    closedParentChannelId,
    handlerRoleIds,
    // Keep legacy field for older server versions.
    allowedRoleIds: handlerRoleIds,
    pingRoleIds,
    templateFields
  };
  const isEdit = window._catEditId !== null && window._catEditId !== undefined;
  const url = isEdit ? `/api/admin/tickets/categories/${window._catEditId}` : '/api/admin/tickets/categories';
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...Object.fromEntries(buildTenantRequestHeaders().entries()) },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (!json.success) return showError(json.message || 'Failed to save category');
    loadTicketCategoriesTab();
  } catch (e) {
    showError('Error saving category');
  }
}

async function toggleTicketCategory(id, enabled) {
  try {
    await fetch(`/api/admin/tickets/categories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...Object.fromEntries(buildTenantRequestHeaders().entries()) },
      credentials: 'include',
      body: JSON.stringify({ enabled })
    });
  } catch (e) { /* ignore */ }
}

async function deleteTicketCategory(id) {
  if (!confirm('Delete this category? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/admin/tickets/categories/${id}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: buildTenantRequestHeaders()
    });
    const json = await res.json();
    if (!json.success) return showError(json.message || 'Failed to delete');
    loadTicketCategoriesTab();
  } catch (e) {
    showError('Error deleting category');
  }
}

function loadTicketPanelTab() {
  const container = document.getElementById('ticketTabContent');
  const textChannels = _ticketChannelsList.filter(c => c.kind === 'text');

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;max-width:500px;">
      <div>
        <label style="font-size:0.85em;font-weight:600;">Channel</label>
        <select id="ticketPanelChannelId" style="width:100%;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;">
          <option value="">— Select Channel —</option>
          ${textChannels.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label style="font-size:0.85em;font-weight:600;">Panel Title</label>
        <input type="text" id="ticketPanelTitle" value="🎫 Support" style="width:100%;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;" />
      </div>
      <div>
        <label style="font-size:0.85em;font-weight:600;">Panel Description</label>
        <textarea id="ticketPanelDesc" rows="3" style="width:100%;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;resize:vertical;">Select a category below to open a support ticket.</textarea>
      </div>
      <button class="btn-primary" onclick="postTicketPanel()" style="align-self:flex-start;">Post Panel</button>
      <div id="ticketPanelResult"></div>
    </div>
  `;
}

async function postTicketPanel() {
  const channelId = document.getElementById('ticketPanelChannelId').value;
  if (!channelId) return showError('Please select a channel');

  const title = document.getElementById('ticketPanelTitle').value.trim() || '🎫 Support';
  const description = document.getElementById('ticketPanelDesc').value.trim();
  const resultEl = document.getElementById('ticketPanelResult');
  resultEl.innerHTML = 'Posting...';

  try {
    const res = await fetch('/api/admin/tickets/panel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...Object.fromEntries(buildTenantRequestHeaders().entries()) },
      credentials: 'include',
      body: JSON.stringify({ channelId, title, description })
    });
    const json = await res.json();
    if (json.success) {
      resultEl.innerHTML = `<span style="color:#57f287;">${json.updated ? '✅ Panel updated!' : '✅ Panel posted!'}</span>`;
    } else {
      resultEl.innerHTML = `<span style="color:#ed4245;">❌ ${json.message || 'Failed'}</span>`;
    }
  } catch (e) {
    resultEl.innerHTML = '<span style="color:#ed4245;">❌ Error posting panel</span>';
  }
}

async function loadTicketOpenTab() {
  const container = document.getElementById('ticketTabContent');
  container.innerHTML = 'Loading tickets...';

  try {
    const res = await fetch('/api/admin/tickets?status=open', { credentials: 'include', headers: buildTenantRequestHeaders() });
    const json = await res.json();
    if (!json.success) { container.innerHTML = 'Failed to load tickets.'; return; }

    const tickets = json.tickets || [];
    let html = `<div style="margin-bottom:var(--space-3);"><button class="btn-secondary" onclick="loadTicketOpenTab()" style="font-size:0.85em;">🔄 Refresh</button></div>`;

    if (tickets.length === 0) {
      html += '<p style="color:var(--text-secondary);">No open tickets.</p>';
    } else {
      html += `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.85em;">
        <thead><tr style="border-bottom:1px solid var(--border-color);">
          <th style="text-align:left;padding:8px;">#</th>
          <th style="text-align:left;padding:8px;">Category</th>
          <th style="text-align:left;padding:8px;">Opened By</th>
          <th style="text-align:left;padding:8px;">Claimed By</th>
          <th style="text-align:left;padding:8px;">Created</th>
          <th style="text-align:center;padding:8px;">Actions</th>
        </tr></thead><tbody>`;

      for (const t of tickets) {
        const created = new Date(t.created_at).toLocaleString();
        html += `<tr style="border-bottom:1px solid var(--border-color);">
          <td style="padding:8px;font-weight:600;">${t.ticket_number}</td>
          <td style="padding:8px;">${escapeHtml(t.category_name || '—')}</td>
          <td style="padding:8px;">${escapeHtml(t.opener_name || t.opener_id)}</td>
          <td style="padding:8px;">${escapeHtml(t.claimed_by || '—')}</td>
          <td style="padding:8px;color:var(--text-secondary);font-size:0.9em;">${created}</td>
          <td style="padding:8px;text-align:center;">
            <button class="btn-secondary" onclick="viewTicketTranscript(${t.id})" style="font-size:0.8em;padding:4px 8px;">Transcript</button>
          </td>
        </tr>`;
      }
      html += '</tbody></table></div>';
    }

    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = 'Error loading tickets.';
  }
}

async function loadTicketArchiveTab() {
  const container = document.getElementById('ticketTabContent');
  container.innerHTML = 'Loading archive...';

  const q = (window._ticketArchiveQuery || '').trim();
  const range = window._ticketArchiveRange || 'all';
  const params = new URLSearchParams({ statuses: 'closed,deleted' });
  if (q) params.set('q', q);
  if (range === '7d' || range === '30d') {
    const days = range === '7d' ? 7 : 30;
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    params.set('from', from);
  }

  try {
    const res = await fetch(`/api/admin/tickets?${params.toString()}`, { credentials: 'include', headers: buildTenantRequestHeaders() });
    const json = await res.json();
    if (!json.success) { container.innerHTML = 'Failed to load archive.'; return; }

    const tickets = json.tickets || [];
    window._ticketArchiveRows = tickets;
    let html = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:var(--space-3);flex-wrap:wrap;">
        <input id="ticketArchiveSearch" type="text" value="${escapeHtml(q)}" placeholder="Search username, category, transcript text..." style="min-width:280px;flex:1;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);" />
        <select id="ticketArchiveRange" style="padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);">
          <option value="all" ${range === 'all' ? 'selected' : ''}>All time</option>
          <option value="7d" ${range === '7d' ? 'selected' : ''}>Last 7 days</option>
          <option value="30d" ${range === '30d' ? 'selected' : ''}>Last 30 days</option>
        </select>
        <button class="btn-primary" onclick="runTicketArchiveSearch()" style="font-size:0.85em;">Search</button>
        <button class="btn-secondary" onclick="clearTicketArchiveSearch()" style="font-size:0.85em;">Clear</button>
        <button class="btn-secondary" onclick="exportTicketArchiveCsv()" style="font-size:0.85em;">📥 Export CSV</button>
      </div>
    `;

    if (tickets.length === 0) {
      html += '<p style="color:var(--text-secondary);">No archived tickets found.</p>';
    } else {
      html += `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.85em;">
        <thead><tr style="border-bottom:1px solid var(--border-color);">
          <th style="text-align:left;padding:8px;">#</th>
          <th style="text-align:left;padding:8px;">Status</th>
          <th style="text-align:left;padding:8px;">Category</th>
          <th style="text-align:left;padding:8px;">Opened By</th>
          <th style="text-align:left;padding:8px;">Closed</th>
          <th style="text-align:center;padding:8px;">Actions</th>
        </tr></thead><tbody>`;

      for (const t of tickets) {
        const closed = t.closed_at ? new Date(t.closed_at).toLocaleString() : '—';
        html += `<tr style="border-bottom:1px solid var(--border-color);">
          <td style="padding:8px;font-weight:600;">${t.ticket_number || t.id}</td>
          <td style="padding:8px;">${escapeHtml(t.status || '—')}</td>
          <td style="padding:8px;">${escapeHtml(t.category_name || '—')}</td>
          <td style="padding:8px;">${escapeHtml(t.opener_name || t.opener_id || '—')}</td>
          <td style="padding:8px;color:var(--text-secondary);font-size:0.9em;">${closed}</td>
          <td style="padding:8px;text-align:center;">
            <button class="btn-secondary" onclick="viewTicketTranscript(${t.id})" style="font-size:0.8em;padding:4px 8px;">Transcript</button>
          </td>
        </tr>`;
      }
      html += '</tbody></table></div>';
    }

    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = 'Error loading archive.';
  }
}

window.runTicketArchiveSearch = function() {
  window._ticketArchiveQuery = document.getElementById('ticketArchiveSearch')?.value || '';
  window._ticketArchiveRange = document.getElementById('ticketArchiveRange')?.value || 'all';
  loadTicketArchiveTab();
};

window.clearTicketArchiveSearch = function() {
  window._ticketArchiveQuery = '';
  window._ticketArchiveRange = 'all';
  loadTicketArchiveTab();
};

window.exportTicketArchiveCsv = function() {
  const rows = window._ticketArchiveRows || [];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['ticket_number','status','category_name','opener_name','opener_id','claimed_by','created_at','closed_at'];
  const csv = [header.join(',')].concat(rows.map(r => [
    esc(r.ticket_number || r.id),
    esc(r.status),
    esc(r.category_name),
    esc(r.opener_name),
    esc(r.opener_id),
    esc(r.claimed_by || ''),
    esc(r.created_at || ''),
    esc(r.closed_at || '')
  ].join(','))).join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ticket-archive-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

async function viewTicketTranscript(id) {
  try {
    const res = await fetch(`/api/admin/tickets/${id}/transcript`, { credentials: 'include', headers: buildTenantRequestHeaders() });
    const json = await res.json();
    if (!json.success) return showError(json.message || 'Failed to load transcript');

    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmTitle').textContent = 'Ticket Transcript';
    document.getElementById('confirmButton').style.display = 'none';
    document.getElementById('confirmMessage').innerHTML = `<pre style="white-space:pre-wrap;word-break:break-word;max-height:400px;overflow:auto;background:rgba(0,0,0,0.2);padding:12px;border-radius:6px;font-size:0.8em;">${escapeHtml(json.transcript || '')}</pre>`;
    confirmCallback = null;
    modal.style.display = 'flex';
  } catch (e) {
    showError('Error loading transcript');
  }
}

function safeJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Plans ──────────────────────────────────────────────
// feature: { label, included: true/false/'partial', note? }
const PLAN_CATALOG = [
  {
    id: "starter",
    name: "Starter",
    tagline: "Perfect for small communities getting started",
    monthlyPrice: 0,
    color: "#64748b",
    features: [
      { label: "1 Discord server", included: true },
      { label: "Solana wallet verification", included: true },
      { label: "Up to 5 verification roles", included: true },
      { label: "Up to 3 treasury wallets", included: true },
      { label: "Governance & proposals", included: true },
      { label: "9 mini-games (Battle, H/L, Dice, Trivia, Slots…)", included: true },
      { label: "NFT activity feed", included: true },
      { label: "🎮 Game Night orchestration", included: false },
      { label: "Trait-based roles", included: false },
      { label: "Custom branding", included: false },
      { label: "Multi-server (multi-tenant)", included: false },
      { label: "Engagement & points system", included: false },
    ],
    cta: "Get Started Free",
    ctaAction: "signup_free",
  },
  {
    id: "growth",
    name: "Growth",
    tagline: "Everything you need to run a thriving community",
    monthlyPrice: 19.99,
    popular: true,
    color: "#6366f1",
    features: [
      { label: "1 Discord server", included: true },
      { label: "Solana wallet verification", included: true },
      { label: "Unlimited verification roles", included: true },
      { label: "Up to 25 treasury wallets", included: true },
      { label: "Governance & proposals", included: true },
      { label: "9 mini-games (all standalone games)", included: true },
      { label: "🎮 Game Night orchestration", included: true },
      { label: "NFT activity feed + Helius webhooks", included: true },
      { label: "Trait-based roles", included: true },
      { label: "Custom branding (logo, colors)", included: true },
      { label: "Self-serve roles & ticketing", included: true },
      { label: "Multi-server (multi-tenant)", included: false },
      { label: "Engagement & points system", included: false },
    ],
    cta: "Upgrade to Growth",
    ctaAction: "upgrade_growth",
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "For serious projects that need the full stack",
    monthlyPrice: 49.99,
    color: "#f59e0b",
    features: [
      { label: "Up to 5 Discord servers", included: true },
      { label: "Solana + EVM wallet verification", included: true },
      { label: "Unlimited verification roles", included: true },
      { label: "Unlimited treasury wallets", included: true },
      { label: "Governance & proposals", included: true },
      { label: "9 mini-games (all standalone games)", included: true },
      { label: "🎮 Game Night orchestration", included: true },
      { label: "NFT activity feed + Helius webhooks", included: true },
      { label: "Trait-based roles", included: true },
      { label: "Custom branding (logo, colors)", included: true },
      { label: "Self-serve roles & ticketing", included: true },
      { label: "Multi-server (multi-tenant)", included: true },
      { label: "Engagement & points system", included: true },
    ],
    cta: "Upgrade to Pro",
    ctaAction: "upgrade_pro",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    tagline: "Custom rollout, multi-server support, and white-glove setup",
    monthlyPrice: null,
    color: "#10b981",
    features: [
      { label: "Multi-server bundle", included: true },
      { label: "Custom per-module limits", included: true },
      { label: "Custom era/module assignments", included: true },
      { label: "Priority support & onboarding", included: true },
      { label: "Dedicated monetization templates", included: true },
    ],
    cta: "Contact Team",
    ctaAction: "contact_enterprise",
  },
];

function updatePlanPrices() {
  const annual = document.getElementById('billingAnnualToggle')?.checked;
  const grid = document.getElementById('plansGrid');
  if (!grid) return;

  grid.innerHTML = PLAN_CATALOG.map(plan => {
    const isContactPlan = plan.monthlyPrice === null || plan.monthlyPrice === undefined;
    const discountedMonthly = (!isContactPlan && Number(plan.monthlyPrice) > 0 && annual)
      ? Number(plan.monthlyPrice) * 0.85
      : Number(plan.monthlyPrice || 0);
    const priceText = isContactPlan
      ? 'Contact'
      : (Number(plan.monthlyPrice || 0) === 0 ? '0' : discountedMonthly.toFixed(2));
    const annualTotal = (!isContactPlan && annual && Number(plan.monthlyPrice) > 0)
      ? `$${(Number(plan.monthlyPrice) * 0.85 * 12).toFixed(2)}/yr`
      : '';
    const period = isContactPlan || Number(plan.monthlyPrice || 0) === 0 ? '' : annual ? '/mo' : '/month';
    const accentColor = plan.color || '#6366f1';

    const featureRows = plan.features.map(f => {
      const included = f.included === true;
      const icon = included
        ? `<span style="color:#4ade80;font-size:1em;line-height:1;flex-shrink:0;">✓</span>`
        : `<span style="color:rgba(148,163,184,0.35);font-size:1em;line-height:1;flex-shrink:0;">✕</span>`;
      return `<li style="opacity:${included ? '1' : '0.5'};">${icon}<span>${escapeHtml(f.label)}</span></li>`;
    }).join('');

    return `
      <div class="plan-card ${plan.popular ? 'popular' : ''}" style="--plan-accent:${accentColor};">
        <div class="plan-header">
          <div class="plan-name" style="color:${accentColor};">${escapeHtml(plan.name)}</div>
          <div class="plan-tagline">${escapeHtml(plan.tagline)}</div>
          <div class="plan-price">
            <span class="plan-price-amount">${isContactPlan ? '' : '$'}${priceText}</span>
            <span class="plan-price-period">${period}</span>
          </div>
          ${annualTotal ? `<div class="plan-annual-note">Billed as ${annualTotal} · Save 15%</div>` : ''}
        </div>
        <ul class="plan-features">${featureRows}</ul>
        <div class="plan-cta">
          <button class="${plan.popular ? 'btn-primary' : 'btn-secondary'}" style="width:100%;${plan.popular ? '' : `border-color:${accentColor}33;color:${accentColor};`}"
            ${plan.ctaDisabled ? 'disabled' : ''}
            onclick="handlePlanCta('${escapeJsString(plan.ctaAction || '')}')">
            ${escapeHtml(plan.cta)}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function handlePlanCta(action) {
  if (!action) return;
  const annual = !!document.getElementById('billingAnnualToggle')?.checked;
  const interval = annual ? 'yearly' : 'monthly';

  if (action === 'signup_free') {
    showInfo('Starter is already active by default when a server installs GuildPilot.');
    return;
  }

  if (!activeGuildId) {
    showInfo('Select a server first to continue with billing actions.');
    return;
  }

  let targetPlan = '';
  if (action === 'upgrade_growth') targetPlan = 'growth';
  if (action === 'upgrade_pro') targetPlan = 'pro';

  if (action === 'contact_enterprise') {
    const support = currentPlanSnapshot?.renewal?.supportUrl;
    if (support) {
      window.open(support, '_blank', 'noopener,noreferrer');
      return;
    }
    showInfo('Contact support to discuss Enterprise setup.');
    return;
  }

  if (!targetPlan) {
    showInfo('Billing action is not configured yet.');
    return;
  }

  (async () => {
    try {
      const response = await fetch(
        `/api/admin/billing/options?plan=${encodeURIComponent(targetPlan)}&interval=${encodeURIComponent(interval)}`,
        { credentials: 'include', headers: buildTenantRequestHeaders() }
      );
      const data = await response.json();
      if (!data?.success) throw new Error(data?.message || 'Failed to load billing options');
      const firstOption = Array.isArray(data.options) ? data.options[0] : null;
      if (firstOption?.url) {
        window.open(firstOption.url, '_blank', 'noopener,noreferrer');
        return;
      }
      if (data?.supportUrl) {
        window.open(data.supportUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      showInfo('No checkout URL configured yet. Contact support to complete the upgrade.');
    } catch (error) {
      showError(`Could not start upgrade: ${error.message}`);
    }
  })();
}

function openExternalPlanUrl(encodedUrl) {
  try {
    const url = decodeURIComponent(String(encodedUrl || ''));
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    showError('Invalid billing URL');
  }
}

async function loadCurrentPlan() {
  try {
    const res = await fetch('/api/admin/plan', { credentials: 'include', headers: buildTenantRequestHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    currentPlanSnapshot = data;

    const card = document.getElementById('currentPlanCard');
    const content = document.getElementById('currentPlanContent');
    if (!card || !content) return;

    const record = getServerRecord(activeGuildId);
    const planName = getTenantPlanLabel(data.plan || 'starter');
    const tenantStatus = String(data.status || 'active').toLowerCase();
    const subscriptionStatus = String(data?.billing?.subscriptionStatus || data.status || 'active').toLowerCase();
    const statusColor = (tenantStatus === 'active' && !['past_due', 'canceled', 'cancelled', 'suspended', 'unpaid', 'payment_failed', 'expired'].includes(subscriptionStatus))
      ? 'badge-active'
      : 'badge-paused';
    const intervalLabel = data?.billing?.billingInterval === 'yearly' ? 'Yearly billing' : 'Monthly billing';
    const renewalOptions = Array.isArray(data?.renewal?.options) ? data.renewal.options : [];

    const actionButtons = [];
    if (data?.billing?.manageUrl) {
      actionButtons.push(`<button class="btn-secondary" onclick="openExternalPlanUrl('${escapeJsString(encodeURIComponent(data.billing.manageUrl))}')">Manage Subscription</button>`);
    }
    renewalOptions.slice(0, 2).forEach(option => {
      if (!option?.url) return;
      actionButtons.push(`<button class="btn-primary" onclick="openExternalPlanUrl('${escapeJsString(encodeURIComponent(option.url))}')">${escapeHtml(option.label || 'Renew')}</button>`);
    });
    if (data?.renewal?.supportUrl) {
      actionButtons.push(`<button class="btn-secondary" onclick="openExternalPlanUrl('${escapeJsString(encodeURIComponent(data.renewal.supportUrl))}')">Contact Support</button>`);
    }

    content.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;">
        ${record?.iconUrl ? `<img src="${record.iconUrl}" style="width:48px;height:48px;border-radius:10px;object-fit:cover;">` : ''}
        <div style="min-width:220px;">
          <div style="font-size:1.1em;font-weight:700;color:#e0e7ff;">${escapeHtml(record?.name || activeGuildId || 'Current Server')}</div>
          <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <span class="badge badge-active">${escapeHtml(planName)}</span>
            <span class="badge ${statusColor}">${escapeHtml(subscriptionStatus)}</span>
          </div>
          <div style="color:var(--text-secondary);font-size:0.82em;margin-top:6px;">${escapeHtml(intervalLabel)}</div>
          ${data.expiresAt ? `<div style="color:var(--text-secondary);font-size:0.82em;margin-top:4px;">Active until ${new Date(data.expiresAt).toLocaleString()}</div>` : ''}
          ${data.plan === 'starter' ? '<div style="color:var(--text-secondary);font-size:0.82em;margin-top:4px;">Starter is free by default. Upgrade anytime for higher module limits.</div>' : ''}
        </div>
        <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;">
          ${actionButtons.join('')}
        </div>
      </div>
    `;
    card.style.display = 'block';
  } catch(e) { /* no plan API yet, silent fail */ }
}

// ==================== SYSTEM MONITOR ====================

async function loadSystemStatus() {
  const el = document.getElementById('systemStatusContent');
  if (!el) return;
  el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading...</p></div>';
  try {
    const res = await fetch('/api/superadmin/system-status', { credentials: 'include' });
    if (!res.ok) throw new Error('Failed');
    const d = await res.json();

    const fmtBytes = b => b > 1073741824 ? (b/1073741824).toFixed(1)+'GB' : (b/1048576).toFixed(0)+'MB';
    const fmtUptime = ms => {
      const h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    const memBar = `<div style="background:rgba(99,102,241,0.1);border-radius:4px;height:6px;margin-top:4px;overflow:hidden;"><div style="background:${d.memory.pct>85?'#f87171':d.memory.pct>65?'#fbbf24':'#4ade80'};height:100%;width:${d.memory.pct}%;border-radius:4px;transition:width 0.3s;"></div></div>`;

    const pm2Rows = d.pm2.length ? d.pm2.map(p => `
      <tr>
        <td>${escapeHtml(p.name)}</td>
        <td><span class="badge ${p.status==='online'?'badge-active':'badge-paused'}">${p.status}</span></td>
        <td>${p.uptime ? fmtUptime(p.uptime) : '\u2014'}</td>
        <td>${p.restarts}</td>
        <td>${fmtBytes(p.memory)}</td>
        <td>${p.cpu}%</td>
      </tr>`).join('') : '<tr><td colspan="6" style="color:var(--text-secondary);text-align:center;">No PM2 processes found</td></tr>';

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px;">
        <div class="stat-mini">
          <div class="stat-mini-label">RAM Usage</div>
          <div class="stat-mini-value">${d.memory.pct}%</div>
          <div style="font-size:0.75em;color:var(--text-secondary);">${fmtBytes(d.memory.used)} / ${fmtBytes(d.memory.total)}</div>
          ${memBar}
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">CPU</div>
          <div class="stat-mini-value">${d.cpu.cores} cores</div>
          <div style="font-size:0.75em;color:var(--text-secondary);">${escapeHtml(d.cpu.model.split('@')[0].trim())}</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">System Uptime</div>
          <div class="stat-mini-value">${d.uptime.display}</div>
          <div style="font-size:0.75em;color:var(--text-secondary);">Node ${d.node.version}</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Disk</div>
          <div class="stat-mini-value">${d.disk?.pct || '\u2014'}</div>
          <div style="font-size:0.75em;color:var(--text-secondary);">${d.disk?.used||''} used of ${d.disk?.total||''}</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Heap</div>
          <div class="stat-mini-value">${fmtBytes(d.node.heapUsed)}</div>
          <div style="font-size:0.75em;color:var(--text-secondary);">of ${fmtBytes(d.node.heapTotal)} allocated</div>
        </div>
      </div>

      <h4 style="margin-bottom:12px;color:var(--text-secondary);font-size:0.85em;text-transform:uppercase;letter-spacing:0.05em;">PM2 Processes</h4>
      <div style="overflow-x:auto;">
        <div class="data-table-wrap"><table class="data-table">
          <thead><tr><th>Name</th><th>Status</th><th>Uptime</th><th>Restarts</th><th>Memory</th><th>CPU</th></tr></thead>
          <tbody>${pm2Rows}</tbody>
        </table></div>
      </div>
      <div style="color:var(--text-secondary);font-size:0.75em;margin-top:8px;text-align:right;">Last updated: ${new Date(d.timestamp).toLocaleTimeString()}</div>
    `;
  } catch(e) {
    el.innerHTML = '<p style="color:var(--text-secondary);">Failed to load system status: ' + escapeHtml(e.message) + '</p>';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ENGAGEMENT & POINTS SECTION
// ═══════════════════════════════════════════════════════════════════════════

async function loadEngagementSection() {
  await Promise.all([loadEngagementConfig(), loadEngagementLeaderboard(), loadEngagementShop()]);
}

async function loadEngagementConfig() {
  try {
    const res = await fetch('/api/admin/engagement/config', { credentials: 'include' });
    const data = await res.json();
    if (!data.success) return;
    const cfg = data.config;
    document.getElementById('engEnabled').checked = !!cfg.enabled;
    document.getElementById('engPtsMsg').value = cfg.points_message ?? 5;
    document.getElementById('engPtsReact').value = cfg.points_reaction ?? 2;
    document.getElementById('engCooldownMsg').value = cfg.cooldown_message_mins ?? 60;
    document.getElementById('engCooldownReact').value = cfg.cooldown_reaction_daily ?? 5;
  } catch (e) { console.error('[Engagement] config load error:', e); }
}

async function saveEngagementConfig() {
  try {
    const body = {
      enabled: document.getElementById('engEnabled').checked,
      points_message: parseInt(document.getElementById('engPtsMsg').value, 10),
      points_reaction: parseInt(document.getElementById('engPtsReact').value, 10),
      cooldown_message_mins: parseInt(document.getElementById('engCooldownMsg').value, 10),
      cooldown_reaction_daily: parseInt(document.getElementById('engCooldownReact').value, 10),
    };
    const res = await fetch('/api/admin/engagement/config', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.success) showSuccess('Engagement settings saved!');
    else showError(data.message || 'Failed to save.');
  } catch (e) { showError('Error saving engagement config.'); }
}

async function loadEngagementLeaderboard() {
  const el = document.getElementById('engagementLeaderboardView');
  if (!el) return;
  el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading...</p></div>';
  try {
    const res = await fetch('/api/admin/engagement/leaderboard?limit=25', { credentials: 'include' });
    const data = await res.json();
    if (!data.success || !data.leaderboard?.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🏅</div><h4 class="empty-state-title">No data yet</h4><p class="empty-state-message">Points will appear here once members start chatting.</p></div>';
      return;
    }
    const medals = ['🥇','🥈','🥉'];
    const rows = data.leaderboard.map((r, i) => `
      <div class="table-row">
        <span style="width:36px;text-align:center;">${medals[i] || (i+1)}</span>
        <span style="flex:1;font-weight:500;">${escapeHtml(r.username || r.user_id)}</span>
        <span style="color:var(--accent-gold);font-weight:600;">${r.total_points.toLocaleString()} pts</span>
      </div>`).join('');
    el.innerHTML = `<div class="table-list" style="display:flex;flex-direction:column;gap:6px;">${rows}</div>`;
  } catch (e) { el.innerHTML = '<p style="color:var(--error);">Failed to load leaderboard.</p>'; }
}

async function loadEngagementShop() {
  const el = document.getElementById('engagementShopView');
  if (!el) return;
  el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading...</p></div>';
  try {
    const res = await fetch('/api/admin/engagement/shop', { credentials: 'include' });
    const data = await res.json();
    if (!data.success || !data.items?.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🛍️</div><h4 class="empty-state-title">Shop is empty</h4><p class="empty-state-message">Add items to reward your community.</p></div>';
      return;
    }
    const rows = data.items.map(item => {
      const stock = item.quantity_remaining < 0 ? '∞' : item.quantity_remaining;
      const typeLabel = { role: '🎭 Role', code: '🎟️ Code', custom: '✨ Custom' }[item.type] || item.type;
      return `
        <div class="table-row" style="align-items:flex-start;">
          <span style="width:36px;font-size:0.8em;color:var(--text-muted);">#${item.id}</span>
          <div style="flex:1;">
            <div style="font-weight:600;">${escapeHtml(item.name)}</div>
            ${item.description ? `<div style="font-size:0.85em;color:var(--text-muted);">${escapeHtml(item.description)}</div>` : ''}
            <div style="font-size:0.8em;color:var(--text-muted);margin-top:2px;">${typeLabel} · Stock: ${stock}</div>
          </div>
          <span style="color:var(--accent-gold);font-weight:600;white-space:nowrap;">${item.cost.toLocaleString()} pts</span>
          <button class="btn-danger btn-sm" style="margin-left:10px;" onclick="deleteEngShopItem(${item.id})">Remove</button>
        </div>`;
    }).join('');
    el.innerHTML = `<div class="table-list" style="display:flex;flex-direction:column;gap:8px;">${rows}</div>`;
  } catch (e) { el.innerHTML = '<p style="color:var(--error);">Failed to load shop items.</p>'; }
}

function openEngShopModal() {
  document.getElementById('engShopName').value = '';
  document.getElementById('engShopDesc').value = '';
  document.getElementById('engShopType').value = 'role';
  document.getElementById('engShopRoleId').value = '';
  document.getElementById('engShopCodes').value = '';
  document.getElementById('engShopCost').value = '';
  document.getElementById('engShopQty').value = '-1';
  onEngShopTypeChange();
  document.getElementById('engShopModal').style.display = 'flex';
}

function closeEngShopModal() {
  document.getElementById('engShopModal').style.display = 'none';
}

function onEngShopTypeChange() {
  const type = document.getElementById('engShopType').value;
  document.getElementById('engShopRoleRow').style.display = type === 'role' ? '' : 'none';
  document.getElementById('engShopCodesRow').style.display = type === 'code' ? '' : 'none';
}

async function submitEngShopItem() {
  const name = document.getElementById('engShopName').value.trim();
  const cost = parseInt(document.getElementById('engShopCost').value, 10);
  if (!name || !cost || cost < 1) { showError('Name and a valid cost are required.'); return; }
  const type = document.getElementById('engShopType').value;
  const body = {
    name,
    description: document.getElementById('engShopDesc').value.trim() || null,
    type,
    cost,
    quantity: parseInt(document.getElementById('engShopQty').value, 10) || -1,
    roleId: type === 'role' ? (document.getElementById('engShopRoleId').value.trim() || null) : null,
    codes: type === 'code' ? document.getElementById('engShopCodes').value.trim().split('\n').map(s=>s.trim()).filter(Boolean) : null,
  };
  try {
    const res = await fetch('/api/admin/engagement/shop', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.success) { showSuccess('Shop item added!'); closeEngShopModal(); loadEngagementShop(); }
    else showError(data.message || 'Failed to add item.');
  } catch (e) { showError('Error adding shop item.'); }
}

async function deleteEngShopItem(itemId) {
  if (!confirm('Remove this shop item?')) return;
  try {
    const res = await fetch(`/api/admin/engagement/shop/${itemId}`, { method: 'DELETE', credentials: 'include' });
    const data = await res.json();
    if (data.success) { showSuccess('Item removed.'); loadEngagementShop(); }
    else showError(data.message || 'Failed to remove item.');
  } catch (e) { showError('Error removing item.'); }
}

async function loadEngagementSettingsTab() {
  try {
    const res = await fetch('/api/admin/engagement/config', { credentials: 'include' });
    const data = await res.json();
    if (!data.success) return;
    const cfg = data.config;
    const en = document.getElementById('ps_moduleEngagementEnabled');
    const pm = document.getElementById('ps_engPtsMsg');
    const pr = document.getElementById('ps_engPtsReact');
    const cm = document.getElementById('ps_engCooldownMsg');
    const cr = document.getElementById('ps_engCooldownReact');
    if (en) en.checked = !!cfg.enabled;
    if (pm) pm.value = cfg.points_message ?? 5;
    if (pr) pr.value = cfg.points_reaction ?? 2;
    if (cm) cm.value = cfg.cooldown_message_mins ?? 60;
    if (cr) cr.value = cfg.cooldown_reaction_daily ?? 5;
  } catch (e) { console.error('[Engagement] settings tab load error:', e); }
}

async function saveEngagementConfigFromSettings() {
  try {
    const body = {
      enabled: document.getElementById('ps_moduleEngagementEnabled')?.checked ?? true,
      points_message: parseInt(document.getElementById('ps_engPtsMsg')?.value || '5', 10),
      points_reaction: parseInt(document.getElementById('ps_engPtsReact')?.value || '2', 10),
      cooldown_message_mins: parseInt(document.getElementById('ps_engCooldownMsg')?.value || '60', 10),
      cooldown_reaction_daily: parseInt(document.getElementById('ps_engCooldownReact')?.value || '5', 10),
    };
    const res = await fetch('/api/admin/engagement/config', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.success) showSuccess('Engagement settings saved!');
    else showError(data.message || 'Failed to save.');
  } catch (e) { showError('Error saving engagement settings.'); }
}



