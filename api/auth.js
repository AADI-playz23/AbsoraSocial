// netlify/functions/auth.js
const { neon } = require('@neondatabase/serverless');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');

const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS' };
const ok  = (code, body) => ({ statusCode: code, headers: H, body: JSON.stringify(body) });
const err = (code, msg)  => ok(code, { error: msg });

function makeToken(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifyToken(token, secret) {
  if (!token) return null;
  try {
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return ok(200, '');
  if (event.httpMethod !== 'POST') return err(405, 'Method not allowed');

  const DB = process.env.DATABASE_URL;
  if (!DB) return err(500, 'DATABASE_URL not set');
  const JWT_SECRET = DB.slice(-32);
  const action = event.queryStringParameters?.action;

  let body;
  try { body = JSON.parse(event.body); }
  catch { return err(400, 'Invalid JSON'); }

  const sql = neon(DB);

  if (action === 'register') {
    const { email, password, name } = body;
    if (!email || !password) return err(400, 'Email and password required');
    if (!name || name.trim().length < 2) return err(400, 'Name too short');
    if (password.length < 6) return err(400, 'Password must be 6+ chars');

    // Auto-generate username from email
    let username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._]/g, '');
    try {
      const existing = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
      if (existing.length) return err(409, 'Email already registered');

      // Ensure unique username
      const uExists = await sql`SELECT id FROM users WHERE username = ${username}`;
      if (uExists.length) username = username + Math.floor(Math.random() * 9999);

      const hash = await bcrypt.hash(password, 10);
      const [user] = await sql`
        INSERT INTO users (email, username, name, password)
        VALUES (${email.toLowerCase()}, ${username}, ${name.trim()}, ${hash})
        RETURNING id, name, email, username, bio, avatar_url, is_verified
      `;
      const token = makeToken({ id: user.id, name: user.name, email: user.email, username: user.username }, JWT_SECRET);
      return ok(201, { token, user: { id: user.id, name: user.name, email: user.email, username: user.username, bio: '', avatar_url: '', is_verified: false } });
    } catch (e) {
      return err(500, 'Register failed: ' + e.message);
    }
  }

  if (action === 'login') {
    const { email, password } = body;
    if (!email || !password) return err(400, 'Email and password required');
    try {
      const [user] = await sql`SELECT * FROM users WHERE email = ${email.toLowerCase()}`;
      if (!user) return err(401, 'Invalid email or password');

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return err(401, 'Invalid email or password');

      // Update last_active
      await sql`UPDATE users SET last_active = NOW() WHERE id = ${user.id}`;

      const token = makeToken({ id: user.id, name: user.name, email: user.email, username: user.username }, JWT_SECRET);
      return ok(200, { token, user: { id: user.id, name: user.name, email: user.email, username: user.username || '', bio: user.bio || '', avatar_url: user.avatar_url || '', is_verified: user.is_verified || false } });
    } catch (e) {
      return err(500, 'Login failed: ' + e.message);
    }
  }

  return err(400, 'Unknown action');
};
