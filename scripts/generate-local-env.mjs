import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve('.env');
let content = existsSync(envPath)
  ? readFileSync(envPath, 'utf8')
  : readFileSync(resolve('.env.example'), 'utf8');

const changed = [];
const current = (key) => {
  const value = content.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  return value === '""' || value === "''" ? '' : value.replace(/^(['"])(.*)\1$/, '$2');
};
const fill = (key, value) => {
  if (current(key)) return;
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`;
  changed.push(key);
};

fill('OKANE_DOKOITTA_ROLES', 'api');
fill('OKANE_DOKOITTA_DB_PASSWORD', randomBytes(24).toString('hex'));
const password = encodeURIComponent(current('OKANE_DOKOITTA_DB_PASSWORD'));
fill('OKANE_DOKOITTA_DATABASE_URL', `postgres://okane:${password}@db:5432/okane`);
fill('OKANE_DOKOITTA_MIGRATE_DATABASE_URL', `postgres://okane:${password}@db:5432/okane`);
fill('OKANE_DOKOITTA_BASE_URL', 'http://localhost:3000');
fill('OKANE_DOKOITTA_SESSION_SECRET', randomBytes(32).toString('base64url'));
fill('OKANE_DOKOITTA_REGISTRATION_MODE', 'invite');
fill('OKANE_DOKOITTA_FILE_KEY', randomBytes(32).toString('base64url'));
fill('OKANE_DOKOITTA_DATA_DIR', '/data');
fill('OKANE_DOKOITTA_IMPORT_RETENTION_DAYS', '90');
fill('OKANE_DOKOITTA_TZ', 'Asia/Taipei');

for (const key of ['OKANE_DOKOITTA_SESSION_SECRET', 'OKANE_DOKOITTA_FILE_KEY']) {
  if (current(key).length < 32) throw new Error(`${key} 必須至少 32 字元；既有非空值不會自動覆寫`);
}
for (const key of ['OKANE_DOKOITTA_DATABASE_URL', 'OKANE_DOKOITTA_MIGRATE_DATABASE_URL']) {
  if (!new URL(current(key)).protocol.startsWith('postgres')) throw new Error(`${key} 必須是 PostgreSQL URL`);
}

if (changed.length) writeFileSync(envPath, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o600 });
console.log(changed.length ? `已補齊 ${changed.join(', ')}` : '.env 必要欄位已齊全，未修改');
