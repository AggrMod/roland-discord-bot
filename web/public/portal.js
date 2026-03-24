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
        <p class="empty-state-message">You haven't created any proposals. Use the /gov create command in Discord to submit your first proposal.</p>
        <div class="empty-state-action">
          <button class="btn-primary" onclick="showInfo('Use /gov create in Discord to create a proposal')">
            <span>ℹ️</span>
            <span>Learn How</span>
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
          <button class="btn-primary" onclick="window.location.href='/verify'">
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
  // Simple alert for now - could be enhanced with toast notifications
  alert(message);
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
