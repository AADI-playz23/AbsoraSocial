// public/js/common.js — Shared utilities across all pages
const SESSION_KEY = 'absorasocial_session';
const DARK_KEY = 'absorasocial_dark';

// ── Session ──
function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function saveSession(data) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  window.__user = data.user;
  window.__token = data.token;
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  window.__user = null;
  window.__token = null;
}
function requireAuth() {
  const s = getSession();
  if (s && s.token && s.user) {
    window.__user = s.user;
    window.__token = s.token;
    return true;
  }
  window.location.href = '/';
  return false;
}

// ── API Helper ──
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (window.__token) headers['Authorization'] = `Bearer ${window.__token}`;
  if (opts.body && typeof opts.body === 'object') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Utilities ──
function esc(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
function initials(name) { return name ? name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2) : '?'; }
function timeAgo(d) {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff/60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m/60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h/24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days/7)}w`;
}
function ttlLabel(exp) {
  const r = new Date(exp).getTime() - Date.now();
  if (r <= 0) return 'Expired';
  const h = Math.floor(r/3600000);
  if (h < 1) return '<1h left';
  if (h < 24) return `${h}h left`;
  return `${Math.floor(h/24)}d left`;
}
function avatarHTML(user, size = 32) {
  if (user.avatar_url) return `<img src="${esc(user.avatar_url)}" alt="" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover">`;
  return `<div class="avatar-initials" style="width:${size}px;height:${size}px;font-size:${size*0.38}px">${initials(user.name || user.user_name)}</div>`;
}
function verifiedBadge(user) {
  return user.is_verified ? '<svg class="verified-badge" width="14" height="14" viewBox="0 0 24 24" fill="#0095f6"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : '';
}
function linkifyCaption(text) {
  if (!text) return '';
  let s = esc(text);
  s = s.replace(/#(\w+)/g, '<a href="/explore.html?tag=$1" class="hashtag-link">#$1</a>');
  s = s.replace(/@(\w+)/g, '<a href="/profile.html?username=$1" class="mention-link">@$1</a>');
  return s;
}

// ── Dark Mode ──
function initDarkMode() {
  const saved = localStorage.getItem(DARK_KEY);
  if (saved === 'true' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
}
function toggleDarkMode() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem(DARK_KEY, isDark);
}
initDarkMode();

// ── Navigation ──
function buildNav(activePage) {
  const u = window.__user;
  if (!u) return;
  const nav = document.createElement('nav');
  nav.className = 'navbar';
  nav.innerHTML = `
    <a href="/" class="nav-logo">AbsoraSocial</a>
    <div class="nav-center">
      <div class="search-bar" id="global-search-bar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" placeholder="Search" id="global-search-input" autocomplete="off"/>
        <div class="search-dropdown" id="search-dropdown"></div>
      </div>
    </div>
    <div class="nav-right">
      <a href="/" class="nav-btn ${activePage==='home'?'active':''}" title="Home">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="${activePage==='home'?'currentColor':'none'}" stroke="currentColor" stroke-width="1.8"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      </a>
      <a href="/explore.html" class="nav-btn ${activePage==='explore'?'active':''}" title="Explore">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
      </a>
      <a href="/messages.html" class="nav-btn ${activePage==='messages'?'active':''}" title="Messages" id="nav-messages-btn">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        <span class="nav-badge" id="nav-msg-badge" style="display:none">0</span>
      </a>
      <button class="nav-btn" id="nav-notif-btn" title="Notifications">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        <span class="nav-badge" id="nav-notif-badge" style="display:none">0</span>
      </button>
      <button class="nav-btn" id="open-upload" title="New Post">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
      </button>
      <button class="nav-btn" id="dark-mode-toggle" title="Toggle Dark Mode">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
      <a href="/profile.html?userId=${u.id}" class="nav-avatar-wrap" title="Profile">
        <div class="nav-avatar">${initials(u.name)}</div>
      </a>
      <button class="nav-btn" id="logout-btn" title="Log out">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </button>
    </div>`;
  document.body.prepend(nav);

  // Bottom nav for mobile
  const bn = document.createElement('nav');
  bn.className = 'bottom-nav';
  bn.innerHTML = `
    <a href="/" class="bottom-nav-btn ${activePage==='home'?'active':''}"><svg width="22" height="22" viewBox="0 0 24 24" fill="${activePage==='home'?'currentColor':'none'}" stroke="currentColor" stroke-width="1.8"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></a>
    <a href="/explore.html" class="bottom-nav-btn ${activePage==='explore'?'active':''}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg></a>
    <button class="bottom-nav-btn" id="bottom-upload-btn"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg></button>
    <a href="/messages.html" class="bottom-nav-btn ${activePage==='messages'?'active':''}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></a>
    <a href="/profile.html?userId=${u.id}" class="bottom-nav-btn ${activePage==='profile'?'active':''}"><div class="nav-avatar" style="width:24px;height:24px;font-size:0.6rem">${initials(u.name)}</div></a>`;
  document.body.append(bn);

  // Notification panel
  const notifPanel = document.createElement('div');
  notifPanel.className = 'notif-panel';
  notifPanel.id = 'notif-panel';
  notifPanel.innerHTML = '<div class="notif-header"><h3>Notifications</h3></div><div class="notif-list" id="notif-list"><div class="notif-empty">No notifications yet</div></div>';
  document.body.append(notifPanel);

  // Event listeners
  document.getElementById('dark-mode-toggle')?.addEventListener('click', toggleDarkMode);
  document.getElementById('logout-btn')?.addEventListener('click', () => { clearSession(); window.location.href = '/'; });
  document.getElementById('nav-notif-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('notif-panel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) loadNotifications();
  });
  document.addEventListener('click', () => {
    document.getElementById('notif-panel')?.classList.remove('open');
    document.getElementById('search-dropdown')?.classList.remove('open');
  });
  document.getElementById('notif-panel')?.addEventListener('click', e => e.stopPropagation());

  // Global search
  let searchTimeout;
  const searchInput = document.getElementById('global-search-input');
  const searchDrop = document.getElementById('search-dropdown');
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = searchInput.value.trim();
    if (q.length < 1) { searchDrop.classList.remove('open'); return; }
    searchTimeout = setTimeout(async () => {
      try {
        const data = await api(`/api/users?action=search&q=${encodeURIComponent(q)}`);
        let html = '';
        if (data.users?.length) {
          data.users.forEach(u => {
            html += `<a href="/profile.html?username=${esc(u.username)}" class="search-result-item">
              ${avatarHTML(u, 36)}<div class="search-result-info"><strong>${esc(u.username)}</strong>${verifiedBadge(u)}<span>${esc(u.name)}</span></div></a>`;
          });
        }
        if (data.hashtags?.length) {
          data.hashtags.forEach(h => {
            html += `<a href="/explore.html?tag=${esc(h.name)}" class="search-result-item">
              <div class="search-hash-icon">#</div><div class="search-result-info"><strong>#${esc(h.name)}</strong><span>${h.post_count} posts</span></div></a>`;
          });
        }
        if (!html) html = '<div class="search-no-results">No results found</div>';
        searchDrop.innerHTML = html;
        searchDrop.classList.add('open');
      } catch {}
    }, 300);
  });
  searchInput?.addEventListener('focus', () => { if (searchDrop.innerHTML && searchInput.value.trim()) searchDrop.classList.add('open'); });

  // Poll for unread counts
  pollBadges();
  setInterval(pollBadges, 15000);
}

async function pollBadges() {
  if (!window.__token) return;
  try {
    const [notifs, msgs] = await Promise.all([
      api('/api/notifications').catch(() => ({ unread_count: 0 })),
      api('/api/messages?action=unread').catch(() => ({ unread: 0 }))
    ]);
    const nb = document.getElementById('nav-notif-badge');
    if (nb) { nb.textContent = notifs.unread_count; nb.style.display = notifs.unread_count > 0 ? '' : 'none'; }
    const mb = document.getElementById('nav-msg-badge');
    if (mb) { mb.textContent = msgs.unread; mb.style.display = msgs.unread > 0 ? '' : 'none'; }
  } catch {}
}

async function loadNotifications() {
  const list = document.getElementById('notif-list');
  if (!list) return;
  try {
    const data = await api('/api/notifications');
    await api('/api/notifications?action=read', { method: 'POST', body: {} });
    const nb = document.getElementById('nav-notif-badge');
    if (nb) { nb.style.display = 'none'; nb.textContent = '0'; }

    if (!data.notifications?.length) { list.innerHTML = '<div class="notif-empty">No notifications yet</div>'; return; }
    list.innerHTML = data.notifications.map(n => {
      let msg = '';
      if (n.type === 'like') msg = 'liked your post';
      else if (n.type === 'comment') msg = 'commented on your post';
      else if (n.type === 'follow') msg = 'started following you';
      else if (n.type === 'mention') msg = 'mentioned you in a comment';
      return `<div class="notif-item ${n.is_read ? '' : 'unread'}">
        <a href="/profile.html?username=${esc(n.actor_username)}">${avatarHTML({name:n.actor_name, avatar_url:n.actor_avatar}, 36)}</a>
        <div class="notif-body"><span><strong>${esc(n.actor_username)}</strong> ${msg}</span><time>${timeAgo(n.created_at)}</time></div>
        ${n.post_image ? `<img src="${esc(n.post_image)}" class="notif-thumb" alt="">` : ''}
      </div>`;
    }).join('');
  } catch {}
}
