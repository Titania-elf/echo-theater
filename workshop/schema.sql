-- 回声工坊 v0 数据结构
-- 注意：desc 是 SQL 保留字，这里用 summary，对外 JSON 仍叫 desc

CREATE TABLE IF NOT EXISTS authors (
  discord_id  TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  avatar      TEXT,
  created_at  INTEGER NOT NULL,
  banned      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scripts (
  id            TEXT PRIMARY KEY,
  author_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT,
  summary       TEXT,
  prompt        TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  rating        TEXT NOT NULL DEFAULT 'general',
  version       INTEGER NOT NULL DEFAULT 1,
  content_hash  TEXT NOT NULL,
  downloads     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'public',
  -- 1 = 对外隐藏作者身份。归属关系照旧存在，作者本人依然能管理自己的投稿
  anonymous     INTEGER NOT NULL DEFAULT 0,
  reviewed      INTEGER NOT NULL DEFAULT 0,
  moderated_at  INTEGER,
  moderated_by  TEXT,
  moderation_note TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 这几个索引不是可选的：D1 免费额度算的是扫描行数，不建索引会白烧配额
CREATE INDEX  IF NOT EXISTS idx_pub    ON scripts(status, updated_at DESC);
CREATE INDEX  IF NOT EXISTS idx_author ON scripts(author_id, created_at DESC);

-- 只对在架内容去重：下架/删除后作者可以重新投同样的内容
CREATE UNIQUE INDEX IF NOT EXISTS idx_hash
  ON scripts(content_hash) WHERE status = 'public';

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id   TEXT NOT NULL,
  reporter_id TEXT,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  handled     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_report_open ON reports(handled, created_at DESC);
