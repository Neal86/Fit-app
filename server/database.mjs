import './runtime.mjs'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { digest } from './security.mjs'
import { fail } from './errors.mjs'

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path, { timeout: 5000 })
  if (path !== ':memory:') chmodSync(path, 0o600)
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF;')
    transaction(db, () => {
      // Read under the write lock: concurrent startup must not apply an old migration twice.
      const version = db.prepare('PRAGMA user_version').get().user_version
      if (version > 5) throw new Error('Database schema is newer than this server.')
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
          verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)), created_at INTEGER NOT NULL,
          consent INTEGER NOT NULL DEFAULT 0 CHECK(consent IN (0,1)), consent_policy TEXT,
          consent_at INTEGER, revision INTEGER NOT NULL DEFAULT 0, state_json TEXT, state_at INTEGER,
          verify_generation TEXT NOT NULL DEFAULT '', reset_generation TEXT NOT NULL DEFAULT '',
          pending_password_hash TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
        CREATE TABLE IF NOT EXISTS email_tokens (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')), expires_at INTEGER NOT NULL,
          ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)), password_hash TEXT,
          generation TEXT NOT NULL DEFAULT ''
        ) STRICT;
        CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, purpose);
        CREATE TABLE IF NOT EXISTS sync_operations (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_id TEXT NOT NULL,
          request_hash TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(user_id,operation_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS rate_limits (
          key_hash TEXT PRIMARY KEY, count INTEGER NOT NULL, window_end INTEGER NOT NULL
        ) STRICT;
      `)
      if (version === 1) {
        db.exec(`
          ALTER TABLE users ADD COLUMN verify_generation TEXT NOT NULL DEFAULT '';
          ALTER TABLE users ADD COLUMN reset_generation TEXT NOT NULL DEFAULT '';
          ALTER TABLE users ADD COLUMN pending_password_hash TEXT;
          ALTER TABLE email_tokens ADD COLUMN generation TEXT NOT NULL DEFAULT '';
          -- The v1 race means unverified password binding cannot be trusted after upgrade.
          -- Require a fresh registration instead of resurrecting an older requested password.
          UPDATE users SET password_hash = '', pending_password_hash = NULL WHERE verified = 0;
          -- Tokens issued without a generation cannot safely survive this security migration.
          DELETE FROM email_tokens;
        `)
      }
      // Additive v2 -> v3 migration: no existing account, security, or snapshot field changes.
      db.exec(`
        CREATE TABLE IF NOT EXISTS coaching_relationships (
          id TEXT PRIMARY KEY,
          athlete_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          coach_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('pending','active','revoked','declined','expired','cancelled')),
          version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
          training INTEGER NOT NULL DEFAULT 0 CHECK(training IN (0,1)),
          body INTEGER NOT NULL DEFAULT 0 CHECK(body IN (0,1)),
          nutrition INTEGER NOT NULL DEFAULT 0 CHECK(nutrition IN (0,1)),
          consent_policy TEXT, consent_at INTEGER,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, revoked_at INTEGER,
          CHECK(athlete_id <> coach_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS coaching_athlete ON coaching_relationships(athlete_id);
        CREATE INDEX IF NOT EXISTS coaching_coach ON coaching_relationships(coach_id);
        CREATE UNIQUE INDEX IF NOT EXISTS coaching_open_pair ON coaching_relationships(athlete_id,coach_id)
          WHERE status IN ('pending','active');
        CREATE TABLE IF NOT EXISTS coaching_feedback (
          id TEXT PRIMARY KEY,
          relationship_id TEXT NOT NULL REFERENCES coaching_relationships(id) ON DELETE CASCADE,
          operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
          text TEXT, created_at INTEGER NOT NULL, removed_at INTEGER,
          UNIQUE(relationship_id,operation_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS coaching_feedback_relationship ON coaching_feedback(relationship_id);
        CREATE TABLE IF NOT EXISTS coaching_invitation_budgets (
          athlete_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 50)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS coaching_global_budget (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 10000)
        ) STRICT;
      `)
      if (version < 4) {
        // v3 recorded eligible rows only. Seed once, then charge every valid attempt
        // equally so later capacity cannot disclose whether a target account exists.
        db.exec(`
          INSERT INTO coaching_invitation_budgets(athlete_id,attempts)
            SELECT athlete_id, MIN(COUNT(*), 50) FROM coaching_relationships GROUP BY athlete_id;
          INSERT INTO coaching_global_budget(id,attempts)
            SELECT 1, MIN(COUNT(*), 10000) FROM coaching_relationships;
        `)
      }
      // Additive v4 -> v5: independent private challenge rows, no existing grants widen.
      db.exec(`
        CREATE TABLE IF NOT EXISTS private_challenges (
          id TEXT PRIMARY KEY,
          inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          invitee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('pending','active','revoked','declined','expired')),
          version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
          start_date TEXT NOT NULL, end_date TEXT NOT NULL,
          inviter_consent INTEGER NOT NULL DEFAULT 0 CHECK(inviter_consent IN (0,1)),
          invitee_consent INTEGER NOT NULL DEFAULT 0 CHECK(invitee_consent IN (0,1)),
          inviter_policy TEXT, invitee_policy TEXT,
          inviter_consent_at INTEGER, invitee_consent_at INTEGER,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, revoked_at INTEGER,
          CHECK(inviter_id <> invitee_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS challenges_inviter ON private_challenges(inviter_id);
        CREATE INDEX IF NOT EXISTS challenges_invitee ON private_challenges(invitee_id);
        CREATE UNIQUE INDEX IF NOT EXISTS challenges_open_pair ON private_challenges(MIN(inviter_id,invitee_id),MAX(inviter_id,invitee_id))
          WHERE status IN ('pending','active');
        CREATE TABLE IF NOT EXISTS challenge_blocks (
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(owner_id,target_id), CHECK(owner_id <> target_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS challenge_blocks_target ON challenge_blocks(target_id);
        CREATE TABLE IF NOT EXISTS challenge_invitation_budgets (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 50)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS challenge_global_budget (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 10000)
        ) STRICT;
        INSERT OR IGNORE INTO challenge_global_budget(id,attempts) VALUES(1,0);
        PRAGMA user_version = 5;
      `)
    })
  } catch (error) { db.close(); throw error }
  return db
}
export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE')
  try { const result = callback(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
}
export function rateLimit(db, key, limit, windowMs, now) {
  const hashed = digest(key)
  db.prepare('DELETE FROM rate_limits WHERE window_end <= ?').run(now)
  const row = db.prepare('SELECT count, window_end FROM rate_limits WHERE key_hash = ?').get(hashed)
  if (row && row.count >= limit) fail(429, 'rate_limited', 'Too many requests. Try again later.', { retryAfterSeconds: Math.ceil((row.window_end - now) / 1000) })
  // Bound attacker-controlled keys on disk; fail closed rather than evict another client's limit.
  if (!row && db.prepare('SELECT COUNT(*) AS count FROM rate_limits').get().count >= 10000) fail(503, 'rate_limit_capacity', 'Service is busy. Try again later.')
  db.prepare('INSERT INTO rate_limits(key_hash,count,window_end) VALUES(?,1,?) ON CONFLICT(key_hash) DO UPDATE SET count=count+1').run(hashed, now + windowMs)
}
export function pruneExpired(db, now) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen <= ?').run(now, now - 30 * 60 * 1000)
  db.prepare('DELETE FROM email_tokens WHERE expires_at <= ?').run(now)
  db.prepare('DELETE FROM rate_limits WHERE window_end <= ?').run(now)
  // Unverified registrations never receive health data; remove abandoned ones after 7 days.
  db.prepare('DELETE FROM users WHERE verified = 0 AND created_at <= ?').run(now - 7 * 86400000)
}
