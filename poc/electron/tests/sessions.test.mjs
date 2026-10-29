import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadConversations, partitionFor } = require('../lib/sessions.js');
const { normalizeUrl } = require('../lib/url.js');

test('会话清单来自真实数据库且按更新时间倒序', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'akb-poc-db-'));
  const database = path.join(directory, 'app.db');
  execFileSync('sqlite3', [database, "CREATE TABLE chat_conversations(id TEXT PRIMARY KEY,title TEXT,thread_id TEXT,closed INTEGER DEFAULT 0,updated_at TEXT); INSERT INTO chat_conversations VALUES('old','旧会话',NULL,0,'2026-01-01'),('new','新会话','thread-1',0,'2026-02-01'),('closed','已关闭',NULL,1,'2026-03-01');"]);
  const sessions = loadConversations(database);
  assert.deepEqual(sessions.map(value => value.id), ['new', 'old']);
  assert.equal(sessions[0].thread_id, 'thread-1');
  assert.deepEqual(loadConversations(path.join(directory, 'missing.db')), []);
});

test('每个会话映射到独立的持久分区，特殊字符不会逃出前缀', () => {
  assert.match(partitionFor('conversation-1'), /^persist:akb-poc-conversation-1-[0-9a-f]{8}$/);
  assert.notEqual(partitionFor('a/b'), partitionFor('a_b'));
  assert.equal(partitionFor('same'), partitionFor('same'));
  assert.throws(() => partitionFor(''));
});

test('地址补全协议并拒绝非 HTTP 与带凭据地址', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('http://127.0.0.1:8080/red'), 'http://127.0.0.1:8080/red');
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
  assert.throws(() => normalizeUrl('file:///etc/passwd'));
  assert.throws(() => normalizeUrl('https://user:pass@example.com/'));
  assert.throws(() => normalizeUrl(''));
});
