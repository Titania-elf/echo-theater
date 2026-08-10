-- 给已有库补 anonymous 列。新库直接用 schema.sql，不需要跑这个。
-- D1 不支持 IF NOT EXISTS，重复执行会报 duplicate column name，那说明已经加过了，忽略即可。
ALTER TABLE scripts ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0;
