import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../database.mjs'

const valid = `CREATE TABLE native_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, credential_binding TEXT NOT NULL
) STRICT`
const malformed = [
  valid.replace(', credential_binding TEXT NOT NULL', ''),
  valid.replace('token_hash TEXT PRIMARY KEY', 'token_hash TEXT NOT NULL'),
  valid.replace('user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE', 'user_id TEXT NOT NULL'),
  valid.replace('ON DELETE CASCADE', 'ON DELETE RESTRICT'),
  valid.replace('REFERENCES users(id)', 'REFERENCES users(email)'),
  valid.replace('user_id TEXT NOT NULL', 'user_id TEXT'),
  valid.replace('expires_at INTEGER NOT NULL', 'expires_at TEXT NOT NULL'),
  valid.replace('credential_binding TEXT NOT NULL', 'credential_binding TEXT'),
  valid.replace('credential_binding TEXT NOT NULL', "credential_binding TEXT NOT NULL DEFAULT ''"),
  valid.replace(') STRICT', ')'),
  valid.replace(') STRICT', ') STRICT, WITHOUT ROWID'),
  valid.replace('credential_binding TEXT NOT NULL', 'credential_binding TEXT NOT NULL, unexpected TEXT'),
]
const schema = db => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()

test('malformed native table collisions and v6 reopens fail closed without changing schema, records or version', t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-native-schema-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const version of [5, 6]) for (const [i, ddl] of malformed.entries()) {
    const path = join(directory, `${version}-${i}.sqlite`), fixture = openDatabase(path)
    fixture.exec(`DROP TABLE native_sessions; ${ddl}; PRAGMA user_version = ${version}`)
    fixture.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('preserved', 'synthetic@example.test', 'synthetic-only-hash', 123)
    const before = schema(fixture), users = fixture.prepare('SELECT * FROM users').all(); fixture.close()
    assert.throws(() => openDatabase(path), /schema is invalid/, `schema ${i} version ${version}`)
    const checked = new DatabaseSync(path)
    assert.equal(checked.prepare('PRAGMA user_version').get().user_version, version)
    assert.deepEqual(schema(checked), before)
    assert.deepEqual(checked.prepare('SELECT * FROM users').all(), users)
    checked.close()
  }
})

test('native index collisions, uniqueness, partial predicates and foreign ownership fail closed', t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-native-index-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const invalidIndexes = [
    'CREATE INDEX native_sessions_user ON native_sessions(expires_at)',
    'CREATE UNIQUE INDEX native_sessions_user ON native_sessions(user_id)',
    'CREATE INDEX native_sessions_user ON native_sessions(user_id) WHERE last_seen > 0',
    'CREATE INDEX native_sessions_user ON sessions(user_id)',
    'CREATE INDEX native_sessions_user ON native_sessions(user_id, expires_at)',
    'CREATE INDEX native_sessions_user ON native_sessions(user_id); CREATE UNIQUE INDEX wrong_extra ON native_sessions(credential_binding)',
  ]
  for (const version of [5, 6]) for (const [i, index] of invalidIndexes.entries()) {
    const path = join(directory, `${version}-${i}.sqlite`), fixture = openDatabase(path)
    fixture.exec(`DROP INDEX native_sessions_user; ${index}; PRAGMA user_version = ${version}`)
    const before = schema(fixture); fixture.close()
    assert.throws(() => openDatabase(path), /schema is invalid/)
    const checked = new DatabaseSync(path)
    assert.equal(checked.prepare('PRAGMA user_version').get().user_version, version)
    assert.deepEqual(schema(checked), before)
    checked.close()
  }
})
