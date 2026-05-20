-- ============================================================
-- AbsoraSocial — Complete Schema
-- Run this in your Neon SQL console
-- ============================================================

-- WIPE EVERYTHING FIRST (Full Clean)
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

-- ── USERS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  username      TEXT UNIQUE,
  name          TEXT NOT NULL,
  password      TEXT NOT NULL,
  bio           TEXT DEFAULT '',
  avatar_url    TEXT DEFAULT '',
  is_private    BOOLEAN DEFAULT FALSE,
  is_verified   BOOLEAN DEFAULT FALSE,
  show_activity BOOLEAN DEFAULT TRUE,
  last_active   TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── POSTS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id                   SERIAL PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name            TEXT NOT NULL,
  image_url            TEXT NOT NULL,
  cloudinary_public_id TEXT,
  caption              TEXT DEFAULT '',
  is_private           BOOLEAN DEFAULT FALSE,
  is_archived          BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  expires_at           TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days'
);

-- ── POST IMAGES (carousel) ──────────────────────────
CREATE TABLE IF NOT EXISTS post_images (
  id                   SERIAL PRIMARY KEY,
  post_id              INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  image_url            TEXT NOT NULL,
  cloudinary_public_id TEXT,
  sort_order           INTEGER DEFAULT 0
);

-- ── LIKES ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS likes (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, post_id)
);

-- ── COMMENTS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── FOLLOWS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS follows (
  id           SERIAL PRIMARY KEY,
  follower_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(follower_id, following_id),
  CHECK(follower_id != following_id)
);

-- ── HASHTAGS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hashtags (
  id   SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS post_hashtags (
  post_id    INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  hashtag_id INTEGER REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY(post_id, hashtag_id)
);

-- ── SAVED / BOOKMARKED ──────────────────────────────
CREATE TABLE IF NOT EXISTS saved_posts (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, post_id)
);

-- ── NOTIFICATIONS ───────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  post_id    INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  is_read    BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── STORIES ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stories (
  id                   SERIAL PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_url            TEXT NOT NULL,
  cloudinary_public_id TEXT,
  text_overlay         TEXT DEFAULT '',
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  expires_at           TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE TABLE IF NOT EXISTS story_views (
  story_id  INTEGER REFERENCES stories(id) ON DELETE CASCADE,
  user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(story_id, user_id)
);

-- ── HIGHLIGHTS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS highlights (
  id        SERIAL PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title     TEXT NOT NULL,
  cover_url TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS highlight_stories (
  highlight_id INTEGER REFERENCES highlights(id) ON DELETE CASCADE,
  story_id     INTEGER REFERENCES stories(id) ON DELETE CASCADE,
  PRIMARY KEY(highlight_id, story_id)
);

-- ── CONVERSATIONS & MESSAGES ────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id         SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text            TEXT,
  image_url       TEXT,
  post_id         INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  is_read         BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── BLOCKED USERS ───────────────────────────────────
CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(blocker_id, blocked_id)
);

-- ── REPORTS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id          SERIAL PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  reported_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── CLOSE FRIENDS ───────────────────────────────────
CREATE TABLE IF NOT EXISTS close_friends (
  user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, friend_id)
);

-- ── INDEXES ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_posts_expires    ON posts(expires_at);
CREATE INDEX IF NOT EXISTS idx_posts_created    ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user       ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_likes_post       ON likes(post_id);
CREATE INDEX IF NOT EXISTS idx_likes_user       ON likes(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_post    ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_notif_user       ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_user       ON saved_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_hashtags_name    ON hashtags(name);
CREATE INDEX IF NOT EXISTS idx_stories_user     ON stories(user_id);
CREATE INDEX IF NOT EXISTS idx_stories_expires  ON stories(expires_at);
CREATE INDEX IF NOT EXISTS idx_msg_conv         ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_member      ON conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_blocked          ON blocked_users(blocker_id);
CREATE INDEX IF NOT EXISTS idx_users_username   ON users(username);
