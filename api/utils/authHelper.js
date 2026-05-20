const jwt = require('jsonwebtoken');

/**
 * Standardized JWT Verification Middleware helper for Vercel Serverless Functions.
 * Parses the Authorization header and verifies the signature using the database URL slice secret.
 */
module.exports = function verifyToken(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;
  
  try {
    const JWT_SECRET = process.env.NEON_DATABASE_URL.slice(-32);
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (error) {
    return null;
  }
};
