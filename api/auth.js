const { Pool } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const verifyToken = require('./_utils/authHelper');
const RateLimiter = require('./_utils/RateLimiter');

const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Rate Limiting (10 requests per minute per IP to prevent bot/brute force)
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  if (await RateLimiter.isRateLimited(ip, 'auth', 10, 60)) {
    return res.status(429).json({ error: 'Too many auth requests. Please slow down.' });
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const JWT_SECRET = process.env.NEON_DATABASE_URL.slice(-32);
  const action = req.query.action;
  const body = req.body || {};

  if (action === 'register') {
    const { email, password, name } = body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Name too short' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ chars' });

    let username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._]/g, '');
    try {
      const client = await pool.connect();
      const existing = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (existing.rows.length) {
        client.release();
        return res.status(409).json({ error: 'Email already registered' });
      }

      const uExists = await client.query('SELECT id FROM users WHERE username = $1', [username]);
      if (uExists.rows.length) username = username + Math.floor(Math.random() * 9999);

      const hash = await bcrypt.hash(password, 10);
      const result = await client.query(
        'INSERT INTO users (email, username, name, password) VALUES ($1, $2, $3, $4) RETURNING id, name, email, username, bio, avatar_url, is_verified',
        [email.toLowerCase(), username, name.trim(), hash]
      );
      const user = result.rows[0];
      client.release();

      const token = jwt.sign({ id: user.id, name: user.name, email: user.email, username: user.username }, JWT_SECRET);
      return res.status(201).json({ token, user });
    } catch (e) {
      return res.status(500).json({ error: 'Register failed: ' + e.message });
    }
  }

  if (action === 'login') {
    const { email, password } = body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    try {
      const client = await pool.connect();
      const result = await client.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
      const user = result.rows[0];
      if (!user) {
        client.release();
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        client.release();
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      await client.query('UPDATE users SET last_active = NOW() WHERE id = $1', [user.id]);
      client.release();

      const token = jwt.sign({ id: user.id, name: user.name, email: user.email, username: user.username }, JWT_SECRET);
      return res.status(200).json({ token, user: { id: user.id, name: user.name, email: user.email, username: user.username || '', bio: user.bio || '', avatar_url: user.avatar_url || '', is_verified: user.is_verified || false } });
    } catch (e) {
      return res.status(500).json({ error: 'Login failed: ' + e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
};
