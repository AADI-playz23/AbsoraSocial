// public/js/explore.js
let exploreCursor = 0;
let exploreLoading = false;
let exploreDone = false;
let currentTag = null;

document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;
  buildNav('explore');

  const params = new URLSearchParams(window.location.search);
  currentTag = params.get('tag');

  if (currentTag) {
    await loadHashtag();
  } else {
    await loadTrendingTags();
    await loadExploreFeed();
  }

  // Infinite scroll
  window.addEventListener('scroll', () => {
    if (exploreDone || exploreLoading || currentTag) return;
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
      loadExploreFeed();
    }
  });
});

async function loadTrendingTags() {
  const container = document.getElementById('trending-tags');
  try {
    const tags = await api('/api/explore?action=tags');
    if (tags.length) {
      container.innerHTML = tags.map(t => `<a href="/explore.html?tag=${esc(t.name)}" class="trending-tag-btn">#${esc(t.name)}</a>`).join('');
    }
  } catch {}
}

async function loadHashtag() {
  const header = document.getElementById('explore-header');
  const grid = document.getElementById('explore-grid');
  
  try {
    const data = await api(`/api/explore?action=hashtag&tag=${encodeURIComponent(currentTag)}`);
    header.style.display = 'flex';
    header.innerHTML = `
      <div class="explore-hash-icon">#</div>
      <div class="explore-header-info">
        <h1>#${esc(data.tag)}</h1>
        <span><strong>${data.post_count}</strong> posts</span>
      </div>
    `;

    renderGrid(data.posts, grid);
  } catch (e) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Not found</h3><p>${e.message}</p></div>`;
  }
}

async function loadExploreFeed() {
  if (exploreLoading || exploreDone) return;
  exploreLoading = true;
  
  const grid = document.getElementById('explore-grid');
  const loader = document.getElementById('infinite-loader');
  if (exploreCursor > 0) loader.style.display = 'flex';

  try {
    const data = await api(`/api/explore?action=trending&cursor=${exploreCursor}`);
    if (exploreCursor === 0) grid.innerHTML = '';
    
    if (!data.posts.length && exploreCursor === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>No posts found</h3></div>`;
      return;
    }

    renderGrid(data.posts, grid, true);
    
    if (data.nextCursor) { exploreCursor = data.nextCursor; } else { exploreDone = true; }
  } catch (e) {
    if (exploreCursor === 0) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Error</h3><p>${e.message}</p></div>`;
  } finally {
    exploreLoading = false;
    loader.style.display = 'none';
  }
}

function renderGrid(posts, grid, append = false) {
  let html = posts.map(p => `
    <div class="profile-grid-item">
      <img src="${esc(p.image_url)}" alt=""/>
      <div class="pgi-overlay">
        <span><svg width="18" height="18" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> ${p.like_count || 0}</span>
        ${p.comment_count !== undefined ? `<span><svg width="18" height="18" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> ${p.comment_count || 0}</span>` : ''}
      </div>
    </div>
  `).join('');
  
  if (append) {
    grid.insertAdjacentHTML('beforeend', html);
  } else {
    grid.innerHTML = html;
  }
}
