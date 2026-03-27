// ==================== PORTAL STATE MANAGEMENT ====================
let userData = null;
let isAdmin = false;
let heistEnabled = false;
let confirmCallback = null;

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
  // Check for section query param
  const urlParams = new URLSearchParams(window.location.search);
  const section = urlParams.get('section');
  
  loadPortal();
  
  // Navigate to specific section if provided
  if (section) {
    setTimeout(() => switchSection(section), 500);
  }

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
      loadDashboardData();
      checkAdminStatus();
    } else {
      showUnauthenticatedState();
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
  navAuthBtn.textContent = 'Login';
  navAuthBtn.onclick = login;
  navAuthBtn.classList.remove('btn-secondary');
  navAuthBtn.classList.add('btn-primary');

  document.getElementById('loginPrompt').style.display = 'block';
  document.getElementById('dashboardContent').style.display = 'none';
}

async function checkAdminStatus() {
  try {
    const response = await fetch('/api/admin/settings', { credentials: 'include' });
    const data = await response.json();
    
    if (data.success) {
      isAdmin = true;
      document.getElementById('navAdmin').style.display = 'block';
      document.getElementById('mobileNavAdmin').style.display = 'block';
      
      // Load treasury data for admin
      await loadTreasuryPublicView();
    }
  } catch (error) {
    // User is not admin, keep admin nav hidden
  }
}

// ==================== DATA LOADING ====================
function loadDashboardData() {
  // Load stats
  document.getElementById('tierStat').textContent = userData.user.tier || 'None';
  document.getElementById('vpStat').textContent = userData.user.votingPower || 0;
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
        <span class="status-badge status-${proposal.status}">${proposal.status}</span>
      </div>
      <div class="proposal-meta">
        Proposal #${proposal.proposal_id} • Created ${formatDate(new Date(proposal.created_at))}
      </div>
      ${proposal.description ? `<p style="color: var(--text-secondary); margin-top: var(--space-3); line-height: 1.6;">${escapeHtml(proposal.description)}</p>` : ''}
    </div>
  `).join('') + '</div>';

  // Also load active votes
  loadActiveVotes();
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
  } else if (sectionName === 'treasury') {
    loadTreasuryPublicView();
    loadTreasuryTransactions();
    loadTreasuryTrackerView();
  } else if (sectionName === 'nft-activity') {
    loadNFTActivityView();
    if (isAdmin) loadNFTActivityAdminView();
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
      const t = data.treasury || {};
      content.innerHTML = `
        <div style="display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr));">
          <div style="padding:16px; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.22); border-radius:10px;">
            <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:8px;">SOL Balance</div>
            <div style="font-size:2em; font-weight:700; color:#93c5fd;">${t.sol_balance?.toFixed(2) || '—'}</div>
          </div>
          <div style="padding:16px; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.22); border-radius:10px;">
            <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:8px;">USDC Balance</div>
            <div style="font-size:2em; font-weight:700; color:#86efac;">${t.usdc_balance?.toFixed(2) || '—'}</div>
          </div>
          <div style="padding:16px; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.22); border-radius:10px;">
            <div style="color:var(--text-secondary); font-size:0.85em; margin-bottom:8px;">Last Updated</div>
            <div style="font-size:1.1em; font-weight:600; color:#e0e7ff;">${t.last_updated ? new Date(t.last_updated).toLocaleString() : '—'}</div>
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
    
    if (data.success && data.transactions?.length > 0) {
      const rows = data.transactions.map(tx => `
        <div style="padding:12px; border-bottom:1px solid rgba(99,102,241,0.15); display:flex; justify-content:space-between; align-items:center;">
          <div style="flex:1;">
            <div style="color:#e0e7ff; font-weight:600;">${tx.type === 'in' ? '➕ Incoming' : '➖ Outgoing'}</div>
            <div style="color:var(--text-secondary); font-size:0.85em; font-family:monospace;">${tx.tx_hash?.slice(0, 16)}...</div>
          </div>
          <div style="text-align:right;">
            <div style="color:#e0e7ff; font-weight:600;">${tx.amount} ${tx.token}</div>
            <div style="color:var(--text-secondary); font-size:0.85em;">${new Date(tx.timestamp).toLocaleDateString()}</div>
          </div>
        </div>
      `).join('');
      
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
        <label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Description *</label>
        <textarea id="proposalDescInput" placeholder="Explain your proposal's purpose and impact" rows="4" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em; resize:vertical;"></textarea>
      </div>
    </div>
  `;

  confirmCallback = async () => {
    const proposalTitle = document.getElementById('proposalTitleInput')?.value.trim();
    const proposalDesc = document.getElementById('proposalDescInput')?.value.trim();
    if (!proposalTitle || !proposalDesc) {
      showError('Please fill in both title and description');
      return;
    }
    try {
      const response = await fetch('/api/user/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: proposalTitle, description: proposalDesc })
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
  ['adminUsersCard', 'adminProposalsCard', 'adminSettingsCard', 'adminAnalyticsCard', 'adminHelpCard', 'adminRolesCard', 'adminActivityCard', 'adminStatsCard']
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

function showAdminView(view) {
  if (!isAdmin) {
    showError('Admin access required.');
    return;
  }

  switchSection('admin');
  hideAllAdminCards();

  const map = {
    stats: { card: 'adminStatsCard', load: loadAdminStats },
    users: { card: 'adminUsersCard', load: loadAdminUsers },
    proposals: { card: 'adminProposalsCard', load: loadAdminProposals },
    settings: { card: 'adminSettingsCard', load: loadAdminSettingsView },
    analytics: { card: 'adminAnalyticsCard', load: loadAdminAnalyticsView },
    help: { card: 'adminHelpCard', load: loadAdminHelpView },
    roles: { card: 'adminRolesCard', load: loadAdminRoles },
    activity: { card: 'adminActivityCard', load: loadAdminActivity }
  };

  const target = map[view] || map.stats;
  const card = document.getElementById(target.card);
  if (card) card.style.display = 'block';
  if (typeof target.load === 'function') target.load();

  loadEnvStatusBar();

  setTimeout(() => card?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

function showAdminUsers() {
  showAdminView('users');
}

async function loadAdminHelpView() {
  if (!isAdmin) return;
  const content = document.getElementById('adminHelpContent');
  if (!content) return;

  content.innerHTML = `
    <div style="display:grid; gap: var(--space-3);">
      <div><strong>Verification Admin</strong>: /verification admin panel, export-user, remove-user, export-wallets, role-config, actions, og-view, og-enable, og-role, og-limit, og-sync, activity-watch-add/remove/list, activity-feed, activity-alerts</div>
      <div><strong>Governance Admin</strong>: /governance admin list, cancel, settings</div>
      <div><strong>Treasury Admin</strong>: /treasury admin status, refresh, enable/disable, set-wallet, set-interval, tx-history, tx-alerts</div>
      <div><strong>Battle Admin</strong>: /battle admin list, force-end, settings</div>
      <div style="color: var(--text-secondary);">For complete reference open standalone admin help.</div>
    </div>
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

    content.innerHTML = `<div style="display:grid; gap:12px;">${proposals.slice(0, 50).map(p => `
      <div style="padding:12px; border:1px solid var(--border-default); border-radius:10px; background: var(--bg-tertiary);">
        <div style="display:flex; justify-content:space-between; gap:12px;">
          <strong>${escapeHtml(p.title || 'Untitled')}</strong>
          <span class="status-badge status-${escapeHtml(p.status || 'draft')}">${escapeHtml(p.status || 'draft')}</span>
        </div>
        <div style="color:var(--text-secondary); font-size:0.9em; margin-top:6px;">ID: ${escapeHtml(p.proposal_id || '')} • Creator: ${escapeHtml(p.creator_id || '')}</div>
      </div>
    `).join('')}</div>`;
  } catch (e) {
    content.innerHTML = `<div class="error-state"><div class="error-message">${escapeHtml(e.message)}</div></div>`;
  }
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
      'ps_moduleTreasuryEnabled': 'ps_section_treasury',
      'ps_moduleRoleResyncEnabled': 'ps_section_roleresync',
      'ps_moduleMicroVerifyEnabled': 'ps_section_micro'
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
          ${moduleToggle('moduleMissionsEnabled', 'Missions', '🎯', true)}
          ${moduleToggle('moduleTreasuryEnabled', 'Treasury', '💰', true)}
          ${moduleToggle('moduleRoleResyncEnabled', 'Role Resync', '👥', true)}
          ${moduleToggle('moduleMicroVerifyEnabled', 'Micro-Transfer Verify', '🔐', false)}
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
      </div>

      <!-- ✅ VERIFICATION MODULE -->
      <div id="ps_section_verification" style="${cardStyle}${moduleCardBorder}display:${(s.moduleVerificationEnabled ?? true) ? 'block' : 'none'};">
        <h3 style="${cardHeader}">✅ Verification Module</h3>
        ${noSettingsMsg}
      </div>

      <!-- 🎯 MISSIONS MODULE -->
      <div id="ps_section_missions" style="${cardStyle}${moduleCardBorder}display:${(s.moduleMissionsEnabled ?? true) ? 'block' : 'none'};">
        <h3 style="${cardHeader}">🎯 Missions Module</h3>
        ${noSettingsMsg}
      </div>

      <!-- 💰 TREASURY MODULE -->
      <div id="ps_section_treasury" style="${cardStyle}${moduleCardBorder}display:${(s.moduleTreasuryEnabled ?? true) ? 'block' : 'none'};">
        <h3 style="${cardHeader}">💰 Treasury Module</h3>
        ${noSettingsMsg}
      </div>

      <!-- 👥 ROLE RESYNC MODULE -->
      <div id="ps_section_roleresync" style="${cardStyle}${moduleCardBorder}display:${(s.moduleRoleResyncEnabled ?? true) ? 'block' : 'none'};">
        <h3 style="${cardHeader}">👥 Role Resync Module</h3>
        ${noSettingsMsg}
      </div>

      <!-- 🔐 MICRO-TRANSFER VERIFY MODULE -->
      <div id="ps_section_micro" style="${cardStyle}${moduleCardBorder}display:${(s.moduleMicroVerifyEnabled ?? false) ? 'block' : 'none'};">
        <h3 style="${cardHeader}">🔐 Micro-Transfer Verify Module</h3>
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

      <!-- Action Buttons — always visible -->
      <div style="display:flex;gap:var(--space-3);justify-content:flex-end;padding-top:var(--space-4);border-top:1px solid rgba(99,102,241,0.15);">
        <button class="btn-danger" onclick="resetPortalSettings()" style="font-size:0.85em;padding:8px 16px;">🔄 Reset to Defaults</button>
        <button class="btn-primary" onclick="savePortalSettings()" style="font-size:0.85em;padding:8px 16px;">💾 Save All Settings</button>
      </div>
    `;

    // Step 3: Attach toggle listeners now that DOM is ready
    attachToggleListeners();

    // Step 3b: Wire ALL module toggles to show/hide their related settings cards
    Object.keys(moduleMap).forEach(id => {
      const cb = document.getElementById(id);
      if (cb) cb.addEventListener('change', updateSectionVisibility);
    });

    // Step 4: Fetch channels AFTER skeleton is in the DOM, then populate selects
    const channelIds = ['proposalsChannelId', 'votingChannelId', 'resultsChannelId', 'governanceLogChannelId'];
    // Verify selects exist in DOM before fetch
    channelIds.forEach(id => {
      const sel = document.getElementById(`ps_${id}`);
      console.log(`[Settings] Channel select ps_${id} in DOM:`, !!sel);
    });
    try {
      console.log('[Settings] Fetching /api/admin/discord/channels...');
      const channelsRes = await fetch('/api/admin/discord/channels', { credentials: 'include' });
      console.log('[Settings] Channels response status:', channelsRes.status, channelsRes.ok);
      let channelsList = [];
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
        return;
      }

      // Group channels by parent category
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
    moduleRoleResyncEnabled: document.getElementById('ps_moduleRoleResyncEnabled').checked,
    moduleMicroVerifyEnabled: document.getElementById('ps_moduleMicroVerifyEnabled').checked,
    proposalsChannelId: document.getElementById('ps_proposalsChannelId').value || '',
    votingChannelId: document.getElementById('ps_votingChannelId').value || '',
    resultsChannelId: document.getElementById('ps_resultsChannelId').value || '',
    governanceLogChannelId: document.getElementById('ps_governanceLogChannelId').value || '',
    verificationReceiveWallet: document.getElementById('ps_verificationReceiveWallet').value.trim() || '',
    nftActivityWebhookSecret: document.getElementById('ps_nftActivityWebhookSecret').value.trim() || '',
    verifyRequestTtlMinutes: parseInt(document.getElementById('ps_verifyRequestTtlMinutes').value),
    pollIntervalSeconds: parseInt(document.getElementById('ps_pollIntervalSeconds').value),
    verifyRateLimitMinutes: parseInt(document.getElementById('ps_verifyRateLimitMinutes').value),
    maxPendingPerUser: parseInt(document.getElementById('ps_maxPendingPerUser').value)
  };

  try {
    const response = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(newSettings)
    });
    const data = await response.json();
    if (data.success) {
      showSettingsSuccess('Settings saved successfully!');
      await loadAdminSettingsView();
    } else {
      showError(data.message || 'Failed to save settings');
    }
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

  try {
    const [usersRes, proposalsRes] = await Promise.all([
      fetch('/api/admin/users', { credentials: 'include' }),
      fetch('/api/admin/proposals', { credentials: 'include' })
    ]);
    const usersData = await usersRes.json();
    const proposalsData = await proposalsRes.json();

    const users = usersData.users || [];
    const proposals = proposalsData.proposals || [];
    const active = proposals.filter(p => ['supporting','voting'].includes((p.status || '').toLowerCase())).length;

    content.innerHTML = `
      <div style="display:grid; gap:12px; grid-template-columns: repeat(auto-fit,minmax(220px,1fr));">
        <div class="stat-card"><div class="stat-label">Total Users</div><div class="stat-value">${users.length}</div></div>
        <div class="stat-card"><div class="stat-label">Total Proposals</div><div class="stat-value">${proposals.length}</div></div>
        <div class="stat-card"><div class="stat-label">Active Proposals</div><div class="stat-value">${active}</div></div>
      </div>
      <div style="margin-top:10px; color: var(--text-secondary);">Light analytics inside portal. Deep analytics remain available in advanced tooling.</div>
    `;
  } catch (e) {
    content.innerHTML = `<div class="error-state"><div class="error-message">${escapeHtml(e.message)}</div></div>`;
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
    html += `<p style="color:var(--text-secondary); font-size:0.85em; margin-bottom:12px;">Define tier levels based on how many NFTs a holder owns. Each tier grants a Discord role and voting power.</p>`;
    if (tiers.length === 0) {
      html += `<div style="padding:16px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.15); border-radius:10px; color:var(--text-secondary); margin-bottom:20px;">No tiers configured. Click "➕ Add Tier" to create one.</div>`;
    } else {
      const tierRows = tiers.map((tier, idx) => `
        <tr>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#e0e7ff; font-weight:600;">${escapeHtml(tier.name)}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#c7d2fe;">${tier.minNFTs}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#c7d2fe;">${tier.maxNFTs === Infinity || tier.maxNFTs >= 999999 ? '∞' : tier.maxNFTs}</td>
          <td class="vp-col" style="padding:10px; border-bottom:1px solid rgba(99,102,241,0.15); color:#fbbf24; font-weight:600;${portalSettingsData?.moduleGovernanceEnabled === false ? 'opacity:0.3;' : ''}">${tier.votingPower}</td>
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
              <th style="padding:10px; color:#c9d6ff;">Minimum NFT count</th>
              <th style="padding:10px; color:#c9d6ff;">Maximum NFT count</th>
              <th class="vp-col" style="padding:10px; color:#c9d6ff;">${portalSettingsData?.moduleGovernanceEnabled === false ? 'Voting Power <span style="color:#888;font-weight:400;font-size:0.85em;">(governance disabled)</span>' : 'Voting Power'}</th>
              <th style="padding:10px; color:#c9d6ff;">Discord Role ID</th>
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
      <div id="tierVPField" style="${portalSettingsData?.moduleGovernanceEnabled === false ? 'display:none;' : ''}"><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Voting Power ${portalSettingsData?.moduleGovernanceEnabled === false ? '<span style="color:#888;font-size:0.85em;">(governance disabled)</span>' : '*'}</label>
        <input id="tierVPInput" type="number" value="${tier.votingPower ?? ''}" min="0" placeholder="10" style="width:100%; padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-size:0.9em;"></div>
      <div><label style="display:block; color:#c9d6ff; font-size:0.9em; margin-bottom:6px;">Discord Role (optional)</label>
        ${roleSelectHTML('tierRoleIdInput', tier.roleId || '')}</div>
    </div>`;
}

async function saveTierFromForm(mode, originalName) {
  const name = document.getElementById('tierNameInput')?.value.trim();
  const minNFTs = parseInt(document.getElementById('tierMinInput')?.value);
  const maxNFTs = document.getElementById('tierMaxInput')?.value.trim() === '' ? 999999 : parseInt(document.getElementById('tierMaxInput')?.value);
  const votingPower = parseInt(document.getElementById('tierVPInput')?.value);
  const roleId = document.getElementById('tierRoleIdInput')?.value || null;

  const govEnabled = portalSettingsData?.moduleGovernanceEnabled !== false;
  if (!name || isNaN(minNFTs) || (govEnabled && isNaN(votingPower))) {
    showError(govEnabled ? 'Please fill in name, min NFTs, and voting power' : 'Please fill in name and min NFTs');
    return;
  }

  try {
    let url, method, body;
    if (mode === 'add') {
      url = '/api/admin/roles/tiers';
      method = 'POST';
      body = { name, minNFTs, maxNFTs, votingPower, roleId };
    } else {
      url = `/api/admin/roles/tiers/${encodeURIComponent(originalName)}`;
      method = 'PUT';
      body = { name, minNFTs, maxNFTs, votingPower, roleId };
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
