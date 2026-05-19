// netlify/functions/messages.js
const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS' };
const ok  = (code, body) => ({ statusCode: code, headers: H, body: JSON.stringify(body) });
const err = (code, msg)  => ok(code, { error: msg });

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
  const DB = process.env.DATABASE_URL;
  if (!DB) return err(500, 'DATABASE_URL not set');
  const JWT_SECRET = DB.slice(-32);
  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  const user = verifyToken(token, JWT_SECRET);
  if (!user) return err(401, 'Not logged in');
  const sql = neon(DB);
  const qp = event.queryStringParameters || {};
  const action = qp.action || '';

  // Update last_active
  await sql`UPDATE users SET last_active=NOW() WHERE id=${user.id}`.catch(() => {});

  if (event.httpMethod === 'GET') {
    // List conversations
    if (action === 'conversations') {
      try {
        const convos = await sql`
          SELECT c.id, c.updated_at,
            (SELECT json_agg(json_build_object('id',u.id,'name',u.name,'username',u.username,'avatar_url',u.avatar_url,'is_verified',u.is_verified,'last_active',u.last_active,'show_activity',u.show_activity))
             FROM conversation_members cm2 JOIN users u ON u.id=cm2.user_id
             WHERE cm2.conversation_id=c.id AND cm2.user_id != ${user.id}) as members,
            (SELECT json_build_object('text',m.text,'sender_id',m.sender_id,'created_at',m.created_at,'image_url',m.image_url)
             FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
            (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id=c.id AND m.sender_id != ${user.id} AND m.is_read=false) as unread_count
          FROM conversations c
          JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=${user.id}
          ORDER BY c.updated_at DESC LIMIT 50`;
        return ok(200, convos);
      } catch (e) { return err(500, e.message); }
    }

    // Get messages in conversation
    if (action === 'messages') {
      const convId = parseInt(qp.conversationId);
      try {
        // Verify membership
        const [member] = await sql`SELECT 1 FROM conversation_members WHERE conversation_id=${convId} AND user_id=${user.id}`;
        if (!member) return err(403, 'Not a member');
        // Mark as read
        await sql`UPDATE messages SET is_read=true WHERE conversation_id=${convId} AND sender_id != ${user.id} AND is_read=false`;
        const msgs = await sql`
          SELECT m.id, m.text, m.image_url, m.post_id, m.sender_id, m.is_read, m.created_at,
                 u.name as sender_name, u.username as sender_username, u.avatar_url as sender_avatar
          FROM messages m JOIN users u ON u.id=m.sender_id
          WHERE m.conversation_id=${convId}
          ORDER BY m.created_at ASC LIMIT 200`;
        return ok(200, msgs);
      } catch (e) { return err(500, e.message); }
    }

    // Unread count total
    if (action === 'unread') {
      try {
        const [{count}] = await sql`
          SELECT COUNT(*)::int as count FROM messages m
          JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=${user.id}
          WHERE m.sender_id != ${user.id} AND m.is_read=false`;
        return ok(200, { unread: count });
      } catch (e) { return err(500, e.message); }
    }

    return err(400, 'Unknown action');
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); } catch { return err(400, 'Invalid JSON'); }

    // Start or find conversation
    if (action === 'start') {
      const targetId = parseInt(body.userId);
      if (targetId === user.id) return err(400, 'Cannot message yourself');
      try {
        // Check if conversation exists
        const existing = await sql`
          SELECT c.id FROM conversations c
          JOIN conversation_members cm1 ON cm1.conversation_id=c.id AND cm1.user_id=${user.id}
          JOIN conversation_members cm2 ON cm2.conversation_id=c.id AND cm2.user_id=${targetId}
          LIMIT 1`;
        if (existing.length) return ok(200, { conversationId: existing[0].id });
        // Create new
        const [conv] = await sql`INSERT INTO conversations DEFAULT VALUES RETURNING id`;
        await sql`INSERT INTO conversation_members (conversation_id,user_id) VALUES (${conv.id},${user.id}),(${conv.id},${targetId})`;
        return ok(201, { conversationId: conv.id });
      } catch (e) { return err(500, e.message); }
    }

    // Send message
    if (action === 'send') {
      const { conversationId, text, image_url, postId } = body;
      if (!conversationId) return err(400, 'conversationId required');
      if (!text && !image_url && !postId) return err(400, 'Message content required');
      try {
        const [member] = await sql`SELECT 1 FROM conversation_members WHERE conversation_id=${parseInt(conversationId)} AND user_id=${user.id}`;
        if (!member) return err(403, 'Not a member');
        const [msg] = await sql`
          INSERT INTO messages (conversation_id,sender_id,text,image_url,post_id)
          VALUES (${parseInt(conversationId)},${user.id},${text||null},${image_url||null},${postId?parseInt(postId):null})
          RETURNING id, created_at`;
        await sql`UPDATE conversations SET updated_at=NOW() WHERE id=${parseInt(conversationId)}`;
        return ok(201, { id: msg.id, created_at: msg.created_at });
      } catch (e) { return err(500, e.message); }
    }

    return err(400, 'Unknown action');
  }

  return err(405, 'Method not allowed');
};
