// public/js/upload.js
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('upload-modal');
  const zone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-input');
  const placeholder = document.getElementById('upload-placeholder');
  const previewImg = document.getElementById('preview-img');
  const captionEl = document.getElementById('caption-input');
  const captionLen = document.getElementById('caption-len');
  const privateEl = document.getElementById('is-private');
  const postBtn = document.getElementById('post-btn');
  const statusEl = document.getElementById('post-status');
  const filterBar = document.getElementById('filter-bar');

  let selectedFile = null;
  let currentFilter = 'none';

  // Open modal
  document.addEventListener('click', e => {
    if (e.target.closest('#open-upload') || e.target.closest('#bottom-upload-btn') || e.target.closest('#story-add-btn')) {
      modal.classList.add('open');
    }
  });

  function closeModal() { modal.classList.remove('open'); reset(); }
  document.getElementById('close-upload')?.addEventListener('click', closeModal);
  modal?.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  function reset() {
    selectedFile = null; currentFilter = 'none';
    if (fileInput) fileInput.value = '';
    if (previewImg) { previewImg.hidden = true; previewImg.src = ''; previewImg.style.filter = 'none'; }
    if (placeholder) placeholder.hidden = false;
    if (captionEl) captionEl.value = '';
    if (captionLen) captionLen.textContent = '0';
    if (privateEl) privateEl.checked = false;
    if (postBtn) postBtn.disabled = false;
    if (statusEl) statusEl.textContent = '';
    if (filterBar) filterBar.style.display = 'none';
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.filter-btn[data-filter="none"]')?.classList.add('active');
  }

  // Caption counter
  captionEl?.addEventListener('input', () => {
    if (captionLen) captionLen.textContent = captionEl.value.length;
  });

  // File pick
  zone?.addEventListener('click', e => {
    if (e.target.classList.contains('upload-cta')) return;
    if (!selectedFile) fileInput.click();
  });
  fileInput?.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });
  zone?.addEventListener('dragover', e => e.preventDefault());
  zone?.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) setFile(f);
  });

  function setFile(file) {
    selectedFile = file;
    previewImg.src = URL.createObjectURL(file);
    previewImg.hidden = false;
    placeholder.hidden = true;
    filterBar.style.display = 'flex';
  }

  // Filters
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      previewImg.style.filter = currentFilter === 'none' ? 'none' : currentFilter;
    });
  });

  // Post
  postBtn?.addEventListener('click', async () => {
    if (!selectedFile) { statusEl.textContent = 'Pick a photo first.'; return; }
    if (!window.__token) { statusEl.textContent = 'Not logged in.'; return; }
    postBtn.disabled = true;

    try {
      statusEl.textContent = 'Preparing upload…';
      const sigRes = await api('/api/sign-upload', { method: 'POST' });

      statusEl.textContent = 'Uploading photo…';
      const form = new FormData();
      form.append('file', selectedFile);
      form.append('api_key', sigRes.api_key);
      form.append('timestamp', String(sigRes.timestamp));
      form.append('signature', sigRes.signature);
      form.append('folder', sigRes.folder);

      const upRes = await fetch(`https://api.cloudinary.com/v1_1/${sigRes.cloud_name}/image/upload`, { method: 'POST', body: form });
      if (!upRes.ok) { const e = await upRes.json().catch(() => ({})); throw new Error(e.error?.message || 'Upload failed'); }
      const upData = await upRes.json();

      statusEl.textContent = 'Sharing…';
      await api('/api/posts', { method: 'POST', body: {
        image_url: upData.secure_url,
        cloudinary_public_id: upData.public_id,
        caption: captionEl.value.trim(),
        is_private: privateEl.checked,
      }});

      statusEl.textContent = 'Posted! ✓';
      setTimeout(() => { closeModal(); loadFeed(); }, 600);
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
      postBtn.disabled = false;
    }
  });
});
