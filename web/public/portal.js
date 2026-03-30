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

window.fetch = async function(input, init = {}) {
  const headers = buildTenantRequestHeaders(init.headers || (input instanceof Request ? input.headers : undefined));

  // Attach CSRF token to all state-changing requests
  const method = (init.method || 'GET').toUpperCase();
  if (_csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers.set('x-csrf-token', _csrfToken);
  }

  const shouldAttachGuild = isTenantSensitiveRequest(input);
  if (!shouldAttachGuild && method === 'GET') {
    return originalFetch(input, init);
  }

  return originalFetch(input, { ...init, headers });
};

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
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

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const mobileMenu = document.getElementById('mobileMenu');
      const confirmModal = document.getElementById('confirmModal');
      
      if (mobileMenu && mobileMenu.style.display === 'block') {
        toggleMobileMenu();
      } else if (confirmModal && confirmModal.style.display !== 'none') {
        closeConfirmModal();
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

  const walletsList = document.getElementById('walletsList');
  if (!walletsList) return;

  walletsList.innerHTML = `
    <div style="display:grid; gap:20px; grid-template-columns:repeat(auto-fit,minmax(280px,1fr));">
      <!-- Wallet Signature Method -->
      <div style="padding:28px; background:linear-gradient(135deg,rgba(99,102,241,0.15),rgba(99,102,241,0.05)); border:2px solid rgba(99,102,241,0.30); border-radius:14px; text-align:center;">
        <div style="font-size:2.5em; margin-bottom:12px;">🔗</div>
        <h4 style="color:#e0e7ff; margin-bottom:12px; font-size:1.15em;">Sign Message</h4>
        <p style="color:var(--text-secondary); font-size:0.9em; line-height:1.6; margin-bottom:20px;">
          Your wallet extension opens automatically.<br>Sign a message to prove ownership — <strong>free, no transaction</strong>.
        </p>
        <button id="signVerifyBtn" onclick="verifyBySignature()" class="btn-primary" style="padding:14px 24px; width:100%; font-size:1em;">
          ✓ Connect & Sign
        </button>
        <p style="color:var(--text-muted); font-size:0.8em; margin-top:10px;">Phantom · Solflare · Backpack</p>
      </div>

      <!-- Micro Transaction Method -->
      <div style="padding:28px; background:linear-gradient(135deg,rgba(99,102,241,0.15),rgba(99,102,241,0.05)); border:2px solid rgba(99,102,241,0.30); border-radius:14px; text-align:center;">
        <div style="font-size:2.5em; margin-bottom:12px;">💸</div>
        <h4 style="color:#e0e7ff; margin-bottom:12px; font-size:1.15em;">Micro Transaction</h4>
        <p style="color:var(--text-secondary); font-size:0.9em; line-height:1.6; margin-bottom:20px;">
          Send a tiny SOL amount (~0.001) to verify.<br>Your wallet opens automatically — <strong>funds returned after</strong>.
        </p>
        <button id="microVerifyBtn" onclick="verifyByMicroTx()" class="btn-primary" style="padding:14px 24px; width:100%; font-size:1em;">
          💰 Send & Verify
        </button>
        <p style="color:var(--text-muted); font-size:0.8em; margin-top:10px;">Any Solana wallet that supports transfers</p>
      </div>
    </div>
    <div id="verifyStatus" style="margin-top:16px;"></div>
  `;
  walletsList.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Detect available Solana wallet provider
function getSolanaProvider() {
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solflare?.isSolflare) return window.solflare;
  if (window.backpack?.isBackpack) return window.backpack;
  if (window.solana) return window.solana;
  return null;
}

async function verifyBySignature() {
  const btn = document.getElementById('signVerifyBtn');
  const statusEl = document.getElementById('verifyStatus');
  
  const provider = getSolanaProvider();
  if (!provider) {
    showError('No Solana wallet detected. Please install Phantom, Solflare, or Backpack.');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '⏳ Connecting wallet...';

  try {
    // 1. Connect wallet
    const resp = await provider.connect();
    const walletAddress = resp.publicKey.toString();
    btn.innerHTML = '⏳ Requesting challenge...';

    // 2. Get challenge from server
    const challengeRes = await fetch('/api/verify/challenge', { method: 'POST', credentials: 'include' });
    const challengeData = await challengeRes.json();
    if (!challengeData.success) throw new Error(challengeData.message || 'Failed to get challenge');

    btn.innerHTML = '⏳ Sign the message in your wallet...';

    // 3. Sign the challenge message
    const encodedMessage = new TextEncoder().encode(challengeData.message);
    const signedMessage = await provider.signMessage(encodedMessage, 'utf8');
    
    // Extract signature bytes → base58
    const signatureBytes = signedMessage.signature || signedMessage;
    const signatureBase58 = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)))
      // We need base58, not base64. Use a lightweight encoder.
      ;
    // Actually, convert Uint8Array to base58 using a small helper
    const sig58 = uint8ToBase58(new Uint8Array(signatureBytes));

    btn.innerHTML = '⏳ Verifying on server...';

    // 4. Submit to server
    const verifyRes = await fetch('/api/verify/signature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, signature: sig58 })
    });
    const verifyData = await verifyRes.json();

    if (verifyData.success) {
      showSuccess(verifyData.message || 'Wallet verified!');
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
    btn.disabled = false;
    btn.innerHTML = '✓ Connect & Sign';
  }
}

async function verifyByMicroTx() {
  const btn = document.getElementById('microVerifyBtn');
  const statusEl = document.getElementById('verifyStatus');

  const provider = getSolanaProvider();
  if (!provider) {
    showError('No Solana wallet detected. Please install Phantom, Solflare, or Backpack.');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '⏳ Requesting verification...';

  try {
    // 1. Create micro-verify request on server
    const reqRes = await fetch('/api/micro-verify/request', { method: 'POST', credentials: 'include' });
    const reqData = await reqRes.json();
    if (!reqData.success) throw new Error(reqData.message || 'Failed to create verification request');

    const { amount, destinationWallet, id: requestId } = reqData.request || reqData;
    const lamports = Math.round((amount || 0.001) * 1e9);

    btn.innerHTML = '⏳ Approve transaction in your wallet...';

    // 2. Connect wallet and send micro transaction
    const resp = await provider.connect();
    const fromPubkey = resp.publicKey;

    // Build and send transaction using Solana web3
    // We need @solana/web3.js — load it dynamically if not present
    if (!window.solanaWeb3) {
      await loadScript('https://unpkg.com/@solana/web3.js@1.98.0/lib/index.iife.min.js');
    }
    const { Connection, PublicKey, Transaction, SystemProgram } = window.solanaWeb3;

    const SOLANA_RPC = window.GUILDPILOT_CONFIG?.solanaRpc || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(SOLANA_RPC, 'confirmed');
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey: new PublicKey(destinationWallet),
        lamports
      })
    );

    transaction.feePayer = fromPubkey;
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    const signed = await provider.signTransaction(transaction);
    btn.innerHTML = '⏳ Sending transaction...';
    const txSig = await connection.sendRawTransaction(signed.serialize());

    btn.innerHTML = '⏳ Confirming...';
    await connection.confirmTransaction(txSig, 'confirmed');

    showSuccess('Transaction sent! Verification is processing — your wallet will appear shortly.');

    // Show status area with polling
    if (statusEl) {
      statusEl.innerHTML = `
        <div style="padding:16px; background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.3); border-radius:10px; text-align:center;">
          <div class="spinner" style="width:24px; height:24px; margin:0 auto 8px;"></div>
          <p style="color:#86efac; font-weight:600;">Transaction sent! Waiting for server confirmation...</p>
          <p style="color:var(--text-secondary); font-size:0.85em; margin-top:6px;">TX: ${txSig.slice(0, 16)}...</p>
        </div>
      `;
    }

    // Poll for completion
    pollMicroVerifyStatus(statusEl);

  } catch (error) {
    if (error.code === 4001 || error.message?.includes('reject')) {
      showInfo('Transaction cancelled. No changes made.');
    } else {
      showError('Verification failed: ' + (error.message || 'Unknown error'));
      console.error('Micro-tx verification error:', error);
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '💰 Send & Verify';
  }
}

async function pollMicroVerifyStatus(statusEl, attempts = 0) {
  if (attempts > 30) {
    if (statusEl) statusEl.innerHTML = `<div style="padding:12px; background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.3); border-radius:10px; text-align:center; color:#fcd34d;">Verification is still processing. It may take a few minutes — refresh the page to check.</div>`;
    return;
  }
  
  try {
    const res = await fetch('/api/micro-verify/status', { credentials: 'include' });
    const data = await res.json();
    
    if (data.success && data.request?.status === 'verified') {
      showSuccess('Wallet verified via micro-transaction!');
      await loadPortal();
      return;
    }
  } catch (e) { /* continue polling */ }

  setTimeout(() => pollMicroVerifyStatus(statusEl, attempts + 1), 5000);
}

// Load external script dynamically
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
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
      const iconUrl = getActiveBrandLogoUrl(record);
      brandTitle.innerHTML = iconUrl
        ? `<img src="${iconUrl}" alt="" style="width:22px;height:22px;border-radius:50%;vertical-align:middle;margin-right:8px;object-fit:cover;">${escapeHtml(record?.name || 'Portal')}`
        : `${escapeHtml(record?.name || 'Portal')}`;
    }
  } else {
    badge.style.display = 'inline-flex';
    badge.textContent = 'Select server';
    badge.title = 'No active server selected';
    if (brandTitle) brandTitle.innerHTML = '<img src="/assets/branding/guildpilot-logo.png" alt="" style="width:22px;height:22px;border-radius:50%;vertical-align:middle;margin-right:8px;object-fit:cover;">GuildPilot';
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
  const tenantSections = ['governance', 'treasury', 'nft-activity', 'heist'];

  tenantSections.forEach(section => {
    setNavSectionVisibility(section, !locked);
    const sectionEl = document.getElementById(`section-${section}`);
    if (sectionEl) sectionEl.style.display = locked ? 'none' : '';
  });

  // Profile/wallets remain available pre-selection
  setNavSectionVisibility('wallets', true);
  setNavSectionVisibility('landing', true);

  const walletsSection = document.getElementById('section-wallets');
  if (walletsSection) walletsSection.style.display = '';

  updateSidebarModuleNav();
  renderGeneralSection();
}

function updateModuleVisibility() {
  const state = window._tenantModuleState || {};
  const moduleNav = [
    { id: 'sidebarNavTreasury', key: 'treasury' },
    { id: 'sidebarNavSelfServe', key: 'selfseveroles' },
    { id: 'sidebarNavTicketing', key: 'ticketing' },
    { id: 'sidebarNavHeist', key: 'heist' },
    { id: 'mobileNavTreasury', key: 'treasury' },
    { id: 'mobileNavSelfServe', key: 'selfseveroles' },
    { id: 'mobileNavTicketing', key: 'ticketing' },
    { id: 'mobileNavHeist', key: 'heist' },
  ];
  moduleNav.forEach(({ id, key }) => {
    const el = document.getElementById(id);
    if (el) el.style.display = (state[key] === false) ? 'none' : '';
  });
}

// ==================== GENERAL HUB & SETTINGS ====================

function renderGeneralSection() {
  const preEl = document.getElementById('generalPreSelection');
  const postEl = document.getElementById('generalPostSelection');
  if (!preEl || !postEl) return;

  if (!activeGuildId) {
    preEl.style.display = '';
    postEl.style.display = 'none';
    return;
  }

  preEl.style.display = 'none';
  postEl.style.display = '';

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
            <button onclick="navigator.clipboard.writeText('${escapeHtml(activeGuildId)}');showSuccess('Server ID copied!')" style="background:none;border:1px solid rgba(99,102,241,0.2);border-radius:4px;color:var(--text-secondary);padding:2px 6px;cursor:pointer;font-size:0.8em;">Copy</button>
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
      { key: 'treasury', icon: '\ud83d\udcb0', label: 'Wallet Tracker', section: 'treasury' },
      { key: 'nfttracker', icon: '\ud83c\udfa8', label: 'NFT Tracker', section: 'nft-activity' },
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
        <button class="quick-action-tile" onclick="switchSection('${m.section}')">
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
    selfserve:    'adminSelfServeRolesCard',
    ticketing:    'adminTicketingCard',
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
    nfttracker:   () => { if (typeof loadNftTrackerSettingsView === 'function') loadNftTrackerSettingsView(); },
    selfserve:    () => { if (typeof loadSelfServeRolesView === 'function') loadSelfServeRolesView(); },
    ticketing:    () => { if (typeof loadTicketingView === 'function') loadTicketingView(); },
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
    { id: 'sidebarNavWallets', module: 'verification' },
    { id: 'sidebarNavTreasury', module: 'treasury' },
    { id: 'sidebarNavNftActivity', module: 'nfttracker' },
    { id: 'sidebarNavHeist', module: 'heist' },
    // Plans nav handled separately (superadmin-only)
  ];

  moduleItems.forEach(({ id, module }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const enabled = module === null || state[module] !== false;
    el.style.display = (hasServer && enabled) ? '' : 'none';
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
  const moduleState = {
    governance: !!settings.moduleGovernanceEnabled,
    verification: !!settings.moduleVerificationEnabled,
    treasury: !!settings.moduleTreasuryEnabled,
    nfttracker: !!settings.moduleNftTrackerEnabled,
    heist: !!settings.moduleMissionsEnabled,
    ticketing: !!settings.moduleTicketingEnabled,
    roleclaim: !!settings.moduleRoleClaimEnabled,
    battle: !!settings.moduleBattleEnabled,
    selfseveroles: !!settings.moduleRoleClaimEnabled
  };
  window._tenantModuleState = moduleState;

  const sectionMap = {
    governance: moduleState.governance,
    wallets: moduleState.verification,
    treasury: moduleState.treasury,
    'nft-activity': moduleState.nfttracker,
    heist: moduleState.heist
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
    'section-treasury': !moduleState.treasury,
    'section-nft-activity': !moduleState.nfttracker,
    'section-heist': !moduleState.heist
  };
  if (activeSection && disabledActive[activeSection]) {
    switchSection('dashboard');
  }
}

// Settings tab -> module key mapping
const SETTINGS_TAB_MODULE_MAP = {
  governance:   'governance',
  verification: 'verification',
  treasury:     'treasury',
  nfttracker:   'nfttracker',
  battle:       'battle',
  heist:        'heist',
  selfserve:    'selfserveroles',
  ticketing:    'ticketing',
};

function applySettingsTabVisibility(settings = {}) {
  // assignedModuleKeys is only present when multiTenant is on and a tenant exists.
  // null means all modules are available (single-tenant mode).
  const assigned = settings.assignedModuleKeys || null;
  const enabledByModule = {
    governance: !!settings.moduleGovernanceEnabled,
    verification: !!settings.moduleVerificationEnabled,
    treasury: !!settings.moduleTreasuryEnabled,
    nfttracker: !!settings.moduleNftTrackerEnabled,
    battle: !!settings.moduleBattleEnabled,
    heist: !!settings.moduleMissionsEnabled,
    selfserveroles: !!settings.moduleRoleClaimEnabled,
    ticketing: !!settings.moduleTicketingEnabled,
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
    ? `onclick="setActiveGuild('${server.guildId}', { goToSettings: true })"`
    : `onclick="openGuildInvite('${server.guildId}')"`;

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
  window.location.href = `/api/servers/invite-link?guildId=${encodeURIComponent(guildId)}`;
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
      
      // Show/hide heist nav items
      if (heistEnabled) {
        document.getElementById('navHeist').style.display = 'block';
        document.getElementById('mobileNavHeist').style.display = 'block';
        document.getElementById('heistPointsCard').style.display = 'block';
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
    const section = urlParams.get('section');
    if (section && !requiresServerSelectionGate()) {
      switchSection(section);
    } else if (userData && requiresServerSelectionGate()) {
      switchSection('landing');
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
    if (landingBtn) {
      landingBtn.style.display = isSuperadmin ? 'inline-block' : 'none';
    }

    if (!isSuperadmin) {
      const card = document.getElementById('adminSuperadminCard');
      if (card) card.style.display = 'none';
    }

    refreshAdminEntryVisibility();
  } catch (error) {
    isSuperadmin = false;
    const landingBtn = document.getElementById('landingSuperadminBtn');
    if (landingBtn) landingBtn.style.display = 'none';
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
        <p class="empty-state-message">You haven't created any proposals. Use the /propose command in Discord to submit your first proposal.</p>
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
      ${proposal.status === 'draft' ? `<button onclick="submitProposalForReview('${escapeHtml(proposal.proposal_id)}')" style="margin-top:8px; padding:6px 14px; background:#6366f1; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">Submit for Review</button>` : ''}
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
  
  try {
    const response = await fetch('/api/public/proposals/active', { credentials: 'include' });
    const data = await response.json();
    
    if (!data.success || !data.proposals || data.proposals.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🗳️</div>
          <h4 class="empty-state-title">No Active Proposals</h4>
          <p class="empty-state-message">There are no proposals currently open for voting. Check back soon or create your own!</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '<div class="proposal-list">' + data.proposals.map(proposal => {
      const totalVP = (proposal.votes?.yes?.vp || 0) + (proposal.votes?.no?.vp || 0) + (proposal.votes?.abstain?.vp || 0);
      const yesPercent = totalVP > 0 ? Math.round((proposal.votes?.yes?.vp || 0) / totalVP * 100) : 0;
      const noPercent = totalVP > 0 ? Math.round((proposal.votes?.no?.vp || 0) / totalVP * 100) : 0;
      const quorumPercent = proposal.quorum?.current || 0;
      const quorumRequired = proposal.quorum?.required || 50;
      const quorumMet = quorumPercent >= quorumRequired;
      
      return `
        <div class="proposal-item">
          <div class="proposal-header">
            <div class="proposal-title">${escapeHtml(proposal.title)}</div>
            <span class="status-badge status-${proposal.status}">${proposal.status}</span>
          </div>
          <div class="proposal-meta" style="margin-bottom: var(--space-4);">
            Proposal #${proposal.proposal_id} • Created by ${escapeHtml(proposal.creator || 'Unknown')}
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
            <button class="btn-success" onclick="castVote('${proposal.proposalId}','yes')" style="flex:1; min-width:80px;">👍 Yes</button>
            <button class="btn-danger" onclick="castVote('${proposal.proposalId}','no')" style="flex:1; min-width:80px;">👎 No</button>
            <button class="btn-secondary" onclick="castVote('${proposal.proposalId}','abstain')" style="flex:1; min-width:80px;">⏭️ Abstain</button>
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
  
  if (!userData.wallets || userData.wallets.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💼</div>
        <h4 class="empty-state-title">No Wallets Connected</h4>
        <p class="empty-state-message">Link your Solana wallet to verify NFT ownership and unlock voting power.</p>
        <div class="empty-state-action">
          <button class="btn-primary" onclick="showWalletAddForm()">
            <span>➕</span>
            <span>Add Your First Wallet</span>
          </button>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = '<div class="wallet-list">' + userData.wallets.map(wallet => `
    <div class="wallet-item ${wallet.is_favorite ? 'favorite' : ''}">
      <div class="wallet-info">
        <div class="wallet-address">
          ${wallet.is_favorite ? '⭐ ' : ''}${escapeHtml(wallet.wallet_address)}
        </div>
        <div class="wallet-meta">
          ${wallet.is_favorite ? '<span style="color: var(--gold);">⭐ Primary Wallet</span>' : '<span>Secondary Wallet</span>'}
          <span>Verified ${formatDate(new Date(wallet.created_at || Date.now()))}</span>
        </div>
      </div>
      <div class="wallet-actions">
        ${!wallet.is_favorite ? `
          <button class="btn-secondary" onclick="setFavorite('${wallet.wallet_address}')">
            <span>⭐</span>
            <span>Set Primary</span>
          </button>
        ` : ''}
        <button class="btn-danger" onclick="confirmRemoveWallet('${wallet.wallet_address}')">
          <span>🗑️</span>
          <span>Remove</span>
        </button>
      </div>
    </div>
  `).join('') + '</div>';
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
    const response = await fetch('/api/public/missions/active', { credentials: 'include' });
    const data = await response.json();
    
    if (!data.success || !data.missions || data.missions.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🗺️</div>
          <h4 class="empty-state-title">No Missions Available</h4>
          <p class="empty-state-message">Check back later for new mission opportunities.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '<div class="mission-list">' + data.missions.map(mission => `
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
function switchSection(sectionName) {
  if (requiresServerSelectionGate()) {
    const allowWithoutServer = ['landing', 'servers', 'wallets'];
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
    treasury: 'treasury',
    'nft-activity': 'nfttracker',
    heist: 'heist',
    battle: 'battle',
    'self-serve-roles': 'selfseveroles',
    ticketing: 'ticketing'
  };
  const required = sectionRequiresModule[sectionName];
  if (required && moduleState && moduleState[required] === false) {
    showInfo('This module is disabled for the selected server.');
    sectionName = 'dashboard';
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
    if (isAdmin) showAdminTreasuryElements();
  } else if (sectionName === 'nft-activity') {
    loadNFTActivityView();
    if (isAdmin) loadNFTActivityAdminView();
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
  url.searchParams.set('section', sectionName);
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
    const response = await fetch('/api/public/v1/treasury', { credentials: 'include' });
    const data = await response.json();
    
    if (data.success) {
      const t = data.data || data.treasury || {};
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
function switchTreasuryTab(tabName) {
  document.querySelectorAll('.treasury-tab-pane').forEach(p => p.style.display = 'none');
  document.querySelectorAll('#treasuryTabs .settings-tab').forEach(t => t.classList.remove('active'));
  const pane = document.getElementById('treasuryTab-' + tabName);
  if (pane) pane.style.display = 'block';
  const btn = document.querySelector(`#treasuryTabs .settings-tab[data-tab="${tabName}"]`);
  if (btn) btn.classList.add('active');

  if (tabName === 'treasury-history') {
    loadTreasuryPublicView();
    loadTreasuryTransactions();
  } else if (tabName === 'treasury-alerts') {
    loadTreasuryAlertsConfig();
  } else if (tabName === 'treasury-wallets') {
    loadTreasuryWalletTable();
  }
}

function showAdminTreasuryElements() {
  document.querySelectorAll('.admin-only-treasury').forEach(el => {
    el.style.display = '';
  });
}

async function loadTreasuryWalletTable() {
  const container = document.getElementById('treasuryWalletTableContainer');
  if (!container) return;

  try {
    const response = await fetch('/api/admin/treasury', { credentials: 'include', headers: buildTenantRequestHeaders() });
    if (!response.ok) {
      // Non-admin: try public endpoint
      const pubRes = await fetch('/api/public/treasury', { credentials: 'include', headers: buildTenantRequestHeaders() });
      const pubData = await pubRes.json();
      const t = pubData.data || pubData.treasury || pubData;
      if (t && t.sol !== undefined) {
        renderWalletTableFromConfig({ solanaWallet: null, label: 'Treasury' }, t);
        document.getElementById('treasuryWalletCount').textContent = '1';
      } else {
        renderWalletEmptyState(container, false);
        document.getElementById('treasuryWalletCount').textContent = '0';
      }
      return;
    }

    const data = await response.json();
    const config = data.config || data;
    const treasury = data.treasury || {};

    if (config.solanaWallet) {
      renderWalletTableFromConfig(config, treasury);
      document.getElementById('treasuryWalletCount').textContent = '1';
      if (isAdmin) showAdminTreasuryElements();
    } else {
      renderWalletEmptyState(container, isAdmin);
      document.getElementById('treasuryWalletCount').textContent = '0';
      if (isAdmin) showAdminTreasuryElements();
    }
  } catch (err) {
    console.error('[Treasury] Wallet table load error:', err);
    container.innerHTML = '<div style="color:#ef4444; text-align:center; padding:20px;">Error loading wallet data</div>';
  }
}

function renderWalletTableFromConfig(config, treasury) {
  const container = document.getElementById('treasuryWalletTableContainer');
  const wallet = config.solanaWallet || config.wallet || '';
  const label = config.label || 'Treasury';
  const truncAddr = wallet ? `${wallet.slice(0,6)}...${wallet.slice(-4)}` : '—';
  const channel = config.txAlertChannelId ? `<code>#${config.txAlertChannelId}</code>` : '<span style="color:var(--text-secondary);">—</span>';
  // TODO: multi-wallet support — txTypes per wallet. For now, show based on config flags.
  const txTypes = ['sol-transfer', 'token-transfer'];
  const typeBadges = txTypes.slice(0, 2).map(t => `<span class="badge badge-module">${t}</span>`).join('') +
    (txTypes.length > 2 ? `<span class="badge badge-module">+${txTypes.length - 2} more</span>` : '');
  const statusBadge = config.enabled !== false
    ? '<span class="badge badge-active">Active</span>'
    : '<span class="badge badge-paused">Paused</span>';
  const balanceInfo = treasury.sol ? ` <span style="color:var(--text-secondary); font-size:0.85em;">(${treasury.sol} SOL)</span>` : '';

  const actionsHtml = isAdmin ? `
    <div class="treasury-wallet-actions" style="display:flex; gap:4px;">
      <button title="Refresh" onclick="refreshTreasuryBalances()">🔄</button>
      <button title="Edit" onclick="openAddWalletModal('${wallet}', '${label}', '${config.txAlertChannelId || ''}')">✏️</button>
      <button title="Remove wallet" style="color:#ef4444;" onclick="removeTreasuryWallet()">🗑️</button>
    </div>
  ` : '';

  container.innerHTML = `
    <div class="card" style="overflow-x:auto;">
      <table class="data-table">
        <thead>
          <tr>
            <th>Address</th>
            <th>Channel</th>
            <th>TX Types</th>
            <th>Status</th>
            ${isAdmin ? '<th>Actions</th>' : ''}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <div class="addr-cell">
                <span>${truncAddr}</span>${balanceInfo}
                ${wallet ? `<button class="copy-btn" onclick="navigator.clipboard.writeText('${wallet}');this.textContent='✓';setTimeout(()=>this.textContent='📋',1200)" title="Copy address">📋</button>` : ''}
                <span style="color:#a5b4fc; font-size:0.85em;">{${label}}</span>
              </div>
            </td>
            <td>${channel}</td>
            <td><div class="tx-type-badges">${typeBadges}</div></td>
            <td>${statusBadge}</td>
            ${isAdmin ? `<td>${actionsHtml}</td>` : ''}
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderWalletEmptyState(container, canAdd) {
  container.innerHTML = `
    <div class="card treasury-empty-state">
      <p>No wallets tracked yet. Add a wallet to start monitoring.</p>
      ${canAdd ? '<button class="btn-primary" onclick="openAddWalletModal()">+ Add Wallet</button>' : ''}
    </div>
  `;
}

async function removeTreasuryWallet() {
  if (!confirm('Remove this treasury wallet? This clears the wallet address from settings.')) return;
  try {
    const res = await fetch('/api/admin/treasury/config', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      body: JSON.stringify({ solanaWallet: '' })
    });
    const data = await res.json();
    if (data.success) {
      showSuccess('Wallet removed.');
      loadTreasuryWalletTable();
    } else {
      showError(data.message || 'Failed to remove wallet.');
    }
  } catch (e) {
    showError('Error removing wallet.');
  }
}

async function refreshTreasuryBalances() {
  try {
    showSuccess('Refreshing treasury balances...');
    await fetch('/api/admin/treasury/refresh', { method: 'POST', credentials: 'include' });
    setTimeout(() => loadTreasuryWalletTable(), 2000);
  } catch (err) {
    console.error('[Treasury] Refresh error:', err);
  }
}

// ==================== ADD WALLET MODAL ====================
async function openAddWalletModal(existingAddr, existingLabel, existingChannel) {
  const modal = document.getElementById('addWalletModal');
  document.getElementById('addWalletAddress').value = existingAddr || '';
  document.getElementById('addWalletLabel').value = existingLabel || '';
  document.getElementById('addWalletError').style.display = 'none';
  // Reset checkboxes
  document.querySelectorAll('.addWalletTxType').forEach(cb => {
    cb.checked = cb.value === 'sol-transfer' || cb.value === 'token-transfer';
  });
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Populate channel dropdown
  const sel = document.getElementById('addWalletChannel');
  sel.innerHTML = '<option value="">-- No alert channel --</option>';
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
      Object.keys(grouped).sort().forEach(parent => {
        const og = document.createElement('optgroup');
        og.label = parent;
        grouped[parent].forEach(ch => {
          const opt = document.createElement('option');
          opt.value = ch.id;
          opt.textContent = '# ' + ch.name;
          og.appendChild(opt);
        });
        sel.appendChild(og);
      });
    }
  } catch (e) { console.error('[AddWalletModal] Channel load error:', e); }
  // Set current value after populating
  if (existingChannel) sel.value = existingChannel;
}

function closeAddWalletModal() {
  document.getElementById('addWalletModal').style.display = 'none';
  document.body.style.overflow = '';
}

async function saveNewWallet() {
  const addr = document.getElementById('addWalletAddress').value.trim();
  const label = document.getElementById('addWalletLabel').value.trim();
  const channel = document.getElementById('addWalletChannel').value.trim();
  const errEl = document.getElementById('addWalletError');

  if (!addr) {
    errEl.textContent = 'Wallet address is required.';
    errEl.style.display = 'block';
    return;
  }
  if (addr.length < 32 || addr.length > 44) {
    errEl.textContent = 'Invalid Solana wallet address.';
    errEl.style.display = 'block';
    return;
  }

  const saveBtn = document.getElementById('addWalletSaveBtn');
  saveBtn.textContent = 'Saving...';
  saveBtn.disabled = true;

  try {
    // TODO: When multi-wallet API exists, POST to /api/admin/treasury/wallets
    // For now, wire to the single-wallet config API
    const payload = {
      enabled: true,
      solanaWallet: addr,
      txAlertChannelId: channel || undefined,
      txAlertsEnabled: !!channel
    };
    const res = await fetch('/api/admin/treasury/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (result.success) {
      closeAddWalletModal();
      showSuccess('Wallet saved successfully!');
      loadTreasuryWalletTable();
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
  window.location.href = '/auth/discord/login';
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

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
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
  ['adminUsersCard', 'adminProposalsCard', 'adminSettingsCard', 'adminSuperadminCard', 'adminSystemMonitorCard', 'adminAnalyticsCard', 'adminHelpCard', 'adminRolesCard', 'adminActivityCard', 'adminStatsCard', 'adminNftTrackerCard', 'adminVotingPowerCard', 'adminSelfServeRolesCard', 'adminApiRefCard', 'adminTicketingCard']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
}

let _envStatusCache = null;
async function loadEnvStatusBar() {
  const bar = document.getElementById('adminEnvStatusBar');
  if (!bar) return;
  if (_envStatusCache && _envStatusCache.nodeEnv) { renderEnvStatusBar(bar, _envStatusCache); return; }
  try {
    const res = await fetch('/api/admin/env-status', { credentials: 'include' });
    const data = await res.json();
    _envStatusCache = data;
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

function toggleAdminSubmenu() {
  const submenu = document.getElementById('adminSubmenu');
  const chevron = document.getElementById('adminChevron');
  if (!submenu) return;
  const isOpen = submenu.style.display !== 'none';
  if (isOpen) {
    submenu.style.display = 'none';
    if (chevron) chevron.textContent = '▶';
  } else {
    submenu.style.display = 'flex';
    if (chevron) chevron.textContent = '▼';
    // If no sub-item is active yet, show settings by default
    const hasActive = submenu.querySelector('.admin-sub-item.active');
    if (!hasActive) showAdminView('settings');
  }
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

function showAdminUsers() {
  showAdminView('users');
}

let superadminListCache = [];
let tenantListCache = [];
let selectedTenantGuildId = null;
let selectedTenantDetailCache = null;
let selectedTenantAuditCache = [];
let superadminTenantSearch = '';
let superadminActiveTab = 'tenants';
let tenantDetailActiveTab = 'overview';

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
  battle: 'Battle',
  heist: 'Heist',
  ticketing: 'Ticketing',
  nfttracker: 'NFT Tracker',
  selfserveroles: 'Self-Serve Roles',
  analytics: 'Analytics'
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

function renderTenantRow(tenant) {
  const selected = tenant.guildId === selectedTenantGuildId;
  const statusColor = String(tenant.status || 'active').toLowerCase() === 'suspended'
    ? 'rgba(239,68,68,0.18)'
    : 'rgba(34,197,94,0.18)';

  return `
    <button type="button" onclick="selectTenantGuild('${escapeHtml(tenant.guildId)}')" style="width:100%; text-align:left; display:grid; grid-template-columns:minmax(0,1.6fr) repeat(3,minmax(0,1fr)); gap:12px; align-items:center; padding:12px 14px; border:none; border-bottom:1px solid rgba(99,102,241,0.15); background:${selected ? 'rgba(99,102,241,0.16)' : 'transparent'}; color:inherit; cursor:pointer;">
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

  return logs.map(log => `
    <div style="padding:12px 14px; border:1px solid rgba(99,102,241,0.15); border-radius:10px; background:rgba(14,23,44,0.45);">
      <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
        <div style="min-width:0;">
          <div style="color:#e0e7ff; font-weight:600;">${escapeHtml(log.action)}</div>
          <div style="color:var(--text-secondary); font-size:0.8em; margin-top:4px; word-break:break-all;">Actor: ${escapeHtml(log.actor_id || 'system')}</div>
        </div>
        <div style="color:var(--text-secondary); font-size:0.78em; white-space:nowrap;">${escapeHtml(new Date(log.created_at).toLocaleString())}</div>
      </div>
    </div>
  `).join('');
}

function renderTenantDetailPanel(tenant) {
  if (!tenant) {
    return `<div style="padding:18px; text-align:center; color:var(--text-secondary);">Select a tenant to manage plan, modules, branding, and status.</div>`;
  }

  const planOptions = Object.entries(TENANT_PLAN_LABELS).map(([key, label]) => `
    <option value="${escapeHtml(key)}"${tenant.planKey === key ? ' selected' : ''}>${escapeHtml(label)}</option>
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

  return `
    <div style="display:grid; gap:16px;">
      <div style="padding:10px 12px;border:1px solid rgba(99,102,241,0.2);border-radius:10px;background:rgba(30,41,59,0.45);color:#cbd5e1;font-size:0.82em;">
        <strong style="color:#e2e8f0;">You are editing tenant:</strong> ${escapeHtml(tenant.guildName || tenant.guildId)} <span style="font-family:monospace;opacity:.85;">(${escapeHtml(tenant.guildId)})</span>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button data-tenant-detail-tab="overview" class="btn-primary" onclick="showTenantDetailTab('overview')" style="padding:8px 12px;">Overview</button>
        <button data-tenant-detail-tab="controls" class="btn-secondary" onclick="showTenantDetailTab('controls')" style="padding:8px 12px;">Plan & Status</button>
        <button data-tenant-detail-tab="branding" class="btn-secondary" onclick="showTenantDetailTab('branding')" style="padding:8px 12px;">Branding</button>
        <button data-tenant-detail-tab="modules" class="btn-secondary" onclick="showTenantDetailTab('modules')" style="padding:8px 12px;">Modules</button>
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
    const [adminsResponse, tenantsResponse] = await Promise.all([
      fetch('/api/superadmin/admins', { credentials: 'include' }),
      fetch('/api/superadmin/tenants', { credentials: 'include' })
    ]);

    const [adminsData, tenantsData] = await Promise.all([
      adminsResponse.json(),
      tenantsResponse.json()
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
    if (!selectedTenantGuildId || !tenantListCache.some(tenant => tenant.guildId === selectedTenantGuildId)) {
      selectedTenantGuildId = tenantListCache[0]?.guildId || null;
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
              <button class="btn-secondary" style="font-size:0.85em; padding:6px 12px; opacity:${removable ? 1 : 0.45};" ${removable ? `onclick="removeSuperadmin('${entry.userId}')"` : 'disabled'}>
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
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button data-superadmin-tab-btn="tenants" class="btn-primary" onclick="showSuperadminTab('tenants')" style="padding:8px 12px;">Tenants</button>
          <button data-superadmin-tab-btn="eras" class="btn-secondary" onclick="showSuperadminTab('eras')" style="padding:8px 12px;">Era Assignments</button>
          <button data-superadmin-tab-btn="superadmins" class="btn-secondary" onclick="showSuperadminTab('superadmins')" style="padding:8px 12px;">Superadmins</button>
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

        <div id="superadminSection-tenants" style="padding:14px; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.45);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Tenant Management <span style="margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(99,102,241,0.2);font-size:0.72em;vertical-align:middle;">Tenant Scoped</span></h4>
            <button class="btn-secondary" onclick="loadSuperadminView()" style="padding:8px 12px;">Refresh</button>
          </div>

          <div style="display:grid; grid-template-columns:minmax(240px,0.45fr) minmax(220px,0.35fr) auto; gap:10px; margin-bottom:12px; align-items:center;">
            <input id="superadminTenantSearch" type="text" value="${escapeHtml(superadminTenantSearch)}" placeholder="Search tenant by name, id, or plan..." oninput="applySuperadminTenantFilter(this.value)" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; width:100%;">
            <select id="superadminTenantSelect" onchange="selectTenantGuild(this.value)" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; width:100%;">
              ${tenantListCache.map(t => `<option value="${escapeHtml(t.guildId)}"${t.guildId === selectedTenantGuildId ? ' selected' : ''}>${escapeHtml(t.guildName || t.guildId)} (${escapeHtml(t.guildId)})</option>`).join('')}
            </select>
            <div style="color:var(--text-secondary);font-size:0.82em;text-align:right;">Showing ${filteredTenants.length}/${tenantListCache.length}</div>
          </div>

          <div style="border:1px solid rgba(99,102,241,0.15); border-radius:10px; overflow:hidden;">
            <div style="display:grid; grid-template-columns:minmax(0,1.6fr) repeat(3,minmax(0,1fr)); gap:12px; padding:10px 14px; background:rgba(99,102,241,0.12); color:#c9d6ff; font-weight:600; font-size:0.82em;">
              <div>Guild</div>
              <div>Plan</div>
              <div>Status</div>
              <div>Modules</div>
            </div>
            <div>${tenantRows}</div>
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

    if (selectedTenantGuildId) {
      await loadSelectedTenantDetail();
    }
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
    content.innerHTML = renderTenantDetailPanel(null);
    return;
  }

  content.innerHTML = `<div style="text-align:center; padding:20px;"><div class="spinner"></div><p style="margin-top:10px;">Loading tenant details...</p></div>`;

  try {
    const [tenantResponse, auditResponse] = await Promise.all([
      fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}`, { credentials: 'include' }),
      fetch(`/api/superadmin/tenants/${encodeURIComponent(selectedTenantGuildId)}/audit?limit=10`, { credentials: 'include' })
    ]);

    const [tenantData, auditData] = await Promise.all([
      tenantResponse.json(),
      auditResponse.json()
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
    content.innerHTML = renderTenantDetailPanel(selectedTenantDetailCache);
    showTenantDetailTab(tenantDetailActiveTab || 'overview');
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
        select.innerHTML = '<option value="">No exclusive eras</option>';
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
            <div style="color:var(--text-secondary); font-size:0.88em;">${escapeHtml(a.assigned_by || '—')}</div>
            <button class="btn-secondary" style="font-size:0.85em; padding:6px 12px;" onclick="revokeEra('${escapeHtml(a.guild_id)}', '${escapeHtml(a.era_key)}')">Revoke</button>
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

function showSuperadminTab(tab) {
  superadminActiveTab = tab;
  const sections = {
    superadmins: ['superadminSection-superadminsInput', 'superadminSection-superadmins'],
    tenants: ['superadminSection-tenants', 'superadminSection-detail'],
    eras: ['superadminSection-eras'],
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
}

function selectTenantGuild(guildId) {
  selectedTenantGuildId = guildId;
  loadSuperadminView();
}

function applySuperadminTenantFilter(query) {
  superadminTenantSearch = String(query || '');
  loadSuperadminView();
}

function showTenantDetailTab(tab) {
  tenantDetailActiveTab = tab;
  const ids = {
    overview: ['tenantDetail-overview'],
    controls: ['tenantDetail-controls'],
    branding: ['tenantDetail-branding'],
    modules: ['tenantDetail-modules'],
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
    support_url: document.getElementById('tenantBrandSupportUrl')?.value || ''
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

async function loadAdminHelpView() {
  if (!isAdmin) return;
  const content = document.getElementById('adminHelpContent');
  if (!content) return;

  const cmdSection = (title, icon, commands) => {
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
      </div>`;
  };

  content.innerHTML = `
    <div style="margin-bottom:16px;padding:12px 14px;border:1px solid rgba(99,102,241,0.18);border-radius:10px;background:rgba(99,102,241,0.08);color:var(--text-secondary);font-size:0.88em;line-height:1.6;">
      Current command surface includes canonical grouped commands, legacy governance aliases (/propose, /support, /vote), and one deprecated OG alias (/og-config).
    </div>
    ${cmdSection('Verification', '🔐', [
      { name: '/verification status', desc: 'Check your wallet verification status and holdings', options: '—', example: '/verification status' },
      { name: '/verification wallets', desc: 'List all your linked wallets', options: '—', example: '/verification wallets' },
      { name: '/verification refresh', desc: 'Refresh your roles based on current holdings', options: '—', example: '/verification refresh' },
      { name: '/verification quick', desc: 'Quick micro-verification for instant role assignment', options: '—', example: '/verification quick' },
      { name: '/verification admin panel', desc: 'Post a verification panel to the channel', options: 'title, description, color (all optional)', example: '/verification admin panel title:"Verify Here"' },
      { name: '/verification admin export-user', desc: "Export a member's verification data", options: 'user (required)', example: '/verification admin export-user user:@member' },
      { name: '/verification admin remove-user', desc: 'Remove a member from the Family (irreversible)', options: 'user, confirm (required)', example: '/verification admin remove-user user:@member confirm:true' },
      { name: '/verification admin export-wallets', desc: 'Export all verified wallets as CSV', options: '—', example: '/verification admin export-wallets' },
      { name: '/verification admin role-config', desc: 'Configure role assignment rules (view/set trait/remove trait; tier roles are managed in the portal)', options: 'action (required), trait-type, trait-value, collection-id, role, description', example: '/verification admin role-config action:View' },
      { name: '/verification admin actions', desc: 'View all verification actions and role assignments', options: '—', example: '/verification admin actions' },
      { name: '/verification admin og-view', desc: 'View OG role configuration and eligible members', options: '—', example: '/verification admin og-view' },
      { name: '/verification admin og-enable', desc: 'Enable or disable the OG role system', options: 'enabled (required)', example: '/verification admin og-enable enabled:true' },
      { name: '/verification admin og-role', desc: 'Set the OG role to assign', options: 'role (required)', example: '/verification admin og-role role:@OG' },
      { name: '/verification admin og-limit', desc: 'Set number of OG slots (first X verified users)', options: 'count (required)', example: '/verification admin og-limit count:50' },
      { name: '/verification admin og-sync', desc: 'Sync OG role to eligible users', options: 'full (optional - also removes from ineligible)', example: '/verification admin og-sync full:true' },
      { name: '/verification admin activity-watch-add', desc: 'Add NFT collection to activity watchlist', options: 'collection (required)', example: '/verification admin activity-watch-add collection:abc123' },
      { name: '/verification admin activity-watch-remove', desc: 'Remove NFT collection from watchlist', options: 'collection (required)', example: '/verification admin activity-watch-remove collection:abc123' },
      { name: '/verification admin activity-watch-list', desc: 'List all watched NFT collections', options: '—', example: '/verification admin activity-watch-list' },
      { name: '/verification admin activity-feed', desc: 'Show recent NFT activity feed', options: 'limit (optional, 1-30)', example: '/verification admin activity-feed limit:10' },
      { name: '/verification admin activity-alerts', desc: 'Configure NFT activity auto-post alerts', options: 'enabled (required), channel, types, min_sol', example: '/verification admin activity-alerts enabled:true channel:#alerts' }
    ])}
    ${cmdSection('Governance', '🏛️', [
      { name: '/governance propose', desc: 'Create a new governance proposal', options: 'title, description (required), category (optional), cost (optional)', example: '/governance propose title:"Fund project" description:"Allocate 100 SOL" category:"Treasury Allocation"' },
      { name: '/governance support', desc: 'Support a draft proposal to promote it to voting', options: 'proposal_id (required)', example: '/governance support proposal_id:P-001' },
      { name: '/governance vote', desc: 'Cast your vote on an active proposal', options: 'proposal_id, choice (required: yes/no/abstain)', example: '/governance vote proposal_id:P-001 choice:yes' },
      { name: '/propose', desc: 'Standalone alias for /governance propose', options: 'title, description (required)', example: '/propose title:"Fund project" description:"Allocate 100 SOL"' },
      { name: '/support', desc: 'Standalone alias for /governance support', options: 'proposal_id (required)', example: '/support proposal_id:P-001' },
      { name: '/vote', desc: 'Standalone alias for /governance vote', options: 'proposal_id, choice (required: yes/no/abstain)', example: '/vote proposal_id:P-001 choice:yes' },
      { name: '/governance admin list', desc: 'View all proposals (any status)', options: 'status (optional: draft/voting/passed/failed)', example: '/governance admin list status:voting' },
      { name: '/governance admin cancel', desc: 'Cancel a proposal (emergency)', options: 'proposal_id, confirm (required)', example: '/governance admin cancel proposal_id:P-001 confirm:true' },
      { name: '/governance admin settings', desc: 'View or update governance settings', options: '—', example: '/governance admin settings' }
    ])}
    ${cmdSection('Battle', '⚔️', [
      { name: '/battle create', desc: 'Create a new battle lobby', options: 'max_players (optional), required_role_1-3, excluded_role_1-3 (optional)', example: '/battle create max_players:10' },
      { name: '/battle start', desc: 'Start the battle (creator only)', options: '—', example: '/battle start' },
      { name: '/battle cancel', desc: 'Cancel the battle lobby (creator only)', options: '—', example: '/battle cancel' },
      { name: '/battle stats', desc: 'View battle statistics', options: 'user (optional)', example: '/battle stats user:@member' },
      { name: '/battle admin list', desc: 'List all active battles', options: '—', example: '/battle admin list' },
      { name: '/battle admin force-end', desc: 'Force end a battle (emergency)', options: 'battle_id, confirm (required)', example: '/battle admin force-end battle_id:abc123 confirm:true' },
      { name: '/battle admin settings', desc: 'View current battle settings', options: '—', example: '/battle admin settings' }
    ])}
    ${cmdSection('Heist', '🎯', [
      { name: '/heist view', desc: 'View available heist missions', options: '—', example: '/heist view' },
      { name: '/heist signup', desc: 'Sign up for a heist mission', options: 'mission_id (required), role (required: driver/hacker/muscle/lookout)', example: '/heist signup mission_id:H-001 role:hacker' },
      { name: '/heist status', desc: 'View your current mission status', options: '—', example: '/heist status' },
      { name: '/heist admin create', desc: 'Create a new heist mission', options: 'title, description, slots (2-20), reward (required)', example: '/heist admin create title:"Bank Job" description:"Hit the vault" slots:4 reward:100' },
      { name: '/heist admin list', desc: 'List all missions (any status)', options: '—', example: '/heist admin list' },
      { name: '/heist admin cancel', desc: 'Cancel a heist mission', options: 'mission_id, confirm (required)', example: '/heist admin cancel mission_id:H-001 confirm:true' }
    ])}
    ${cmdSection('Treasury', '💰', [
      { name: '/treasury view', desc: 'View current treasury balances (public read-only)', options: '—', example: '/treasury view' },
      { name: '/treasury admin status', desc: 'View full treasury status (admin)', options: '—', example: '/treasury admin status' },
      { name: '/treasury admin refresh', desc: 'Manually refresh treasury balances', options: '—', example: '/treasury admin refresh' },
      { name: '/treasury admin enable', desc: 'Enable treasury monitoring', options: '—', example: '/treasury admin enable' },
      { name: '/treasury admin disable', desc: 'Disable treasury monitoring', options: '—', example: '/treasury admin disable' },
      { name: '/treasury admin set-wallet', desc: 'Set the treasury wallet address', options: 'address (required)', example: '/treasury admin set-wallet address:So1...' },
      { name: '/treasury admin set-interval', desc: 'Set refresh interval in hours', options: 'hours (required, 1-168)', example: '/treasury admin set-interval hours:6' },
      { name: '/treasury admin tx-history', desc: 'Show recent treasury transactions', options: 'limit (optional, 1-20)', example: '/treasury admin tx-history limit:10' },
      { name: '/treasury admin tx-alerts', desc: 'Configure automatic treasury transaction alerts', options: 'enabled (required), channel, incoming_only, min_sol', example: '/treasury admin tx-alerts enabled:true channel:#treasury' }
    ])}
    ${cmdSection('Config', '⚙️', [
      { name: '/config modules', desc: 'View all module toggle states', options: '—', example: '/config modules' },
      { name: '/config toggle', desc: 'Toggle a module on or off', options: 'module (required: verification/governance/treasury/battle/heist), enabled (required)', example: '/config toggle module:battle enabled:true' },
      { name: '/config status', desc: 'System status overview (uptime, memory, guilds)', options: '—', example: '/config status' }
    ])}
    ${cmdSection('Deprecated', '⚠️', [
      { name: '/og-config', desc: 'Deprecated legacy OG command; use /verification admin og-* instead', options: 'view/enable/role/limit/sync', example: '/og-config view' }
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
            <button onclick="adminProposalAction('${p.proposal_id}', 'approve')" style="padding:6px 14px; background:#10b981; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">Approve</button>
            <button onclick="adminProposalHold('${p.proposal_id}')" style="padding:6px 14px; background:#f59e0b; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">Hold</button>
          </div>`;
        } else if (status === 'on_hold') {
          actions = `<div style="display:flex; gap:8px; margin-top:8px;">
            <button onclick="adminProposalAction('${p.proposal_id}', 'approve')" style="padding:6px 14px; background:#10b981; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">Approve</button>
            ${p.on_hold_reason ? `<span style="color:var(--text-secondary); font-size:0.85em; align-self:center;">Reason: ${escapeHtml(p.on_hold_reason)}</span>` : ''}
          </div>`;
        } else if (status === 'supporting') {
          actions = `<div style="display:flex; gap:8px; margin-top:8px;">
            <button onclick="adminProposalAction('${p.proposal_id}', 'promote')" style="padding:6px 14px; background:#6366f1; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">Promote to Voting</button>
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
              <button onclick="adminProposalAction('${p.proposal_id}', 'conclude')" style="padding:6px 14px; background:#ef4444; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">Conclude</button>
              <button onclick="adminProposalAction('${p.proposal_id}', 'pause')" style="padding:6px 14px; background:#f59e0b; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:0.85em;">${p.paused ? 'Unpause' : 'Pause'}</button>
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
    if (minEl) minEl.value = s.battleRoundPauseMinSec ?? 5;
    if (maxEl) maxEl.value = s.battleRoundPauseMaxSec ?? 10;
    if (eliteEl) eliteEl.value = s.battleElitePrepSec ?? 12;

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
  if (isNaN(minVal) || isNaN(maxVal) || isNaN(eliteVal)) return showError('Please enter valid numbers for all timing fields.');
  if (minVal > maxVal) return showError('Minimum pause cannot be greater than maximum pause.');
  const eraVal = document.getElementById('battleDefaultEraSelect')?.value || 'mafia';
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...buildTenantRequestHeaders() },
      body: JSON.stringify({ battleRoundPauseMinSec: minVal, battleRoundPauseMaxSec: maxVal, battleElitePrepSec: eliteVal, battleDefaultEra: eraVal })
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
    const settingsRes = await fetch('/api/admin/settings', { credentials: 'include' });
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
      { id: 'moduleBattleEnabled',       label: 'Battle',          icon: '⚔️',  moduleKey: 'battle'        },
      { id: 'moduleGovernanceEnabled',   label: 'Governance',      icon: '🗳️',  moduleKey: 'governance'    },
      { id: 'moduleVerificationEnabled', label: 'Verification',    icon: '✅',  moduleKey: 'verification'  },
      { id: 'moduleMissionsEnabled',     label: 'Heist',           icon: '🎯',  moduleKey: 'heist'         },
      { id: 'moduleTreasuryEnabled',     label: 'Wallet Tracker',  icon: '💰',  moduleKey: 'treasury'      },
      { id: 'moduleNftTrackerEnabled',   label: 'NFT Tracker',     icon: '📡',  moduleKey: 'nfttracker'    },
      { id: 'moduleRoleClaimEnabled',    label: 'Self-Serve Roles',icon: '🎖️',  moduleKey: 'selfserveroles'},
      { id: 'moduleTicketingEnabled',    label: 'Ticketing',       icon: '🎫',  moduleKey: 'ticketing'     },
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
    content.innerHTML = `<div class="error-state"><div class="error-message">${escapeHtml(e.message)}</div></div>`;
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
    'moduleBattleEnabled', 'moduleGovernanceEnabled', 'moduleVerificationEnabled',
    'moduleMissionsEnabled', 'moduleTreasuryEnabled', 'moduleNftTrackerEnabled',
    'moduleRoleClaimEnabled', 'moduleTicketingEnabled',
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
      fetch('/api/public/treasury').catch(() => null),
      fetch('/api/public/leaderboard').catch(() => null),
      fetch('/api/public/stats').catch(() => null)
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
    const leaders = (leaderboardData?.leaderboard || leaderboardData?.entries || leaderboardData || []).slice(0, 5);
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
let discordRolesCache = null;

async function fetchDiscordRoles() {
  if (discordRolesCache) return discordRolesCache;
  try {
    const res = await fetch('/api/admin/discord/roles', { credentials: 'include' });
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

  content.innerHTML = '<p style="color:var(--text-secondary);font-size:0.9em;">Loading tracked collections...</p>';

  // Fetch channels for dropdown
  let channelsList = [];
  try {
    const chRes = await fetch('/api/admin/discord/channels', { credentials: 'include' });
    const chData = await chRes.json();
    channelsList = chData.channels || [];
  } catch (e) { console.error('[NFT Tracker] Channels fetch error:', e); }

  const populateNftChannelDropdown = (selectEl) => {
    if (!selectEl) return;
    if (channelsList.length > 0) {
      const grouped = {};
      channelsList.forEach(ch => {
        const parent = ch.parentName || 'Other';
        if (!grouped[parent]) grouped[parent] = [];
        grouped[parent].push(ch);
      });
      selectEl.innerHTML = '<option value="">-- Select channel --</option>';
      Object.keys(grouped).sort().forEach(parent => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = parent;
        grouped[parent].forEach(ch => {
          const opt = document.createElement('option');
          opt.value = ch.id;
          opt.textContent = '# ' + ch.name;
          optgroup.appendChild(opt);
        });
        selectEl.appendChild(optgroup);
      });
    } else {
      selectEl.innerHTML = '<option value="">-- No channels available --</option>';
    }
  };

  const editNftCollection = (btn) => {
    const id = btn.dataset.id;
    const nameVal = escapeHtml(btn.dataset.name || '');
    const meVal = escapeHtml(btn.dataset.me || '');
    // Remove any existing edit modal
    const old = document.getElementById('nftEditModal');
    if (old) old.remove();

    const modalFieldInput = 'width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;';
    const modalLabel = 'display:block;font-weight:600;font-size:0.85em;color:#c9d6ff;margin-bottom:6px;';
    const overlay = document.createElement('div');
    overlay.id = 'nftEditModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML = `
      <div style="background:var(--card-bg, #1e293b);border:1px solid rgba(99,102,241,0.3);border-radius:12px;padding:24px;width:480px;max-width:95vw;max-height:90vh;overflow-y:auto;">
        <h3 style="margin:0 0 16px;color:var(--text-primary, #e0e7ff);">✏️ Edit Collection</h3>
        <div style="margin-bottom:12px;">
          <label style="${modalLabel}">Collection Name</label>
          <input type="text" id="nftEditName" value="${nameVal}" style="${modalFieldInput}">
        </div>
        <div style="margin-bottom:12px;">
          <label style="${modalLabel}">Alert Channel</label>
          <select id="nftEditChannel" style="${modalFieldInput}"><option value="">-- Select channel --</option></select>
        </div>
        <div style="margin-bottom:12px;">
          <label style="${modalLabel}">Magic Eden Symbol <small style="color:#94a3b8;">(slug for listing alerts)</small></label>
          <input type="text" id="nftEditMeSymbol" value="${meVal}" style="${modalFieldInput}">
        </div>
        <div style="margin-bottom:16px;">
          <label style="${modalLabel}">Track Events</label>
          <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:4px;">
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="nftEditMint" ${btn.dataset.mint === '1' ? 'checked' : ''}> 🪙 Mint</label>
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="nftEditSale" ${btn.dataset.sale === '1' ? 'checked' : ''}> 💰 Sale</label>
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="nftEditList" ${btn.dataset.list === '1' ? 'checked' : ''}> 📋 List</label>
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="nftEditDelist" ${btn.dataset.delist === '1' ? 'checked' : ''}> ❌ Delist</label>
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="nftEditTransfer" ${btn.dataset.transfer === '1' ? 'checked' : ''}> 🔄 Transfer</label>
          </div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;">
          <button id="nftEditSaveBtn" style="padding:8px 18px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:0.85em;font-weight:600;cursor:pointer;">Save</button>
          <button id="nftEditCancelBtn" style="padding:8px 18px;background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,0.12);border-radius:8px;font-size:0.85em;cursor:pointer;">Cancel</button>
          <span id="nftEditFeedback" style="font-size:0.85em;font-weight:600;"></span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Populate channel dropdown and select current
    populateNftChannelDropdown(document.getElementById('nftEditChannel'));
    const editChSel = document.getElementById('nftEditChannel');
    if (editChSel) editChSel.value = btn.dataset.channel;

    // Close on overlay click
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById('nftEditCancelBtn').addEventListener('click', () => overlay.remove());

    document.getElementById('nftEditSaveBtn').addEventListener('click', async () => {
      const saveBtn = document.getElementById('nftEditSaveBtn');
      const feedback = document.getElementById('nftEditFeedback');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const payload = {
          collectionName: document.getElementById('nftEditName').value.trim(),
          channelId: document.getElementById('nftEditChannel').value,
          meSymbol: document.getElementById('nftEditMeSymbol').value.trim(),
          trackMint: !!document.getElementById('nftEditMint').checked,
          trackSale: !!document.getElementById('nftEditSale').checked,
          trackList: !!document.getElementById('nftEditList').checked,
          trackDelist: !!document.getElementById('nftEditDelist').checked,
          trackTransfer: !!document.getElementById('nftEditTransfer').checked,
        };
        const res = await fetch('/api/admin/nft-tracker/collections/' + id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok && data.success) {
          overlay.remove();
          renderNftCollectionsTable();
        } else {
          if (feedback) { feedback.style.color = '#fca5a5'; feedback.textContent = data.message || 'Failed to save'; }
        }
      } catch (err) {
        console.error('[NFT Tracker] Edit save error:', err);
        if (feedback) { feedback.style.color = '#fca5a5'; feedback.textContent = 'Network error'; }
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });
  };

  const renderNftCollectionsTable = async () => {
    const wrap = document.getElementById('nftCollectionsTableWrap');
    if (!wrap) return;
    try {
      const res = await fetch('/api/admin/nft-tracker/collections', { credentials: 'include' });
      const data = await res.json();
      const collections = data.collections || [];
      if (!collections.length) {
        wrap.innerHTML = '<p style="color:var(--text-secondary);font-size:0.9em;margin:0;">No tracked collections yet. Add one below.</p>';
        return;
      }
      const channelName = (id) => { const ch = channelsList.find(c => c.id === id); return ch ? '#' + ch.name : id; };
      const truncAddr = (a) => a && a.length > 12 ? a.slice(0, 6) + '...' + a.slice(-4) : a;
      const eventIcons = (c) => {
        let s = '';
        if (c.track_mint) s += '🪙 ';
        if (c.track_sale) s += '💰 ';
        if (c.track_list) s += '📋 ';
        if (c.track_delist) s += '❌ ';
        if (c.track_transfer) s += '🔄 ';
        return s.trim() || '—';
      };
      const rows = collections.map(c => `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
          <td style="padding:8px 10px;font-size:0.85em;color:var(--text-primary);">${escapeHtml(c.collection_name)}</td>
          <td style="padding:8px 10px;font-size:0.85em;color:var(--text-secondary);font-family:monospace;" title="${escapeHtml(c.collection_address)}">${truncAddr(c.collection_address)}</td>
          <td style="padding:8px 10px;font-size:0.85em;color:var(--text-secondary);">${escapeHtml(channelName(c.channel_id))}</td>
          <td style="padding:8px 10px;font-size:0.85em;">${eventIcons(c)}</td>
          <td style="padding:8px 10px;font-size:0.85em;color:${c.enabled ? '#86efac' : '#fca5a5'};">${c.enabled ? 'Yes' : 'No'}</td>
          <td style="padding:8px 10px;display:flex;gap:6px;">
            <button class="nft-edit-btn" data-id="${c.id}" data-name="${escapeHtml(c.collection_name)}" data-channel="${c.channel_id}" data-me="${escapeHtml(c.me_symbol || '')}" data-mint="${c.track_mint}" data-sale="${c.track_sale}" data-list="${c.track_list}" data-delist="${c.track_delist}" data-transfer="${c.track_transfer}" style="font-size:0.8em;padding:4px 10px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;">✏️ Edit</button>
            <button class="btn-danger nft-remove-btn" data-id="${c.id}" style="font-size:0.8em;padding:4px 10px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;">Remove</button>
          </td>
        </tr>
      `).join('');
      wrap.innerHTML = `
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="border-bottom:2px solid rgba(255,255,255,0.1);">
              <th style="text-align:left;padding:8px 10px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">Name</th>
              <th style="text-align:left;padding:8px 10px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">Address</th>
              <th style="text-align:left;padding:8px 10px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">Channel</th>
              <th style="text-align:left;padding:8px 10px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">Events</th>
              <th style="text-align:left;padding:8px 10px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">Enabled</th>
              <th style="padding:8px 10px;"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
      wrap.querySelectorAll('.nft-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this tracked collection?')) return;
          btn.disabled = true;
          btn.textContent = '...';
          try {
            await fetch('/api/admin/nft-tracker/collections/' + btn.dataset.id, { method: 'DELETE', credentials: 'include' });
          } catch (e) { console.error('[NFT Tracker] Remove error:', e); }
          renderNftCollectionsTable();
        });
      });
      wrap.querySelectorAll('.nft-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => editNftCollection(btn));
      });
    } catch (e) {
      wrap.innerHTML = '<p style="color:#fca5a5;font-size:0.9em;">Failed to load tracked collections.</p>';
      console.error('[NFT Tracker] Table render error:', e);
    }
  };

  const cardStyle = 'background:var(--card-bg);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:var(--space-5);margin-bottom:var(--space-4);';
  const gridRow = 'display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);';
  const fieldLabel = 'display:block;font-weight:600;font-size:0.85em;color:#c9d6ff;margin-bottom:6px;';
  const fieldInput = 'width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;';
  const selectStyle = fieldInput;

  content.innerHTML = `
    <div style="${cardStyle}">
      <div id="nftCollectionsTableWrap" style="overflow-x:auto;"></div>
      <div style="margin-top:var(--space-4);padding-top:var(--space-4);border-top:1px solid rgba(255,255,255,0.08);">
        <h4 style="color:var(--text-primary);font-size:0.95em;margin:0 0 var(--space-3) 0;">➕ Add Collection</h4>
        <div style="${gridRow}">
          <div>
            <label style="${fieldLabel}">Collection Name</label>
            <input type="text" id="nftAddName" placeholder="e.g. My NFT Collection" style="${fieldInput}" required>
          </div>
          <div>
            <label style="${fieldLabel}">Collection Address</label>
            <input type="text" id="nftAddAddress" placeholder="Solana collection address" style="${fieldInput}" required>
          </div>
          <div>
            <label style="${fieldLabel}">Magic Eden Symbol <small style="color:#94a3b8;">(e.g. vault_runners — needed for listing alerts)</small></label>
            <input type="text" id="nftAddMeSymbol" placeholder="vault_runners" style="${fieldInput}">
          </div>
        </div>
        <div style="${gridRow}margin-top:var(--space-3);">
          <div>
            <label style="${fieldLabel}">Alert Channel</label>
            <select id="nftAddChannel" style="${selectStyle}"><option value="">-- Select channel --</option></select>
          </div>
        </div>
        <div style="margin-top:var(--space-3);">
          <label style="${fieldLabel}">Track Events</label>
          <div style="display:flex;flex-wrap:wrap;gap:var(--space-3);margin-top:var(--space-2);">
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;font-weight:600;cursor:pointer;">
              <input type="checkbox" id="nftAddMint" checked> 🪙 Mint
            </label>
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;font-weight:600;cursor:pointer;">
              <input type="checkbox" id="nftAddSale" checked> 💰 Sale
            </label>
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;font-weight:600;cursor:pointer;">
              <input type="checkbox" id="nftAddList" checked> 📋 List
            </label>
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;font-weight:600;cursor:pointer;">
              <input type="checkbox" id="nftAddDelist" checked> ❌ Delist
            </label>
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;font-weight:600;cursor:pointer;">
              <input type="checkbox" id="nftAddTransfer"> 🔄 Transfer
            </label>
          </div>
        </div>
        <div style="margin-top:var(--space-4);display:flex;align-items:center;gap:var(--space-3);">
          <button class="btn-primary" id="nftAddCollectionBtn" style="font-size:0.85em;padding:8px 16px;">Add Collection</button>
          <span id="nftTrackerFeedback" style="font-size:0.85em;font-weight:600;"></span>
        </div>
      </div>
    </div>
  `;

  populateNftChannelDropdown(document.getElementById('nftAddChannel'));
  await renderNftCollectionsTable();

  const addBtn = document.getElementById('nftAddCollectionBtn');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const feedback = document.getElementById('nftTrackerFeedback');
      const name = document.getElementById('nftAddName')?.value?.trim();
      const address = document.getElementById('nftAddAddress')?.value?.trim();
      const channelId = document.getElementById('nftAddChannel')?.value;
      if (!name || !address || !channelId) {
        if (feedback) { feedback.style.color = '#fca5a5'; feedback.textContent = 'Name, address, and channel are required'; setTimeout(() => { feedback.textContent = ''; }, 5000); }
        return;
      }
      addBtn.disabled = true;
      addBtn.textContent = 'Adding...';
      try {
        const payload = {
          collectionName: name,
          collectionAddress: address,
          channelId,
          trackMint: !!document.getElementById('nftAddMint')?.checked,
          trackSale: !!document.getElementById('nftAddSale')?.checked,
          trackList: !!document.getElementById('nftAddList')?.checked,
          trackDelist: !!document.getElementById('nftAddDelist')?.checked,
          trackTransfer: !!document.getElementById('nftAddTransfer')?.checked,
          meSymbol: document.getElementById('nftAddMeSymbol')?.value?.trim() || ''
        };
        const res = await fetch('/api/admin/nft-tracker/collections', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok && data.success) {
          if (feedback) { feedback.style.color = '#86efac'; feedback.textContent = '✓ Collection added!'; setTimeout(() => { feedback.textContent = ''; }, 5000); }
          document.getElementById('nftAddName').value = '';
          document.getElementById('nftAddAddress').value = '';
          if (document.getElementById('nftAddMeSymbol')) document.getElementById('nftAddMeSymbol').value = '';
          renderNftCollectionsTable();
        } else {
          if (feedback) { feedback.style.color = '#fca5a5'; feedback.textContent = data.message || 'Failed to add collection'; setTimeout(() => { feedback.textContent = ''; }, 8000); }
        }
      } catch (err) {
        console.error('[NFT Tracker] Add error:', err);
        if (feedback) { feedback.style.color = '#fca5a5'; feedback.textContent = 'Network error'; setTimeout(() => { feedback.textContent = ''; }, 8000); }
      } finally {
        addBtn.disabled = false;
        addBtn.textContent = 'Add Collection';
      }
    });
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
      headers: { 'Content-Type': 'application/json' },
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
    const settingsRes = await fetch('/api/admin/settings', { credentials: 'include' });
    const settingsJson = await settingsRes.json();
    const vs = settingsJson.success ? settingsJson.settings : {};

    container.innerHTML = `
      <div style="${cardStyle}">
        <h3 style="${cardHeader}">✅ Verification Settings</h3>
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
            <label style="${fieldLabel}">OG Role Limit</label>
            <p style="color:var(--text-secondary);font-size:0.8em;margin:0 0 8px 0;">First N verifiers get OG role</p>
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
          <button class="btn-secondary" id="verOgSyncBtn" onclick="runOgSync()" style="font-size:0.85em;padding:8px 16px;">✨ Run OG Sync</button>
          <button class="btn-primary" onclick="saveVerificationSettings()" style="font-size:0.85em;padding:8px 16px;">💾 Save Verification Settings</button>
        </div>
      </div>
    `;

    // Populate role selects
    populateRoleSelect('ver_baseVerifiedRoleId', vs.baseVerifiedRoleId || '').then(() => {
      const sel = document.getElementById('ver_baseVerifiedRoleId');
      if (sel && sel.options.length > 0) sel.options[0].textContent = '-- None (disabled) --';
    });
    populateRoleSelect('ver_ogRoleId', vs.ogRoleId || '').then(() => {
      const sel = document.getElementById('ver_ogRoleId');
      if (sel && sel.options.length > 0) sel.options[0].textContent = '-- None --';
    });
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
      headers: { 'Content-Type': 'application/json' },
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

async function runOgSync(fullSync = false) {
  const btn = document.getElementById('verOgSyncBtn');
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }
    const res = await fetch('/api/admin/og-role/sync', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
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
    if (btn) { btn.disabled = false; btn.textContent = '✨ Run OG Sync'; }
  }
}

// ==================== TREASURY MODULE SETTINGS ====================

async function loadTreasuryModuleSettings() {
  const pane = document.getElementById('settingsTab-treasury');
  if (!pane) return;

  const cardStyle = 'background:rgba(14,23,44,0.5);border:1px solid rgba(99,102,241,0.22);border-radius:10px;padding:var(--space-5);margin-bottom:var(--space-5);';
  const cardHeader = 'color:#c9d6ff;font-size:var(--font-lg);font-weight:700;margin:0 0 var(--space-4) 0;padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);';
  const gridRow = 'display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);';
  const fieldLabel = 'display:block;color:#c9d6ff;font-size:0.9em;font-weight:600;margin-bottom:6px;';
  const fieldInput = 'width:100%;padding:10px 12px;border:1px solid rgba(99,102,241,0.22);border-radius:8px;background:rgba(30,41,59,0.8);color:#e0e7ff;font-size:0.9em;';
  const selectStyle = 'width:100%;padding:10px 12px;border:1px solid rgba(99,102,241,0.22);border-radius:8px;background:rgba(30,41,59,0.8);color:#e0e7ff;font-size:0.9em;';

  pane.innerHTML = `<div style="${cardStyle}"><div style="text-align:center;padding:var(--space-5);color:var(--text-secondary);"><div class="spinner"></div><p>Loading treasury settings...</p></div></div>`;

  try {
    const [settingsRes, treasuryRes] = await Promise.all([
      fetch('/api/admin/settings', { credentials: 'include' }),
      fetch('/api/admin/treasury', { credentials: 'include' })
    ]);
    const settingsJson = await settingsRes.json();
    const ts = settingsJson.success ? settingsJson.settings : {};
    const treasuryData = treasuryRes.ok ? await treasuryRes.json() : {};
    const tc = treasuryData.config || treasuryData;

    pane.innerHTML = `
      <div style="${cardStyle}">
        <h3 style="${cardHeader}">💰 Wallet Tracker Settings</h3>
        <div style="${gridRow}">
          <div>
            <label style="${fieldLabel}">Solana Wallet Address</label>
            <input type="text" id="trs_walletAddress" placeholder="Solana wallet address to monitor" value="${escapeHtml(tc.solanaWallet || ts.treasuryWalletAddress || '')}" style="${fieldInput}">
          </div>
          <div>
            <label style="${fieldLabel}">Balance Refresh Interval (hours)</label>
            <input type="number" id="trs_refreshInterval" min="1" max="168" value="${tc.refreshHours ?? 6}" style="${fieldInput}">
          </div>
        </div>
        <div style="${gridRow}margin-top:var(--space-3);">
          <div>
            <label style="${fieldLabel}">Treasury Watch Channel</label>
            <select id="trs_watchChannelId" style="${selectStyle}"><option value="">Loading channels...</option></select>
            <div style="color:var(--text-secondary);font-size:0.78em;margin-top:4px;">Post a live treasury panel embed to this channel.</div>
          </div>
          <div>
            <label style="${fieldLabel}">TX Alert Channel</label>
            <select id="trs_txAlertChannelId" style="${selectStyle}"><option value="">Loading channels...</option></select>
          </div>
        </div>
        <div style="${gridRow}margin-top:var(--space-3);">
          <div>
            <label style="${fieldLabel}">TX Alert Min SOL</label>
            <input type="number" id="trs_txAlertMinSol" min="0" step="0.1" value="${tc.txAlertMinSol ?? 0}" style="${fieldInput}">
          </div>
          <div style="display:flex;flex-direction:column;gap:var(--space-3);justify-content:center;">
            <label style="display:flex;align-items:center;gap:8px;color:#c9d6ff;font-size:0.9em;font-weight:600;cursor:pointer;">
              <input type="checkbox" id="trs_txAlertEnabled"${tc.txAlertsEnabled ? ' checked' : ''}> TX Alerts Enabled
            </label>
            <label style="display:flex;align-items:center;gap:8px;color:#c9d6ff;font-size:0.9em;font-weight:600;cursor:pointer;">
              <input type="checkbox" id="trs_txAlertIncomingOnly"${tc.txAlertIncomingOnly ? ' checked' : ''}> Incoming Only
            </label>
          </div>
        </div>
        <div style="display:flex;gap:var(--space-3);justify-content:flex-end;padding-top:var(--space-4);border-top:1px solid rgba(99,102,241,0.15);margin-top:var(--space-4);">
          <button class="btn-primary" onclick="saveTreasuryModuleSettings()" style="font-size:0.85em;padding:8px 16px;">💾 Save Wallet Tracker Settings</button>
        </div>
      </div>
      <!-- Wallet list injected below -->
      <div id="trs_walletListCard" style="${cardStyle}margin-top:0;"></div>
    `;

    // Populate channel selects
    try {
      const chRes = await fetch('/api/admin/discord/channels', { credentials: 'include' });
      if (chRes.ok) {
        const chJson = await chRes.json();
        const channels = chJson.success ? (chJson.channels || []) : [];
        populateChannelSelects(
          ['trs_watchChannelId', 'trs_txAlertChannelId'],
          channels,
          { watchChannelId: tc.watchChannelId || '', txAlertChannelId: tc.txAlertChannelId || '' },
          ['watchChannelId', 'txAlertChannelId']
        );
      }
    } catch (e) { console.error('[Treasury] Channel load error:', e); }

    // Load multi-wallet list
    loadTreasuryWalletList();
  } catch (e) {
    console.error('[Treasury] Settings load error:', e);
    pane.innerHTML = '<p style="color:#fca5a5;font-size:0.85em;padding:var(--space-4);">Failed to load treasury settings.</p>';
  }
}

async function loadTreasuryWalletList() {
  const card = document.getElementById('trs_walletListCard');
  if (!card) return;
  const fieldInput = 'width:100%;padding:10px 12px;border:1px solid rgba(99,102,241,0.22);border-radius:8px;background:rgba(30,41,59,0.8);color:#e0e7ff;font-size:0.9em;';
  const cardHeader = 'color:#c9d6ff;font-size:var(--font-lg);font-weight:700;margin:0 0 var(--space-4) 0;padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);';
  try {
    const res = await fetch('/api/admin/treasury/wallets', { credentials: 'include' });
    const data = await res.json();
    const wallets = data.wallets || [];

    const truncAddr = (a) => a && a.length > 12 ? a.slice(0, 6) + '...' + a.slice(-4) : (a || '—');
    const tableRows = wallets.length ? wallets.map(w => `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
        <td style="padding:8px 10px;font-size:0.85em;color:var(--text-primary);">${escapeHtml(w.label || 'Wallet')}</td>
        <td style="padding:8px 10px;font-size:0.85em;color:var(--text-secondary);font-family:monospace;" title="${escapeHtml(w.address)}">${truncAddr(w.address)}</td>
        <td style="padding:8px 10px;font-size:0.85em;color:${w.enabled !== 0 ? '#86efac' : '#fca5a5'};">${w.enabled !== 0 ? 'Yes' : 'No'}</td>
        <td style="padding:8px 10px;">
          <button class="trs-edit-wallet-btn" data-id="${w.id}" data-address="${escapeHtml(w.address)}" data-label="${escapeHtml(w.label || '')}" data-enabled="${w.enabled !== 0 ? 1 : 0}" style="font-size:0.8em;padding:4px 10px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;margin-right:4px;">✏️ Edit</button>
          <button class="trs-remove-wallet-btn" data-id="${w.id}" style="font-size:0.8em;padding:4px 10px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
        </td>
      </tr>
    `).join('') : `<tr><td colspan="4" style="padding:12px;color:var(--text-secondary);font-size:0.85em;text-align:center;">No tracked wallets yet. Add one below.</td></tr>`;

    card.innerHTML = `
      <h3 style="${cardHeader}">📡 Tracked Wallets</h3>
      <p style="color:var(--text-secondary);font-size:0.85em;margin-bottom:12px;">Manage all tracked wallets with custom labels. This mirrors the NFT Tracker settings layout.</p>
      <div style="overflow-x:auto;margin-bottom:14px;">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="border-bottom:2px solid rgba(255,255,255,0.1);">
            <th style="text-align:left;padding:8px 10px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Label</th>
            <th style="text-align:left;padding:8px 10px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Address</th>
            <th style="text-align:left;padding:8px 10px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">On</th>
            <th style="padding:8px 10px;"></th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div style="padding-top:var(--space-4);border-top:1px solid rgba(99,102,241,0.15);">
        <h4 style="color:#c9d6ff;font-size:0.9em;font-weight:600;margin:0 0 10px;">➕ Add Wallet</h4>
        <div style="display:flex;gap:8px;align-items:flex-end;">
          <div style="flex:1;"><input type="text" id="trs_newWalletAddr" placeholder="Solana wallet address" style="${fieldInput}"></div>
          <div style="width:180px;"><input type="text" id="trs_newWalletLabel" placeholder="Label (optional)" style="${fieldInput}"></div>
          <button class="btn-primary" onclick="addTreasuryWallet()" style="font-size:0.85em;padding:10px 16px;white-space:nowrap;">Add Wallet</button>
        </div>
      </div>
    `;

    card.querySelectorAll('.trs-remove-wallet-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this wallet?')) return;
        btn.disabled = true;
        try {
          const r = await fetch('/api/admin/treasury/wallets/' + btn.dataset.id, { method: 'DELETE', credentials: 'include' });
          const d = await r.json();
          if (d.success) { showSuccess('Wallet removed'); loadTreasuryWalletList(); }
          else showError(d.message || 'Failed to remove wallet');
        } catch { showError('Error removing wallet'); btn.disabled = false; }
      });
    });

    card.querySelectorAll('.trs-edit-wallet-btn').forEach(btn => {
      btn.addEventListener('click', () => openEditTreasuryWalletModal(btn.dataset.id, btn.dataset.address, btn.dataset.label, btn.dataset.enabled === '1'));
    });
  } catch (e) {
    console.error('[Treasury] Wallet list error:', e);
    card.innerHTML = '<p style="color:#fca5a5;font-size:0.85em;">Failed to load wallets.</p>';
  }
}

async function addTreasuryWallet() {
  const addr = (document.getElementById('trs_newWalletAddr')?.value || '').trim();
  const label = (document.getElementById('trs_newWalletLabel')?.value || '').trim();
  if (!addr) return showError('Wallet address is required');
  try {
    const res = await fetch('/api/admin/treasury/wallets', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addr, label })
    });
    const data = await res.json();
    if (data.success) {
      showSuccess('Wallet added');
      document.getElementById('trs_newWalletAddr').value = '';
      document.getElementById('trs_newWalletLabel').value = '';
      loadTreasuryWalletList();
    } else showError(data.message || 'Failed to add wallet');
  } catch { showError('Error adding wallet'); }
}

async function openEditTreasuryWalletModal(id, address, label, enabled) {
  const old = document.getElementById('trsEditWalletModal');
  if (old) old.remove();
  const fi = 'width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;';
  const lb = 'display:block;color:#c9d6ff;font-size:0.9em;font-weight:600;margin-bottom:6px;';
  const overlay = document.createElement('div');
  overlay.id = 'trsEditWalletModal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:var(--card-bg,#1e293b);border:1px solid rgba(99,102,241,0.3);border-radius:12px;padding:24px;width:480px;max-width:95vw;">
      <h3 style="margin:0 0 16px;color:var(--text-primary,#e0e7ff);">✏️ Edit Wallet</h3>
      <div style="display:grid;gap:14px;">
        <div><label style="${lb}">Wallet Label</label><input id="trsEditLabel" type="text" value="${escapeHtml(label || '')}" style="${fi}"></div>
        <div><label style="${lb}">Wallet Address</label><input id="trsEditAddr" type="text" value="${escapeHtml(address || '')}" style="${fi};font-family:monospace;"></div>
        <label style="display:flex;align-items:center;gap:8px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input id="trsEditEnabled" type="checkbox" ${enabled ? 'checked' : ''}> Enabled</label>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:18px;">
        <button id="trsEditSaveBtn" class="btn-primary" style="font-size:0.85em;padding:8px 16px;">Save</button>
        <button id="trsEditCancelBtn" class="btn-secondary" style="font-size:0.85em;padding:8px 16px;">Cancel</button>
        <span id="trsEditFeedback" style="font-size:0.82em;"></span>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('trsEditCancelBtn').addEventListener('click', () => overlay.remove());
  document.getElementById('trsEditSaveBtn').addEventListener('click', async () => {
    const saveBtn = document.getElementById('trsEditSaveBtn');
    const feedback = document.getElementById('trsEditFeedback');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
      const res = await fetch('/api/admin/treasury/wallets/' + id, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: (document.getElementById('trsEditAddr')?.value || '').trim(),
          label: (document.getElementById('trsEditLabel')?.value || '').trim(),
          enabled: !!document.getElementById('trsEditEnabled')?.checked,
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        overlay.remove();
        showSuccess('Wallet updated');
        loadTreasuryWalletList();
      } else {
        feedback.style.color = '#fca5a5';
        feedback.textContent = data.message || 'Failed to save';
      }
    } catch {
      feedback.style.color = '#fca5a5';
      feedback.textContent = 'Network error';
    }
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
  });
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

async function loadNftTrackerSettingsView() {
  if (!isAdmin) return;
  const pane = document.getElementById('settingsTab-nfttracker');
  if (!pane) return;

  const cardStyle = 'background:rgba(14,23,44,0.5);border:1px solid rgba(99,102,241,0.22);border-radius:10px;padding:var(--space-5);margin-bottom:var(--space-5);';
  const cardHeader = 'color:#c9d6ff;font-size:var(--font-lg);font-weight:700;margin:0 0 var(--space-4) 0;padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);';
  const fieldInput = 'width:100%;padding:10px 12px;border:1px solid rgba(99,102,241,0.22);border-radius:8px;background:rgba(30,41,59,0.8);color:#e0e7ff;font-size:0.9em;';

  pane.innerHTML = `<div style="${cardStyle}"><div style="text-align:center;padding:var(--space-5);color:var(--text-secondary);"><div class="spinner"></div><p>Loading NFT tracker settings...</p></div></div>`;

  try {
    // Fetch channels + collections in parallel
    const [chRes, colRes] = await Promise.all([
      fetch('/api/admin/discord/channels', { credentials: 'include' }),
      fetch('/api/admin/nft-tracker/collections', { credentials: 'include' }),
    ]);
    const channels = chRes.ok ? ((await chRes.json()).channels || []) : [];
    const colData = colRes.ok ? await colRes.json() : {};
    const collections = colData.collections || [];

    // Build channel options
    const grouped = {};
    channels.forEach(ch => {
      const parent = ch.parentName || 'Other';
      if (!grouped[parent]) grouped[parent] = [];
      grouped[parent].push(ch);
    });
    const chOptions = (sel) => {
      let html = `<option value="">-- Select channel --</option>`;
      Object.keys(grouped).sort().forEach(parent => {
        html += `<optgroup label="${escapeHtml(parent)}">`;
        grouped[parent].forEach(ch => {
          html += `<option value="${ch.id}"${ch.id === sel ? ' selected' : ''}># ${escapeHtml(ch.name)}</option>`;
        });
        html += `</optgroup>`;
      });
      return html;
    };

    const truncAddr = (a) => a && a.length > 12 ? a.slice(0, 6) + '...' + a.slice(-4) : (a || '—');
    const eventIcons = (c) => [c.track_mint && '🪙', c.track_sale && '💰', c.track_list && '📋', c.track_delist && '❌', c.track_transfer && '🔄'].filter(Boolean).join(' ') || '—';

    const collectionRows = collections.length ? collections.map(c => `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
        <td style="padding:8px 10px;font-size:0.85em;color:var(--text-primary);">${escapeHtml(c.collection_name)}</td>
        <td style="padding:8px 10px;font-size:0.85em;color:var(--text-secondary);font-family:monospace;" title="${escapeHtml(c.collection_address)}">${truncAddr(c.collection_address)}</td>
        <td style="padding:8px 10px;font-size:0.85em;">${eventIcons(c)}</td>
        <td style="padding:8px 10px;font-size:0.85em;color:${c.enabled ? '#86efac' : '#fca5a5'};">${c.enabled ? 'Yes' : 'No'}</td>
        <td style="padding:8px 10px;">
          <button class="nft-settings-edit-btn" data-id="${c.id}" data-name="${escapeHtml(c.collection_name)}" data-channel="${escapeHtml(c.channel_id||'')}" data-me="${escapeHtml(c.me_symbol||'')}" data-mint="${c.track_mint?1:0}" data-sale="${c.track_sale?1:0}" data-list="${c.track_list?1:0}" data-delist="${c.track_delist?1:0}" data-transfer="${c.track_transfer?1:0}" style="font-size:0.8em;padding:4px 10px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;margin-right:4px;">✏️ Edit</button>
          <button class="nft-settings-remove-btn" data-id="${c.id}" style="font-size:0.8em;padding:4px 10px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
        </td>
      </tr>
    `).join('') : `<tr><td colspan="5" style="padding:12px;color:var(--text-secondary);font-size:0.85em;text-align:center;">No tracked collections yet. Add one below.</td></tr>`;

    pane.innerHTML = `
      <div style="${cardStyle}">
        <h3 style="${cardHeader}">📡 Tracked Collections</h3>
        <div style="overflow-x:auto;margin-bottom:14px;">
          <table style="width:100%;border-collapse:collapse;" id="nts_collectionsTable">
            <thead><tr style="border-bottom:2px solid rgba(255,255,255,0.1);">
              <th style="text-align:left;padding:8px 10px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Name</th>
              <th style="text-align:left;padding:8px 10px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Address</th>
              <th style="text-align:left;padding:8px 10px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">Events</th>
              <th style="text-align:left;padding:8px 10px;font-size:0.8em;color:var(--text-secondary);text-transform:uppercase;">On</th>
              <th style="padding:8px 10px;"></th>
            </tr></thead>
            <tbody>${collectionRows}</tbody>
          </table>
        </div>
        <div style="padding-top:var(--space-4);border-top:1px solid rgba(99,102,241,0.15);">
          <h4 style="color:#c9d6ff;font-size:0.9em;font-weight:600;margin:0 0 10px;">➕ Add Collection</h4>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);margin-bottom:var(--space-3);">
            <div>
              <label style="display:block;color:#c9d6ff;font-size:0.85em;margin-bottom:4px;">Collection Name</label>
              <input type="text" id="nts_addName" placeholder="e.g. Vault Runners" style="${fieldInput}">
            </div>
            <div>
              <label style="display:block;color:#c9d6ff;font-size:0.85em;margin-bottom:4px;">Collection Address</label>
              <input type="text" id="nts_addAddr" placeholder="Solana collection address" style="${fieldInput};font-family:monospace;">
            </div>
            <div>
              <label style="display:block;color:#c9d6ff;font-size:0.85em;margin-bottom:4px;">Alert Channel</label>
              <select id="nts_addChannel" style="${fieldInput}">${chOptions('')}</select>
            </div>
            <div>
              <label style="display:block;color:#c9d6ff;font-size:0.85em;margin-bottom:4px;">Magic Eden Symbol (optional)</label>
              <input type="text" id="nts_addMe" placeholder="vault_runners" style="${fieldInput}">
            </div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:var(--space-3);">
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.85em;cursor:pointer;"><input type="checkbox" id="nts_addMint"> 🪙 Mint</label>
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.85em;cursor:pointer;"><input type="checkbox" id="nts_addSale" checked> 💰 Sale</label>
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.85em;cursor:pointer;"><input type="checkbox" id="nts_addList"> 📋 List</label>
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.85em;cursor:pointer;"><input type="checkbox" id="nts_addDelist"> ❌ Delist</label>
            <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.85em;cursor:pointer;"><input type="checkbox" id="nts_addTransfer"> 🔄 Transfer</label>
          </div>
          <button class="btn-primary" id="nts_addBtn" style="font-size:0.85em;padding:8px 16px;">Add Collection</button>
        </div>
      </div>
    `;

    // Wire add collection
    document.getElementById('nts_addBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('nts_addBtn');
      const name = document.getElementById('nts_addName')?.value.trim();
      const addr = document.getElementById('nts_addAddr')?.value.trim();
      const chId = document.getElementById('nts_addChannel')?.value;
      if (!name || !addr || !chId) return showError('Name, address, and channel are required');
      btn.disabled = true; btn.textContent = 'Adding...';
      try {
        const r = await fetch('/api/admin/nft-tracker/collections', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            collectionName: name, collectionAddress: addr, channelId: chId,
            meSymbol: document.getElementById('nts_addMe')?.value.trim() || '',
            trackMint: !!document.getElementById('nts_addMint')?.checked,
            trackSale: !!document.getElementById('nts_addSale')?.checked,
            trackList: !!document.getElementById('nts_addList')?.checked,
            trackDelist: !!document.getElementById('nts_addDelist')?.checked,
            trackTransfer: !!document.getElementById('nts_addTransfer')?.checked,
          })
        });
        const d = await r.json();
        if (d.success !== false) { showSuccess('Collection added!'); loadNftTrackerSettingsView(); }
        else showError(d.message || 'Failed to add collection');
      } catch { showError('Error adding collection'); }
      btn.disabled = false; btn.textContent = 'Add Collection';
    });

    // Wire edit/remove buttons
    pane.querySelectorAll('.nft-settings-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        // Reuse the modal from the full tracker view
        const fakeBtn = { dataset: { id: btn.dataset.id, name: btn.dataset.name, channel: btn.dataset.channel, me: btn.dataset.me, mint: btn.dataset.mint, sale: btn.dataset.sale, list: btn.dataset.list, delist: btn.dataset.delist, transfer: btn.dataset.transfer } };
        // Build inline edit modal (same as loadNftTrackerView's editNftCollection)
        const old = document.getElementById('nftEditModal');
        if (old) old.remove();
        const modalFieldInput = 'width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;';
        const modalLabel = 'display:block;font-weight:600;font-size:0.85em;color:#c9d6ff;margin-bottom:6px;';
        const overlay = document.createElement('div');
        overlay.id = 'nftEditModal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
        overlay.innerHTML = `
          <div style="background:var(--card-bg,#1e293b);border:1px solid rgba(99,102,241,0.3);border-radius:12px;padding:24px;width:480px;max-width:95vw;max-height:90vh;overflow-y:auto;">
            <h3 style="margin:0 0 16px;color:var(--text-primary,#e0e7ff);">✏️ Edit Collection</h3>
            <div style="margin-bottom:12px;"><label style="${modalLabel}">Collection Name</label><input type="text" id="nftEditName" value="${escapeHtml(btn.dataset.name||'')}" style="${modalFieldInput}"></div>
            <div style="margin-bottom:12px;"><label style="${modalLabel}">Alert Channel</label><select id="nftEditChannel" style="${modalFieldInput}"><option value="">Loading...</option></select></div>
            <div style="margin-bottom:12px;"><label style="${modalLabel}">Magic Eden Symbol</label><input type="text" id="nftEditMeSymbol" value="${escapeHtml(btn.dataset.me||'')}" style="${modalFieldInput}"></div>
            <div style="margin-bottom:16px;"><label style="${modalLabel}">Track Events</label>
              <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:4px;">
                <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="nftEditMint" ${btn.dataset.mint==='1'?'checked':''}> 🪙 Mint</label>
                <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="nftEditSale" ${btn.dataset.sale==='1'?'checked':''}> 💰 Sale</label>
                <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="nftEditList" ${btn.dataset.list==='1'?'checked':''}> 📋 List</label>
                <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="nftEditDelist" ${btn.dataset.delist==='1'?'checked':''}> ❌ Delist</label>
                <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="nftEditTransfer" ${btn.dataset.transfer==='1'?'checked':''}> 🔄 Transfer</label>
              </div>
            </div>
            <div style="display:flex;gap:10px;align-items:center;">
              <button id="nftEditSaveBtn" style="padding:8px 18px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:0.85em;font-weight:600;cursor:pointer;">Save</button>
              <button id="nftEditCancelBtn" style="padding:8px 18px;background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,0.12);border-radius:8px;font-size:0.85em;cursor:pointer;">Cancel</button>
              <span id="nftEditFeedback" style="font-size:0.85em;font-weight:600;"></span>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        // Populate channel dropdown
        const sel = document.getElementById('nftEditChannel');
        sel.innerHTML = '<option value="">-- Select channel --</option>';
        Object.keys(grouped).sort().forEach(parent => {
          const og = document.createElement('optgroup'); og.label = parent;
          grouped[parent].forEach(ch => { const o = document.createElement('option'); o.value = ch.id; o.textContent = '# ' + ch.name; og.appendChild(o); });
          sel.appendChild(og);
        });
        sel.value = btn.dataset.channel || '';
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.getElementById('nftEditCancelBtn').addEventListener('click', () => overlay.remove());
        document.getElementById('nftEditSaveBtn').addEventListener('click', async () => {
          const saveBtn = document.getElementById('nftEditSaveBtn');
          const feedback = document.getElementById('nftEditFeedback');
          saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
          try {
            const r = await fetch('/api/admin/nft-tracker/collections/' + btn.dataset.id, {
              method: 'PUT', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                collectionName: document.getElementById('nftEditName').value.trim(),
                channelId: document.getElementById('nftEditChannel').value,
                meSymbol: document.getElementById('nftEditMeSymbol').value.trim(),
                trackMint: !!document.getElementById('nftEditMint').checked,
                trackSale: !!document.getElementById('nftEditSale').checked,
                trackList: !!document.getElementById('nftEditList').checked,
                trackDelist: !!document.getElementById('nftEditDelist').checked,
                trackTransfer: !!document.getElementById('nftEditTransfer').checked,
              })
            });
            const d = await r.json();
            if (r.ok && d.success) { overlay.remove(); loadNftTrackerSettingsView(); }
            else { if (feedback) { feedback.style.color='#fca5a5'; feedback.textContent = d.message || 'Failed to save'; } }
          } catch (err) { if (feedback) { feedback.style.color='#fca5a5'; feedback.textContent='Network error'; } }
          saveBtn.disabled = false; saveBtn.textContent = 'Save';
        });
      });
    });

    pane.querySelectorAll('.nft-settings-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this tracked collection?')) return;
        btn.disabled = true;
        try {
          await fetch('/api/admin/nft-tracker/collections/' + btn.dataset.id, { method: 'DELETE', credentials: 'include' });
          loadNftTrackerSettingsView();
        } catch { btn.disabled = false; }
      });
    });
  } catch (e) {
    console.error('[NFT Tracker Settings] error:', e);
    pane.innerHTML = '<p style="color:#fca5a5;font-size:0.85em;padding:var(--space-4);">Failed to load NFT tracker settings.</p>';
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
        <td style="padding:10px 12px;"><button onclick="removeVPMapping('${m.role_id}')" style="padding:4px 12px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);border-radius:6px;color:#fca5a5;font-size:0.82em;cursor:pointer;">Remove</button></td>
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

async function loadVPMappings() {
  const container = document.getElementById('vpMappingsTableContainer');
  if (!container) return;
  try {
    const res = await fetch('/api/admin/governance/vp-mappings', { credentials: 'include' });
    const data = await res.json();
    if (!data.success || !data.mappings || data.mappings.length === 0) {
      container.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85em;font-style:italic;">No VP mappings configured. Falling back to tier-based VP.</p>';
      return;
    }
    const rows = data.mappings.map(m => `<tr style="border-bottom:1px solid rgba(99,102,241,0.08);">
      <td style="padding:10px 12px;color:#e0e7ff;">${m.role_name || m.role_id}</td>
      <td style="padding:10px 12px;color:#a5b4fc;font-weight:600;">${m.voting_power}</td>
      <td style="padding:10px 12px;"><button onclick="removeVPMapping('${m.role_id}')" style="padding:4px 12px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);border-radius:6px;color:#fca5a5;font-size:0.82em;cursor:pointer;">Remove</button></td>
    </tr>`).join('');
    container.innerHTML = `<div style="overflow-x:auto;border-radius:10px;border:1px solid rgba(99,102,241,0.12);">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:rgba(30,41,59,0.7);">
          <th style="padding:10px 12px;text-align:left;color:#94a3b8;font-size:0.82em;font-weight:600;">Role</th>
          <th style="padding:10px 12px;text-align:left;color:#94a3b8;font-size:0.82em;font-weight:600;">Voting Power</th>
          <th style="padding:10px 12px;text-align:left;color:#94a3b8;font-size:0.82em;font-weight:600;">Actions</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  } catch (e) {
    console.error('Failed to load VP mappings:', e);
    container.innerHTML = '<p style="color:#fca5a5;font-size:0.85em;">Failed to load VP mappings.</p>';
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
    const response = await fetch('/api/admin/roles/config', { credentials: 'include' });
    const data = await response.json();
    if (!data.success) throw new Error(data.message || 'Failed to load roles');

    const config = data.config || {};
    const tiers = config.tiers || [];
    const traitRoles = config.traitRoles || [];
    adminTiersCache = tiers;
    adminTraitsCache = traitRoles;
    // Keep legacy cache for export
    adminRolesCache = [...tiers.map(t => ({ ...t, _type: 'tier' })), ...traitRoles.map(t => ({ ...t, _type: 'trait' }))];

    const allRules = [
      ...tiers.map((t, idx) => ({ ...t, _type: 'collection', _idx: idx })),
      ...traitRoles.map((t, idx) => ({ ...t, _type: 'trait', _idx: idx }))
    ];

    let html = '';
    html += `<div style="margin-bottom:12px;">
      <p style="color:var(--text-secondary); font-size:0.85em; margin:0;">Define collection-based tiers and trait-based roles for automatic Discord role assignment.</p>
    </div>`;

    if (allRules.length === 0) {
      html += `<div style="padding:24px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.15); border-radius:10px; color:var(--text-secondary); text-align:center;">No verification rules yet. Click <strong>+ Add Rule</strong> to create one.</div>`;
    } else {
      const truncId = (id) => id && id.length > 16 ? id.slice(0, 8) + '...' + id.slice(-4) : (id || '—');
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
        const badge = isCollection
          ? '<span class="badge-collection">Collection</span>'
          : '<span class="badge-trait">Trait</span>';
        const ruleName = isCollection
          ? escapeHtml(rule.name || 'Unnamed')
          : escapeHtml(rule.traitType || rule.trait_type || '');
        const colId = isCollection
          ? (rule.collectionId || rule.collection_id || '')
          : (rule.collectionId || rule.trait_collection_id || '');
        const roleId = rule.roleId || '';
        let details = '';
        if (isCollection) {
          const max = (rule.maxNFTs === Infinity || rule.maxNFTs >= 999999) ? '∞' : rule.maxNFTs;
          details = `Min: ${rule.minNFTs}, Max: ${max} NFTs`;
        } else {
          const vals = rule.traitValues || rule.trait_values || (rule.traitValue || rule.trait_value ? [rule.traitValue || rule.trait_value] : []);
          const valArr = Array.isArray(vals) ? vals : String(vals).split(',').map(v => v.trim()).filter(Boolean);
          details = valArr.length ? 'Values: ' + valArr.map(v => escapeHtml(v)).join(', ') : '—';
        }
        const editFn = isCollection ? `editTier(${rule._idx})` : `editTraitRule(${rule._idx})`;
        const deleteFn = isCollection ? `deleteTier(${rule._idx})` : `deleteTraitRule(${rule._idx})`;

        return `<tr>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15);">${badge}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#e0e7ff; font-weight:600;">${ruleName}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); font-family:monospace; font-size:0.82em; color:#a5b4fc;" title="${escapeHtml(colId)}">
            <span style="cursor:pointer;" onclick="navigator.clipboard.writeText('${escapeHtml(colId)}');showSuccess('Copied!')">${escapeHtml(truncId(colId))}</span>
          </td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#93c5fd; font-size:0.85em;">${resolveRole(roleId)}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:var(--text-secondary); font-size:0.85em;">${details}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); text-align:right; white-space:nowrap;">
            <button onclick="${editFn}" style="width:32px; height:32px; background:rgba(99,102,241,0.2); border:1px solid rgba(99,102,241,0.35); border-radius:6px; cursor:pointer; color:#818cf8; font-size:0.9em;">✏️</button>
            <button onclick="${deleteFn}" style="width:32px; height:32px; background:rgba(239,68,68,0.2); border:1px solid rgba(239,68,68,0.35); border-radius:6px; cursor:pointer; color:#fca5a5; font-size:0.9em; margin-left:4px;">🗑️</button>
          </td>
        </tr>`;
      }).join('');

      html += `
        <div style="overflow:auto; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.5); margin-bottom:16px;">
          <table style="width:100%; border-collapse:collapse; font-size:0.9em;">
            <thead><tr style="background:rgba(99,102,241,0.12); text-align:left;">
              <th style="padding:10px; color:#c9d6ff;">Type</th>
              <th style="padding:10px; color:#c9d6ff;">Rule Name</th>
              <th style="padding:10px; color:#c9d6ff;">Collection ID</th>
              <th style="padding:10px; color:#c9d6ff;">Discord Role</th>
              <th style="padding:10px; color:#c9d6ff;">Details</th>
              <th style="padding:10px; color:#c9d6ff; text-align:right;">Actions</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    html += `<div style="margin-top:8px; color:var(--text-secondary); font-size:0.9em;">Showing ${tiers.length} collection rule(s) and ${traitRoles.length} trait rule(s)</div>`;

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div class="error-state"><div class="error-message">${escapeHtml(e.message)}</div></div>`;
  }
}

// ==================== UNIFIED VERIFICATION RULE MODAL ====================
let _editingRuleType = null; // "tier" or "trait"
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
              <span>\uD83C\uDFC6 Collection</span>
              <small>Min/max NFT count</small>
            </label>
            <label class="rule-type-option" id="ruleTypeTraitLabel">
              <input type="radio" name="ruleType" value="trait" id="ruleTypeTrait" onchange="onRuleTypeChange()">
              <span>\uD83C\uDFAD Trait</span>
              <small>Specific NFT traits</small>
            </label>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:14px;">
          <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Collection ID <span style="color:#f87171;">*</span></label>
          <input type="text" id="ruleCollectionId" placeholder="Solana collection address" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
        </div>
        <div class="form-group" style="margin-bottom:14px;">
          <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Discord Role <span style="color:#f87171;">*</span></label>
          ${roleSelectHTML('ruleRoleId', '')}
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
              <label style="display:block;color:#c9d6ff;font-size:0.9em;margin-bottom:6px;">Max NFTs <small style="color:var(--text-secondary);">(blank = \u221E)</small></label>
              <input type="number" id="ruleMaxNFTs" placeholder="\u221E" min="0" style="width:100%;padding:10px 12px;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;color:#e0e7ff;font-size:0.9em;">
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
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="closeAddRuleModal()">Cancel</button>
        <button class="btn-primary" onclick="saveRule()" id="saveRuleBtn">Save Rule</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function onRuleTypeChange() {
  const isTrait = document.getElementById('ruleTypeTrait').checked;
  document.getElementById('collectionFields').style.display = isTrait ? 'none' : '';
  document.getElementById('traitFields').style.display = isTrait ? '' : 'none';
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
  document.getElementById('traitValueTags').innerHTML = '';
  document.getElementById('traitValueInput').value = '';
  document.getElementById('ruleTraitValues').value = '';

  // Set type radio
  const isTrait = editData?._type === 'trait';
  document.getElementById(isTrait ? 'ruleTypeTrait' : 'ruleTypeCollection').checked = true;
  onRuleTypeChange();

  // Populate edit data
  if (editData) {
    document.getElementById('ruleCollectionId').value = editData.collectionId || editData.collection_id || editData.trait_collection_id || '';
    document.getElementById('ruleRoleId').value = editData.roleId || '';
    document.getElementById('addRuleModalTitle').textContent = 'Edit Verification Rule';
    if (isTrait) {
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
  const isTrait = document.getElementById('ruleTypeTrait').checked;
  const collectionId = document.getElementById('ruleCollectionId').value.trim();
  const roleId = document.getElementById('ruleRoleId').value;
  if (!collectionId || !roleId) { showError('Collection ID and Discord Role are required.'); return; }

  const btn = document.getElementById('saveRuleBtn');
  btn.disabled = true; btn.textContent = 'Saving...';

  try {
    if (isTrait) {
      const traitType = document.getElementById('ruleTraitType').value.trim();
      const traitValues = [..._traitValues];
      if (!traitType || !traitValues.length) { showError('Trait type and at least one trait value are required.'); btn.disabled = false; btn.textContent = 'Save Rule'; return; }
      const description = document.getElementById('ruleDescription').value.trim();
      // For backward compat, send both traitValue (first) and traitValues (array)
      const traitValue = traitValues[0];

      if (_editingRuleIdx !== null && _editingRuleType === 'trait') {
        const existing = adminTraitsCache[_editingRuleIdx];
        const origType = existing.traitType || existing.trait_type;
        const origValue = existing.traitValue || existing.trait_value;
        const response = await fetch(`/api/admin/roles/traits/${encodeURIComponent(origType)}/${encodeURIComponent(origValue)}`, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ traitType, traitValue, traitValues, collectionId, roleId, description })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || 'Failed to update trait rule');
      } else {
        const response = await fetch('/api/admin/roles/traits', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ traitType, traitValue, traitValues, collectionId, roleId, description })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || 'Failed to create trait rule');
      }
    } else {
      const name = document.getElementById('ruleTierName').value.trim() || 'Tier';
      const minNFTs = parseInt(document.getElementById('ruleMinNFTs').value) || 1;
      const maxNFTsRaw = document.getElementById('ruleMaxNFTs').value;
      const maxNFTs = maxNFTsRaw === '' ? 999999 : parseInt(maxNFTsRaw);

      if (_editingRuleIdx !== null && _editingRuleType === 'tier') {
        const existing = adminTiersCache[_editingRuleIdx];
        const response = await fetch(`/api/admin/roles/tiers/${encodeURIComponent(existing.name)}`, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, minNFTs, maxNFTs, votingPower: 1, collectionId, roleId })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || 'Failed to update tier');
      } else {
        const response = await fetch('/api/admin/roles/tiers', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, minNFTs, maxNFTs, votingPower: 1, collectionId, roleId })
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

function deleteTier(idx) {
  if (!isAdmin || !adminTiersCache[idx]) return;
  const tier = adminTiersCache[idx];
  showConfirmModal('Delete Tier', `Are you sure you want to delete tier "${tier.name}"? This cannot be undone.`, async () => {
    try {
      const response = await fetch(`/api/admin/roles/tiers/${encodeURIComponent(tier.name)}`, { method: 'DELETE', credentials: 'include' });
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
      const response = await fetch(`/api/admin/roles/traits/${encodeURIComponent(traitType)}/${encodeURIComponent(traitValue)}`, { method: 'DELETE', credentials: 'include' });
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

function openAddRoleModal() {
  // Legacy: redirect to the new split UI
  openAddTraitModal();
}

let adminRolesCache = [];

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
    return `
      <tr>
        <td style="padding:8px; border-bottom:1px solid var(--border-default);">${escapeHtml(name)}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-default); font-family:monospace; font-size:0.85em;">${escapeHtml(String(did))}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-default);">${escapeHtml(String(tier))}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-default);">${nfts}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-default);">${vp}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-default); text-align:right; white-space:nowrap;">
          <button onclick="viewUserDetails('${escapeHtml(String(did))}')" style="width:28px; height:28px; background:rgba(99,102,241,0.2); border:1px solid rgba(99,102,241,0.35); border-radius:6px; cursor:pointer; color:#818cf8; font-size:0.85em;" title="View Details">👁️</button>
          <button onclick="confirmRemoveUser('${escapeHtml(String(did))}', '${escapeHtml(name)}')" style="width:28px; height:28px; background:rgba(239,68,68,0.2); border:1px solid rgba(239,68,68,0.35); border-radius:6px; cursor:pointer; color:#fca5a5; font-size:0.85em; margin-left:4px;" title="Remove User">🗑️</button>
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

  container.innerHTML = `<div style="text-align:center; padding: var(--space-5);"><div class="spinner"></div><p>Loading...</p></div>`;

  try {
    const [activityRes, collectionsRes] = await Promise.all([
      (isAdmin
        ? fetch('/api/admin/nft-activity/events?limit=20', { credentials: 'include', headers: buildTenantRequestHeaders() })
        : fetch('/api/public/v1/nft/activity?limit=20', { credentials: 'include' })
      ).catch(() => null),
      isAdmin ? fetch('/api/admin/nft-tracker/collections', { credentials: 'include' }).catch(() => null) : Promise.resolve(null)
    ]);

    const activityData = activityRes ? await activityRes.json() : {};
    const collectionsData = collectionsRes ? await collectionsRes.json() : {};
    const events = activityData?.data?.events || activityData?.events || [];
    const collections = collectionsData?.collections || [];

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

    if (isAdmin) {
      html += `<div style="margin-top:16px;">
        <button class="btn-primary" onclick="loadNFTActivityAdminView()">
          <span>⚙️</span>
          <span>Manage Watchlist</span>
        </button>
      </div>`;
    }

    container.innerHTML = html;

    if (isAdmin) {
      const adminCard = document.getElementById('nftActivityAdminCard');
      if (adminCard) adminCard.style.display = 'block';
      loadNFTActivityAdminView(collections);
    }
  } catch (error) {
    console.error('Error loading NFT activity:', error);
    container.innerHTML = '<p style="color:#ef4444;">Failed to load NFT activity</p>';
  }
}

async function legacyLoadNFTActivityAdminView() {
  if (!isAdmin) return;
  
  const card = document.getElementById('nftActivityAdminCard');
  const content = document.getElementById('nftActivityAdminView');
  if (!card || !content) return;
  
  card.style.display = 'block';

  content.innerHTML = `
    <div style="display:grid; gap:12px;">
      <div style="display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr));">
        <button class="btn-primary" onclick="openAddWatchCollectionModal()" style="justify-content:center;">
          <span>➕</span>
          <span>Add Collection to Watch</span>
        </button>
        <button class="btn-secondary" onclick="openEditActivityAlertsModal()" style="justify-content:center;">
          <span>⚙️</span>
          <span>Edit Alert Settings</span>
        </button>
      </div>
      <div id="nftActivityAdminList" style="margin-top:8px;"></div>
    </div>
  `;

  // Load the list with remove buttons
  try {
    const response = await fetch('/api/admin/activity/watch-list', { credentials: 'include' });
    const data = await response.json();
    const listEl = document.getElementById('nftActivityAdminList');
    
    if (!data.success || !data.collections || data.collections.length === 0) {
      listEl.innerHTML = `<div style="color:var(--text-secondary); text-align:center; padding:12px;">No watched collections. Add one above.</div>`;
      return;
    }

    const rows = data.collections.map(col => {
      const name = col.name || col.collection_name || col.address || 'Unknown';
      const addr = col.address || col.collection_address || '';
      return `
        <div style="padding:10px 14px; border-bottom:1px solid rgba(99,102,241,0.12); display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="color:#e0e7ff; font-weight:600;">${escapeHtml(name)}</div>
            <div style="color:var(--text-secondary); font-size:0.8em; font-family:monospace;">${escapeHtml(addr)}</div>
          </div>
          <button class="btn-danger" onclick="removeWatchedCollection('${escapeHtml(addr || name)}')" style="font-size:0.8em; padding:6px 12px;">
            <span>🗑️</span><span>Remove</span>
          </button>
        </div>
      `;
    }).join('');

    listEl.innerHTML = `<div style="border:1px solid rgba(99,102,241,0.22); border-radius:10px; overflow:hidden;">${rows}</div>`;
  } catch (e) {
    document.getElementById('nftActivityAdminList').innerHTML = `<div style="color:#ef4444; padding:12px;">Error loading list: ${escapeHtml(e.message)}</div>`;
  }
}

function openAddWatchCollectionModal() {
  if (!isAdmin) return;
  showConfirmModal('Add Watched Collection', '', null);
  const title = document.getElementById('confirmTitle');
  const body = document.getElementById('confirmMessage');
  const btn = document.getElementById('confirmButton');
  title.textContent = '➕ Watch New Collection';
  btn.textContent = 'Add Collection';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-primary');
  body.innerHTML = `
    <div style="display:grid; gap:14px;">
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Collection Address *</label>
        <input id="watchCollAddrInput" type="text" placeholder="Solana collection address" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; font-family:monospace;"></div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Collection Name (optional)</label>
        <input id="watchCollNameInput" type="text" placeholder="e.g. Alpha Collection" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;"></div>
    </div>
  `;
  confirmCallback = async () => {
    const address = document.getElementById('watchCollAddrInput')?.value.trim();
    const name = document.getElementById('watchCollNameInput')?.value.trim();
    if (!address) { showError('Collection address is required'); return; }
    try {
      const response = await fetch('/api/admin/activity/watch-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ address, name })
      });
      const data = await response.json();
      if (data.success) {
        showSuccess('Collection added to watch list');
        loadNFTActivityView();
        loadNFTActivityAdminView();
      } else {
        showError(data.message || 'Failed to add collection');
      }
    } catch (e) {
      showError('Error: ' + e.message);
    }
  };
}

async function removeWatchedCollection(identifier) {
  if (!isAdmin) return;
  showConfirmModal('Remove Collection', `Stop watching "${identifier}"? You can re-add it later.`, async () => {
    try {
      const response = await fetch('/api/admin/activity/watch-remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ address: identifier })
      });
      const data = await response.json();
      if (data.success) {
        showSuccess('Collection removed from watch list');
        loadNFTActivityView();
        loadNFTActivityAdminView();
      } else {
        showError(data.message || 'Failed to remove collection');
      }
    } catch (e) {
      showError('Error: ' + e.message);
    }
  }, 'Remove');
}

function openEditActivityAlertsModal() {
  if (!isAdmin) return;
  showConfirmModal('Edit Activity Alerts', '', null);
  const title = document.getElementById('confirmTitle');
  const body = document.getElementById('confirmMessage');
  const btn = document.getElementById('confirmButton');
  title.textContent = '⚙️ Activity Alert Settings';
  btn.textContent = 'Save Settings';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-primary');
  body.innerHTML = `
    <div style="display:grid; gap:14px;">
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Alert Channel ID</label>
        <input id="activityAlertChannelInput" type="text" placeholder="Discord channel ID" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; font-family:monospace;"></div>
      <div>
        <label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Event Types to Track</label>
        <div style="display:flex; flex-wrap:wrap; gap:10px;">
          ${['mints','sales','listings','delistings','transfers'].map(ev => `
            <label style="display:flex; align-items:center; gap:6px; color:#c9d6ff; font-size:0.9em;">
              <input type="checkbox" class="activityEventCheckbox" value="${ev}" checked style="width:16px; height:16px;">
              <span>${ev.charAt(0).toUpperCase() + ev.slice(1)}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div><label style="display:flex; align-items:center; gap:8px; color:#c9d6ff;">
        <input id="activityAlertsEnabledInput" type="checkbox" checked style="width:18px; height:18px;">
        <span>Enable activity alerts</span>
      </label></div>
    </div>
  `;
  confirmCallback = async () => {
    const channel = document.getElementById('activityAlertChannelInput')?.value.trim();
    const enabled = document.getElementById('activityAlertsEnabledInput')?.checked;
    const events = [...document.querySelectorAll('.activityEventCheckbox:checked')].map(cb => cb.value);
    try {
      const response = await fetch('/api/admin/nft-activity/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          enabled,
          channelId: channel || undefined,
          eventTypes: events,
          minSol: 0
        })
      });
      const data = await response.json();
      if (data.success) {
        showSuccess('Activity alert settings updated');
        loadNFTActivityView();
      } else {
        showError(data.message || 'Failed to update alert settings');
      }
    } catch (e) {
      showError('Error: ' + e.message);
    }
  };
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
// Add these functions to portal.js at the end, before the closing comment

// ==================== NFT ACTIVITY TRACKER ====================
async function legacyLoadNFTActivityView() {
  const container = document.getElementById('nftActivityPublicView');
  if (!container) return;

  container.innerHTML = `<div style="text-align:center; padding: var(--space-5);"><div class="spinner"></div><p>Loading...</p></div>`;

  try {
    const [activityRes, collectionsRes] = await Promise.all([
      fetch('/api/public/v1/nft/activity?limit=20', { credentials: 'include' }).catch(() => null),
      isAdmin ? fetch('/api/admin/nft-tracker/collections', { credentials: 'include' }).catch(() => null) : Promise.resolve(null)
    ]);

    const activityData = activityRes ? await activityRes.json() : {};
    const collectionsData = collectionsRes ? await collectionsRes.json() : {};
    const events = activityData?.events || activityData?.data?.events || [];
    const collections = collectionsData?.collections || [];

    let html = '';

    if (events.length > 0) {
      html += `<div style="display:grid; gap:12px; margin-bottom:16px;">${events.slice(0, 10).map((event) => `
        <div style="padding:16px; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.22); border-radius:10px;">
          <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
            <div>
              <div style="color:#e0e7ff; font-weight:600; margin-bottom:4px;">${escapeHtml(event.event_type || event.type || 'activity')}</div>
              <div style="color:var(--text-secondary); font-size:0.85em;">${escapeHtml(event.collection_key || event.collection || 'Unscoped')}</div>
              <div style="color:var(--text-secondary); font-size:0.82em; margin-top:4px;">${escapeHtml(event.token_name || event.token_mint || '')}</div>
            </div>
            <div style="color:var(--text-secondary); font-size:0.82em; white-space:nowrap;">${event.event_time ? new Date(event.event_time).toLocaleString() : ''}</div>
          </div>
        </div>
      `).join('')}</div>`;
    } else {
      html += '<p style="text-align:center; padding:20px; color:var(--text-secondary);">No recent NFT activity yet.</p>';
    }

    if (isAdmin) {
      html += `<div style="margin-top:16px;">
        <button class="btn-primary" onclick="loadNFTActivityAdminView()">
          <span>⚙️</span>
          <span>Manage Watchlist</span>
        </button>
      </div>`;
    }

    container.innerHTML = html;

    if (isAdmin) {
      const adminCard = document.getElementById('nftActivityAdminCard');
      if (adminCard) adminCard.style.display = 'block';
      loadNFTActivityAdminView(collections);
    }
  } catch (error) {
    console.error('Error loading NFT activity:', error);
    container.innerHTML = '<p style="color:#ef4444;">Failed to load NFT activity</p>';
  }
}

async function loadNFTActivityAdminView(preloadedCollections = null) {
  if (!isAdmin) return;

  const container = document.getElementById('nftActivityAdminView');
  if (!container) return;

  try {
    let collections = preloadedCollections;
    if (!collections) {
      const response = await fetch('/api/admin/nft-tracker/collections', { credentials: 'include' });
      const data = await response.json();
      collections = data.success ? (data.collections || []) : [];
    }

    container.innerHTML = `
      <div style="display:grid; gap:12px;">
        <div style="display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr));">
          <button class="btn-primary" onclick="openAddCollectionModal()" style="justify-content:center;">
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
    const chRes = await fetch('/api/admin/discord/channels', { credentials: 'include' });
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
        headers: { 'Content-Type': 'application/json' },
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

async function openAddCollectionModal() {
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
          <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="caList" checked> 📋 List</label>
          <label style="display:flex;align-items:center;gap:6px;color:#c9d6ff;font-size:0.9em;cursor:pointer;"><input type="checkbox" id="caDelist"> ❌ Delist</label>
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
    const chRes = await fetch('/api/admin/discord/channels', { credentials: 'include' });
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collectionAddress: addr, collectionName: name, channelId: chId,
          meSymbol: document.getElementById('caMeInput').value.trim(),
          trackMint: !!document.getElementById('caMint').checked,
          trackSale: !!document.getElementById('caSale').checked,
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
          credentials: 'include'
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
// Add these functions to portal.js at the end, before the closing comment

// ==================== NFT ACTIVITY TRACKER ====================
async function legacyLoadNFTActivityView() {
  try {
    // Load watched collections from backend
    const response = await fetch('/api/verification/admin/activity-watch-list', { credentials: 'include' });
    const data = await response.json();
    
    const container = document.getElementById('nftActivityPublicView');
    if (!container) return;
    
    if (data.success && data.collections && data.collections.length > 0) {
      container.innerHTML = `
        <div style="display:grid; gap:12px;">
          ${data.collections.map((col, idx) => `
            <div style="padding:16px; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.22); border-radius:10px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                  <div style="color:#e0e7ff; font-weight:600; margin-bottom:4px;">${col.collection || col.key || 'Unknown Collection'}</div>
                  <div style="color:var(--text-secondary); font-size:0.85em;">Added: ${new Date(col.created_at).toLocaleDateString()}</div>
                </div>
                <div style="font-size:1.5em;">📊</div>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      container.innerHTML = '<p style="text-align:center; padding:20px; color:var(--text-secondary);">No collections being watched yet.<br>Admin can add collections via the Admin panel.</p>';
    }
    
    // Show admin section if user is admin
    if (isAdmin) {
      document.getElementById('nftActivityAdminCard').style.display = 'block';
      loadNFTActivityAdminView();
    }
  } catch (error) {
    console.error('Error loading NFT activity:', error);
    document.getElementById('nftActivityPublicView').innerHTML = '<p style="color:#ef4444;">Failed to load collections</p>';
  }
}

async function legacyLoadNFTActivityAdminView() {
  if (!isAdmin) return;
  
  try {
    const container = document.getElementById('nftActivityAdminView');
    if (!container) return;
    
    const response = await fetch('/api/verification/admin/activity-watch-list', { credentials: 'include' });
    const data = await response.json();
    const collections = (data.success ? data.collections : []) || [];
    
    container.innerHTML = `
      <div style="margin-bottom:16px;">
        <button class="btn-primary" onclick="openAddCollectionModal()">
          <span>➕</span>
          <span>Add Collection</span>
        </button>
      </div>
      <div style="display:grid; gap:12px;">
        ${collections.map((col, idx) => `
          <div style="padding:16px; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.22); border-radius:10px; display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="color:#e0e7ff; font-weight:600;">${col.collection || col.key || 'Unknown'}</div>
              <div style="color:var(--text-secondary); font-size:0.85em;">Added: ${new Date(col.created_at).toLocaleDateString()}</div>
            </div>
            <button class="btn-secondary" onclick="removeWatchedCollection(${idx}, '${encodeURIComponent(col.collection || col.key)}')" style="padding:8px 16px;">
              <span>🗑️</span>
              <span>Remove</span>
            </button>
          </div>
        `).join('')}
        ${collections.length === 0 ? '<p style="color:var(--text-secondary); text-align:center;">No collections configured</p>' : ''}
      </div>
    `;
  } catch (error) {
    console.error('Error loading NFT activity admin:', error);
  }
}

function legacyOpenAddCollectionModal() {
  showConfirmModal(
    'Add Watched Collection',
    `
      <input type="text" id="newCollectionInput" placeholder="Collection address or key (e.g., collection-key)" 
        style="width:100%; padding:12px; background:rgba(0,0,0,0.3); border:1px solid rgba(99,102,241,0.3); border-radius:8px; color:#e0e7ff; font-size:1em; margin-top:12px;" />
    `,
    async () => {
      const collection = document.getElementById('newCollectionInput').value.trim();
      if (!collection) {
        showError('Please enter a collection address or key');
        return;
      }
      
      try {
        const response = await fetch('/api/verification/admin/activity-watch-add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ collection })
        });
        const data = await response.json();
        
        if (data.success) {
          showSuccess('Collection added to watchlist');
          loadNFTActivityAdminView();
          loadNFTActivityView();
        } else {
          showError(data.message || 'Failed to add collection');
        }
      } catch (error) {
        showError('Failed to add collection');
      }
    },
    null,
    true // Don't auto-close
  );
}

async function legacyRemoveWatchedCollection(idx, collectionEncoded) {
  const collection = decodeURIComponent(collectionEncoded);
  
  showConfirmModal(
    'Remove Collection',
    `Are you sure you want to stop watching "${collection}"? This cannot be undone.`,
    async () => {
      try {
        const response = await fetch('/api/verification/admin/activity-watch-remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ collection })
        });
        const data = await response.json();
        
        if (data.success) {
          showSuccess('Collection removed from watchlist');
          loadNFTActivityAdminView();
          loadNFTActivityView();
        } else {
          showError(data.message || 'Failed to remove collection');
        }
      } catch (error) {
        showError('Failed to remove collection');
      }
    }
  );
}

// ==================== TREASURY TRACKER ====================
async function legacyLoadTreasuryTrackerView() {
  try {
    const response = await fetch('/api/admin/settings', { credentials: 'include' });
    const data = await response.json();
    
    const container = document.getElementById('treasuryTrackerView');
    if (!container) return;
    
    if (data.success && data.settings) {
      const s = data.settings;
      container.innerHTML = `
        <div style="display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr));">
          <div class="stat-card">
            <div class="stat-label">Treasury Wallet</div>
            <div class="stat-value" style="font-size:0.9em;">${s.treasuryWallet ? s.treasuryWallet.slice(0,8) + '...' + s.treasuryWallet.slice(-8) : 'Not configured'}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Refresh Interval</div>
            <div class="stat-value">${s.treasuryRefreshInterval || '—'} hours</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Last Sync</div>
            <div class="stat-value" style="font-size:0.9em;">${s.treasuryLastSync ? new Date(s.treasuryLastSync).toLocaleString() : 'Never'}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">TX Alerts</div>
            <div class="stat-value">${s.treasuryTxAlertsEnabled ? '✅ Enabled' : '❌ Disabled'}</div>
          </div>
        </div>
        ${isAdmin ? `
          <div style="margin-top:16px; padding:12px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.22); border-radius:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="color:var(--text-secondary); font-size:0.9em;">Configure treasury settings via Discord: <code style="background:rgba(0,0,0,0.3); padding:4px 8px; border-radius:4px;">/treasury admin set-wallet</code></span>
              <button class="btn-secondary" onclick="loadTreasuryPublicView()" style="padding:8px 16px;">
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
    document.getElementById('treasuryTrackerView').innerHTML = '<p style="color:#ef4444;">Failed to load tracker config</p>';
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

async function addSelfServeRole() {} // kept for legacy compatibility
async function removeSelfServeRole() {}
async function toggleSelfServeRole() {}
async function postSelfServePanel() {}

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
      <a href="#apiref-legacy" style="color:var(--accent-primary);font-size:0.85em;text-decoration:none;">Legacy Aliases</a>
      <a href="#apiref-auth" style="color:var(--accent-primary);font-size:0.85em;text-decoration:none;">Session / Auth</a>
      <a href="#apiref-flow" style="color:var(--accent-primary);font-size:0.85em;text-decoration:none;">Auth Flow</a>
    </div>

    <div style="margin-bottom:16px;padding:12px 14px;border:1px solid rgba(99,102,241,0.18);border-radius:10px;background:rgba(99,102,241,0.08);color:var(--text-secondary);font-size:0.88em;line-height:1.6;">
      Canonical public routes use <code>/api/public/v1/*</code> and return the standard <code>{ success, data, error, meta }</code> envelope. Legacy <code>/api/public/*</code> aliases remain mounted for compatibility.
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

    ${section('apiref-legacy', 'Legacy Public Aliases', '(still mounted for compatibility)', [
      endpoint('GET', '/api/public/stats', 'Legacy stats route used by older portal views.', true, null),
      endpoint('GET', '/api/public/treasury', 'Legacy treasury route used by older views.', true, null),
      endpoint('GET', '/api/public/proposals/active', 'Legacy active proposals route used by the voting panel.', true, null),
      endpoint('GET', '/api/public/proposals/concluded', 'Legacy concluded proposals route.', true, null),
      endpoint('GET', '/api/public/proposals/:id', 'Legacy single-proposal route.', true, null),
      endpoint('GET', '/api/public/missions/active', 'Legacy active missions route.', true, null),
      endpoint('GET', '/api/public/missions/completed', 'Legacy completed missions route.', true, null),
      endpoint('GET', '/api/public/missions/:id', 'Legacy single-mission route.', true, null),
      endpoint('GET', '/api/public/leaderboard', 'Legacy leaderboard route.', true, null),
      endpoint('GET', '/api/public/leaderboard/:userId', 'Legacy single-user leaderboard route.', true, null)
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
      const buttons = roles.map(r => `<button class="btn-secondary" onclick="toggleWebClaimRole(${p.id}, '${escapeHtml(r.role_id)}', this)" style="font-size:0.85em;padding:8px 12px;">${escapeHtml(r.label || r.role_id)}</button>`).join(' ');
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
    </div>
    <div id="ticketTabContent">Loading...</div>
  `;

  // Fetch channels if not cached
  if (_ticketChannelsList.length === 0) {
    try {
      const res = await fetch('/api/admin/discord/channels', { credentials: 'include' });
      const json = await res.json();
      if (json.success) _ticketChannelsList = json.channels || [];
    } catch (e) { /* ignore */ }
  }

  // Fetch roles if not cached
  if (_ticketRolesList.length === 0) {
    try {
      const res = await fetch('/api/admin/discord/roles', { credentials: 'include' });
      const json = await res.json();
      if (json.success) _ticketRolesList = json.roles || [];
    } catch (e) { /* ignore */ }
  }

  showTicketTab('categories');
}

function showTicketTab(tab) {
  ['categories', 'panel', 'tickets', 'archive'].forEach(t => {
    const btn = document.getElementById('ticketTab' + t.charAt(0).toUpperCase() + t.slice(1));
    if (btn) btn.className = t === tab ? 'btn-primary' : 'btn-secondary';
  });

  if (tab === 'categories') loadTicketCategoriesTab();
  else if (tab === 'panel') loadTicketPanelTab();
  else if (tab === 'tickets') loadTicketOpenTab();
  else if (tab === 'archive') loadTicketArchiveTab();
}

async function loadTicketCategoriesTab() {
  const container = document.getElementById('ticketTabContent');
  container.innerHTML = 'Loading categories...';

  try {
    const res = await fetch('/api/admin/tickets/categories', { credentials: 'include' });
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
  const allowedRoles = cat ? safeJsonArray(cat.allowed_role_ids) : [];
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
        <label style="font-size:0.85em;font-weight:600;">Allowed Roles</label>
        <select id="catRoles" multiple style="width:100%;min-height:120px;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;">
          ${_ticketRolesList.map(r => `<option value="${r.id}" ${allowedRoles.includes(r.id) ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
        </select>
        <div style="font-size:0.78em;color:var(--text-secondary);margin-top:4px;">Hold Ctrl/Cmd to select multiple roles.</div>
      </div>
      <div>
        <label style="font-size:0.85em;font-weight:600;">Roles to Ping on New Ticket</label>
        <select id="catPingRoles" multiple style="width:100%;min-height:120px;padding:6px 10px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);margin-top:4px;">
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
  const roleSelect = document.getElementById('catRoles');
  const pingRoleSelect = document.getElementById('catPingRoles');
  const allowedRoleIds = roleSelect ? Array.from(roleSelect.selectedOptions || []).map(o => o.value).filter(Boolean) : [];
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

  const payload = { name, emoji, description, parentChannelId, closedParentChannelId, allowedRoleIds, pingRoleIds, templateFields };
  const isEdit = window._catEditId != null;
  const url = isEdit ? `/api/admin/tickets/categories/${window._catEditId}` : '/api/admin/tickets/categories';
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
      credentials: 'include'
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
      headers: { 'Content-Type': 'application/json' },
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
    const res = await fetch('/api/admin/tickets?status=open', { credentials: 'include' });
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
    const res = await fetch(`/api/admin/tickets?${params.toString()}`, { credentials: 'include' });
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
    const res = await fetch(`/api/admin/tickets/${id}/transcript`, { credentials: 'include' });
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
const PLAN_CATALOG = [
  {
    id: "free",
    name: "Free",
    monthlyPrice: 0,
    features: [
      "1 Discord server",
      "Basic verification",
      "Up to 3 wallet trackers",
      "Community governance",
      "Standard support",
    ],
    cta: "Current Plan",
    ctaDisabled: true,
  },
  {
    id: "plus",
    name: "Plus",
    monthlyPrice: 15,
    popular: true,
    features: [
      "1 Discord server",
      "Advanced verification + traits",
      "Up to 50 wallet trackers",
      "NFT activity alerts",
      "Battle module",
      "Priority support",
    ],
    cta: "Upgrade to Plus",
    ctaAction: "upgrade_plus",
  },
  {
    id: "pro",
    name: "Pro",
    monthlyPrice: 30,
    features: [
      "Up to 3 Discord servers",
      "Everything in Plus",
      "Unlimited wallet trackers",
      "Snapshot exports",
      "Custom branding",
      "Dedicated support",
    ],
    cta: "Upgrade to Pro",
    ctaAction: "upgrade_pro",
  },
];

function updatePlanPrices() {
  const annual = document.getElementById('billingAnnualToggle')?.checked;
  const grid = document.getElementById('plansGrid');
  if (!grid) return;

  grid.innerHTML = PLAN_CATALOG.map(plan => {
    const price = annual ? Math.round(plan.monthlyPrice * 0.85) : plan.monthlyPrice;
    const period = plan.monthlyPrice === 0 ? "" : annual ? "/mo, billed annually" : "/month";
    return `
      <div class="plan-card ${plan.popular ? 'popular' : ''}">
        <div class="plan-name">${plan.name}</div>
        <div class="plan-price">$${price}<span>${period}</span></div>
        <ul class="plan-features">
          ${plan.features.map(f => `<li>${escapeHtml(f)}</li>`).join('')}
        </ul>
        <div class="plan-cta">
          <button class="btn-primary" style="width:100%;"
            ${plan.ctaDisabled ? 'disabled' : ''}
            onclick="handlePlanCta('${plan.ctaAction || ''}')">
            ${escapeHtml(plan.cta)}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function handlePlanCta(action) {
  if (!action) return;
  showInfo('Billing integration coming soon. Contact support to upgrade.');
}

async function loadCurrentPlan() {
  try {
    const res = await fetch('/api/admin/plan', { credentials: 'include', headers: buildTenantRequestHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (data.plan && data.plan !== 'free') {
      const card = document.getElementById('currentPlanCard');
      const content = document.getElementById('currentPlanContent');
      if (card && content) {
        const record = getServerRecord(activeGuildId);
        content.innerHTML = `
          <div style="display:flex;align-items:center;gap:16px;">
            ${record?.iconUrl ? `<img src="${record.iconUrl}" style="width:48px;height:48px;border-radius:10px;object-fit:cover;">` : ''}
            <div>
              <div style="font-size:1.1em;font-weight:700;color:#e0e7ff;">${escapeHtml(record?.name || activeGuildId)}</div>
              <div style="margin-top:4px;"><span class="badge badge-active">${escapeHtml(data.plan)}</span></div>
              ${data.expiresAt ? `<div style="color:var(--text-secondary);font-size:0.82em;margin-top:4px;">Until ${new Date(data.expiresAt).toLocaleDateString()}</div>` : ''}
            </div>
            <div style="margin-left:auto;display:flex;gap:8px;">
              <button class="btn-primary" onclick="handlePlanCta('manage')">Manage Plan</button>
              <button class="btn-secondary" onclick="handlePlanCta('cancel')">Cancel Plan</button>
            </div>
          </div>
        `;
        card.style.display = 'block';
      }
    }
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
        <table class="data-table">
          <thead><tr><th>Name</th><th>Status</th><th>Uptime</th><th>Restarts</th><th>Memory</th><th>CPU</th></tr></thead>
          <tbody>${pm2Rows}</tbody>
        </table>
      </div>
      <div style="color:var(--text-secondary);font-size:0.75em;margin-top:8px;text-align:right;">Last updated: ${new Date(d.timestamp).toLocaleTimeString()}</div>
    `;
  } catch(e) {
    el.innerHTML = '<p style="color:var(--text-secondary);">Failed to load system status: ' + escapeHtml(e.message) + '</p>';
  }
}
