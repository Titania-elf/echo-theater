-- 回声工坊：使用反馈与站内通知
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_body TEXT,
  replied_at INTEGER,
  status TEXT NOT NULL DEFAULT 'public',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_once
  ON comments(script_id, author_id) WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_comment_script
  ON comments(script_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  actor_id TEXT,
  type TEXT NOT NULL,
  script_id TEXT,
  comment_id TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_recipient
  ON notifications(recipient_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS comment_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id TEXT NOT NULL,
  reporter_id TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  handled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comment_report_open
  ON comment_reports(handled, created_at DESC);
