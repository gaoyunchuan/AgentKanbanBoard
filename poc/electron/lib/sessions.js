// PoC 只读现有应用数据库中的会话清单，不写入任何业务数据。
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createHash } = require('node:crypto');

function loadConversations(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return [];
  try {
    const output = execFileSync('sqlite3', ['-readonly', '-json', dbPath,
      'SELECT id,title,thread_id FROM chat_conversations WHERE closed=0 ORDER BY updated_at DESC LIMIT 50'], { encoding: 'utf8' });
    return JSON.parse(output || '[]').map(row => ({
      id: String(row.id),
      title: String(row.title || '未命名会话'),
      thread_id: row.thread_id == null ? null : String(row.thread_id),
    }));
  } catch {
    return [];
  }
}

function partitionFor(conversationId) {
  const safe = String(conversationId || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  if (!safe) throw new Error('会话标识为空');
  // 清理后的短名可能碰撞，摘要后缀保证不同会话永不共用分区。
  const digest = createHash('sha256').update(String(conversationId)).digest('hex').slice(0, 8);
  return `persist:akb-poc-${safe}-${digest}`;
}

module.exports = { loadConversations, partitionFor };
