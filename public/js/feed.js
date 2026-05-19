// public/js/feed.js
let feedMode = 'all';
let feedCursor = 0;
let feedLoading = false;
let feedDone = false;

function renderPost(post) {
  const card = document.createElement('article');
  card.className = 'post-card';
  card.dataset.id = post.id;
  const isOwn = window.__user && window.__user.id === post.user_id;

  card.innerHTML = `
    <div class="post-header">
      <a href="/profile.html?username=${esc(post.username)}" class="post-avatar-ring">
        <div class="post-avatar-inner">
          ${post.avatar_url ? `<img src="${esc(post.avatar_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` :
          `<div class="post-avatar-initials">${esc(initials(post.user_name))}</div>`}
        </div>
      </a>
      <div class="post-meta">
        <a href="/profile.html?username=${esc(post.username)}" class="post-name">${esc(post.username || post.user_name)}${verifiedBadge(post)}</a>
        ${post.is_private ? '<span class="post-badge-private">Private</span>' : ''}
      </div>
      <button class="post-more" data-id="${post.id}">···</button>
      <div class="post-menu" id="menu-${post.id}">
        ${isOwn ? `<button class="pm-item pm-delete" data-id="${post.id}">Delete</button>
                   <button class="pm-item pm-archive" data-id="${post.id}">Archive</button>` : 
                  `<button class="pm-item pm-report" data-id="${post.id}">Report</button>`}
        <button class="pm-item pm-cancel">Cancel</button>
      </div>
    </div>

    <div class="post-image-wrap">
      <img class="post-image" src="${esc(post.image_url)}" alt="${esc(post.caption)}" loading="lazy"/>
      <div class="double-tap-heart" id="dbl-${post.id}">
        <svg width="80" height="80" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      </div>
    </div>

    <div class="post-actions">
      <button class="post-action-btn like-btn ${post.is_liked ? 'liked' : ''}" data-id="${post.id}">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="${post.is_liked ? 'var(--red)' : 'none'}" stroke="${post.is_liked ? 'var(--red)' : 'currentColor'}" stroke-width="1.8">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      </button>
      <button class="post-action-btn comment-toggle-btn" data-id="${post.id}">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </button>
      <button class="post-action-btn share-btn" data-id="${post.id}">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
      <button class="post-action-btn post-save save-btn ${post.is_saved ? 'saved' : ''}" data-id="${post.id}">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="${post.is_saved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8"><polygon points="19 21 12 16 5 21 5 3 19 3"/></svg>
      </button>
    </div>

    <div class="post-likes">${(post.like_count || 0).toLocaleString()} like${post.like_count !== 1 ? 's' : ''}</div>

    ${post.caption ? `<div class="post-caption-row"><strong>${esc(post.username || post.user_name)}</strong> ${linkifyCaption(post.caption)}</div>` : ''}

    ${post.comment_count > 0 ? `<div class="post-comments-link" data-id="${post.id}">View all ${post.comment_count} comments</div>` : ''}

    <div class="post-comments" id="comments-${post.id}" style="display:none"></div>

    <div class="post-time">${timeAgo(post.created_at)} · ${ttlLabel(post.expires_at)}</div>

    <div class="post-add-comment">
      <input class="comment-input" placeholder="Add a comment…" data-id="${post.id}"/>
      <button class="comment-post-btn" data-id="${post.id}">Post</button>
    </div>`;

  // ── Event listeners ──

  // Like toggle
  card.querySelector('.like-btn').addEventListener('click', async function() {
    const liked = this.classList.contains('liked');
    const action = liked ? 'unlike' : 'like';
    this.classList.toggle('liked');
    const svg = this.querySelector('svg');
    svg.setAttribute('fill', !liked ? 'var(--red)' : 'none');
    svg.setAttribute('stroke', !liked ? 'var(--red)' : 'currentColor');
    try {
      const res = await api(`/api/posts?action=${action}`, { method: 'POST', body: { postId: post.id } });
      card.querySelector('.post-likes').textContent = `${res.like_count.toLocaleString()} like${res.like_count !== 1 ? 's' : ''}`;
    } catch {}
  });

  // Double-tap to like
  let lastTap = 0;
  card.querySelector('.post-image-wrap').addEventListener('click', async (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      const heart = card.querySelector('.double-tap-heart');
      heart.classList.add('show');
      setTimeout(() => heart.classList.remove('show'), 800);
      if (!card.querySelector('.like-btn').classList.contains('liked')) {
        card.querySelector('.like-btn').click();
      }
    }
    lastTap = now;
  });

  // Save toggle
  card.querySelector('.save-btn').addEventListener('click', async function() {
    const saved = this.classList.contains('saved');
    this.classList.toggle('saved');
    this.querySelector('svg').setAttribute('fill', !saved ? 'currentColor' : 'none');
    try { await api(`/api/posts?action=${saved ? 'unsave' : 'save'}`, { method: 'POST', body: { postId: post.id } }); }
    catch { this.classList.toggle('saved'); }
  });

  // Three-dot menu
  card.querySelector('.post-more').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = card.querySelector('.post-menu');
    document.querySelectorAll('.post-menu.open').forEach(m => m.classList.remove('open'));
    menu.classList.toggle('open');
  });
  card.querySelector('.pm-cancel')?.addEventListener('click', () => card.querySelector('.post-menu').classList.remove('open'));
  card.querySelector('.pm-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this post?')) return;
    try { await api(`/api/posts?postId=${post.id}`, { method: 'DELETE' }); card.remove(); } catch (e) { alert(e.message); }
  });
  card.querySelector('.pm-archive')?.addEventListener('click', async () => {
    try { await api('/api/posts?action=archive', { method: 'POST', body: { postId: post.id } }); card.remove(); } catch (e) { alert(e.message); }
  });
  card.querySelector('.pm-report')?.addEventListener('click', async () => {
    try { await api('/api/posts?action=report', { method: 'POST', body: { postId: post.id, reason: 'Inappropriate' } }); alert('Reported. Thank you.'); card.querySelector('.post-menu').classList.remove('open'); } catch {}
  });

  // Comments
  card.querySelector('.post-comments-link')?.addEventListener('click', () => toggleComments(post.id, card));
  card.querySelector('.comment-toggle-btn').addEventListener('click', () => {
    const input = card.querySelector('.comment-input');
    input.focus();
  });
  card.querySelector('.comment-post-btn').addEventListener('click', () => postComment(post.id, card));
  card.querySelector('.comment-input').addEventListener('keydown', e => { if (e.key === 'Enter') postComment(post.id, card); });

  // Share to DM
  card.querySelector('.share-btn')?.addEventListener('click', () => {
    if (confirm('Share this post via DM? (Opens messages)')) {
      window.location.href = `/messages.html?sharePost=${post.id}`;
    }
  });

  // Close menus on outside click
  document.addEventListener('click', () => document.querySelectorAll('.post-menu.open').forEach(m => m.classList.remove('open')));

  return card;
}

async function toggleComments(postId, card) {
  const container = card.querySelector(`#comments-${postId}`);
  if (container.style.display === 'none') {
    container.style.display = 'block';
    container.innerHTML = '<div class="comments-loading">Loading…</div>';
    try {
      const comments = await api(`/api/posts?action=comments&postId=${postId}`);
      if (!comments.length) { container.innerHTML = '<div class="comments-empty">No comments yet</div>'; return; }
      container.innerHTML = comments.map(c => `
        <div class="comment-item" data-cid="${c.id}">
          <a href="/profile.html?username=${esc(c.username)}" class="comment-avatar">${avatarHTML({name:c.user_name, avatar_url:c.avatar_url}, 28)}</a>
          <div class="comment-body">
            <span><strong>${esc(c.username || c.user_name)}</strong> ${linkifyCaption(c.text)}</span>
            <div class="comment-meta"><time>${timeAgo(c.created_at)}</time>
              ${c.user_id === window.__user?.id ? `<button class="comment-delete" data-cid="${c.id}">Delete</button>` : ''}
            </div>
          </div>
        </div>`).join('');
      container.querySelectorAll('.comment-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await api(`/api/posts?action=comment&commentId=${btn.dataset.cid}`, { method: 'DELETE' }); btn.closest('.comment-item').remove(); } catch {}
        });
      });
    } catch { container.innerHTML = '<div class="comments-empty">Failed to load</div>'; }
  } else {
    container.style.display = 'none';
  }
}

async function postComment(postId, card) {
  const input = card.querySelector('.comment-input');
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  try {
    const c = await api('/api/posts?action=comment', { method: 'POST', body: { postId, text } });
    input.value = '';
    // Show comments section
    const container = card.querySelector(`#comments-${postId}`);
    container.style.display = 'block';
    const commentEl = document.createElement('div');
    commentEl.className = 'comment-item';
    commentEl.innerHTML = `<div class="comment-body"><span><strong>${esc(c.username || c.user_name)}</strong> ${linkifyCaption(c.text)}</span><div class="comment-meta"><time>Just now</time></div></div>`;
    container.appendChild(commentEl);
    // Update count
    const link = card.querySelector('.post-comments-link');
    if (link) {
      const count = parseInt(link.textContent.match(/\d+/)?.[0] || 0) + 1;
      link.textContent = `View all ${count} comments`;
    }
  } catch (e) { console.error(e); }
  finally { input.disabled = false; }
}

async function loadFeed(reset = true) {
  if (reset) { feedCursor = 0; feedDone = false; }
  if (feedLoading || feedDone) return;
  feedLoading = true;

  const feed = document.getElementById('feed');
  const loader = document.getElementById('infinite-loader');
  if (reset) feed.innerHTML = '<div class="feed-loader"><div class="spinner"></div></div>';
  else if (loader) loader.style.display = 'flex';

  try {
    const data = await api(`/api/posts?mode=${feedMode}&cursor=${feedCursor}&limit=20`);
    if (reset) feed.innerHTML = '';
    if (!data.posts.length && feedCursor === 0) {
      feed.innerHTML = `<div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        <h3>No posts yet</h3><p>Be the first to share a photo.</p></div>`;
      return;
    }
    data.posts.forEach((post, i) => {
      const card = renderPost(post);
      card.style.animationDelay = `${i * 0.04}s`;
      feed.appendChild(card);
    });
    if (data.nextCursor) { feedCursor = data.nextCursor; } else { feedDone = true; }
  } catch (e) {
    if (reset) feed.innerHTML = `<div class="empty-state"><h3>Something went wrong</h3><p>${e.message}</p></div>`;
  } finally {
    feedLoading = false;
    if (loader) loader.style.display = 'none';
  }
}

// Feed tabs
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.feed-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.feed-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      feedMode = tab.dataset.mode;
      loadFeed(true);
    });
  });

  // Infinite scroll
  window.addEventListener('scroll', () => {
    if (feedDone || feedLoading) return;
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
      loadFeed(false);
    }
  });
});

window.loadFeed = loadFeed;
