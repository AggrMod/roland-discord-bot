// ==================== PORTAL STATE MANAGEMENT ====================
let userData = null;
let isAdmin = false;
let isSuperadmin = false;
let heistEnabled = false;
let confirmCallback = null;
let activeGuildId = localStorage.getItem('activeGuildId') || '';
let serverAccessData = { managedServers: [], unmanagedServers: [], isSuperadmin: false };
let originalFetch = window.fetch.bind(window);

function normalizeGuildId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isTenantSensitiveRequest(input) {
  const rawUrl = typeof input === 'string' ? input : (input?.url || '');
  try {
    const url = new URL(rawUrl, window.location.origin);
    return (
      url.pathname.startsWith('/api/admin/') ||
      url.pathname.startsWith('/api/superadmin/') ||
      url.pathname.startsWith('/api/verification/admin/') ||
      url.pathname === '/api/user/is-admin'
    );
  } catch (error) {
    return false;
  }
}

window.fetch = async function(input, init = {}) {
  const shouldAttachGuild = isTenantSensitiveRequest(input);
  if (!shouldAttachGuild) {
    return originalFetch(input, init);
  }

  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  if (activeGuildId && !headers.has('x-guild-id')) {
    headers.set('x-guild-id', activeGuildId);
  }

  return originalFetch(input, { ...init, headers });
};

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
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
      await loadScript('https://unpkg.com/@solana/web3.js@latest/lib/index.iife.min.js');
    }
    const { Connection, PublicKey, Transaction, SystemProgram } = window.solanaWeb3;

    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
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

function setActiveGuild(guildId, { persist = true, announce = true } = {}) {
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
}

function refreshTenantScopedViews() {
  syncTenantModuleNavVisibility();
  const activeSection = document.querySelector('.content-section.active')?.id || '';
  const activeAdminView = document.querySelector('.admin-sub-item.active')?.getAttribute('data-admin-nav');

  if (activeSection === 'section-admin' && activeAdminView) {
    showAdminView(activeAdminView);
    return;
  }

  if (activeSection === 'section-governance') {
    loadActiveVotes();
  } else if (activeSection === 'section-treasury') {
    loadTreasuryPublicView();
    loadTreasuryTransactions();
    loadTreasuryTrackerView();
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
      const iconUrl = getGuildIconUrl(record);
      brandTitle.innerHTML = iconUrl
        ? `<img src="${iconUrl}" alt="" style="width:22px;height:22px;border-radius:50%;vertical-align:middle;margin-right:8px;object-fit:cover;">${escapeHtml(record?.name || 'Portal')}`
        : `🎩 ${escapeHtml(record?.name || 'Portal')}`;
    }
  } else {
    badge.style.display = 'inline-flex';
    badge.textContent = 'Select server';
    badge.title = 'No active server selected';
    if (brandTitle) brandTitle.textContent = '🎩 Solpranos';
  }

  renderNavServerSelect();
}

function renderNavServerSelect() {
  const sel = document.getElementById('navServerSelect');
  if (!sel) return;

  const managed = serverAccessData?.managedServers || [];
  if (!userData || managed.length === 0) {
    sel.style.display = 'none';
    sel.innerHTML = '';
    return;
  }

  sel.innerHTML = managed
    .map(s => `<option value="${escapeHtml(s.guildId)}" ${s.guildId === activeGuildId ? 'selected' : ''}>${escapeHtml(s.name || s.guildId)}</option>`)
    .join('');
  sel.style.display = 'inline-block';
}

function onNavServerSelect(guildId) {
  setActiveGuild(guildId);
}

function setNavSectionVisibility(section, visible) {
  document.querySelectorAll(`[data-section="${section}"]`).forEach(el => {
    el.style.display = visible ? '' : 'none';
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
    roleclaim: !!settings.moduleRoleClaimEnabled
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

  const adminMap = {
    verificationroles: moduleState.verification,
    votingpower: moduleState.governance,
    nfttracker: moduleState.nfttracker,
    ticketing: moduleState.ticketing,
    selfserveroles: moduleState.roleclaim
  };
  Object.entries(adminMap).forEach(([view, enabled]) => {
    document.querySelectorAll(`.admin-sub-item[data-admin-nav="${view}"]`).forEach(el => {
      el.style.display = enabled ? '' : 'none';
    });
  });

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

async function syncTenantModuleNavVisibility() {
  if (!isAdmin) return;
  try {
    const res = await fetch('/api/admin/settings', { credentials: 'include', headers: activeGuildId ? { 'x-guild-id': activeGuildId } : {} });
    const data = await res.json();
    if (data.success && data.settings) {
      applyTenantModuleNavVisibility(data.settings);
    }
  } catch (e) {
    console.warn('Could not sync tenant module nav visibility:', e.message);
  }
}

function renderServerCard(server, { managed = true } = {}) {
  const isActive = server.guildId === activeGuildId;
  const badgeClass = managed ? 'managed' : 'unmanaged';
  const actionButton = managed
    ? isActive
      ? '<button class="btn-secondary" disabled style="opacity:0.65;">Active</button>'
      : `<button class="btn-primary" onclick="setActiveGuild('${server.guildId}')">Set Active</button>`
    : `<button class="btn-secondary" onclick="openGuildInvite('${server.guildId}')">Invite Bot</button>`;

  return `
    <div class="server-card">
      <div style="min-width:0;">
        <div class="server-card__title">${escapeHtml(server.name || server.guildId)}</div>
        <div class="server-card__meta">Guild ID: ${escapeHtml(server.guildId)}</div>
        <div style="margin-top:8px;">
          <span class="server-status-badge ${isActive ? 'active' : badgeClass}">
            ${isActive ? 'Active' : (managed ? 'Managed' : 'Invite needed')}
          </span>
        </div>
      </div>
      <div class="server-card__actions">
        ${actionButton}
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

    if ((!activeGuildId || !knownIds.has(activeGuildId)) && serverAccessData.managedServers.length === 1) {
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
      await checkSuperadminStatus();
      await checkAdminStatus();
      await syncTenantModuleNavVisibility();
      loadDashboardData();
    } else {
      showUnauthenticatedState();
    }

    // Navigate to section from URL after admin check is complete
    const urlParams = new URLSearchParams(window.location.search);
    const section = urlParams.get('section');
    if (section) {
      switchSection(section);
    } else if (userData) {
      // If user can manage multiple servers, force server selection first on login
      const managedCount = (serverAccessData?.managedServers || []).length;
      if (managedCount > 1) {
        switchSection('servers');
      }
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
  const navServerSelect = document.getElementById('navServerSelect');
  if (navServerSelect) navServerSelect.style.display = 'none';
  navAuthBtn.textContent = 'Login';
  navAuthBtn.onclick = login;
  navAuthBtn.classList.remove('btn-secondary');
  navAuthBtn.classList.add('btn-primary');

  document.getElementById('loginPrompt').style.display = 'block';
  document.getElementById('dashboardContent').style.display = 'none';
}

async function checkAdminStatus() {
  try {
    const response = await fetch('/api/user/is-admin', { credentials: 'include' });
    const data = await response.json();

    isAdmin = !!data.isAdmin || isSuperadmin;

    if (isAdmin) {
      document.getElementById('adminSidebarGroup').style.display = 'block';
      document.getElementById('mobileNavAdmin').style.display = 'block';
      const topNav = document.getElementById('topNavAdmin');
      if (topNav) topNav.style.display = '';

      // Load treasury data for admin
      await loadTreasuryPublicView();
    } else {
      isAdmin = false;
      document.getElementById('adminSidebarGroup').style.display = 'none';
      document.getElementById('mobileNavAdmin').style.display = 'none';

      // If user navigated directly to admin section, redirect to dashboard
      const params = new URLSearchParams(window.location.search);
      if (params.get('section') === 'admin') {
        switchSection('dashboard');
        showError('Admin access required.');
      }
    }
  } catch (error) {
    // User is not admin, keep admin nav hidden
  }
}

async function checkSuperadminStatus() {
  try {
    const response = await fetch('/api/superadmin/me', { credentials: 'include' });
    const data = await response.json();
    isSuperadmin = !!data.isSuperadmin;

    const navItem = document.getElementById('adminSuperadminNav');
    if (navItem) {
      navItem.style.display = isSuperadmin ? 'flex' : 'none';
    }

    if (!isSuperadmin) {
      const card = document.getElementById('adminSuperadminCard');
      if (card) card.style.display = 'none';
    }
  } catch (error) {
    isSuperadmin = false;
    const navItem = document.getElementById('adminSuperadminNav');
    if (navItem) navItem.style.display = 'none';
  }
}

// ==================== DATA LOADING ====================
async function loadDashboardData() {
  let governanceEnabledForTenant = true;
  let verificationEnabledForTenant = true;
  let tierConfiguredForTenant = true;

  try {
    const headers = activeGuildId ? { 'x-guild-id': activeGuildId } : {};

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
  const moduleState = window._tenantModuleState || null;
  const sectionRequiresModule = {
    governance: 'governance',
    wallets: 'verification',
    treasury: 'treasury',
    'nft-activity': 'nfttracker',
    heist: 'heist'
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
  if (sectionName === 'governance' && userData) {
    loadActiveVotes();
  } else if (sectionName === 'servers') {
    loadServerAccess();
  } else if (sectionName === 'treasury') {
    loadTreasuryPublicView();
    loadTreasuryTransactions();
    loadTreasuryTrackerView();
  } else if (sectionName === 'nft-activity') {
    loadNFTActivityView();
    if (isAdmin) loadNFTActivityAdminView();
  } else if (sectionName === 'admin') {
    loadEnvStatusBar();
  } else if (sectionName === 'heist' && userData && heistEnabled) {
    loadAvailableMissions();
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
    content.innerHTML = `<div style="color:#ef4444; text-align:center; padding:20px;">Error loading treasury: ${e.message}</div>`;
  }
  
  // Also load treasury tracker config
  loadTreasuryTrackerView();
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
  ['adminUsersCard', 'adminProposalsCard', 'adminSettingsCard', 'adminSuperadminCard', 'adminAnalyticsCard', 'adminHelpCard', 'adminRolesCard', 'adminActivityCard', 'adminStatsCard', 'adminNftTrackerCard', 'adminVotingPowerCard', 'adminSelfServeRolesCard', 'adminApiRefCard', 'adminTicketingCard']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
}

let _envStatusCache = null;
async function loadEnvStatusBar() {
  const bar = document.getElementById('adminEnvStatusBar');
  if (!bar) return;
  if (_envStatusCache) { renderEnvStatusBar(bar, _envStatusCache); return; }
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
    'superadmin',
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

  switchSection('admin');
  hideAllAdminCards();

  const map = {
    stats: { card: 'adminStatsCard', load: loadAdminStats },
    users: { card: 'adminUsersCard', load: loadAdminUsers },
    proposals: { card: 'adminProposalsCard', load: loadAdminProposals },
    settings: { card: 'adminSettingsCard', load: loadAdminSettingsView },
    superadmin: { card: 'adminSuperadminCard', load: loadSuperadminView },
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

  if (isTenantSensitiveAdminView(view) && serverAccessData.managedServers.length > 0 && !getServerRecord(activeGuildId)) {
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
  if (view === 'superadmin') {
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
      <div style="display:grid; gap:14px; grid-template-columns:minmax(0,1.2fr) minmax(0,0.8fr);">
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

      <div style="display:grid; gap:16px; grid-template-columns:minmax(0,0.8fr) minmax(0,1.2fr);">
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
        </div>
      </div>

      <div style="display:grid; gap:16px; grid-template-columns:minmax(0,1fr) minmax(0,1fr);">
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

    const tenantRows = tenantListCache.length > 0
      ? tenantListCache.map(renderTenantRow).join('')
      : `<div style="padding:18px; text-align:center; color:var(--text-secondary);">No tenants found yet. New guilds will bootstrap automatically.</div>`;

    content.innerHTML = `
      <div style="display:grid; gap:16px;">
        <div style="display:grid; gap:12px; grid-template-columns:minmax(0,1fr) auto;">
          <input id="adminSuperadminUserIdInput" type="text" placeholder="Discord ID" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; width:100%;">
          <button id="adminSuperadminAddBtn" class="btn-primary" onclick="addSuperadminFromInput()" style="padding:10px 16px;">Add</button>
        </div>

        <div style="padding:14px; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.45);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Current superadmins</h4>
            <span style="color:var(--text-secondary); font-size:0.85em;">Env roots cannot be removed</span>
          </div>
          <div style="border:1px solid rgba(99,102,241,0.15); border-radius:10px; overflow:hidden;">
            ${superadminRows}
          </div>
        </div>

        <div style="padding:14px; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.45);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Tenant Management</h4>
            <button class="btn-secondary" onclick="loadSuperadminView()" style="padding:8px 12px;">Refresh</button>
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

        <div style="padding:14px; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.45);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px;">
            <h4 style="margin:0; color:#c9d6ff;">Tenant Detail</h4>
            <span style="color:var(--text-secondary); font-size:0.85em;">Select a guild to edit plan, modules, branding, and status</span>
          </div>
          <div id="adminTenantDetailContent">${renderTenantDetailPanel(null)}</div>
        </div>
      </div>
    `;

    if (selectedTenantGuildId) {
      await loadSelectedTenantDetail();
    }
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
  } catch (error) {
    content.innerHTML = `<div style="color:#fca5a5; text-align:center; padding:20px;">Error loading tenant details: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

function selectTenantGuild(guildId) {
  selectedTenantGuildId = guildId;
  loadSuperadminView();
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
      showError(data.message || 'Failed to update tenant module');
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
      { name: '/verification admin role-config', desc: 'Configure role assignment rules (view/set tier/set trait/remove trait)', options: 'action (required), trait-type, trait-value, collection-id, role, description', example: '/verification admin role-config action:Set Tier Role' },
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
      { name: '/governance propose', desc: 'Create a new governance proposal', options: 'title, description (required)', example: '/governance propose title:"Fund project" description:"Allocate 100 SOL"' },
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

async function loadAdminSettingsView() {
  if (!isAdmin) return;
  const content = document.getElementById('adminSettingsContent');
  if (!content) return;

  content.innerHTML = `<div style="text-align:center; padding: var(--space-5); color: var(--text-secondary);"><div class="spinner"></div><p>Loading settings...</p></div>`;

  // --- Shared inline-style constants (matched to Verification Roles tab) ---
  const cardStyle = 'background:rgba(14,23,44,0.5);border:1px solid rgba(99,102,241,0.22);border-radius:10px;padding:var(--space-5);margin-bottom:var(--space-5);';
  const cardHeader = 'color:#c9d6ff;font-size:var(--font-lg);font-weight:700;margin:0 0 var(--space-4) 0;padding-bottom:var(--space-3);border-bottom:1px solid rgba(99,102,241,0.15);';
  const gridRow = 'display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);';
  const fieldLabel = 'display:block;color:#c9d6ff;font-size:0.9em;font-weight:600;margin-bottom:6px;';
  const fieldInput = 'width:100%;padding:10px 12px;border:1px solid rgba(99,102,241,0.22);border-radius:8px;background:rgba(30,41,59,0.8);color:#e0e7ff;font-size:0.9em;';
  const selectStyle = 'width:100%;padding:10px 12px;border:1px solid rgba(99,102,241,0.22);border-radius:8px;background:rgba(30,41,59,0.8);color:#e0e7ff;font-size:0.9em;';

  try {
    // Step 1: Fetch settings first
    const settingsRes = await fetch('/api/admin/settings', { credentials: 'include' });
    const settingsJson = await settingsRes.json();
    if (!settingsJson.success) throw new Error(settingsJson.message || 'Failed to load settings');
    portalSettingsData = settingsJson.settings;
    const s = portalSettingsData;
    const tenantReadOnlyModules = !!(s.multiTenantEnabled && s.readOnlyManaged && !isSuperadmin);

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

    // Attach toggle animation via event delegation (after HTML injected)
    const attachToggleListeners = () => {
      content.querySelectorAll('input[type="checkbox"][id^="ps_module"]').forEach(cb => {
        cb.addEventListener('change', function() {
          const knob = this.parentElement.querySelector('.ps-toggle-knob');
          if (knob) knob.style.left = this.checked ? '22px' : '3px';
        });
      });
    };

    // Helper: show/hide module cards based on module toggles
    const moduleMap = {
      'ps_moduleBattleEnabled': 'ps_section_battle',
      'ps_moduleGovernanceEnabled': 'ps_section_governance',
      'ps_moduleVerificationEnabled': 'ps_section_verification',
      'ps_moduleMissionsEnabled': 'ps_section_missions',
      'ps_moduleTreasuryEnabled': 'ps_section_treasury'
    };
    const updateSectionVisibility = () => {
      Object.entries(moduleMap).forEach(([toggleId, sectionId]) => {
        const cb = document.getElementById(toggleId);
        const section = document.getElementById(sectionId);
        if (cb && section) section.style.display = cb.checked ? 'block' : 'none';
      });
    };

    const noSettingsMsg = '<p style="color:var(--text-secondary);font-size:0.9em;margin:0;">No configurable settings for this module yet.</p>';
    const moduleCardBorder = 'border-left:3px solid var(--gold);';

    // Step 2: Inject HTML skeleton
    content.innerHTML = `
      <!-- ENV STATUS BAR -->
      <div id="adminEnvStatusBar" style="margin-bottom:var(--space-4);"></div>

      <!-- MODULE CONTROL — always visible -->
      <div style="${cardStyle}">
        <h3 style="${cardHeader}">🎮 Module Control</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--space-3);">
          ${moduleToggle('moduleBattleEnabled', 'Battle', '⚔️', true)}
          ${moduleToggle('moduleGovernanceEnabled', 'Governance', '🗳️', true)}
          ${moduleToggle('moduleVerificationEnabled', 'Verification', '✅', true)}
          ${moduleToggle('moduleMissionsEnabled', 'Heist', '🎯', true)}
          ${moduleToggle('moduleTreasuryEnabled', 'Treasury', '💰', true)}
          ${moduleToggle('moduleNftTrackerEnabled', 'NFT Tracker', '📡', true)}
          ${moduleToggle('moduleRoleClaimEnabled', 'Self-Serve Roles', '🎖️', true)}
          ${moduleToggle('moduleTicketingEnabled', 'Ticketing', '🎫', true)}
        </div>
      </div>

      <!-- ⚔️ BATTLE MODULE -->
      <div id="ps_section_battle" style="${cardStyle}${moduleCardBorder}display:${(s.moduleBattleEnabled ?? true) ? 'block' : 'none'};">
        <h3 style="${cardHeader}">⚔️ Battle Module</h3>
        <div style="${gridRow}">
          <div>
            <label style="${fieldLabel}">Round Pause Min (s)</label>
            <input type="number" id="ps_battleRoundPauseMinSec" min="0" max="120" step="1" value="${s.battleRoundPauseMinSec ?? 5}" style="${fieldInput}">
          </div>
          <div>
            <label style="${fieldLabel}">Round Pause Max (s)</label>
            <input type="number" id="ps_battleRoundPauseMaxSec" min="0" max="180" step="1" value="${s.battleRoundPauseMaxSec ?? 10}" style="${fieldInput}">
          </div>
        </div>
        <div style="${gridRow}margin-top:var(--space-3);">
          <div>
            <label style="${fieldLabel}">Elite Four Prep Delay (s)</label>
            <input type="number" id="ps_battleElitePrepSec" min="0" max="300" step="1" value="${s.battleElitePrepSec ?? 12}" style="${fieldInput}">
          </div>
          <div></div>
        </div>
      </div>

      <!-- 🗳️ GOVERNANCE MODULE -->
      <div id="ps_section_governance" style="${cardStyle}${moduleCardBorder}display:${(s.moduleGovernanceEnabled ?? true) ? 'block' : 'none'};">
        <h3 style="${cardHeader}">🗳️ Governance Module</h3>
        <div style="${gridRow}">
          <div>
            <label style="${fieldLabel}">Quorum Percentage (%)</label>
            <input type="number" id="ps_quorumPercentage" min="1" max="100" value="${s.quorumPercentage ?? ''}" style="${fieldInput}">
          </div>
          <div>
            <label style="${fieldLabel}">Support Threshold</label>
            <input type="number" id="ps_supportThreshold" min="1" value="${s.supportThreshold ?? ''}" style="${fieldInput}">
          </div>
        </div>
        <div style="${gridRow}margin-top:var(--space-3);">
          <div>
            <label style="${fieldLabel}">Vote Duration (Days)</label>
            <input type="number" id="ps_voteDurationDays" min="1" max="30" value="${s.voteDurationDays ?? ''}" style="${fieldInput}">
          </div>
          <div></div>
        </div>
        <h4 style="color:#c9d6ff;font-size:0.95em;font-weight:600;margin:var(--space-4) 0 var(--space-3) 0;padding-top:var(--space-3);border-top:1px solid rgba(99,102,241,0.12);">🔗 Channel Overrides</h4>
        <p style="color:var(--text-secondary);font-size:0.85em;margin-bottom:12px;">Leave empty to use .env defaults.</p>
        <div style="${gridRow}">
          <div>
            <label style="${fieldLabel}">Proposals Channel</label>
            <select id="ps_proposalsChannelId" style="${selectStyle}"><option value="">Loading channels...</option></select>
          </div>
          <div>
            <label style="${fieldLabel}">Voting Channel</label>
            <select id="ps_votingChannelId" style="${selectStyle}"><option value="">Loading channels...</option></select>
          </div>
        </div>
        <div style="${gridRow}margin-top:var(--space-3);">
          <div>
            <label style="${fieldLabel}">Results Channel</label>
            <select id="ps_resultsChannelId" style="${selectStyle}"><option value="">Loading channels...</option></select>
          </div>
          <div>
            <label style="${fieldLabel}">Governance Log Channel</label>
            <select id="ps_governanceLogChannelId" style="${selectStyle}"><option value="">Loading channels...</option></select>
          </div>
        </div>
        <p style="color:var(--text-secondary);font-size:0.85em;margin-top:var(--space-4);padding-top:var(--space-3);border-top:1px solid rgba(99,102,241,0.12);font-style:italic;">Voting Power mappings are managed in the <a href="#" onclick="event.preventDefault();showAdminView('votingpower')" style="color:#a5b4fc;text-decoration:underline;">Voting Power tab</a> &rarr;</p>
      </div>

      <!-- ✅ VERIFICATION MODULE -->
      <div id="ps_section_verification" style="${cardStyle}${moduleCardBorder}display:${(s.moduleVerificationEnabled ?? true) ? 'block' : 'none'};">
        <h3 style="${cardHeader}">✅ Verification Module</h3>
        <div>
          <label style="${fieldLabel}">Base Verified Role</label>
          <p style="color:var(--text-secondary);font-size:0.8em;margin:0 0 8px 0;">Assigned to all verified members regardless of NFT holdings</p>
          ${roleSelectHTML('ps_baseVerifiedRoleId', s.baseVerifiedRoleId || '')}
        </div>
        <div style="margin-top:var(--space-4);padding-top:var(--space-3);border-top:1px solid rgba(99,102,241,0.12);">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:var(--space-3) var(--space-4);background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;">
            <label for="ps_moduleRoleResyncEnabled" style="cursor:pointer;font-weight:500;font-size:0.9em;color:#e0e7ff;display:flex;align-items:center;gap:var(--space-2);">
              <span style="font-size:1.25em;">👥</span> Auto Role Resync
              <span style="font-size:0.8em;color:var(--text-secondary);margin-left:4px;">(periodically re-syncs holder roles)</span>
            </label>
            <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0;">
              <input type="checkbox" id="ps_moduleRoleResyncEnabled"${(s.moduleRoleResyncEnabled ?? true) ? ' checked' : ''} style="opacity:0;width:0;height:0;"
                onchange="this.parentElement.querySelector('span').style.background=this.checked?'var(--gold)':'#555';">
              <span style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${(s.moduleRoleResyncEnabled ?? true) ? 'var(--gold)' : '#555'};border-radius:24px;transition:.3s;"></span>
              <span style="position:absolute;content:'';height:18px;width:18px;left:${(s.moduleRoleResyncEnabled ?? true) ? '22px' : '3px'};bottom:3px;background:#fff;border-radius:50%;transition:.3s;pointer-events:none;"
                class="ps-toggle-knob"></span>
            </label>
          </div>
        </div>

        <!-- Micro-Transfer Verification (inline subsection) -->
        <div style="margin-top:var(--space-4);padding-top:var(--space-3);border-top:1px solid rgba(99,102,241,0.12);">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:var(--space-3) var(--space-4);background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.22);border-radius:8px;">
            <label for="ps_moduleMicroVerifyEnabled" style="cursor:pointer;font-weight:500;font-size:0.9em;color:#e0e7ff;display:flex;align-items:center;gap:var(--space-2);">
              <span style="font-size:1.25em;">🔐</span> Enable Micro-Transfer Verification
            </label>
            <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0;">
              <input type="checkbox" id="ps_moduleMicroVerifyEnabled"${(s.moduleMicroVerifyEnabled ?? false) ? ' checked' : ''} style="opacity:0;width:0;height:0;"
                onchange="this.parentElement.querySelector('span').style.background=this.checked?'var(--gold)':'#555';document.getElementById('microVerifySubFields').style.display=this.checked?'block':'none';">
              <span style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${(s.moduleMicroVerifyEnabled ?? false) ? 'var(--gold)' : '#555'};border-radius:24px;transition:.3s;"></span>
              <span style="position:absolute;content:'';height:18px;width:18px;left:${(s.moduleMicroVerifyEnabled ?? false) ? '22px' : '3px'};bottom:3px;background:#fff;border-radius:50%;transition:.3s;pointer-events:none;"
                class="ps-toggle-knob"></span>
            </label>
          </div>
          <div id="microVerifySubFields" style="display:${(s.moduleMicroVerifyEnabled ?? false) ? 'block' : 'none'};margin-top:var(--space-3);padding:var(--space-3);background:rgba(30,41,59,0.4);border-radius:8px;border:1px solid rgba(99,102,241,0.12);">
            <div style="${gridRow}">
              <div>
                <label style="${fieldLabel}">Verification Receive Wallet</label>
                <input type="text" id="ps_verificationReceiveWallet" placeholder="Solana wallet address" value="${escapeHtml(s.verificationReceiveWallet ?? '')}" style="${fieldInput}">
              </div>
              <div>
                <label style="${fieldLabel}">NFT Activity Webhook Secret</label>
                <input type="text" id="ps_nftActivityWebhookSecret" placeholder="Optional shared secret" value="${escapeHtml(s.nftActivityWebhookSecret ?? '')}" style="${fieldInput}">
              </div>
            </div>
            <div style="${gridRow}margin-top:var(--space-3);">
              <div>
                <label style="${fieldLabel}">Verify Request TTL (minutes)</label>
                <input type="number" id="ps_verifyRequestTtlMinutes" min="1" max="1440" value="${s.verifyRequestTtlMinutes ?? 15}" style="${fieldInput}">
              </div>
              <div>
                <label style="${fieldLabel}">Poll Interval (seconds)</label>
                <input type="number" id="ps_pollIntervalSeconds" min="5" max="300" value="${s.pollIntervalSeconds ?? 30}" style="${fieldInput}">
              </div>
            </div>
            <div style="${gridRow}margin-top:var(--space-3);">
              <div>
                <label style="${fieldLabel}">Verify Rate Limit (minutes)</label>
                <input type="number" id="ps_verifyRateLimitMinutes" min="1" max="60" value="${s.verifyRateLimitMinutes ?? 5}" style="${fieldInput}">
              </div>
              <div>
                <label style="${fieldLabel}">Max Pending Per User</label>
                <input type="number" id="ps_maxPendingPerUser" min="1" max="10" value="${s.maxPendingPerUser ?? 1}" style="${fieldInput}">
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 🎯 HEIST MODULE -->
      <div id="ps_section_missions" style="${cardStyle}${moduleCardBorder}display:${(s.moduleMissionsEnabled ?? true) ? 'block' : 'none'};">
        <h3 style="${cardHeader}">🎯 Heist Module</h3>
        ${noSettingsMsg}
      </div>

      <!-- 💰 TREASURY MODULE -->
      <div id="ps_section_treasury" style="${cardStyle}${moduleCardBorder}display:${(s.moduleTreasuryEnabled ?? true) ? 'block' : 'none'};">
        <h3 style="${cardHeader}">💰 Treasury Module</h3>
        <div id="treasuryConfigLoading" style="color:var(--text-secondary);font-size:0.9em;">Loading treasury config...</div>
        <div id="treasuryConfigForm" style="display:none;">
          <div style="${gridRow}">
            <div>
              <label style="${fieldLabel}">Solana Wallet Address</label>
              <input type="text" id="treasuryWalletInput" placeholder="Solana wallet address to monitor" style="${fieldInput}">
            </div>
            <div>
              <label style="${fieldLabel}">Balance refresh every X hours</label>
              <input type="number" id="treasuryRefreshHours" min="1" max="168" value="6" style="${fieldInput}">
            </div>
          </div>
          <div style="margin-top:var(--space-3);">
            <label style="${fieldLabel}">Treasury Watch Channel</label>
            <select id="treasuryWatchChannelId" style="${selectStyle}"><option value="">Loading channels...</option></select>
            <div style="color:var(--text-secondary);font-size:0.78em;margin-top:4px;">Post a live treasury panel embed to this channel. Updates on every balance refresh.</div>
          </div>
          <div style="margin-top:var(--space-3);">
            <label style="display:flex;align-items:center;gap:8px;color:#c9d6ff;font-size:0.9em;font-weight:600;cursor:pointer;">
              <input type="checkbox" id="treasuryTxAlerts"> Transaction Alerts — enable tx monitoring
            </label>
          </div>
          <div id="treasuryTxAlertSubFields" style="display:none;margin-top:var(--space-3);padding:var(--space-3);background:rgba(30,41,59,0.4);border-radius:8px;border:1px solid rgba(99,102,241,0.12);">
            <div style="${gridRow}">
              <div>
                <label style="${fieldLabel}">Alert Channel</label>
                <select id="treasuryAlertChannelId" style="${selectStyle}"><option value="">Loading channels...</option></select>
              </div>
              <div>
                <label style="${fieldLabel}">Min SOL to alert on</label>
                <input type="number" id="treasuryMinSol" min="0" step="0.1" value="0" style="${fieldInput}">
              </div>
            </div>
            <div style="margin-top:var(--space-3);">
              <label style="display:flex;align-items:center;gap:8px;color:#c9d6ff;font-size:0.9em;font-weight:600;cursor:pointer;">
                <input type="checkbox" id="treasuryIncomingOnly"> Incoming Only — only alert on received SOL
              </label>
            </div>
          </div>
          <div style="margin-top:var(--space-4);display:flex;align-items:center;gap:var(--space-3);">
            <!-- Treasury settings saved via global Save Settings button below -->
            <span id="treasuryFeedback" style="font-size:0.85em;font-weight:600;"></span>
          </div>
        </div>
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

    // Populate base verified role dropdown
    populateRoleSelect('ps_baseVerifiedRoleId', s.baseVerifiedRoleId || '').then(() => {
      const sel = document.getElementById('ps_baseVerifiedRoleId');
      if (sel && sel.options.length > 0) sel.options[0].textContent = '-- None (disabled) --';
    });

    // Load VP mappings UI in governance card
    populateRoleSelect('vpMappingRoleSelect', '');
    loadVPMappings();

    // Step 3b: Wire ALL module toggles to show/hide their related settings cards
    Object.keys(moduleMap).forEach(id => {
      const cb = document.getElementById(id);
      if (cb) cb.addEventListener('change', updateSectionVisibility);
    });

    // Step 4: Fetch channels AFTER skeleton is in the DOM, then populate selects
    const channelIds = ['proposalsChannelId', 'votingChannelId', 'resultsChannelId', 'governanceLogChannelId'];
    let channelsList = [];
    // Verify selects exist in DOM before fetch
    channelIds.forEach(id => {
      const sel = document.getElementById(`ps_${id}`);
      console.log(`[Settings] Channel select ps_${id} in DOM:`, !!sel);
    });
    try {
      console.log('[Settings] Fetching /api/admin/discord/channels...');
      const channelsRes = await fetch('/api/admin/discord/channels', { credentials: 'include' });
      console.log('[Settings] Channels response status:', channelsRes.status, channelsRes.ok);
      if (channelsRes.ok) {
        const channelsJson = await channelsRes.json();
        console.log('[Settings] Channels response:', channelsJson.success, 'count:', (channelsJson.channels || []).length);
        if (channelsJson.success) channelsList = channelsJson.channels || [];
      } else {
        console.error('[Settings] Channels fetch failed with status:', channelsRes.status);
      }

      if (channelsList.length === 0) {
        console.warn('[Settings] No channels returned from API');
        channelIds.forEach(id => {
          const sel = document.getElementById(`ps_${id}`);
          if (sel) sel.innerHTML = '<option value="">-- No channels available --</option>';
        });
      }

      // Group channels by parent category (skip if empty)
      const grouped = {};
      channelsList.forEach(ch => {
        const parent = ch.parentName || 'Other';
        if (!grouped[parent]) grouped[parent] = [];
        grouped[parent].push(ch);
      });
      console.log('[Settings] Channel groups:', Object.keys(grouped).length, 'categories');

      // Populate each select element that exists in the DOM
      channelIds.forEach(id => {
        const sel = document.getElementById(`ps_${id}`);
        if (!sel) {
          console.error(`[Settings] Select element ps_${id} not found in DOM during population`);
          return;
        }
        sel.innerHTML = '<option value="">-- Use .env default --</option>';
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
        // Set selected value AFTER all options are in the DOM
        if (s[id]) {
          sel.value = s[id];
          console.log(`[Settings] Set ps_${id} selected value:`, s[id], '-> matched:', sel.value === s[id]);
        }
      });
      console.log('[Settings] Channel dropdowns populated successfully');
    } catch (chErr) {
      console.error('[Settings] Failed to load channels:', chErr);
      channelIds.forEach(id => {
        const sel = document.getElementById(`ps_${id}`);
        if (sel) sel.innerHTML = '<option value="">-- Channel load failed --</option>';
      });
    }

    // Step 5: Load Treasury config and wire up its form
    try {
      const treasuryRes = await fetch('/api/admin/treasury', { credentials: 'include' });
      if (treasuryRes.ok) {
        const treasuryData = await treasuryRes.json();
        const tc = treasuryData.config || treasuryData;

        // Populate form fields
        const walletInput = document.getElementById('treasuryWalletInput');
        const refreshInput = document.getElementById('treasuryRefreshHours');
        const txAlertsCheck = document.getElementById('treasuryTxAlerts');
        const alertChannelSel = document.getElementById('treasuryAlertChannelId');
        const incomingOnlyCheck = document.getElementById('treasuryIncomingOnly');
        const minSolInput = document.getElementById('treasuryMinSol');
        const subFields = document.getElementById('treasuryTxAlertSubFields');

        if (walletInput) walletInput.value = tc.solanaWallet || '';
        if (refreshInput) refreshInput.value = tc.refreshHours ?? 6;
        if (txAlertsCheck) txAlertsCheck.checked = !!tc.txAlertsEnabled;
        if (incomingOnlyCheck) incomingOnlyCheck.checked = !!tc.txAlertIncomingOnly;
        if (minSolInput) minSolInput.value = tc.txAlertMinSol ?? 0;

        // Show/hide tx alert sub-fields
        if (subFields) subFields.style.display = txAlertsCheck && txAlertsCheck.checked ? 'block' : 'none';
        if (txAlertsCheck) {
          txAlertsCheck.addEventListener('change', () => {
            if (subFields) subFields.style.display = txAlertsCheck.checked ? 'block' : 'none';
          });
        }

        // Populate treasury alert channel dropdown using already-fetched channelsList
        if (alertChannelSel && channelsList.length > 0) {
          const tGrouped = {};
          channelsList.forEach(ch => {
            const parent = ch.parentName || 'Other';
            if (!tGrouped[parent]) tGrouped[parent] = [];
            tGrouped[parent].push(ch);
          });
          alertChannelSel.innerHTML = '<option value="">-- Select channel --</option>';
          Object.keys(tGrouped).sort().forEach(parent => {
            const optgroup = document.createElement('optgroup');
            optgroup.label = parent;
            tGrouped[parent].forEach(ch => {
              const opt = document.createElement('option');
              opt.value = ch.id;
              opt.textContent = '# ' + ch.name;
              optgroup.appendChild(opt);
            });
            alertChannelSel.appendChild(optgroup);
          });
          if (tc.txAlertChannelId) alertChannelSel.value = tc.txAlertChannelId;
        } else if (alertChannelSel) {
          alertChannelSel.innerHTML = '<option value="">-- No channels available --</option>';
        }

        // Populate watch channel dropdown
        const watchChannelSel = document.getElementById('treasuryWatchChannelId');
        if (watchChannelSel && channelsList.length > 0) {
          const wGrouped = {};
          channelsList.forEach(ch => {
            const parent = ch.parentName || 'Other';
            if (!wGrouped[parent]) wGrouped[parent] = [];
            wGrouped[parent].push(ch);
          });
          watchChannelSel.innerHTML = '<option value="">-- None (disabled) --</option>';
          Object.keys(wGrouped).sort().forEach(parent => {
            const optgroup = document.createElement('optgroup');
            optgroup.label = parent;
            wGrouped[parent].forEach(ch => {
              const opt = document.createElement('option');
              opt.value = ch.id;
              opt.textContent = '# ' + ch.name;
              optgroup.appendChild(opt);
            });
            watchChannelSel.appendChild(optgroup);
          });
          if (tc.watchChannelId) watchChannelSel.value = tc.watchChannelId;
        } else if (watchChannelSel) {
          watchChannelSel.innerHTML = '<option value="">-- No channels available --</option>';
        }

        // Show form, hide loading
        const configForm = document.getElementById('treasuryConfigForm');
        const configLoading = document.getElementById('treasuryConfigLoading');
        if (configForm) configForm.style.display = 'block';
        if (configLoading) configLoading.style.display = 'none';

        // Save button handler
        const saveBtn = document.getElementById('treasurySaveBtn');
        if (saveBtn) {
          saveBtn.addEventListener('click', async () => {
            const feedback = document.getElementById('treasuryFeedback');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
            try {
              const payload = {
                enabled: true,
                solanaWallet: (document.getElementById('treasuryWalletInput')?.value || '').trim(),
                refreshHours: parseInt(document.getElementById('treasuryRefreshHours')?.value) || 6,
                txAlertsEnabled: !!document.getElementById('treasuryTxAlerts')?.checked,
                txAlertChannelId: document.getElementById('treasuryAlertChannelId')?.value || '',
                txAlertIncomingOnly: !!document.getElementById('treasuryIncomingOnly')?.checked,
                txAlertMinSol: parseFloat(document.getElementById('treasuryMinSol')?.value) || 0,
                watchChannelId: document.getElementById('treasuryWatchChannelId')?.value || ''
              };
              const saveRes = await fetch('/api/admin/treasury/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
              });
              const saveData = await saveRes.json();
              if (saveRes.ok && saveData.success !== false) {
                if (feedback) {
                  feedback.style.color = '#86efac';
                  feedback.textContent = payload.watchChannelId ? '✓ Treasury settings saved. Watch panel posted to channel.' : '✓ Treasury settings saved!';
                  setTimeout(() => { feedback.textContent = ''; }, 5000);
                }
              } else {
                if (feedback) {
                  feedback.style.color = '#fca5a5';
                  feedback.textContent = saveData.message || 'Failed to save treasury settings';
                  setTimeout(() => { feedback.textContent = ''; }, 8000);
                }
              }
            } catch (saveErr) {
              console.error('[Treasury] Save error:', saveErr);
              if (feedback) {
                feedback.style.color = '#fca5a5';
                feedback.textContent = 'Network error saving treasury settings';
                setTimeout(() => { feedback.textContent = ''; }, 8000);
              }
            } finally {
              saveBtn.disabled = false;
              saveBtn.textContent = '💾 Save Treasury Settings';
            }
          });
        }
      } else {
        console.warn('[Settings] Treasury config fetch failed:', treasuryRes.status);
        const configLoading = document.getElementById('treasuryConfigLoading');
        if (configLoading) configLoading.textContent = 'Failed to load treasury config.';
      }
    } catch (tErr) {
      console.error('[Settings] Treasury config error:', tErr);
      const configLoading = document.getElementById('treasuryConfigLoading');
      if (configLoading) configLoading.textContent = 'Error loading treasury config.';
    }

    // NFT tracker is now in its own tab — see loadNftTrackerView()
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

  const battleRoundPauseMinSec = parseInt(document.getElementById('ps_battleRoundPauseMinSec').value);
  const battleRoundPauseMaxSec = parseInt(document.getElementById('ps_battleRoundPauseMaxSec').value);
  const battleElitePrepSec = parseInt(document.getElementById('ps_battleElitePrepSec').value);

  if (Number.isFinite(battleRoundPauseMinSec) && Number.isFinite(battleRoundPauseMaxSec) && battleRoundPauseMinSec > battleRoundPauseMaxSec) {
    return showError('Round Pause Min cannot be greater than Round Pause Max');
  }

  const newSettings = {
    quorumPercentage: parseFloat(document.getElementById('ps_quorumPercentage').value),
    supportThreshold: parseInt(document.getElementById('ps_supportThreshold').value),
    voteDurationDays: parseInt(document.getElementById('ps_voteDurationDays').value),
    battleRoundPauseMinSec,
    battleRoundPauseMaxSec,
    battleElitePrepSec,
    moduleBattleEnabled: document.getElementById('ps_moduleBattleEnabled').checked,
    moduleGovernanceEnabled: document.getElementById('ps_moduleGovernanceEnabled').checked,
    moduleVerificationEnabled: document.getElementById('ps_moduleVerificationEnabled').checked,
    moduleMissionsEnabled: document.getElementById('ps_moduleMissionsEnabled').checked,
    moduleTreasuryEnabled: document.getElementById('ps_moduleTreasuryEnabled').checked,
    moduleNftTrackerEnabled: document.getElementById('ps_moduleNftTrackerEnabled')?.checked ?? true,
    moduleRoleResyncEnabled: document.getElementById('ps_moduleRoleResyncEnabled')?.checked ?? true,
    moduleMicroVerifyEnabled: document.getElementById('ps_moduleMicroVerifyEnabled')?.checked ?? false,
    moduleRoleClaimEnabled: document.getElementById('ps_moduleRoleClaimEnabled')?.checked ?? true,
    moduleTicketingEnabled: document.getElementById('ps_moduleTicketingEnabled')?.checked ?? true,
    proposalsChannelId: document.getElementById('ps_proposalsChannelId').value || '',
    votingChannelId: document.getElementById('ps_votingChannelId').value || '',
    resultsChannelId: document.getElementById('ps_resultsChannelId').value || '',
    governanceLogChannelId: document.getElementById('ps_governanceLogChannelId').value || '',
    verificationReceiveWallet: document.getElementById('ps_verificationReceiveWallet').value.trim() || '',
    nftActivityWebhookSecret: document.getElementById('ps_nftActivityWebhookSecret').value.trim() || '',
    verifyRequestTtlMinutes: parseInt(document.getElementById('ps_verifyRequestTtlMinutes').value),
    pollIntervalSeconds: parseInt(document.getElementById('ps_pollIntervalSeconds').value),
    verifyRateLimitMinutes: parseInt(document.getElementById('ps_verifyRateLimitMinutes').value),
    maxPendingPerUser: parseInt(document.getElementById('ps_maxPendingPerUser').value),
    baseVerifiedRoleId: document.getElementById('ps_baseVerifiedRoleId').value || ''
  };

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

    // Also save treasury-specific config (separate API)
    const treasuryPayload = {
      enabled: document.getElementById('ps_moduleTreasuryEnabled')?.checked ?? true,
      solanaWallet: (document.getElementById('treasuryWalletInput')?.value || '').trim(),
      refreshHours: parseInt(document.getElementById('treasuryRefreshHours')?.value) || 6,
      txAlertsEnabled: !!document.getElementById('treasuryTxAlerts')?.checked,
      txAlertChannelId: document.getElementById('treasuryAlertChannelId')?.value || '',
      txAlertIncomingOnly: !!document.getElementById('treasuryIncomingOnly')?.checked,
      txAlertMinSol: parseFloat(document.getElementById('treasuryMinSol')?.value) || 0,
      watchChannelId: document.getElementById('treasuryWatchChannelId')?.value || ''
    };
    if (treasuryPayload.solanaWallet || treasuryPayload.txAlertChannelId || treasuryPayload.watchChannelId) {
      await fetch('/api/admin/treasury/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(treasuryPayload)
      });
    }

    showSettingsSuccess('Settings saved successfully!');
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
          <td style="padding:8px 10px;"><button class="btn-danger nft-remove-btn" data-id="${c.id}" style="font-size:0.8em;padding:4px 10px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;">Remove</button></td>
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
          trackTransfer: !!document.getElementById('nftAddTransfer')?.checked
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

    content.innerHTML = `
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

    let html = '';

    // === TIERS SECTION ===
    html += `<h4 style="color:#c9d6ff; margin-bottom:8px;">🏆 NFT Holder Tiers</h4>`;
    html += `<p style="color:var(--text-secondary); font-size:0.85em; margin-bottom:12px;">Define tier levels based on how many NFTs a holder owns. Each tier grants a Discord role.</p>`;
    if (tiers.length === 0) {
      html += `<div style="padding:16px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.15); border-radius:10px; color:var(--text-secondary); margin-bottom:20px;">No tiers configured. Click "➕ Add Tier" to create one.</div>`;
    } else {
      const tierRows = tiers.map((tier, idx) => `
        <tr>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#e0e7ff; font-weight:600;">${escapeHtml(tier.name)}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#a5b4fc; font-family:monospace; font-size:0.82em;">${escapeHtml(tier.collectionId || tier.collection_id || '—')}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#c7d2fe;">${tier.minNFTs}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#c7d2fe;">${tier.maxNFTs === Infinity || tier.maxNFTs >= 999999 ? '∞' : tier.maxNFTs}</td>

          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#93c5fd; font-family:monospace; font-size:0.85em;">${escapeHtml(tier.roleId || 'Not set')}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); text-align:right;">
            <button onclick="editTier(${idx})" style="width:32px; height:32px; background:rgba(99,102,241,0.2); border:1px solid rgba(99,102,241,0.35); border-radius:6px; cursor:pointer; color:#818cf8; font-size:0.9em;">✏️</button>
            <button onclick="deleteTier(${idx})" style="width:32px; height:32px; background:rgba(239,68,68,0.2); border:1px solid rgba(239,68,68,0.35); border-radius:6px; cursor:pointer; color:#fca5a5; font-size:0.9em; margin-left:4px;">🗑️</button>
          </td>
        </tr>
      `).join('');
      html += `
        <div style="overflow:auto; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.5); margin-bottom:20px;">
          <table style="width:100%; border-collapse:collapse; font-size:0.9em;">
            <thead><tr style="background:rgba(99,102,241,0.12); text-align:left;">
              <th style="padding:10px; color:#c9d6ff;">Tier Name</th>
              <th style="padding:10px; color:#c9d6ff;">Collection ID</th>
              <th style="padding:10px; color:#c9d6ff;">Min NFTs</th>
              <th style="padding:10px; color:#c9d6ff;">Max NFTs</th>
              <th style="padding:10px; color:#c9d6ff;">Discord Role</th>
              <th style="padding:10px; color:#c9d6ff; text-align:right;">Actions</th>
            </tr></thead>
            <tbody>${tierRows}</tbody>
          </table>
        </div>`;
    }
    html += `<button class="btn-primary" onclick="openAddTierModal()" style="font-size:0.85em; padding:8px 16px; margin-bottom:24px;">➕ Add Tier</button>`;

    // === TRAIT RULES SECTION ===
    html += `<h4 style="color:#c9d6ff; margin:20px 0 8px;">🎭 Trait-Based Roles</h4>`;
    html += `<p style="color:var(--text-secondary); font-size:0.85em; margin-bottom:12px;">Assign Discord roles automatically based on specific NFT traits (e.g. "Background: Gold" → Gold Role).</p>`;
    if (traitRoles.length === 0) {
      html += `<div style="padding:16px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.15); border-radius:10px; color:var(--text-secondary); margin-bottom:20px;">No trait rules configured. Click "➕ Add Trait Rule" to create one.</div>`;
    } else {
      const traitRows = traitRoles.map((tr, idx) => `
        <tr>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#e0e7ff; font-weight:600;">${escapeHtml(tr.traitType || tr.trait_type || '')}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#c7d2fe;">${escapeHtml(tr.traitValue || tr.trait_value || '')}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#a5b4fc; font-family:monospace; font-size:0.85em;">${escapeHtml(tr.collectionId || tr.trait_collection_id || '—')}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#93c5fd; font-family:monospace; font-size:0.85em;">${escapeHtml(tr.roleId || '')}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:var(--text-secondary); font-size:0.85em;">${escapeHtml(tr.description || '—')}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); text-align:right;">
            <button onclick="editTraitRule(${idx})" style="width:32px; height:32px; background:rgba(99,102,241,0.2); border:1px solid rgba(99,102,241,0.35); border-radius:6px; cursor:pointer; color:#818cf8; font-size:0.9em;">✏️</button>
            <button onclick="deleteTraitRule(${idx})" style="width:32px; height:32px; background:rgba(239,68,68,0.2); border:1px solid rgba(239,68,68,0.35); border-radius:6px; cursor:pointer; color:#fca5a5; font-size:0.9em; margin-left:4px;">🗑️</button>
          </td>
        </tr>
      `).join('');
      html += `
        <div style="overflow:auto; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.5); margin-bottom:20px;">
          <table style="width:100%; border-collapse:collapse; font-size:0.9em;">
            <thead><tr style="background:rgba(99,102,241,0.12); text-align:left;">
              <th style="padding:10px; color:#c9d6ff;">Trait Type</th>
              <th style="padding:10px; color:#c9d6ff;">Trait Value</th>
              <th style="padding:10px; color:#c9d6ff;">Collection</th>
              <th style="padding:10px; color:#c9d6ff;">Discord Role ID</th>
              <th style="padding:10px; color:#c9d6ff;">Description</th>
              <th style="padding:10px; color:#c9d6ff; text-align:right;">Actions</th>
            </tr></thead>
            <tbody>${traitRows}</tbody>
          </table>
        </div>`;
    }
    html += `<button class="btn-primary" onclick="openAddTraitModal()" style="font-size:0.85em; padding:8px 16px;">➕ Add Trait Rule</button>`;

    html += `<div style="margin-top:16px; color:var(--text-secondary); font-size:0.9em;">Showing ${tiers.length} tier(s) and ${traitRoles.length} trait rule(s)</div>`;

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div class="error-state"><div class="error-message">${escapeHtml(e.message)}</div></div>`;
  }
}

// ==================== TIER CRUD ====================
function openAddTierModal() {
  if (!isAdmin) return;
  showConfirmModal('Add Tier', '', null);
  const title = document.getElementById('confirmTitle');
  const body = document.getElementById('confirmMessage');
  const btn = document.getElementById('confirmButton');
  title.textContent = '🏆 Add NFT Tier';
  btn.textContent = 'Create Tier';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-primary');
  body.innerHTML = tierFormHTML();
  setTimeout(() => populateRoleSelect('tierRoleIdInput', ''), 0);
  confirmCallback = () => saveTierFromForm('add');
}

function editTier(idx) {
  if (!isAdmin || !adminTiersCache[idx]) return;
  const tier = adminTiersCache[idx];
  showConfirmModal('Edit Tier', '', null);
  const title = document.getElementById('confirmTitle');
  const body = document.getElementById('confirmMessage');
  const btn = document.getElementById('confirmButton');
  title.textContent = '✏️ Edit Tier: ' + escapeHtml(tier.name);
  btn.textContent = 'Save Changes';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-primary');
  body.innerHTML = tierFormHTML(tier);
  setTimeout(() => populateRoleSelect('tierRoleIdInput', tier.roleId || ''), 0);
  body.dataset.editName = tier.name;
  confirmCallback = () => saveTierFromForm('edit', tier.name);
}

function tierFormHTML(tier = {}) {
  return `
    <div style="display:grid; gap:14px;">
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Tier Name *</label>
        <input id="tierNameInput" type="text" value="${escapeHtml(tier.name || '')}" placeholder="e.g. Whale, Diamond" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;"></div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Minimum NFT count *</label>
          <input id="tierMinInput" type="number" value="${tier.minNFTs ?? ''}" min="0" placeholder="1" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;"></div>
        <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Maximum NFT count</label>
          <input id="tierMaxInput" type="number" value="${tier.maxNFTs >= 999999 ? '' : (tier.maxNFTs ?? '')}" min="0" placeholder="∞ (leave blank for unlimited)" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;"></div>
      </div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Collection ID <span style="color:#f87171; font-size:0.85em;">*</span></label>
        <input id="tierCollectionInput" type="text" value="${escapeHtml(tier.collectionId || tier.collection_id || '')}" placeholder="Solana collection address" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;" required>
        <div id="tierCollectionError" style="color:#f87171; font-size:0.82em; margin-top:4px; display:none;">Collection ID is required</div></div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Discord Role (optional)</label>
        ${roleSelectHTML('tierRoleIdInput', tier.roleId || '')}</div>
    </div>`;
}

async function saveTierFromForm(mode, originalName) {
  const name = document.getElementById('tierNameInput')?.value.trim();
  const minNFTs = parseInt(document.getElementById('tierMinInput')?.value);
  const maxNFTs = document.getElementById('tierMaxInput')?.value.trim() === '' ? 999999 : parseInt(document.getElementById('tierMaxInput')?.value);
  const collectionId = document.getElementById('tierCollectionInput')?.value.trim();
  const roleId = document.getElementById('tierRoleIdInput')?.value || null;

  if (!collectionId) {
    const errEl = document.getElementById('tierCollectionError');
    if (errEl) errEl.style.display = 'block';
    return;
  }

  if (!name || isNaN(minNFTs)) {
    showError('Please fill in tier name and minimum NFT count');
    return;
  }

  try {
    let url, method, body;
    if (mode === 'add') {
      url = '/api/admin/roles/tiers';
      method = 'POST';
      body = { name, minNFTs, maxNFTs, roleId, collectionId };
    } else {
      url = `/api/admin/roles/tiers/${encodeURIComponent(originalName)}`;
      method = 'PUT';
      body = { name, minNFTs, maxNFTs, roleId, collectionId };
    }

    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (data.success) {
      showSuccess(`Tier "${name}" ${mode === 'add' ? 'created' : 'updated'} successfully`);
      await loadAdminRoles();
    } else {
      showError(data.message || `Failed to ${mode} tier`);
    }
  } catch (e) {
    showError('Error saving tier: ' + e.message);
  }
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

// ==================== TRAIT RULE CRUD ====================
function openAddTraitModal() {
  if (!isAdmin) return;
  showConfirmModal('Add Trait Rule', '', null);
  const title = document.getElementById('confirmTitle');
  const body = document.getElementById('confirmMessage');
  const btn = document.getElementById('confirmButton');
  title.textContent = '🎭 Add Trait Rule';
  btn.textContent = 'Create Rule';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-primary');
  body.innerHTML = traitFormHTML();
  setTimeout(() => populateRoleSelect('traitRoleIdInput', ''), 0);
  confirmCallback = () => saveTraitFromForm('add');
}

function editTraitRule(idx) {
  if (!isAdmin || !adminTraitsCache[idx]) return;
  const tr = adminTraitsCache[idx];
  showConfirmModal('Edit Trait Rule', '', null);
  const title = document.getElementById('confirmTitle');
  const body = document.getElementById('confirmMessage');
  const btn = document.getElementById('confirmButton');
  title.textContent = '✏️ Edit Trait Rule';
  btn.textContent = 'Save Changes';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-primary');
  body.innerHTML = traitFormHTML(tr);
  setTimeout(() => populateRoleSelect('traitRoleIdInput', tr.roleId || ''), 0);
  body.dataset.editType = tr.traitType || tr.trait_type;
  body.dataset.editValue = tr.traitValue || tr.trait_value;
  confirmCallback = () => saveTraitFromForm('edit', tr.traitType || tr.trait_type, tr.traitValue || tr.trait_value);
}

function traitFormHTML(tr = {}) {
  return `
    <div style="display:grid; gap:14px;">
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Trait Type *</label>
        <input id="traitTypeInput" type="text" value="${escapeHtml(tr.traitType || tr.trait_type || '')}" placeholder="e.g. Role, Background, Accessory" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;"></div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Trait Value *</label>
        <input id="traitValueInput" type="text" value="${escapeHtml(tr.traitValue || tr.trait_value || '')}" placeholder="e.g. Hitman, Gold Chain" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;"></div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Collection ID (optional)</label>
        <input id="traitCollectionInput" type="text" value="${escapeHtml(tr.collectionId || tr.trait_collection_id || '')}" placeholder="Required — Solana collection address" required style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;">
        <div id="traitCollectionError" style="color:#fca5a5; font-size:0.8em; margin-top:4px; display:none;">Collection ID is required</div></div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Discord Role *</label>
        ${roleSelectHTML('traitRoleIdInput', tr.roleId || '')}</div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Description (optional)</label>
        <input id="traitDescInput" type="text" value="${escapeHtml(tr.description || '')}" placeholder="e.g. Assigned to Hitman trait holders" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;"></div>
    </div>`;
}

async function saveTraitFromForm(mode, origType, origValue) {
  const traitType = document.getElementById('traitTypeInput')?.value.trim();
  const traitValue = document.getElementById('traitValueInput')?.value.trim();
  const roleId = document.getElementById('traitRoleIdInput')?.value;
  const collectionId = document.getElementById('traitCollectionInput')?.value.trim() || '';
  const description = document.getElementById('traitDescInput')?.value.trim() || null;

  if (!collectionId) {
    const errEl = document.getElementById('traitCollectionError');
    if (errEl) errEl.style.display = 'block';
    showError('Collection ID is required');
    return;
  }

  if (!traitType || !traitValue || !roleId) {
    showError('Please fill in trait type, value, and role ID');
    return;
  }

  try {
    let url, method;
    if (mode === 'add') {
      url = '/api/admin/roles/traits';
      method = 'POST';
    } else {
      url = `/api/admin/roles/traits/${encodeURIComponent(origType)}/${encodeURIComponent(origValue)}`;
      method = 'PUT';
    }

    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ traitType, traitValue, roleId, collectionId, description })
    });
    const data = await response.json();
    if (data.success) {
      showSuccess(`Trait rule ${mode === 'add' ? 'created' : 'updated'} successfully`);
      await loadAdminRoles();
    } else {
      showError(data.message || `Failed to ${mode} trait rule`);
    }
  } catch (e) {
    showError('Error saving trait rule: ' + e.message);
  }
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
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Refresh Interval (e.g. 5m, 1h)</label>
        <input id="treasuryIntervalInput" type="text" placeholder="5m" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;"></div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Alert Channel ID</label>
        <input id="treasuryAlertChannelInput" type="text" placeholder="Discord channel ID for alerts" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; font-family:monospace;"></div>
      <div><label style="display:flex; align-items:center; gap:8px; color:#c9d6ff;">
        <input id="treasuryAlertsEnabledInput" type="checkbox" style="width:18px; height:18px;">
        <span>Enable transaction alerts</span>
      </label></div>
    </div>
    <p style="color:var(--text-secondary); font-size:0.8em; margin-top:12px;">💡 These settings are also configurable via Discord: /treasury admin set-wallet, set-interval, tx-alerts</p>
  `;
  confirmCallback = async () => {
    const wallet = document.getElementById('treasuryWalletInput')?.value.trim();
    const interval = document.getElementById('treasuryIntervalInput')?.value.trim();
    const alertChannel = document.getElementById('treasuryAlertChannelInput')?.value.trim();
    const alertsEnabled = document.getElementById('treasuryAlertsEnabledInput')?.checked;
    try {
      // Use the verification admin endpoint to relay commands
      const commands = [];
      if (wallet) commands.push(fetch('/api/admin/treasury/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ wallet, interval, alertChannel, alertsEnabled }) }));
      
      if (commands.length > 0) await Promise.all(commands);
      showSuccess('Treasury config updated. Changes may take a moment to apply.');
      loadTreasuryTrackerView();
    } catch (e) {
      showError('Error updating config: ' + e.message);
    }
  };
}

// ==================== NFT ACTIVITY TRACKER ====================
async function loadNFTActivityView() {
  const content = document.getElementById('nftActivityPublicView');
  if (!content) return;

  content.innerHTML = `<div style="text-align:center; padding: var(--space-5);"><div class="spinner"></div><p>Loading...</p></div>`;

  try {
    const response = await fetch('/api/admin/activity/watch-list', { credentials: 'include' });
    const data = await response.json();

    if (!data.success || !data.collections || data.collections.length === 0) {
      content.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔔</div>
          <h4 class="empty-state-title">No Collections Being Watched</h4>
          <p class="empty-state-message">No NFT collections are currently being monitored for activity. Admins can add collections to track.</p>
        </div>
      `;
      return;
    }

    const collections = data.collections;
    const alertStatus = data.alertsEnabled !== undefined ? data.alertsEnabled : true;
    const alertChannel = data.alertChannel || 'Not configured';
    const eventTypes = data.eventTypes || ['mints', 'sales', 'listings'];

    let html = `
      <div style="display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); margin-bottom:16px;">
        <div style="padding:14px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.18); border-radius:10px;">
          <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:4px;">Collections Watched</div>
          <div style="color:#e0e7ff; font-size:1.5em; font-weight:700;">${collections.length}</div>
        </div>
        <div style="padding:14px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.18); border-radius:10px;">
          <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:4px;">Alert Status</div>
          <div style="color:${alertStatus ? '#10b981' : '#ef4444'}; font-size:1.1em; font-weight:600;">${alertStatus ? '✅ Active' : '❌ Disabled'}</div>
          <div style="color:var(--text-secondary); font-size:0.8em; margin-top:2px;">Channel: ${escapeHtml(String(alertChannel))}</div>
        </div>
        <div style="padding:14px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.18); border-radius:10px;">
          <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:4px;">Events Tracked</div>
          <div style="color:#e0e7ff; font-size:0.9em; font-weight:600;">${eventTypes.map(e => `<span style="display:inline-block; padding:2px 8px; margin:2px; background:rgba(99,102,241,0.2); border-radius:4px; font-size:0.85em;">${escapeHtml(e)}</span>`).join('')}</div>
        </div>
      </div>
    `;

    html += `<div style="border:1px solid rgba(99,102,241,0.22); border-radius:10px; overflow:hidden;">`;
    collections.forEach(col => {
      const name = col.name || col.collection_name || col.address || 'Unknown';
      const addr = col.address || col.collection_address || '';
      html += `
        <div style="padding:12px 16px; border-bottom:1px solid rgba(99,102,241,0.12); display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="color:#e0e7ff; font-weight:600;">${escapeHtml(name)}</div>
            <div style="color:var(--text-secondary); font-size:0.8em; font-family:monospace;">${escapeHtml(addr ? addr.slice(0,20) + '...' : '')}</div>
          </div>
          <span style="color:#10b981; font-size:0.85em;">● Monitoring</span>
        </div>
      `;
    });
    html += `</div>`;

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div style="color:var(--text-secondary); text-align:center; padding:20px;">Unable to load watched collections. You may need admin access or the feature isn't configured yet.</div>`;
  }
}

async function loadNFTActivityAdminView() {
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
    document.getElementById('nftActivityAdminList').innerHTML = `<div style="color:#ef4444; padding:12px;">Error loading list: ${e.message}</div>`;
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
        <input id="watchCollNameInput" type="text" placeholder="e.g. Solpranos" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;"></div>
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
      const response = await fetch('/api/admin/activity/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ channel, enabled, events })
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
async function loadNFTActivityView() {
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

async function loadNFTActivityAdminView() {
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

function openAddCollectionModal() {
  showConfirmModal(
    'Add Watched Collection',
    `
      <input type="text" id="newCollectionInput" placeholder="Collection address or key (e.g., solpranos)" 
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

async function removeWatchedCollection(idx, collectionEncoded) {
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
async function loadTreasuryTrackerView() {
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
// Add these functions to portal.js at the end, before the closing comment

// ==================== NFT ACTIVITY TRACKER ====================
async function loadNFTActivityView() {
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

async function loadNFTActivityAdminView() {
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

function openAddCollectionModal() {
  showConfirmModal(
    'Add Watched Collection',
    `
      <input type="text" id="newCollectionInput" placeholder="Collection address or key (e.g., solpranos)" 
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

async function removeWatchedCollection(idx, collectionEncoded) {
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
async function loadTreasuryTrackerView() {
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
  const content = document.getElementById('adminSelfServeRolesContent');
  if (!content) return;
  content.innerHTML = '<p style="color:var(--text-secondary);">Loading...</p>';

  try {
    const res = await fetch('/api/admin/role-claim/config', { credentials: 'include' });
    const roles = await res.json();

    const tableRows = (roles && roles.length)
      ? roles.map(r => `<tr>
          <td style="padding:8px 12px;">${r.name || r.roleId}</td>
          <td style="padding:8px 12px;">${r.label || '—'}</td>
          <td style="padding:8px 12px;">${r.memberCount ?? '—'}</td>
          <td style="padding:8px 12px;">${r.manageable ? '✅' : '⚠️'}</td>
          <td style="padding:8px 12px;">
            <label style="position:relative;display:inline-block;width:40px;height:22px;">
              <input type="checkbox" ${r.enabled !== false ? 'checked' : ''} onchange="toggleSelfServeRole('${r.roleId}', this.checked)" style="opacity:0;width:0;height:0;">
              <span style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${r.enabled !== false ? 'var(--gold)' : '#555'};border-radius:24px;transition:.3s;"></span>
              <span style="position:absolute;height:16px;width:16px;left:${r.enabled !== false ? '20px' : '3px'};bottom:3px;background:#fff;border-radius:50%;transition:.3s;pointer-events:none;"></span>
            </label>
          </td>
          <td style="padding:8px 12px;">
            <button class="btn-secondary" style="padding:4px 10px;font-size:0.8em;" onclick="removeSelfServeRole('${r.roleId}')">Remove</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="6" style="padding:12px;color:var(--text-secondary);text-align:center;">No claimable roles configured yet.</td></tr>';

    content.innerHTML = `
      <p style="color:var(--text-secondary);margin-bottom:var(--space-4);font-size:0.92em;">
        Configure roles users can self-assign. Post a panel to Discord so users can claim/unclaim roles with buttons.
      </p>

      <table style="width:100%;border-collapse:collapse;margin-bottom:var(--space-4);">
        <thead>
          <tr style="border-bottom:2px solid rgba(99,102,241,0.2);text-align:left;">
            <th style="padding:8px 12px;color:var(--text-secondary);font-size:0.85em;">Role Name</th>
            <th style="padding:8px 12px;color:var(--text-secondary);font-size:0.85em;">Label</th>
            <th style="padding:8px 12px;color:var(--text-secondary);font-size:0.85em;">Members</th>
            <th style="padding:8px 12px;color:var(--text-secondary);font-size:0.85em;">Status</th>
            <th style="padding:8px 12px;color:var(--text-secondary);font-size:0.85em;">Enabled</th>
            <th style="padding:8px 12px;color:var(--text-secondary);font-size:0.85em;"></th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>

      <div style="background:rgba(30,41,59,0.5);border-radius:8px;padding:var(--space-4);margin-bottom:var(--space-4);border:1px solid rgba(99,102,241,0.15);">
        <h4 style="margin:0 0 var(--space-3) 0;color:var(--text-primary);">Add Role</h4>
        <div style="display:flex;gap:var(--space-3);align-items:flex-end;flex-wrap:wrap;">
          <div style="flex:1;min-width:180px;">
            <label style="display:block;font-size:0.85em;color:var(--text-secondary);margin-bottom:4px;">Discord Role</label>
            ${roleSelectHTML('srRoleSelect', '')}
          </div>
          <div style="flex:1;min-width:150px;">
            <label style="display:block;font-size:0.85em;color:var(--text-secondary);margin-bottom:4px;">Button Label</label>
            <input type="text" id="srLabelInput" placeholder="e.g. Builders, Raiders, Whitelist"
              style="width:100%;padding:8px 12px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid rgba(99,102,241,0.2);border-radius:6px;font-size:0.9em;">
          </div>
          <button class="btn-primary" style="padding:8px 16px;" onclick="addSelfServeRole()">Add Role</button>
        </div>
      </div>

      <div style="background:rgba(30,41,59,0.5);border-radius:8px;padding:var(--space-4);border:1px solid rgba(99,102,241,0.15);">
        <h4 style="margin:0 0 var(--space-3) 0;color:var(--text-primary);">📢 Post Role Claim Panel</h4>
        <p style="color:var(--text-secondary);font-size:0.85em;margin-bottom:var(--space-3);">
          Creates one button per enabled role. Users click to toggle. Updates the existing panel message if already posted in this channel.
        </p>
        <div style="display:flex;flex-direction:column;gap:var(--space-3);">
          <div>
            <label style="display:block;font-size:0.85em;color:var(--text-secondary);margin-bottom:4px;">Channel</label>
            <select id="srPanelChannelId" style="width:100%;padding:8px 12px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid rgba(99,102,241,0.2);border-radius:6px;font-size:0.9em;">
              <option value="">-- Select Channel --</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-size:0.85em;color:var(--text-secondary);margin-bottom:4px;">Panel Title</label>
            <input type="text" id="srPanelTitle" value="🎖️ Get Your Roles"
              style="width:100%;padding:8px 12px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid rgba(99,102,241,0.2);border-radius:6px;font-size:0.9em;">
          </div>
          <div>
            <label style="display:block;font-size:0.85em;color:var(--text-secondary);margin-bottom:4px;">Panel Description</label>
            <textarea id="srPanelDesc" rows="2" style="width:100%;padding:8px 12px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid rgba(99,102,241,0.2);border-radius:6px;font-size:0.9em;resize:vertical;">Click a button below to claim or unclaim a community role.</textarea>
          </div>
          <button class="btn-primary" style="padding:8px 16px;align-self:flex-start;" onclick="postSelfServePanel()">📢 Post Panel</button>
          <div id="srPanelStatus"></div>
        </div>
      </div>
    `;

    populateRoleSelect('srRoleSelect', '');
    // Populate channel dropdown — use cached channelsList if available
    setTimeout(() => {
      const sel = document.getElementById('srPanelChannelId');
      if (!sel) return;
      const list = (typeof channelsList !== 'undefined' && channelsList.length > 0)
        ? channelsList
        : [];
      if (list.length > 0) {
        const grouped = {};
        list.forEach(ch => {
          const parent = ch.parentName || 'Other';
          if (!grouped[parent]) grouped[parent] = [];
          grouped[parent].push(ch);
        });
        sel.innerHTML = '<option value="">-- Select Channel --</option>';
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
      } else {
        // Fallback: fetch directly
        fetch('/api/admin/discord/channels', { credentials: 'include' })
          .then(r => r.json())
          .then(data => {
            const chs = data.channels || data || [];
            sel.innerHTML = '<option value="">-- Select Channel --</option>';
            chs.forEach(ch => {
              const opt = document.createElement('option');
              opt.value = ch.id;
              opt.textContent = (ch.parentName ? ch.parentName + ' > ' : '') + '# ' + ch.name;
              sel.appendChild(opt);
            });
          })
          .catch(e => console.error('Failed to load channels:', e));
      }
    }, 100);

  } catch (error) {
    console.error('Error loading self-serve roles:', error);
    content.innerHTML = '<p style="color:#ef4444;">Failed to load self-serve roles.</p>';
  }
}

async function addSelfServeRole() {
  const roleId = document.getElementById('srRoleSelect')?.value;
  const label = document.getElementById('srLabelInput')?.value.trim();
  if (!roleId) return showError('Please select a role.');
  if (!label) return showError('Please enter a button label.');
  try {
    const res = await fetch('/api/admin/role-claim/add', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId, label })
    });
    const data = await res.json();
    if (!data.success) return showError(data.message || 'Failed to add role');
    loadSelfServeRolesView();
  } catch (e) { showError('Error adding role: ' + e.message); }
}

async function removeSelfServeRole(roleId) {
  if (!confirm('Remove this claimable role?')) return;
  try {
    const res = await fetch(`/api/admin/role-claim/${roleId}`, {
      method: 'DELETE', credentials: 'include'
    });
    const data = await res.json();
    if (!data.success) return showError(data.message || 'Failed to remove role');
    loadSelfServeRolesView();
  } catch (e) { showError('Error removing role: ' + e.message); }
}

async function toggleSelfServeRole(roleId, enabled) {
  try {
    const res = await fetch(`/api/admin/role-claim/${roleId}/toggle`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const data = await res.json();
    if (!data.success) { showError(data.message || 'Failed to toggle role'); loadSelfServeRolesView(); }
  } catch (e) { showError('Error toggling role: ' + e.message); loadSelfServeRolesView(); }
}

async function postSelfServePanel() {
  const channelId = document.getElementById('srPanelChannelId')?.value;
  const title = document.getElementById('srPanelTitle')?.value.trim();
  const description = document.getElementById('srPanelDesc')?.value.trim();
  const status = document.getElementById('srPanelStatus');
  if (!channelId) return showError('Please select a channel.');
  if (status) status.innerHTML = '<p style="color:var(--text-secondary);">Posting panel...</p>';
  try {
    const res = await fetch('/api/admin/roles/post-panel', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, title, description })
    });
    const data = await res.json();
    if (data.success) {
      if (status) status.innerHTML = `<p style="color:#22c55e;">✅ Panel ${data.action || 'posted'} successfully!</p>`;
    } else {
      if (status) status.innerHTML = `<p style="color:#ef4444;">❌ ${data.message || 'Failed to post panel'}</p>`;
    }
  } catch (e) {
    if (status) status.innerHTML = `<p style="color:#ef4444;">❌ Error: ${e.message}</p>`;
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
      endpoint('POST', '/api/user/proposals', 'Creates a governance proposal. Body: <code>{ "title": "...", "description": "..." }</code>', false, null),
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

// ==================== TICKETING VIEW ====================

let _ticketCategories = [];
let _ticketChannelsList = [];
let _ticketRolesList = [];

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
