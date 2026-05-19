// public/js/auth.js
document.addEventListener('DOMContentLoaded', () => {
  // Tab switcher
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      document.getElementById('login-error').textContent = '';
      document.getElementById('register-error').textContent = '';
    });
  });

  function showError(id, msg) { document.getElementById(id).textContent = msg; }

  // Login
  document.getElementById('login-btn').addEventListener('click', async () => {
    const btn = document.getElementById('login-btn');
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    showError('login-error', '');
    if (!email || !password) { showError('login-error', 'Fill in all fields.'); return; }
    btn.disabled = true; btn.textContent = 'Logging in…';
    try {
      const data = await api('/api/auth?action=login', { method: 'POST', body: { email, password } });
      saveSession(data);
      enterApp(data.user);
    } catch (e) { showError('login-error', e.message || 'Login failed'); }
    finally { btn.disabled = false; btn.textContent = 'Log In'; }
  });

  // Register
  document.getElementById('register-btn').addEventListener('click', async () => {
    const btn = document.getElementById('register-btn');
    const name = document.getElementById('reg-name').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    showError('register-error', '');
    if (!name || !email || !password) { showError('register-error', 'Fill in all fields.'); return; }
    if (password.length < 6) { showError('register-error', 'Password must be 6+ chars.'); return; }
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const data = await api('/api/auth?action=register', { method: 'POST', body: { name, email, password } });
      saveSession(data);
      enterApp(data.user);
    } catch (e) { showError('register-error', e.message || 'Registration failed'); }
    finally { btn.disabled = false; btn.textContent = 'Sign Up'; }
  });

  // Enter key support
  ['login-email', 'login-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-btn').click(); });
  });
  ['reg-name', 'reg-email', 'reg-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('register-btn').click(); });
  });

  // Restore session
  const s = getSession();
  if (s && s.token && s.user) {
    window.__user = s.user;
    window.__token = s.token;
    enterApp(s.user);
  }
});

function enterApp(user) {
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');

  // Build nav
  buildNav('home');

  // Sidebar
  const sbName = document.getElementById('sb-name');
  const sbAv = document.getElementById('sb-avatar');
  const mdAv = document.getElementById('md-avatar');
  const mdName = document.getElementById('md-name');
  const sbLink = document.getElementById('sb-profile-link');
  if (sbName) sbName.textContent = user.name;
  if (sbAv) sbAv.textContent = initials(user.name);
  if (mdAv) mdAv.textContent = initials(user.name);
  if (mdName) mdName.textContent = user.name;
  if (sbLink) sbLink.href = `/profile.html?userId=${user.id}`;

  // Load feed and stories
  if (typeof loadFeed === 'function') loadFeed();
  if (typeof loadStories === 'function') loadStories();
}
