// public/js/stories.js
let storyData = [];
let currentGroupIndex = 0;
let currentStoryIndex = 0;
let storyTimer = null;
let storyProgressInterval = null;

async function loadStories() {
  try {
    storyData = await api('/api/stories?action=feed');
    renderStoriesBar();
  } catch {}
}

function renderStoriesBar() {
  const bar = document.getElementById('stories-bar');
  if (!bar) return;
  // Remove old story items (keep the add button)
  bar.querySelectorAll('.story-item').forEach(el => el.remove());
  const addBtn = bar.querySelector('.story-add');

  storyData.forEach((group, gi) => {
    const item = document.createElement('div');
    item.className = 'story-item';
    const isOwn = group.user_id === window.__user?.id;
    item.innerHTML = `
      <div class="story-ring ${group.all_viewed ? 'viewed' : ''}">
        <div class="story-ring-inner">
          ${group.avatar_url ? `<img src="${esc(group.avatar_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` :
          `<div class="post-avatar-initials" style="width:100%;height:100%;font-size:1rem">${initials(group.user_name)}</div>`}
        </div>
      </div>
      <span class="story-name">${isOwn ? 'Your Story' : esc(group.username || group.user_name)}</span>`;
    item.addEventListener('click', () => openStoryViewer(gi));
    bar.insertBefore(item, addBtn.nextSibling);
  });
}

function openStoryViewer(groupIndex) {
  currentGroupIndex = groupIndex;
  currentStoryIndex = 0;
  const viewer = document.getElementById('story-viewer');
  viewer.classList.add('open');
  showStory();
}

function showStory() {
  const group = storyData[currentGroupIndex];
  if (!group) { closeStoryViewer(); return; }
  const story = group.stories[currentStoryIndex];
  if (!story) { nextGroup(); return; }

  // Header
  document.getElementById('story-header').innerHTML = `
    <a href="/profile.html?username=${esc(group.username)}" class="story-user">
      ${avatarHTML({ name: group.user_name, avatar_url: group.avatar_url }, 32)}
      <span class="story-username">${esc(group.username || group.user_name)}</span>
      <time>${timeAgo(story.created_at)}</time>
    </a>`;

  // Image
  document.getElementById('story-image').src = story.image_url;
  document.getElementById('story-text-overlay').textContent = story.text_overlay || '';

  // Progress bars
  const progressContainer = document.getElementById('story-progress');
  progressContainer.innerHTML = group.stories.map((_, i) =>
    `<div class="story-progress-bar ${i < currentStoryIndex ? 'done' : ''} ${i === currentStoryIndex ? 'active' : ''}"><div class="story-progress-fill"></div></div>`
  ).join('');

  // Mark as viewed
  if (!story.is_viewed && window.__token) {
    api('/api/stories?action=view', { method: 'POST', body: { storyId: story.id } }).catch(() => {});
    story.is_viewed = true;
  }

  // Auto-advance timer (5 seconds per story)
  clearTimeout(storyTimer);
  clearInterval(storyProgressInterval);
  const fill = progressContainer.querySelector('.active .story-progress-fill');
  if (fill) {
    fill.style.transition = 'none';
    fill.style.width = '0%';
    requestAnimationFrame(() => {
      fill.style.transition = 'width 5s linear';
      fill.style.width = '100%';
    });
  }
  storyTimer = setTimeout(() => nextStory(), 5000);
}

function nextStory() {
  const group = storyData[currentGroupIndex];
  if (currentStoryIndex < group.stories.length - 1) {
    currentStoryIndex++;
    showStory();
  } else {
    nextGroup();
  }
}

function prevStory() {
  if (currentStoryIndex > 0) {
    currentStoryIndex--;
    showStory();
  } else if (currentGroupIndex > 0) {
    currentGroupIndex--;
    currentStoryIndex = storyData[currentGroupIndex].stories.length - 1;
    showStory();
  }
}

function nextGroup() {
  if (currentGroupIndex < storyData.length - 1) {
    currentGroupIndex++;
    currentStoryIndex = 0;
    showStory();
  } else {
    closeStoryViewer();
  }
}

function closeStoryViewer() {
  clearTimeout(storyTimer);
  clearInterval(storyProgressInterval);
  document.getElementById('story-viewer').classList.remove('open');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('story-close')?.addEventListener('click', closeStoryViewer);
  document.getElementById('story-prev')?.addEventListener('click', prevStory);
  document.getElementById('story-next')?.addEventListener('click', nextStory);

  // Keyboard nav
  document.addEventListener('keydown', e => {
    if (!document.getElementById('story-viewer')?.classList.contains('open')) return;
    if (e.key === 'ArrowRight') nextStory();
    else if (e.key === 'ArrowLeft') prevStory();
    else if (e.key === 'Escape') closeStoryViewer();
  });
});

window.loadStories = loadStories;
