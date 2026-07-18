-- DB 最小權限（SECURITY §5 M1）：app 執行帳號無 DDL；migration 用 owner 帳號。
-- 使用方式（以 superuser / owner 連線執行；密碼自行替換，不要提交任何真實密碼）：
--   psql "$OKANE_DOKOITTA_MIGRATE_DATABASE_URL" -v app_password='<替換>' -f init-roles.sql
--
-- app 帳號只有 SELECT / INSERT / UPDATE：
--   - 無 DDL（不能改 schema）
--   - 無 DELETE —— 軟刪除只用 UPDATE，物理刪除在權限層就被擋掉

CREATE ROLE okane_app LOGIN PASSWORD :'app_password';

GRANT USAGE ON SCHEMA okane_dokoitta TO okane_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA okane_dokoitta TO okane_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA okane_dokoitta
  GRANT SELECT, INSERT, UPDATE ON TABLES TO okane_app;

-- drizzle migrations 記錄表（app 啟動時讀取以檢查 pending migrations）
GRANT USAGE ON SCHEMA drizzle TO okane_app;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO okane_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle
  GRANT SELECT ON TABLES TO okane_app;
