-- 回声工坊内容管理 v1
-- 对已有投稿默认视为未审核；管理员批量导入和管理操作会写入审核元数据。
ALTER TABLE scripts ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scripts ADD COLUMN moderated_at INTEGER;
ALTER TABLE scripts ADD COLUMN moderated_by TEXT;
ALTER TABLE scripts ADD COLUMN moderation_note TEXT;
