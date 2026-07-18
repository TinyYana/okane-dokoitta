import {
  constants,
  cp,
  mkdir,
  mkdtemp,
  open,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { decryptBackupFile, encryptBackupFile } from './backup-crypto.mjs';

const [operation, fileArg, confirmation] = process.argv.slice(2);
if (!['backup', 'restore'].includes(operation ?? '') || !fileArg) usage();

const databaseUrl = process.env['OKANE_DOKOITTA_MIGRATE_DATABASE_URL']
  ?? process.env['OKANE_DOKOITTA_DATABASE_URL'];
const fileKey = process.env['OKANE_DOKOITTA_FILE_KEY'];
const dataDir = resolve(process.env['OKANE_DOKOITTA_DATA_DIR'] ?? './data');
if (!databaseUrl) fail('缺少 OKANE_DOKOITTA_DATABASE_URL（或 migration URL）');
if (!fileKey || fileKey.length < 32) fail('OKANE_DOKOITTA_FILE_KEY 必須至少 32 字元');

const backupPath = resolve(fileArg);
const postgres = postgresConnection(databaseUrl);
const temporary = await mkdtemp(join(tmpdir(), 'okane-dokoitta-backup-'));
try {
  if (operation === 'backup') await backup();
  else await restore();
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function backup() {
  await mkdir(dirname(backupPath), { recursive: true });
  const file = await open(backupPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY).catch((error) => {
    if (error?.code === 'EEXIST') fail(`拒絕覆寫既有備份：${backupPath}`);
    throw error;
  });
  await file.close();

  try {
    const stage = join(temporary, 'stage');
    await mkdir(stage);
    await run('pg_dump', ['--format=custom', '--no-owner', '--file', join(stage, 'database.dump'), '--dbname', postgres.publicUrl], postgres.env);
    if (await exists(dataDir)) {
      const excludedBackups = join(dataDir, 'backups');
      await cp(dataDir, join(stage, 'files'), {
        recursive: true,
        filter: (source) => ![excludedBackups, backupPath].includes(resolve(source)),
      });
    }
    const tarPath = join(temporary, 'bundle.tar');
    await run('tar', ['-cf', tarPath, '-C', stage, '.']);
    await encryptBackupFile(tarPath, backupPath, fileKey);
    console.log(`encrypted backup written: ${backupPath}`);
  } catch (error) {
    await rm(backupPath, { force: true });
    throw error;
  }
}

async function restore() {
  if (confirmation !== '--confirm-restore') {
    fail('還原會改寫目標資料庫；請明確加上 --confirm-restore');
  }
  if (!(await exists(backupPath))) fail(`找不到備份：${backupPath}`);
  const tarPath = join(temporary, 'bundle.tar');
  await decryptBackupFile(backupPath, tarPath, fileKey);
  const stage = join(temporary, 'stage');
  await mkdir(stage);
  await run('tar', ['-xf', tarPath, '-C', stage]);
  const dump = join(stage, 'database.dump');
  if (!(await exists(dump))) fail('備份缺少 database.dump');
  await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--dbname', postgres.publicUrl, dump], postgres.env);
  const files = join(stage, 'files');
  if (await exists(files)) {
    await mkdir(dataDir, { recursive: true });
    await cp(files, dataDir, { recursive: true, force: true });
  }
  console.log(`restore completed from: ${backupPath}`);
}

function run(command, args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)));
  });
}

function postgresConnection(connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail('DATABASE_URL 必須是 postgres:// 或 postgresql://');
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const authority = `${username ? `${encodeURIComponent(username)}@` : ''}${url.host}`;
  return {
    publicUrl: `postgresql://${authority}${url.pathname}${url.search}`,
    env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) },
  };
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

function usage() {
  fail(`用法：\n  pnpm backup -- <output.odkbak>\n  pnpm restore -- <input.odkbak> --confirm-restore`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
