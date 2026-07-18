#!/bin/sh
set -e
case "$1" in
  migrate)
    # 明確執行 migration（升級前請先備份 — DEPLOYMENT §3）
    exec node_modules/.bin/tsx node_modules/@okane-dokoitta/database/scripts/migrate-cli.ts
    ;;
  serve|"")
    exec node_modules/.bin/tsx src/server.ts
    ;;
  *)
    exec "$@"
    ;;
esac
