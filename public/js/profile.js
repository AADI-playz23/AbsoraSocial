// public/js/profile.js
let profileUser = null;
let profileUserId = null;
let profileUsername = null;
let currentTab = 'posts';

document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;
  buildNav('profile');

  const params = new URLSearchParams(window.location.search);
  profileUserId = params.get('userId');
  profileUsername = params.get('username');

  if (!profileUserId && !profileUsername) {
    profileUserId = window.__user.id;
  }

  await loadProfile();
  await loadProfilePosts();

  // Tab switching
  document.querySelectorAll('.profile-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      loadProfilePosts();
    });
  });

  // Edit Profile
  document.getElementById('close-edit-profile')?.addEventListener('click', () => {
    document.getElementById('edit-profile-modal').classList.remove('open');
  });
  
  let avatarFile = null;
  document.getElementById('edit-avatar-btn')?.addEventListener('click', () => document.getElementById('avatar-input').click());
  document.getElementById('avatar-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      avatarFile = file;
      document.getElementById('edit-avatar-preview').innerHTML = `<img src="${URL.createObjectURL(file)}" alt="" style="width:80px;height:80px;border-radius:50%;object-fit:cover">`;
    }
  });

  document.getElementById('save-profile-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('save-profile-btn');
    const status = document.getElementById('edit-status');
    btn.disabled = true;
    try {
      let avatar_url = profileUser.avatar_url;
      if (avatarFile) {
        status.textContent = 'Uploading photo…';
        const sigRes = await api('/api/sign-upload', { method: 'POST' });
        const form = new FormData();
        form.append('file', avatarFile);
        form.append('api_key', sigRes.api_key);
        form.append('timestamp', String(sigRes.timestamp));
        form.append('signature', sigRes.signature);
        form.append('folder', sigRes.folder);
        const upRes = await fetch(`https://api.cloudinary.com/v1_1/${sigRes.cloud_name}/image/upload`, { method: 'POST', body: form });
        if (!upRes.ok) throw new Error('Upload failed');
        const upData = await upRes.json();
        avatar_url = upData.secure_url;
      }
      
      status.textContent = 'Saving…';
      const body = {
        name: document.getElementById('edit-name').value.trim(),
        username: document.getElementById('edit-username').value.trim(),
        bio: document.getElementById('edit-bio').value.trim(),
        is_private: document.getElementById('edit-private').checked,
        avatar_url
      };
      
      const updated = await api('/api/users?action=edit', { method: 'PUT', body });
      const session = getSession();
      session.user = updated;
      saveSession(session);
      
      window.location.reload();
    } catch (e) {
      status.textContent = e.message;
      btn.disabled = false;
    }
  });
});

async function loadProfile() {
  const container = document.getElementById('profile-header-container');
  try {
    const q = profileUsername ? `username=${encodeURIComponent(profileUsername)}` : `userId=${profileUserId}`;
    profileUser = await api(`/api/users?action=profile&${q}`);
    profileUserId = profileUser.id;
    
    // Show saved tab if own profile
    if (profileUser.is_own) {
      document.getElementById('tab-saved').style.display = 'block';
    }

    let actionsHtml = '';
    if (profileUser.is_own) {
      actionsHtml = `
        <button class="profile-btn" onclick="openEditProfile()">Edit Profile</button>
        <button class="profile-btn" onclick="document.getElementById('open-upload').click()">New Post</button>
      `;
    } else {
      actionsHtml = `
        <button class="profile-btn ${profileUser.is_following ? 'following' : 'primary'}" onclick="toggleFollow(${profileUser.id}, this)">
          ${profileUser.is_following ? 'Following' : 'Follow'}
        </button>
        <button class="profile-btn" onclick="messageUser(${profileUser.id})">Message</button>
      `;
    }

    container.innerHTML = `
      <header class="profile-header">
        <div class="profile-avatar-wrap">
          ${avatarHTML(profileUser, 150)}
        </div>
        <div class="profile-info">
          <div class="profile-title-row">
            <h1 class="profile-username">${esc(profileUser.username)} ${verifiedBadge(profileUser)}</h1>
            <div class="profile-actions">${actionsHtml}</div>
          </div>
          <div class="profile-stats">
            <span><strong>${profileUser.posts_count}</strong> posts</span>
            <span><strong>${profileUser.followers_count}</strong> followers</span>
            <span><strong>${profileUser.following_count}</strong> following</span>
          </div>
          <div class="profile-bio">
            <strong>${esc(profileUser.name)}</strong>
            <p>${linkifyCaption(profileUser.bio)}</p>
          </div>
        </div>
      </header>
    `;
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><h3>User not found</h3><p>${e.message}</p></div>`;
  }
}

async function loadProfilePosts() {
  const grid = document.getElementById('profile-grid');
  const empty = document.getElementById('profile-empty');
  if (!profileUserId) return;
  
  grid.innerHTML = '<div class="feed-loader" style="grid-column: 1 / -1"><div class="spinner"></div></div>';
  empty.style.display = 'none';

  try {
    const posts = await api(`/api/users?action=posts&userId=${profileUserId}&tab=${currentTab}`);
    if (!posts.length) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    
    grid.innerHTML = posts.map(p => `
      <div class="profile-grid-item">
        <img src="${esc(p.image_url)}" alt=""/>
        <div class="pgi-overlay">
          <span><svg width="18" height="18" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> ${p.like_count || 0}</span>
          ${p.comment_count !== undefined ? `<span><svg width="18" height="18" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> ${p.comment_count || 0}</span>` : ''}
        </div>
      </div>
    `).join('');
  } catch (e) {
    grid.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1"><h3>Failed to load</h3><p>${e.message}</p></div>`;
  }
}

window.openEditProfile = () => {
  if (!profileUser) return;
  document.getElementById('edit-name').value = profileUser.name || '';
  document.getElementById('edit-username').value = profileUser.username || '';
  document.getElementById('edit-bio').value = profileUser.bio || '';
  document.getElementById('edit-private').checked = profileUser.is_private || false;
  document.getElementById('edit-avatar-preview').innerHTML = avatarHTML(profileUser, 80);
  document.getElementById('edit-status').textContent = '';
  document.getElementById('edit-profile-modal').classList.add('open');
};

window.toggleFollow = async (userId, btn) => {
  const isFollowing = btn.classList.contains('following');
  const action = isFollowing ? 'unfollow' : 'follow';
  btn.classList.toggle('following');
  btn.classList.toggle('primary');
  btn.textContent = isFollowing ? 'Follow' : 'Following';
  try {
    await api(`/api/users?action=${action}`, { method: 'POST', body: { userId } });
    loadProfile(); // reload stats
  } catch {
    // Revert
    btn.classList.toggle('following');
    btn.classList.toggle('primary');
    btn.textContent = isFollowing ? 'Following' : 'Follow';
  }
};

window.messageUser = async (userId) => {
  try {
    const res = await api('/api/messages?action=start', { method: 'POST', body: { userId } });
    window.location.href = `/messages.html?id=${res.conversationId}`;
  } catch (e) { alert('Could not start message: ' + e.message); }
};
