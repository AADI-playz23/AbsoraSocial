// netlify/functions/sign-upload.js
const crypto = require('crypto');

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
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const DB = process.env.DATABASE_URL;
  if (!DB) return { statusCode: 500, headers, body: JSON.stringify({ error: 'DATABASE_URL not set' }) };

  const JWT_SECRET = DB.slice(-32);
  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  const user = verifyToken(token, JWT_SECRET);
  if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not logged in' }) };

  const CLOUD_SECRET = process.env.CLOUDINARY_API_SECRET;
  if (!CLOUD_SECRET) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Cloudinary not configured' }) };

  const timestamp = Math.round(Date.now() / 1000);
  const folder = 'absorasocial';
  const toSign = `folder=${folder}&timestamp=${timestamp}${CLOUD_SECRET}`;
  const signature = crypto.createHash('sha256').update(toSign).digest('hex');

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      signature, timestamp, folder,
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
    }),
  };
};
