import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES } from '@okane-dokoitta/domain';
import type { Db } from './client.js';
import { newId } from './ids.js';
import { accounts, auditLogs, authCredentials, instanceState, registrationInvites, sessions, syncDevices, users } from './schema.js';

export interface NewUser {
  email: string;
  displayName: string | null;
  passwordHash: string;
  ledgerTimeZone: string;
  isAdmin?: boolean;
}

export async function countUsers(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users);
  return row?.n ?? 0;
}

/** 淨資產一覽的換算基準幣別（M4，非同步 mutation 實體，設定頁直接呼叫）。 */
export async function updateUserBaseCurrency(db: Db, userId: string, baseCurrency: string): Promise<void> {
  await db.update(users).set({ baseCurrency }).where(eq(users.id, userId));
}

/**
 * 建立使用者 + 期初 equity 帳戶 + 預設分類（單一 transaction 內）。
 * 分類與 equity 帳戶是帳本運作的前提（期初餘額分錄、F1 快速記帳）。
 */
export async function createUserWithDefaults(db: Db, input: NewUser): Promise<{ userId: string }> {
  return db.transaction(async (tx) => insertUserWithDefaults(tx as Db, input));
}

async function insertUserWithDefaults(db: Db, input: NewUser): Promise<{ userId: string }> {
    const userId = newId();
    await db.insert(users).values({
      id: userId,
      email: input.email,
      displayName: input.displayName,
      ledgerTimeZone: input.ledgerTimeZone,
      isAdmin: input.isAdmin ?? false,
    });
    const credentialId = newId();
    await db.insert(authCredentials).values({
      id: credentialId,
      userId,
      kind: 'password',
      passwordHash: input.passwordHash,
    });
    const defaults = [
      { subtype: 'opening_balance' as const, kind: 'equity' as const, names: ['期初餘額'] },
      { subtype: 'category_expense' as const, kind: 'expense' as const, names: DEFAULT_EXPENSE_CATEGORIES },
      { subtype: 'category_income' as const, kind: 'income' as const, names: DEFAULT_INCOME_CATEGORIES },
    ];
    for (const group of defaults) {
      for (const name of group.names) {
        const accountId = newId();
        await db.insert(accounts).values({
          id: accountId,
          userId,
          kind: group.kind,
          subtype: group.subtype,
          name,
          currency: 'TWD',
        });
        await db.insert(auditLogs).values({
          id: newId(),
          userId,
          actor: 'system',
          entity: 'accounts',
          entityId: accountId,
          action: 'create',
          after: { name, subtype: group.subtype, currency: 'TWD' },
        });
      }
    }
    await db.insert(auditLogs).values([
      {
        id: newId(), userId, actor: 'system', entity: 'users', entityId: userId,
        action: 'create', after: { email: input.email, displayName: input.displayName, ledgerTimeZone: input.ledgerTimeZone, isAdmin: input.isAdmin ?? false },
      },
      {
        id: newId(), userId, actor: 'system', entity: 'auth_credentials', entityId: credentialId,
        action: 'create', after: { kind: 'password' },
      },
    ]);
    return { userId };
}

export async function createFirstUserWithDefaults(db: Db, input: NewUser): Promise<{ userId: string } | null> {
  return db.transaction(async (tx) => {
    if ((await countUsers(tx as Db)) > 0) return null;
    const claim = await tx
      .insert(instanceState)
      .values({ key: 'first_user_claim', value: {} })
      .onConflictDoNothing()
      .returning({ key: instanceState.key });
    if (claim.length === 0) return null;
    return insertUserWithDefaults(tx as Db, input);
  });
}

export async function findUserByEmail(db: Db, email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return user ?? null;
}

export async function findUserById(db: Db, userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user ?? null;
}

export async function listInstanceUsers(db: Db) {
  return db
    .select({ id: users.id, email: users.email, displayName: users.displayName, isAdmin: users.isAdmin, createdAt: users.createdAt })
    .from(users)
    .orderBy(users.createdAt);
}

export async function getPasswordCredential(db: Db, userId: string) {
  const [cred] = await db
    .select()
    .from(authCredentials)
    .where(and(eq(authCredentials.userId, userId), eq(authCredentials.kind, 'password')))
    .limit(1);
  return cred ?? null;
}

export async function createSession(
  db: Db,
  input: { tokenHash: string; publicId: string; userId: string; csrfToken: string; expiresAt: Date; deviceId?: string | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(sessions).values(input);
    await tx.insert(auditLogs).values({
      id: newId(), userId: input.userId, actor: 'system', entity: 'sessions', entityId: input.publicId,
      action: 'create', after: { expiresAt: input.expiresAt.toISOString(), deviceId: input.deviceId ?? null },
    });
  });
}

/** 有效 session（未撤銷、未過期）連使用者一起取。 */
export async function findActiveSession(db: Db, tokenHash: string) {
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), sql`${sessions.expiresAt} > now()`))
    .limit(1);
  return row ?? null;
}

export async function touchSession(db: Db, tokenHash: string): Promise<void> {
  await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.tokenHash, tokenHash));
}

export async function revokeSession(db: Db, tokenHash: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [session] = await tx.select({ publicId: sessions.publicId, userId: sessions.userId }).from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1);
    if (!session) return;
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, tokenHash));
    await tx.insert(auditLogs).values({
      id: newId(), userId: session.userId, actor: 'user', entity: 'sessions', entityId: session.publicId,
      action: 'revoke', after: { revoked: true },
    });
  });
}

export async function attachSessionDevice(db: Db, tokenHash: string, userId: string, deviceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [device] = await tx
      .select({ id: syncDevices.id })
      .from(syncDevices)
      .where(and(eq(syncDevices.id, deviceId), eq(syncDevices.userId, userId), isNull(syncDevices.revokedAt)))
      .limit(1);
    if (!device) throw new Error('device unavailable');
    const [session] = await tx.update(sessions).set({ deviceId }).where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.userId, userId))).returning({ publicId: sessions.publicId });
    if (session) await tx.insert(auditLogs).values({
      id: newId(), userId, actor: 'user', entity: 'sessions', entityId: session.publicId,
      action: 'attach_device', after: { deviceId },
    });
  });
}

export async function listUserSessions(db: Db, userId: string) {
  return db
    .select({
      id: sessions.publicId,
      deviceId: sessions.deviceId,
      deviceName: syncDevices.name,
      platform: syncDevices.platform,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .leftJoin(syncDevices, eq(syncDevices.id, sessions.deviceId))
    .where(eq(sessions.userId, userId));
}

export async function revokeUserSession(db: Db, userId: string, publicId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), eq(sessions.publicId, publicId)))
      .returning({ id: sessions.publicId });
    if (rows.length === 0) return false;
    await tx.insert(auditLogs).values({
      id: newId(), userId, actor: 'user', entity: 'sessions', entityId: publicId, action: 'revoke', after: { revoked: true },
    });
    return true;
  });
}

export async function createRegistrationInvite(
  db: Db,
  input: { id: string; createdByUserId: string; codeHash: string; expiresAt: Date },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(registrationInvites).values(input);
    await tx.insert(auditLogs).values({
      id: newId(), userId: input.createdByUserId, actor: 'user', entity: 'registration_invites', entityId: input.id,
      action: 'create', after: { expiresAt: input.expiresAt.toISOString() },
    });
  });
}

export async function listRegistrationInvites(db: Db, userId: string) {
  return db
    .select({
      id: registrationInvites.id,
      expiresAt: registrationInvites.expiresAt,
      usedAt: registrationInvites.usedAt,
      revokedAt: registrationInvites.revokedAt,
      createdAt: registrationInvites.createdAt,
    })
    .from(registrationInvites)
    .where(eq(registrationInvites.createdByUserId, userId))
    .orderBy(desc(registrationInvites.createdAt));
}

export async function revokeRegistrationInvite(db: Db, userId: string, inviteId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(registrationInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(registrationInvites.id, inviteId), eq(registrationInvites.createdByUserId, userId), isNull(registrationInvites.usedAt)))
      .returning({ id: registrationInvites.id });
    if (rows.length === 0) return false;
    await tx.insert(auditLogs).values({
      id: newId(), userId, actor: 'user', entity: 'registration_invites', entityId: inviteId,
      action: 'revoke', after: { revoked: true },
    });
    return true;
  });
}

export async function createUserFromInvite(db: Db, codeHash: string, input: NewUser): Promise<{ userId: string } | null> {
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(registrationInvites)
      .where(
        and(
          eq(registrationInvites.codeHash, codeHash),
          isNull(registrationInvites.usedAt),
          isNull(registrationInvites.revokedAt),
          gt(registrationInvites.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for('update');
    if (!invite) return null;
    const result = await insertUserWithDefaults(tx as Db, input);
    const consumed = await tx
      .update(registrationInvites)
      .set({ usedAt: new Date(), usedByUserId: result.userId })
      .where(and(eq(registrationInvites.id, invite.id), isNull(registrationInvites.usedAt)))
      .returning({ id: registrationInvites.id });
    if (consumed.length === 0) throw new Error('invite already consumed');
    await tx.insert(auditLogs).values({
      id: newId(), userId: invite.createdByUserId, actor: 'system', entity: 'registration_invites', entityId: invite.id,
      action: 'consume', after: { usedByUserId: result.userId },
    });
    return result;
  });
}
