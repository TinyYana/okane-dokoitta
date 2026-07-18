import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { toJsonSafe, type Db } from './client.js';
import { newId } from './ids.js';
import {
  accountGroups,
  accounts,
  auditLogs,
  changeLog,
  creditCards,
  creditLimitGroups,
  exchangeRates,
  expectedTransactions,
  investmentAccounts,
  marketPrices,
  recurringRules,
  securities,
  sessions,
  syncDevices,
  transactions,
} from './schema.js';

export async function recordChange(
  db: Db,
  userId: string,
  entity: string,
  entityId: string,
  version: number,
): Promise<void> {
  const snapshot = await entitySnapshot(db, userId, entity, entityId);
  if (!snapshot) throw new Error(`change snapshot missing: ${entity}/${entityId}`);
  await db.insert(changeLog).values({
    userId,
    entity,
    entityId,
    version,
    snapshot: toJsonSafe(snapshot) as Record<string, unknown>,
  });
}

async function entitySnapshot(db: Db, userId: string, entity: string, entityId: string): Promise<unknown | null> {
  switch (entity) {
    case 'accounts': {
      const [row] = await db
        .select({ account: accounts, creditCard: creditCards })
        .from(accounts)
        .leftJoin(creditCards, eq(creditCards.accountId, accounts.id))
        .where(and(eq(accounts.id, entityId), eq(accounts.userId, userId)))
        .limit(1);
      return row ? { ...row.account, creditCard: row.creditCard } : null;
    }
    case 'account_groups':
      return one(db, accountGroups, accountGroups.id, accountGroups.userId, entityId, userId);
    case 'credit_limit_groups':
      return one(db, creditLimitGroups, creditLimitGroups.id, creditLimitGroups.userId, entityId, userId);
    case 'transactions':
      return one(db, transactions, transactions.id, transactions.userId, entityId, userId);
    case 'recurring_rules':
      return one(db, recurringRules, recurringRules.id, recurringRules.userId, entityId, userId);
    case 'expected_transactions':
      return one(db, expectedTransactions, expectedTransactions.id, expectedTransactions.userId, entityId, userId);
    case 'investment_accounts':
      return one(db, investmentAccounts, investmentAccounts.id, investmentAccounts.userId, entityId, userId);
    case 'securities':
      return one(db, securities, securities.id, securities.userId, entityId, userId);
    case 'market_prices': {
      const [row] = await db
        .select({ price: marketPrices })
        .from(marketPrices)
        .innerJoin(securities, eq(marketPrices.securityId, securities.id))
        .where(and(eq(marketPrices.id, entityId), eq(securities.userId, userId)))
        .limit(1);
      return row?.price ?? null;
    }
    case 'exchange_rates': {
      // 全域資料（非使用者範疇），無 user_id 可界定
      const [row] = await db.select().from(exchangeRates).where(eq(exchangeRates.id, entityId)).limit(1);
      return row ?? null;
    }
    default:
      throw new Error(`unsupported change entity: ${entity}`);
  }
}

async function one(
  db: Db,
  table:
    | typeof accountGroups
    | typeof creditLimitGroups
    | typeof transactions
    | typeof recurringRules
    | typeof expectedTransactions
    | typeof investmentAccounts
    | typeof securities,
  idColumn:
    | typeof accountGroups.id
    | typeof creditLimitGroups.id
    | typeof transactions.id
    | typeof recurringRules.id
    | typeof expectedTransactions.id
    | typeof investmentAccounts.id
    | typeof securities.id,
  userColumn:
    | typeof accountGroups.userId
    | typeof creditLimitGroups.userId
    | typeof transactions.userId
    | typeof recurringRules.userId
    | typeof expectedTransactions.userId
    | typeof investmentAccounts.userId
    | typeof securities.userId,
  entityId: string,
  userId: string,
): Promise<unknown | null> {
  const [row] = await db.select().from(table).where(and(eq(idColumn, entityId), eq(userColumn, userId))).limit(1);
  return row ?? null;
}

export async function listChanges(db: Db, userId: string, since: bigint, limit: number) {
  return db
    .select()
    .from(changeLog)
    .where(and(eq(changeLog.userId, userId), gt(changeLog.seq, since)))
    .orderBy(asc(changeLog.seq))
    .limit(limit);
}

export async function registerDevice(
  db: Db,
  input: { id: string; userId: string; name: string; platform: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const created = await tx.insert(syncDevices).values(input).onConflictDoNothing().returning({ id: syncDevices.id });
    const rows = await tx
      .update(syncDevices)
      .set({ name: input.name, platform: input.platform, lastSeenAt: new Date() })
      .where(and(eq(syncDevices.id, input.id), eq(syncDevices.userId, input.userId), isNull(syncDevices.revokedAt)))
      .returning({ id: syncDevices.id });
    if (rows.length === 0) throw new Error('device unavailable');
    if (created.length > 0) {
      await tx.insert(auditLogs).values({
        id: newId(), userId: input.userId, actor: 'user', entity: 'sync_devices', entityId: input.id,
        action: 'create', after: { name: input.name, platform: input.platform },
      });
    }
  });
}

export async function listDevices(db: Db, userId: string) {
  return db.select().from(syncDevices).where(eq(syncDevices.userId, userId)).orderBy(asc(syncDevices.createdAt));
}

export async function renameDevice(db: Db, userId: string, deviceId: string, name: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(syncDevices).where(and(eq(syncDevices.id, deviceId), eq(syncDevices.userId, userId))).limit(1);
    const rows = await tx
      .update(syncDevices)
      .set({ name })
      .where(and(eq(syncDevices.id, deviceId), eq(syncDevices.userId, userId), isNull(syncDevices.revokedAt)))
      .returning({ id: syncDevices.id });
    if (rows.length === 0) return false;
    await tx.insert(auditLogs).values({
      id: newId(), userId, actor: 'user', entity: 'sync_devices', entityId: deviceId, action: 'update',
      before: before ? { name: before.name } : null, after: { name },
    });
    return true;
  });
}

export async function revokeDevice(db: Db, userId: string, deviceId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const affectedSessions = await tx.select({ publicId: sessions.publicId }).from(sessions).where(and(eq(sessions.userId, userId), eq(sessions.deviceId, deviceId), isNull(sessions.revokedAt)));
    const rows = await tx
      .update(syncDevices)
      .set({ revokedAt: new Date() })
      .where(and(eq(syncDevices.id, deviceId), eq(syncDevices.userId, userId)))
      .returning({ id: syncDevices.id });
    if (rows.length === 0) return false;
    await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), eq(sessions.deviceId, deviceId)));
    await tx.insert(auditLogs).values({
      id: newId(), userId, actor: 'user', entity: 'sync_devices', entityId: deviceId, action: 'revoke', after: { revoked: true },
    });
    if (affectedSessions.length > 0) await tx.insert(auditLogs).values(affectedSessions.map((session) => ({
      id: newId(), userId, actor: 'user' as const, entity: 'sessions', entityId: session.publicId,
      action: 'revoke_from_device', after: { revoked: true, deviceId },
    })));
    return true;
  });
}

export async function deviceIsActive(db: Db, userId: string, deviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: syncDevices.id })
    .from(syncDevices)
    .where(and(eq(syncDevices.id, deviceId), eq(syncDevices.userId, userId), isNull(syncDevices.revokedAt)))
    .limit(1);
  return Boolean(row);
}
