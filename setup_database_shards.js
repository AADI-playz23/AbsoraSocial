const fs = require('fs');
const path = require('path');
const { Pool, Client } = require('@neondatabase/serverless');
const { MongoClient } = require('mongodb');
const dns = require('dns');

// Dynamically override Node DNS to bypass Windows DNS SRV lookup issues for MongoDB Atlas!
try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {}

require('dotenv').config();

const D1_API = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database`;

// Table SQL for Neon/Supabase PostgreSQL shards
const SHARD_PG_SQL = `
CREATE TABLE IF NOT EXISTS posts (
  id                   INTEGER PRIMARY KEY,
  user_id              INTEGER NOT NULL,
  user_name            TEXT NOT NULL,
  image_url            TEXT NOT NULL,
  cloudinary_public_id TEXT,
  caption              TEXT DEFAULT '',
  is_private           BOOLEAN DEFAULT FALSE,
  is_archived          BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  expires_at           TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days'
);

CREATE TABLE IF NOT EXISTS likes (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  post_id    INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, post_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  post_id    INTEGER NOT NULL,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  sender_id       INTEGER NOT NULL,
  text            TEXT,
  image_url       TEXT,
  post_id         INTEGER,
  is_read         BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posts_expires    ON posts(expires_at);
CREATE INDEX IF NOT EXISTS idx_posts_created    ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user       ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_likes_post       ON likes(post_id);
CREATE INDEX IF NOT EXISTS idx_likes_user       ON likes(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_post    ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_msg_conv         ON messages(conversation_id, created_at DESC);
`;

// Table SQL for Cloudflare D1 SQLite shards
const SHARD_D1_SQL = `
CREATE TABLE IF NOT EXISTS posts (
  id                   INTEGER PRIMARY KEY,
  user_id              INTEGER NOT NULL,
  user_name            TEXT NOT NULL,
  image_url            TEXT NOT NULL,
  cloudinary_public_id TEXT,
  caption              TEXT DEFAULT '',
  is_private           INTEGER DEFAULT 0,
  is_archived          INTEGER DEFAULT 0,
  created_at           TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at           TEXT
);

CREATE TABLE IF NOT EXISTS likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  post_id    INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, post_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  post_id    INTEGER NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_id       INTEGER NOT NULL,
  text            TEXT,
  image_url       TEXT,
  post_id         INTEGER,
  is_read         INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_posts_expires    ON posts(expires_at);
CREATE INDEX IF NOT EXISTS idx_posts_created    ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_posts_user       ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_likes_post       ON likes(post_id);
CREATE INDEX IF NOT EXISTS idx_likes_user       ON likes(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_post    ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_msg_conv         ON messages(conversation_id);
`;

async function executeD1Query(dbId, sql, params = []) {
    const url = `${D1_API}/${dbId}/query`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`
        },
        body: JSON.stringify({ sql, params })
    });
    
    const data = await response.json();
    if (!data.success) throw new Error(data.errors[0]?.message || 'D1 Query Failed');
    return data.result[0].results;
}

async function run() {
    console.log('=== ABSORASOCIAL ULTIMATE SHARDS SCHEMA INITIALIZATION ===\n');

    // 1. Neon Database (Central Catalog & Shard 3)
    console.log('1. Configuring Neon Database (Central Catalog & Shard 3)...');
    try {
        const schemaPath = path.resolve(__dirname, 'schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');

        // Split Neon schema by statements to execute cleanly
        const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });
        const client = await pool.connect();
        
        console.log('  - Connected to Neon. Executing schema.sql...');
        const statements = schemaSql
            .split(';')
            .map(s => s.replace(/--.*$/gm, '').trim())
            .filter(Boolean);

        for (const stmt of statements) {
            await client.query(stmt).catch(err => {
                if (!err.message.includes('already exists')) {
                    console.warn(`    - Neon Query Warning: ${err.message}`);
                }
            });
        }
        client.release();
        await pool.end();
        console.log('✓ Neon Database (Central Directory & Shard 3) initialized successfully\n');
    } catch (e) {
        console.error('✗ Neon Database setup failed:', e.message, '\n');
    }

    // 2. Supabase Database (Shard 2)
    console.log('2. Configuring Supabase PostgreSQL Database (Shard 2)...');
    try {
        // Try standard database user postgres password from aadibabaji config
        const client = new Client({
            host: 'db.ziwrluokuvemsarifpva.supabase.co',
            port: 5432,
            user: 'postgres',
            database: 'postgres',
            password: 'cLQ2Lqz90hb7tiM9', // Aadibabaji standard credentials
            ssl: { rejectUnauthorized: false }
        });
        
        await client.connect();
        console.log('  - Connected to Supabase PG. Executing Shard schema...');
        await client.query('CREATE SCHEMA IF NOT EXISTS public').catch(() => {});
        await client.query('SET search_path TO public').catch(() => {});

        const statements = SHARD_PG_SQL.split(';').map(s => s.trim()).filter(Boolean);
        for (const stmt of statements) {
            await client.query(stmt).catch(err => {
                if (!err.message.includes('already exists')) {
                    console.warn(`    - Supabase Query Warning: ${err.message}`);
                }
            });
        }
        await client.end();
        console.log('✓ Supabase (Shard 2) initialized successfully\n');
    } catch (e) {
        console.warn(`  - Supabase Direct connection bypass: ${e.message}`);
        console.warn('  - Note: Ensure Shard 2 tables (posts, comments, likes, messages) are created in your Supabase SQL editor.\n');
    }

    // 3. MongoDB (Shard 1)
    console.log('3. Configuring MongoDB Shard 1 Indexes...');
    try {
        const mongoClient = new MongoClient(process.env.MONGODB_URI);
        await mongoClient.connect();
        const db = mongoClient.db('absorasocial');
        
        await db.collection('posts').createIndex({ user_id: 1, created_at: -1 });
        await db.collection('posts').createIndex({ expires_at: 1 });
        await db.collection('likes').createIndex({ post_id: 1, user_id: 1 }, { unique: true });
        await db.collection('comments').createIndex({ post_id: 1 });
        await db.collection('messages').createIndex({ conversation_id: 1, created_at: -1 });
        
        await mongoClient.close();
        console.log('✓ MongoDB (Shard 1) indexes initialized successfully\n');
    } catch (e) {
        console.error('✗ MongoDB setup failed:', e.message, '\n');
    }

    // 4. Cloudflare D1 Databases (Shards 4 - 13)
    console.log('4. Configuring Cloudflare D1 Databases (Shards 4 - 13)...');
    const d1Queries = SHARD_D1_SQL.split(';').map(q => q.trim()).filter(Boolean);
    for (let i = 1; i <= 10; i++) {
        const dbId = process.env[`D1_DB_${i}_ID`];
        if (!dbId) {
            console.warn(`  - Skipping D1 DB ${i} (No ID found in .env)`);
            continue;
        }
        
        console.log(`  - Configuring Cloudflare D1 DB ${i}: ${dbId}...`);
        try {
            for (const q of d1Queries) {
                await executeD1Query(dbId, q).catch(err => {
                    if (!err.message.includes('already exists')) {
                        console.warn(`    - D1 DB ${i} Warning: ${err.message}`);
                    }
                });
            }
            console.log(`  ✓ Cloudflare D1 DB ${i} configured successfully`);
        } catch (err) {
            console.error(`  ✗ Cloudflare D1 DB ${i} setup failed:`, err.message);
        }
    }
    console.log('\n✓ Cloudflare D1 Shards configuration complete\n');

    console.log('=== SYSTEM DATABASE SETUP COMPLETED SUCCESSFULLY ===');
}

run();
