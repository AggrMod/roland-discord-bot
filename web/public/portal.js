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

  // Close role modal when clicking outside
  document.getElementById('roleModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'roleModal') {
      closeRoleModal();
    }
  });

  // Attach role form submission
  const roleForm = document.getElementById('roleForm');
  if (roleForm) {
    roleForm.addEventListener('submit', saveRole);
  }

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
  // Show dual verification methods
  const walletsList = document.getElementById('walletsList');
  if (walletsList) {
    const formHtml = `
      <div style="display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(280px,1fr));">
        <!-- Wallet Connection Method -->
        <div style="padding:20px; background:linear-gradient(135deg,rgba(99,102,241,0.15),rgba(99,102,241,0.05)); border:1px solid rgba(99,102,241,0.22); border-radius:12px;">
          <h4 style="color:#e0e7ff; margin-bottom:16px; display:flex; align-items:center; gap:8px;">
            <span style="font-size:1.3em;">🔗</span>
            <span>Wallet Connection</span>
          </h4>
          <p style="color:var(--text-secondary); font-size:0.9em; margin-bottom:12px; line-height:1.6;">Sign a message with your wallet to prove ownership. No transaction required.</p>
          <div style="display:grid; gap:12px;">
            <div>
              <label style="color:#c9d6ff; font-size:0.85em; margin-bottom:6px; display:block;">Which wallet are you signing with?</label>
              <input id="walletAddr1" type="text" placeholder="Enter your Solana wallet address" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-family:monospace; font-size:0.85em; width:100%;">
              <p style="color:var(--text-secondary); font-size:0.8em; margin-top:6px;">You'll sign a message to verify ownership</p>
            </div>
            <button onclick="verifyBySignature()" class="btn-primary" style="padding:10px 16px; width:100%;">✓ Sign & Verify</button>
          </div>
        </div>

        <!-- Micro Transaction Method -->
        <div style="padding:20px; background:linear-gradient(135deg,rgba(99,102,241,0.15),rgba(99,102,241,0.05)); border:1px solid rgba(99,102,241,0.22); border-radius:12px;">
          <h4 style="color:#e0e7ff; margin-bottom:16px; display:flex; align-items:center; gap:8px;">
            <span style="font-size:1.3em;">💰</span>
            <span>Micro Transaction</span>
          </h4>
          <p style="color:var(--text-secondary); font-size:0.9em; margin-bottom:12px; line-height:1.6;">Send a small SOL amount to prove ownership. Funds returned after verification.</p>
          <div style="display:grid; gap:12px;">
            <div>
              <label style="color:#c9d6ff; font-size:0.85em; margin-bottom:6px; display:block;">Which wallet are you sending from?</label>
              <input id="walletAddr2" type="text" placeholder="Enter your Solana wallet address" style="padding:10px 12px; background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.22); border-radius:8px; color:#e0e7ff; font-family:monospace; font-size:0.85em; width:100%;">
              <p style="color:var(--text-secondary); font-size:0.8em; margin-top:6px;">Send a tiny amount of SOL from this wallet</p>
            </div>
            <button onclick="verifyByMicroTx()" class="btn-primary" style="padding:10px 16px; width:100%;">💸 Send Verification</button>
          </div>
        </div>
      </div>
    `;
    walletsList.innerHTML = formHtml;
    walletsList.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function verifyBySignature() {
  const addr = document.getElementById('walletAddr1')?.value.trim();
  if (!addr) {
    showError('Please enter a wallet address');
    return;
  }
  showSuccess('Initiating wallet signature verification...');
  setTimeout(() => {
    window.location.href = '/verify';
  }, 600);
}

function verifyByMicroTx() {
  const addr = document.getElementById('walletAddr2')?.value.trim();
  if (!addr) {
    showError('Please enter a wallet address');
    return;
  }
  showSuccess('Initiating micro-transaction verification...');
  setTimeout(() => {
    window.location.href = '/verify?method=micro';
  }, 600);
}

// ==================== PORTAL LOADING ====================
async function loadPortal() {
  try {
    // Check feature flags
    const flagsResponse = await fetch('/api/features');
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

    // Try to load user data
    const response = await fetch('/api/user/me');
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
    const response = await fetch('/api/admin/settings');
    const data = await response.json();
    
    if (data.success) {
      isAdmin = true;
      document.getElementById('navAdmin').style.display = 'block';
      document.getElementById('mobileNavAdmin').style.display = 'block';
      
      // Load treasury data for admin
      await loadTreasuryData();
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
  loadPublicTreasuryData(); // Load public treasury data
  
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
    const response = await fetch('/api/public/proposals/active');
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
            Proposal #${proposal.proposal_id} • Created by ${escapeHtml(proposal.author || 'Unknown')}
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
    () => removeWallet(address)
  );
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
    const response = await fetch('/api/public/missions/active');
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
    const response = await fetch('/api/public/v1/treasury');
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
}

async function loadTreasuryTransactions() {
  const content = document.getElementById('publicTreasuryTransactions');
  if (!content) return;
  
  try {
    const response = await fetch('/api/public/v1/treasury/transactions?limit=10');
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
function showConfirmModal(title, message, callback) {
  const modal = document.getElementById('confirmModal');
  const modalTitle = document.getElementById('confirmTitle');
  const modalMessage = document.getElementById('confirmMessage');
  
  modalTitle.textContent = title;
  modalMessage.textContent = message;
  confirmCallback = callback;
  
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeConfirmModal() {
  const modal = document.getElementById('confirmModal');
  modal.style.display = 'none';
  document.body.style.overflow = '';
  confirmCallback = null;
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
  });
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

// ==================== TREASURY WATCH ====================
async function loadPublicTreasuryData() {
  const content = document.getElementById('publicTreasuryContent');
  const card = document.getElementById('publicTreasuryCard');
  if (!content || !card) return;

  try {
    const response = await fetch('/api/public/treasury');
    const data = await response.json();

    if (!data.success) {
      // Treasury not enabled, hide the card
      card.style.display = 'none';
      return;
    }

    // Show the card
    card.style.display = 'block';

    const treasury = data.treasury;
    
    const statusEmoji = {
      ok: '✅',
      warning: '⚠️',
      stale: '🔴',
      never_updated: '⭕'
    };

    const lastUpdatedText = treasury.lastUpdated 
      ? new Date(treasury.lastUpdated).toLocaleString()
      : 'Never';

    const html = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-4);">
        <div class="stat-card">
          <div class="stat-label">SOL Balance</div>
          <div class="stat-value" style="font-size: 1.8em;">${treasury.sol}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">USDC Balance</div>
          <div class="stat-value" style="font-size: 1.8em;">${treasury.usdc}</div>
        </div>
      </div>
      
      <div style="margin-top: var(--space-4); padding: var(--space-3); background: var(--card-bg); border-radius: var(--radius-md); border: 1px solid var(--border-color); text-align: center; font-size: 0.85em; color: var(--text-secondary);">
        ${statusEmoji[treasury.status]} Last updated: ${lastUpdatedText}
      </div>
    `;

    content.innerHTML = html;
  } catch (error) {
    console.error('Error loading public treasury data:', error);
    card.style.display = 'none';
  }
}

async function loadTreasuryData() {
  if (!isAdmin) return;

  const content = document.getElementById('treasuryContent');
  if (!content) return;

  try {
    const response = await fetch('/api/admin/treasury');
    const data = await response.json();

    if (!data.success) {
      content.innerHTML = `
        <div style="text-align: center; padding: var(--space-4); color: var(--text-secondary);">
          <p>⚠️ ${data.message || 'Treasury monitoring is disabled'}</p>
          <p style="margin-top: var(--space-2); font-size: 0.9em;">
            Configure treasury monitoring using <code>/treasury</code> commands in Discord.
          </p>
        </div>
      `;
      return;
    }

    const { config, treasury } = data;
    
    const statusEmoji = {
      ok: '✅',
      warning: '⚠️',
      stale: '🔴',
      never_updated: '⭕'
    };

    const statusText = {
      ok: 'Current',
      warning: 'Needs Refresh',
      stale: 'Stale',
      never_updated: 'Never Updated'
    };

    const statusColor = {
      ok: 'var(--success)',
      warning: 'var(--warning)',
      stale: 'var(--error)',
      never_updated: 'var(--text-secondary)'
    };

    const lastUpdatedText = treasury.lastUpdated 
      ? new Date(treasury.lastUpdated).toLocaleString()
      : 'Never';

    const html = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4);">
        <div class="stat-card">
          <div class="stat-label">SOL Balance</div>
          <div class="stat-value">${treasury.sol}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">USDC Balance</div>
          <div class="stat-value">${treasury.usdc}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Status</div>
          <div class="stat-value" style="color: ${statusColor[treasury.status]};">
            ${statusEmoji[treasury.status]} ${statusText[treasury.status]}
          </div>
        </div>
      </div>
      
      <div style="margin-top: var(--space-4); padding: var(--space-3); background: var(--card-bg); border-radius: var(--radius-md); border: 1px solid var(--border-color);">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); font-size: 0.9em;">
          <div>
            <strong style="color: var(--text-secondary);">Wallet:</strong>
            <span style="margin-left: var(--space-2); font-family: monospace;">${config.wallet || 'Not configured'}</span>
          </div>
          <div>
            <strong style="color: var(--text-secondary);">Refresh Interval:</strong>
            <span style="margin-left: var(--space-2);">${config.refreshHours} hours</span>
          </div>
          <div>
            <strong style="color: var(--text-secondary);">Last Updated:</strong>
            <span style="margin-left: var(--space-2);">${lastUpdatedText}</span>
          </div>
          <div>
            <strong style="color: var(--text-secondary);">Monitoring:</strong>
            <span style="margin-left: var(--space-2);">${config.enabled ? '✅ Enabled' : '❌ Disabled'}</span>
          </div>
        </div>
        ${config.lastError ? `
          <div style="margin-top: var(--space-3); padding: var(--space-2); background: var(--error-bg); border-left: 3px solid var(--error); border-radius: var(--radius-sm);">
            <strong style="color: var(--error);">⚠️ Last Error:</strong>
            <p style="margin-top: var(--space-1); font-size: 0.85em; color: var(--text-primary);">${config.lastError}</p>
          </div>
        ` : ''}
      </div>
      
      <div style="margin-top: var(--space-4); padding: var(--space-3); background: var(--info-bg); border-left: 3px solid var(--info); border-radius: var(--radius-sm); font-size: 0.9em;">
        <strong>ℹ️ Note:</strong> Full wallet address is never exposed in the UI for security. Use Discord <code>/treasury</code> commands for full admin controls.
      </div>
    `;

    content.innerHTML = html;
  } catch (error) {
    console.error('Error loading treasury data:', error);
    content.innerHTML = `
      <div style="text-align: center; padding: var(--space-4); color: var(--error);">
        <p>❌ Failed to load treasury data</p>
        <p style="margin-top: var(--space-2); font-size: 0.9em;">${error.message}</p>
      </div>
    `;
  }
}

async function refreshTreasury() {
  if (!isAdmin) return;

  const btn = document.getElementById('treasuryRefreshBtn');
  const originalText = btn.innerHTML;
  
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span><span>Refreshing...</span>';

  try {
    const response = await fetch('/api/admin/treasury/refresh', { method: 'POST' });
    const data = await response.json();

    if (data.success) {
      showSuccess('Treasury balances refreshed successfully!');
      await loadTreasuryData();
    } else {
      showError(data.message || 'Failed to refresh treasury');
    }
  } catch (error) {
    console.error('Error refreshing treasury:', error);
    showError('Failed to refresh treasury: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// ==================== INTEGRATED ADMIN WORKSPACE ====================
function hideAllAdminCards() {
  ['adminUsersCard', 'adminProposalsCard', 'adminSettingsCard', 'adminAnalyticsCard', 'adminHelpCard', 'adminRolesCard', 'adminActivityCard', 'adminStatsCard']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
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
    const response = await fetch('/api/admin/proposals');
    const data = await response.json();
    if (!data.success) throw new Error(data.message || 'Failed to load proposals');

    const proposals = data.proposals || [];
    if (!proposals.length) {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-title">No proposals found</div></div>`;
      return;
    }

    content.innerHTML = `<div style="display:grid; gap:12px;">${proposals.slice(0, 50).map(p => `
      <div style="padding:12px; border:1px solid var(--border-color); border-radius:10px; background: var(--bg-tertiary);">
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

async function loadAdminSettingsView() {
  if (!isAdmin) return;
  const content = document.getElementById('adminSettingsContent');
  if (!content) return;

  content.innerHTML = `<div style="text-align:center; padding: var(--space-5); color: var(--text-secondary);"><div class="spinner"></div><p>Loading settings...</p></div>`;

  try {
    const response = await fetch('/api/admin/settings');
    const data = await response.json();
    if (!data.success) throw new Error(data.message || 'Failed to load settings');

    const s = data.settings || {};
    
    // Module toggles
    const modules = [
      { name: 'Verification', key: 'verificationEnabled', icon: '✓' },
      { name: 'Governance', key: 'governanceEnabled', icon: '📜' },
      { name: 'Treasury', key: 'treasuryEnabled', icon: '💰' },
      { name: 'Battle', key: 'battleEnabled', icon: '⚔️' },
      { name: 'Heist', key: 'heistEnabled', icon: '🎯' }
    ];

    const moduleToggles = modules.map(mod => `
      <div style="padding:12px; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.22); border-radius:10px; display:flex; justify-content:space-between; align-items:center;">
        <span style="color:#e0e7ff; font-weight:600;">${mod.icon} ${mod.name}</span>
        <span style="font-size:1.5em; color:${s[mod.key] ? '#10b981' : '#ef4444'};">${s[mod.key] ? '✅' : '❌'}</span>
      </div>
    `).join('');

    content.innerHTML = `
      <div style="margin-bottom:24px;">
        <h4 style="color:#c9d6ff; margin-bottom:12px;">📦 Module Status</h4>
        <div style="display:grid; gap:12px; grid-template-columns: repeat(auto-fit,minmax(200px,1fr));">
          ${moduleToggles}
        </div>
      </div>

      <div style="margin-bottom:24px;">
        <h4 style="color:#c9d6ff; margin-bottom:12px;">⚙️ Governance Settings</h4>
        <div style="display:grid; gap:12px; grid-template-columns: repeat(auto-fit,minmax(220px,1fr));">
          <div class="stat-card"><div class="stat-label">Support Threshold</div><div class="stat-value">${s.supportThreshold ?? '—'}</div></div>
          <div class="stat-card"><div class="stat-label">Voting Days</div><div class="stat-value">${s.votingDays ?? '—'}</div></div>
          <div class="stat-card"><div class="stat-label">Quorum %</div><div class="stat-value">${s.quorumPercent ?? '—'}</div></div>
        </div>
      </div>

      <div style="padding:12px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.22); border-radius:10px; color:var(--text-secondary); font-size:0.9em;">
        <strong>💡 Tip:</strong> Configure module settings via Discord commands. Use /verification admin, /governance admin, /treasury admin, /battle admin, or /heist commands to manage detailed settings.
      </div>
    `;
  } catch (e) {
    content.innerHTML = `<div class="error-state"><div class="error-message">${escapeHtml(e.message)}</div></div>`;
  }
}

async function loadAdminAnalyticsView() {
  if (!isAdmin) return;
  const content = document.getElementById('adminAnalyticsContent');
  if (!content) return;

  try {
    const [usersRes, proposalsRes] = await Promise.all([
      fetch('/api/admin/users'),
      fetch('/api/admin/proposals')
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

async function loadAdminRoles() {
  if (!isAdmin) return;
  const content = document.getElementById('adminRolesContent');
  if (!content) return;

  content.innerHTML = `<div style="text-align:center; padding: var(--space-5); color: var(--text-secondary);"><div class="spinner"></div><p>Loading roles...</p></div>`;

  try {
    const response = await fetch('/api/admin/roles/config');
    const data = await response.json();
    if (!data.success) throw new Error(data.message || 'Failed to load roles');

    const roles = data.roles || data.config || [];
    adminRolesCache = roles;
    if (!roles.length) {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-title">No verification roles configured</div></div>`;
      return;
    }

    const rows = roles.map((role, idx) => `
      <tr>
        <td style="padding:12px; border-bottom:1px solid rgba(99,102,241,0.15); color:#e0e7ff; font-weight:600;">${escapeHtml(role.role_name || role.roleId || '')}</td>
        <td style="padding:12px; border-bottom:1px solid rgba(99,102,241,0.15); color:#c7d2fe;"><span style="display:inline-block; background:rgba(168,85,247,0.18); border:1px solid rgba(168,85,247,0.35); border-radius:4px; padding:4px 8px; font-size:0.85em;">Solana</span></td>
        <td style="padding:12px; border-bottom:1px solid rgba(99,102,241,0.15); color:#c7d2fe; font-family:monospace; font-size:0.85em;">${escapeHtml((role.collection_id || role.mint || 'N/A').slice(0, 12))}...</td>
        <td style="padding:12px; border-bottom:1px solid rgba(99,102,241,0.15);"><span style="display:inline-block; background:rgba(59,130,246,0.18); border:1px solid rgba(59,130,246,0.35); border-radius:4px; padding:4px 8px; font-size:0.85em; color:#93c5fd;">${escapeHtml(role.type || 'Collection')}</span></td>
        <td style="padding:12px; border-bottom:1px solid rgba(99,102,241,0.15); color:#c7d2fe; font-size:0.9em;">
          ${role.wallet_required ? '<span style="color:#10b981;">✓ Wallet Required</span>' : ''}
          ${role.min_holdings ? `<br/><span style="color:#fbbf24;">Min: ${role.min_holdings}</span>` : ''}
          ${role.options ? `<br/><span style="color:#06b6d4;">${role.options}</span>` : ''}
        </td>
        <td style="padding:12px; border-bottom:1px solid rgba(99,102,241,0.15); text-align:right;">
          <button class="btn-icon" onclick="editRole(${idx})" style="width:32px; height:32px; background:rgba(99,102,241,0.2); border:1px solid rgba(99,102,241,0.35); border-radius:6px; cursor:pointer; color:#818cf8; font-size:0.9em;">✏️</button>
          <button class="btn-icon" onclick="deleteRole(${idx})" style="width:32px; height:32px; background:rgba(239,68,68,0.2); border:1px solid rgba(239,68,68,0.35); border-radius:6px; cursor:pointer; color:#fca5a5; font-size:0.9em; margin-left:4px;">🗑️</button>
        </td>
      </tr>
    `).join('');

    content.innerHTML = `
      <div style="overflow:auto; border:1px solid rgba(99,102,241,0.22); border-radius:10px; background:rgba(14,23,44,0.5);">
        <table style="width:100%; border-collapse:collapse; font-size:0.9em;">
          <thead>
            <tr style="background:rgba(99,102,241,0.12); text-align:left;">
              <th style="padding:12px; color:#c9d6ff; font-weight:600; border-bottom:1px solid rgba(99,102,241,0.22);">Role</th>
              <th style="padding:12px; color:#c9d6ff; font-weight:600; border-bottom:1px solid rgba(99,102,241,0.22);">Chain</th>
              <th style="padding:12px; color:#c9d6ff; font-weight:600; border-bottom:1px solid rgba(99,102,241,0.22);">Token / Identifier</th>
              <th style="padding:12px; color:#c9d6ff; font-weight:600; border-bottom:1px solid rgba(99,102,241,0.22);">Type</th>
              <th style="padding:12px; color:#c9d6ff; font-weight:600; border-bottom:1px solid rgba(99,102,241,0.22);">Options</th>
              <th style="padding:12px; color:#c9d6ff; font-weight:600; border-bottom:1px solid rgba(99,102,241,0.22); text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:12px; color:var(--text-secondary); font-size:0.9em;">Showing ${roles.length} role(s)</div>
    `;
  } catch (e) {
    content.innerHTML = `<div class="error-state"><div class="error-message">${escapeHtml(e.message)}</div></div>`;
  }
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

      const response = await fetch('/api/admin/roles/sync', { method: 'POST' });
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
  if (!isAdmin) return;
  document.getElementById('roleModalTitle').textContent = 'Add Verification Role';
  document.getElementById('roleForm').reset();
  document.getElementById('roleForm').dataset.mode = 'add';
  const modal = document.getElementById('roleModal');
  if (modal) {
    modal.style.display = 'flex';
  }
}

function closeRoleModal() {
  document.getElementById('roleModal').style.display = 'none';
  document.getElementById('roleForm').reset();
}

async function saveRole(e) {
  e.preventDefault();
  if (!isAdmin) return;

  const mode = document.getElementById('roleForm').dataset.mode || 'add';
  const name = document.getElementById('roleNameInput').value.trim();
  const type = document.getElementById('roleTypeInput').value.trim();
  const tokenId = document.getElementById('roleTokenInput').value.trim();
  const minHoldings = parseInt(document.getElementById('roleMinInput').value) || 0;
  const walletRequired = document.getElementById('roleWalletRequiredInput').checked;

  if (!name || !type || !tokenId) {
    showError('Please fill in all required fields');
    return;
  }

  const btn = document.querySelector('#roleForm button[type="submit"]');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span><span>Saving...</span>';

  try {
    const endpoint = mode === 'add' ? '/api/admin/roles/traits' : '/api/admin/roles/traits/update';
    const method = mode === 'add' ? 'POST' : 'PUT';
    
    const payload = {
      traitType: type,
      traitValue: tokenId,
      roleId: name,
      description: `${type}: ${minHoldings > 0 ? `Min ${minHoldings} ` : ''}${walletRequired ? '(Wallet Required)' : ''}`
    };

    const response = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (data.success) {
      showSuccess(`Role ${mode === 'add' ? 'created' : 'updated'} successfully`);
      closeRoleModal();
      await loadAdminRoles();
    } else {
      showError(data.message || 'Failed to save role');
    }
  } catch (e) {
    showError('Error saving role: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

let adminRolesCache = [];

function editRole(idx) {
  if (!isAdmin || !adminRolesCache[idx]) return;
  const role = adminRolesCache[idx];
  document.getElementById('roleModalTitle').textContent = 'Edit Verification Role';
  document.getElementById('roleNameInput').value = role.role_name || role.roleId || '';
  document.getElementById('roleTypeInput').value = role.type || '';
  document.getElementById('roleTokenInput').value = role.collection_id || role.mint || '';
  document.getElementById('roleMinInput').value = role.min_holdings || '';
  document.getElementById('roleWalletRequiredInput').checked = !!role.wallet_required;
  document.getElementById('roleExemptInput').checked = !!role.exempt;
  document.getElementById('roleForm').dataset.mode = 'edit';
  document.getElementById('roleForm').dataset.editIdx = idx;
  document.getElementById('roleModal').style.display = 'flex';
}

async function deleteRole(idx) {
  if (!isAdmin || !adminRolesCache[idx]) return;
  const role = adminRolesCache[idx];
  const roleName = role.role_name || role.roleId || `Role #${idx}`;
  showConfirmModal('Delete Role', `Are you sure you want to delete "${roleName}"? This cannot be undone.`, async () => {
    try {
      const traitType = role.type || 'collection';
      const traitValue = role.collection_id || role.mint || '';
      const response = await fetch(`/api/admin/roles/traits/${encodeURIComponent(traitType)}/${encodeURIComponent(traitValue)}`, { method: 'DELETE' });
      const data = await response.json();
      if (data.success) {
        showSuccess(`Role "${roleName}" deleted`);
        await loadAdminRoles();
      } else {
        showError(data.message || 'Failed to delete role');
      }
    } catch (e) {
      showError('Error deleting role: ' + e.message);
    }
  });
}

async function loadAdminStats() {
  if (!isAdmin) return;
  const content = document.getElementById('adminStatsContent');
  if (!content) return;

  try {
    const [usersRes, proposalsRes] = await Promise.all([
      fetch('/api/admin/users'),
      fetch('/api/admin/proposals')
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
    const response = await fetch('/api/admin/users');
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
        <td style="padding:8px; border-bottom:1px solid var(--border-color);">${escapeHtml(name)}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-color); font-family:monospace;">${escapeHtml(String(did))}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-color);">${escapeHtml(String(tier))}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-color);">${nfts}</td>
        <td style="padding:8px; border-bottom:1px solid var(--border-color);">${vp}</td>
      </tr>
    `;
  }).join('');

  content.innerHTML = `
    <div style="margin-bottom:10px; color: var(--text-secondary); font-size: 0.9em;">Showing ${Math.min(users.length, 100)} of ${users.length} users</div>
    <div style="overflow:auto; border:1px solid var(--border-color); border-radius:8px;">
      <table style="width:100%; border-collapse:collapse; font-size: 0.92em;">
        <thead>
          <tr style="background: var(--bg-tertiary); text-align:left;">
            <th style="padding:8px;">Username</th>
            <th style="padding:8px;">Discord ID</th>
            <th style="padding:8px;">Tier</th>
            <th style="padding:8px;">NFTs</th>
            <th style="padding:8px;">VP</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="margin-top:8px; color: var(--text-secondary); font-size: 0.85em;">Need advanced edits? Use the full admin panel.</div>
  `;
}

async function loadAdminActivity() {
  if (!isAdmin) return;
  const content = document.getElementById('adminActivityContent');
  if (!content) return;

  content.innerHTML = `<div style="text-align:center; padding: var(--space-5); color: var(--text-secondary);"><div class="spinner"></div><p>Loading activity...</p></div>`;

  try {
    // Build activity from real data (proposals + users)
    const [usersRes, proposalsRes] = await Promise.all([
      fetch('/api/admin/users'),
      fetch('/api/admin/proposals')
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
