// public/js/messages.js
let conversations = [];
let activeConvId = null;
let activeTargetUser = null;
let pollInterval = null;
let pendingImageFile = null;

document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;
  buildNav('messages');

  document.getElementById('ms-username').textContent = window.__user.username || window.__user.name;

  await loadConversations();

  // Check URL for active conversation or shared post
  const params = new URLSearchParams(window.location.search);
  const convId = params.get('id');
  const sharePostId = params.get('sharePost');

  if (convId) {
    openConversation(parseInt(convId));
  } else if (sharePostId) {
    openNewMessageModal(sharePostId);
  }

  // Polling for active conversation (every 3 seconds)
  pollInterval = setInterval(() => {
    if (activeConvId) loadMessages(activeConvId, true);
    loadConversations(true);
  }, 3000);

  // Layout handlers
  document.getElementById('mc-back').addEventListener('click', closeConversation);
  
  // New Message Modal
  ['ms-new-btn', 'mc-start-btn'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => openNewMessageModal());
  });
  document.getElementById('close-new-msg').addEventListener('click', () => {
    document.getElementById('new-msg-modal').classList.remove('open');
  });

  let searchTimeout;
  document.getElementById('new-msg-search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => searchUsers(e.target.value), 300);
  });

  // Input & Send
  const input = document.getElementById('mc-input');
  const sendBtn = document.getElementById('mc-send-btn');
  
  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim() && !pendingImageFile;
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !sendBtn.disabled) sendBtn.click();
  });
  sendBtn.addEventListener('click', sendMessage);

  // Image attach
  document.getElementById('mc-attach-btn').addEventListener('click', () => document.getElementById('mc-file-input').click());
  document.getElementById('mc-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      pendingImageFile = file;
      document.getElementById('mc-preview-img').src = URL.createObjectURL(file);
      document.getElementById('mc-upload-preview').style.display = 'block';
      sendBtn.disabled = false;
    }
  });
  document.getElementById('mc-preview-remove').addEventListener('click', () => {
    pendingImageFile = null;
    document.getElementById('mc-file-input').value = '';
    document.getElementById('mc-upload-preview').style.display = 'none';
    sendBtn.disabled = !input.value.trim();
  });
});

async function loadConversations(silent = false) {
  const list = document.getElementById('ms-list');
  if (!silent) list.innerHTML = '<div class="feed-loader"><div class="spinner"></div></div>';
  try {
    conversations = await api('/api/messages?action=conversations');
    if (!conversations.length) {
      if (!silent) list.innerHTML = '<div class="empty-state" style="border:none;margin-top:2rem">No messages</div>';
      return;
    }
    
    list.innerHTML = conversations.map(c => {
      const otherUser = c.members[0] || {};
      const msgText = c.last_message?.image_url ? 'Sent an image' : (c.last_message?.text || 'New message');
      const time = c.last_message ? timeAgo(c.last_message.created_at) : '';
      const unreadBadge = c.unread_count > 0 ? `<div class="ms-unread-badge">${c.unread_count}</div>` : '';
      const isActive = c.id === activeConvId ? 'active' : '';
      const activityStr = otherUser.show_activity ? (isOnline(otherUser.last_active) ? '<span class="online-dot"></span>' : '') : '';
      
      return `
        <div class="ms-item ${isActive} ${c.unread_count > 0 ? 'unread' : ''}" data-id="${c.id}" onclick="openConversation(${c.id})">
          <div class="ms-avatar-wrap">
            ${avatarHTML(otherUser, 56)}
            ${activityStr}
          </div>
          <div class="ms-item-info">
            <span class="ms-item-name">${esc(otherUser.name)}</span>
            <span class="ms-item-sub">${msgText} · ${time}</span>
          </div>
          ${unreadBadge}
        </div>
      `;
    }).join('');
  } catch (e) {
    if (!silent) list.innerHTML = `<div class="empty-state" style="border:none">Error loading messages</div>`;
  }
}

function isOnline(lastActive) {
  if (!lastActive) return false;
  const diff = Date.now() - new Date(lastActive).getTime();
  return diff < 5 * 60000; // 5 mins
}

async function openConversation(convId) {
  activeConvId = convId;
  const c = conversations.find(x => x.id === convId);
  if (c) {
    activeTargetUser = c.members[0];
    updateChatHeader(activeTargetUser);
  }
  
  document.getElementById('messages-sidebar').classList.add('hidden-mobile');
  document.getElementById('messages-chat').classList.add('active-mobile');
  document.getElementById('mc-empty').style.display = 'none';
  document.getElementById('mc-active').style.display = 'flex';
  
  // Highlight active
  document.querySelectorAll('.ms-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.ms-item[data-id="${convId}"]`)?.classList.add('active');

  await loadMessages(convId);
}

function updateChatHeader(user) {
  const info = document.getElementById('mc-user-info');
  info.href = `/profile.html?userId=${user.id}`;
  const status = user.show_activity ? (isOnline(user.last_active) ? 'Active now' : `Active ${timeAgo(user.last_active)}`) : '';
  info.innerHTML = `
    ${avatarHTML(user, 44)}
    <div class="mc-user-text">
      <strong>${esc(user.name)}</strong>
      <span>${status}</span>
    </div>
  `;
}

async function loadMessages(convId, silent = false) {
  const body = document.getElementById('mc-body');
  if (!silent) body.innerHTML = '<div class="feed-loader"><div class="spinner"></div></div>';
  
  try {
    const msgs = await api(`/api/messages?action=messages&conversationId=${convId}`);
    
    // Quick and dirty scroll check (if user is scrolled up, don't auto-scroll down)
    const isScrolledToBottom = body.scrollHeight - body.clientHeight <= body.scrollTop + 50;

    body.innerHTML = msgs.map((m, i) => {
      const isMine = m.sender_id === window.__user.id;
      const showAvatar = !isMine && (i === msgs.length - 1 || msgs[i+1].sender_id === window.__user.id);
      
      return `
        <div class="msg-row ${isMine ? 'mine' : 'theirs'}">
          ${!isMine ? `<div class="msg-avatar">${showAvatar ? avatarHTML({name:m.sender_name, avatar_url:m.sender_avatar}, 28) : ''}</div>` : ''}
          <div class="msg-bubble">
            ${m.image_url ? `<img src="${esc(m.image_url)}" class="msg-image" alt="Shared image"/>` : ''}
            ${m.text ? `<p>${linkifyCaption(m.text)}</p>` : ''}
          </div>
        </div>
      `;
    }).join('');

    if (!silent || isScrolledToBottom) {
      body.scrollTop = body.scrollHeight;
    }
  } catch {}
}

function closeConversation() {
  activeConvId = null;
  activeTargetUser = null;
  document.getElementById('messages-sidebar').classList.remove('hidden-mobile');
  document.getElementById('messages-chat').classList.remove('active-mobile');
  document.getElementById('mc-active').style.display = 'none';
  document.getElementById('mc-empty').style.display = 'flex';
  document.querySelectorAll('.ms-item').forEach(el => el.classList.remove('active'));
}

async function sendMessage() {
  if (!activeConvId) return;
  const input = document.getElementById('mc-input');
  const text = input.value.trim();
  const file = pendingImageFile;
  
  if (!text && !file) return;
  
  const sendBtn = document.getElementById('mc-send-btn');
  input.disabled = true;
  sendBtn.disabled = true;
  
  try {
    let image_url = null;
    if (file) {
      const uploadResult = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onloadend = async () => {
          try {
            const res = await api('/api/upload', {
              method: 'POST',
              body: { file: reader.result }
            });
            resolve(res.secure_url);
          } catch (err) {
            reject(err);
          }
        };
      });
      image_url = uploadResult;
    }

    await api('/api/messages?action=send', { method: 'POST', body: { conversationId: activeConvId, text, image_url } });
    
    // Clear and reload
    input.value = '';
    document.getElementById('mc-preview-remove').click();
    await loadMessages(activeConvId);
    loadConversations(true);
  } catch (e) { alert('Failed to send: ' + e.message); }
  finally {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

// ── New Message Modal ──
let sharePostIdCache = null;

function openNewMessageModal(sharePostId = null) {
  sharePostIdCache = sharePostId;
  document.getElementById('new-msg-modal').classList.add('open');
  document.getElementById('new-msg-search').value = '';
  document.getElementById('new-msg-results').innerHTML = '';
  setTimeout(() => document.getElementById('new-msg-search').focus(), 100);
}

async function searchUsers(query) {
  const q = query.trim();
  const container = document.getElementById('new-msg-results');
  if (q.length < 1) { container.innerHTML = ''; return; }
  
  container.innerHTML = '<div class="feed-loader"><div class="spinner"></div></div>';
  try {
    const data = await api(`/api/users?action=search&q=${encodeURIComponent(q)}`);
    if (!data.users.length) { container.innerHTML = '<div class="empty-state" style="border:none">No users found</div>'; return; }
    
    container.innerHTML = data.users.map(u => `
      <div class="search-result-item" style="cursor:pointer" onclick="startConversation(${u.id})">
        ${avatarHTML(u, 44)}
        <div class="search-result-info">
          <strong>${esc(u.username)}</strong>${verifiedBadge(u)}
          <span>${esc(u.name)}</span>
        </div>
      </div>
    `).join('');
  } catch { container.innerHTML = ''; }
}

window.startConversation = async (userId) => {
  try {
    const res = await api('/api/messages?action=start', { method: 'POST', body: { userId } });
    document.getElementById('new-msg-modal').classList.remove('open');
    
    if (sharePostIdCache) {
      // Send shared post immediately
      await api('/api/messages?action=send', { method: 'POST', body: { conversationId: res.conversationId, postId: sharePostIdCache, text: 'Shared a post' } });
      sharePostIdCache = null;
    }
    
    // Only fetch conversations list before opening it
    await loadConversations(true);
    openConversation(res.conversationId);
  } catch (e) { alert(e.message); }
};
