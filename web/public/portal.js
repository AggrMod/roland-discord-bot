// Portal application state
let userData = null;
let isAdmin = false;
let heistEnabled = false;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  // Check for section query param
  const urlParams = new URLSearchParams(window.location.search);
  const section = urlParams.get('section');
  
  loadPortal();
  
  // Navigate to specific section if provided
  if (section) {
    setTimeout(() => switchSection(section), 500);
  }
});

async function loadPortal() {
  try {
    // Check feature flags
    const flagsResponse = await fetch('/api/features');
    if (flagsResponse.ok) {
      const flags = await flagsResponse.json();
      heistEnabled = flags.heistEnabled || false;
      
      // Show/hide heist nav item
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

function showAuthenticatedState() {
  // Update nav bar
  const avatarUrl = userData.user.avatar 
    ? `https://cdn.discordapp.com/avatars/${userData.user.discordId}/${userData.user.avatar}.png`
    : 'https://cdn.discordapp.com/embed/avatars/0.png';
  
  document.getElementById('navAvatar').src = avatarUrl;
  document.getElementById('navAvatar').style.display = 'block';
  document.getElementById('navUsername').textContent = userData.user.username;
  document.getElementById('navAuthBtn').textContent = 'Logout';
  document.getElementById('navAuthBtn').onclick = logout;

  // Show dashboard content
  document.getElementById('loginPrompt').style.display = 'none';
  document.getElementById('dashboardContent').style.display = 'block';
}

function showUnauthenticatedState() {
  document.getElementById('navAvatar').style.display = 'none';
  document.getElementById('navUsername').textContent = '';
  document.getElementById('navAuthBtn').textContent = 'Login';
  document.getElementById('navAuthBtn').onclick = login;

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

function loadDashboardData() {
  // Load stats
  document.getElementById('tierStat').textContent = userData.user.tier || 'None';
  document.getElementById('vpStat').textContent = userData.user.votingPower;
  document.getElementById('nftsStat').textContent = userData.user.totalNFTs;
  document.getElementById('pointsStat').textContent = userData.user.totalPoints;

  // Load recent activity
  renderRecentActivity();

  // Load proposals
  renderProposals();

  // Load wallets
  renderWallets();

  // Load missions (if heist enabled)
  if (heistEnabled) {
    renderMissions();
  }
}

function renderRecentActivity() {
  const container = document.getElementById('recentActivity');
  const activities = [];

  // Combine proposals and missions into activity feed
  userData.proposals.forEach(p => {
    activities.push({
      type: 'proposal',
      title: p.title,
      date: new Date(p.created_at),
      status: p.status
    });
  });

  if (heistEnabled) {
    userData.missions.forEach(m => {
      activities.push({
        type: 'mission',
        title: m.title,
        date: new Date(m.joined_at || m.created_at),
        status: m.status
      });
    });
  }

  // Sort by date
  activities.sort((a, b) => b.date - a.date);

  if (activities.length === 0) {
    container.innerHTML = '<div class="empty-state">No recent activity</div>';
    return;
  }

  container.innerHTML = activities.slice(0, 5).map(activity => `
    <div class="${activity.type}-item">
      <div class="${activity.type}-title">
        ${activity.type === 'proposal' ? '📜' : '🎯'} ${activity.title}
        <span class="status-badge status-${activity.status}">${activity.status}</span>
      </div>
      <div class="${activity.type}-meta">
        ${activity.date.toLocaleDateString()}
      </div>
    </div>
  `).join('');
}

function renderProposals() {
  const container = document.getElementById('myProposals');
  
  if (userData.proposals.length === 0) {
    container.innerHTML = '<div class="empty-state">No proposals created yet</div>';
    return;
  }

  container.innerHTML = userData.proposals.map(proposal => `
    <div class="proposal-item">
      <div class="proposal-title">
        ${proposal.title}
        <span class="status-badge status-${proposal.status}">${proposal.status.toUpperCase()}</span>
      </div>
      <div class="proposal-meta">
        ${proposal.proposal_id} • Created ${new Date(proposal.created_at).toLocaleDateString()}
      </div>
    </div>
  `).join('');

  // Also show in governance section
  loadActiveVotes();
}

async function loadActiveVotes() {
  try {
    const response = await fetch('/api/public/proposals/active');
    const data = await response.json();
    
    const container = document.getElementById('activeVotes');
    
    if (!data.success || data.proposals.length === 0) {
      container.innerHTML = '<div class="empty-state">No active proposals</div>';
      return;
    }

    container.innerHTML = data.proposals.map(proposal => `
      <div class="proposal-item">
        <div class="proposal-title">
          ${proposal.title}
          <span class="status-badge status-${proposal.status}">${proposal.status.toUpperCase()}</span>
        </div>
        <div class="proposal-meta">
          Yes: ${proposal.votes.yes.vp} VP (${proposal.votes.yes.count}) | 
          No: ${proposal.votes.no.vp} VP (${proposal.votes.no.count}) | 
          Quorum: ${proposal.quorum.current}%/${proposal.quorum.required}%
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading active votes:', error);
  }
}

function renderWallets() {
  const container = document.getElementById('walletsList');
  
  if (userData.wallets.length === 0) {
    container.innerHTML = '<div class="empty-state">No wallets linked. Click "Add Wallet" to get started.</div>';
    return;
  }

  container.innerHTML = userData.wallets.map(wallet => `
    <div class="wallet-item ${wallet.is_favorite ? 'favorite' : ''}">
      <span class="wallet-address">${wallet.is_favorite ? '⭐ ' : ''}${wallet.wallet_address}</span>
      <div class="wallet-actions">
        ${!wallet.is_favorite ? `<button class="btn-secondary" onclick="setFavorite('${wallet.wallet_address}')">Set Favorite</button>` : ''}
        <button class="btn-secondary" style="background: #dc3545; border-color: #dc3545; color: #fff;" onclick="removeWallet('${wallet.wallet_address}')">Remove</button>
      </div>
    </div>
  `).join('');
}

async function setFavorite(address) {
  try {
    const response = await fetch(`/api/user/wallets/${address}/favorite`, {
      method: 'POST'
    });
    const data = await response.json();

    if (data.success) {
      await loadPortal();
    } else {
      alert(data.message);
    }
  } catch (error) {
    console.error('Error setting favorite:', error);
    alert('Failed to set favorite wallet');
  }
}

async function removeWallet(address) {
  if (!confirm('Are you sure you want to remove this wallet?')) {
    return;
  }

  try {
    const response = await fetch(`/api/user/wallets/${address}`, {
      method: 'DELETE'
    });
    const data = await response.json();

    if (data.success) {
      await loadPortal();
    } else {
      alert(data.message);
    }
  } catch (error) {
    console.error('Error removing wallet:', error);
    alert('Failed to remove wallet');
  }
}

function renderMissions() {
  const container = document.getElementById('myMissions');
  
  if (userData.missions.length === 0) {
    container.innerHTML = '<div class="empty-state">No missions joined yet</div>';
    return;
  }

  container.innerHTML = userData.missions.map(mission => `
    <div class="mission-item">
      <div class="mission-title">
        ${mission.title}
        <span class="status-badge status-${mission.status}">${mission.status.toUpperCase()}</span>
      </div>
      <div class="mission-meta">
        ${mission.mission_id} • Role: ${mission.assigned_role} • NFT: ${mission.assigned_nft_name || 'N/A'}
        ${mission.points_awarded > 0 ? ` • Earned: ${mission.points_awarded} pts` : ''}
      </div>
    </div>
  `).join('');

  loadAvailableMissions();
}

async function loadAvailableMissions() {
  try {
    const response = await fetch('/api/public/missions/active');
    const data = await response.json();
    
    const container = document.getElementById('availableMissions');
    
    if (!data.success || data.missions.length === 0) {
      container.innerHTML = '<div class="empty-state">No missions available</div>';
      return;
    }

    container.innerHTML = data.missions.map(mission => `
      <div class="mission-item">
        <div class="mission-title">
          ${mission.title}
          <span class="status-badge status-${mission.status}">${mission.status.toUpperCase()}</span>
        </div>
        <div class="mission-meta">
          ${mission.description} • 
          Slots: ${mission.filledSlots}/${mission.totalSlots} • 
          Reward: ${mission.rewardPoints} pts
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading available missions:', error);
  }
}

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
  document.getElementById(`section-${sectionName}`).classList.add('active');

  // Load data for specific sections
  if (sectionName === 'governance' && userData) {
    loadActiveVotes();
  } else if (sectionName === 'heist' && userData && heistEnabled) {
    loadAvailableMissions();
  }
}

function toggleHelp(categoryId) {
  // Hide all help content
  document.querySelectorAll('.help-content').forEach(content => {
    content.style.display = 'none';
  });

  // Show selected help content
  const content = document.getElementById(`help-${categoryId}`);
  if (content) {
    content.style.display = 'block';
    content.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function login() {
  window.location.href = '/auth/discord/login';
}

function logout() {
  window.location.href = '/auth/discord/logout';
}

function handleAuth() {
  if (userData) {
    logout();
  } else {
    login();
  }
}

function toggleMobileMenu() {
  const menu = document.getElementById('mobileMenu');
  if (menu.style.display === 'block') {
    menu.style.display = 'none';
  } else {
    menu.style.display = 'block';
  }
}
