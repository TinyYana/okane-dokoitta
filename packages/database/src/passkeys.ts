import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from './client.js';
import { newId } from './ids.js';
import { auditLogs, authChallenges, passkeys, recoveryCodes, totpCredentials, users } from './schema.js';

export async function listPasskeys(db: Db, userId: string) {
  return db.select().from(passkeys).where(eq(passkeys.userId, userId));
}

export async function findPasskey(db: Db, credentialId: string) {
  const [row] = await db
    .select({ passkey: passkeys, user: users })
    .from(passkeys)
    .innerJoin(users, eq(users.id, passkeys.userId))
    .where(eq(passkeys.credentialId, credentialId))
    .limit(1);
  return row ?? null;
}

export async function savePasskey(
  db: Db,
  input: {
    id: string;
    userId: string;
    credentialId: string;
    publicKey: string;
    counter: bigint;
    transports: string[];
    deviceType: string;
    backedUp: boolean;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(passkeys).values(input);
    await tx.insert(auditLogs).values({
      id: newId(), userId: input.userId, actor: 'user', entity: 'passkeys', entityId: input.id,
      action: 'create', after: { credentialId: input.credentialId, deviceType: input.deviceType, backedUp: input.backedUp },
    });
  });
}

export async function updatePasskeyCounter(db: Db, credentialId: string, counter: bigint): Promise<void> {
  await db.update(passkeys).set({ counter, lastUsedAt: new Date() }).where(eq(passkeys.credentialId, credentialId));
}

export async function createAuthChallenge(
  db: Db,
  input: { id: string; userId: string | null; kind: 'registration' | 'authentication' | 'totp' | 'totp_login'; challenge: string; expiresAt: Date },
): Promise<void> {
  await db.insert(authChallenges).values(input);
}

export async function consumeAuthChallenge(
  db: Db,
  input: { id: string; kind: 'registration' | 'authentication' | 'totp' | 'totp_login'; userId?: string },
) {
  return db.transaction(async (tx) => {
    const conditions = [
      eq(authChallenges.id, input.id),
      eq(authChallenges.kind, input.kind),
      isNull(authChallenges.usedAt),
      gt(authChallenges.expiresAt, new Date()),
    ];
    if (input.userId) conditions.push(eq(authChallenges.userId, input.userId));
    const [row] = await tx.select().from(authChallenges).where(and(...conditions)).limit(1);
    if (!row) return null;
    const updated = await tx
      .update(authChallenges)
      .set({ usedAt: new Date() })
      .where(and(eq(authChallenges.id, row.id), isNull(authChallenges.usedAt)))
      .returning({ id: authChallenges.id });
    return updated.length > 0 ? row : null;
  });
}

export async function replaceRecoveryCodes(db: Db, userId: string, hashes: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await tx.insert(recoveryCodes).values(hashes.map((codeHash) => ({ id: newId(), userId, codeHash })));
    await tx.insert(auditLogs).values({
      id: newId(), userId, actor: 'user', entity: 'recovery_codes', entityId: newId(),
      action: 'replace', after: { count: hashes.length },
    });
  });
}

export async function consumeRecoveryCode(db: Db, userId: string, codeHash: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(recoveryCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, codeHash), isNull(recoveryCodes.usedAt)))
      .returning({ id: recoveryCodes.id });
    if (rows.length === 0) return false;
    await tx.insert(auditLogs).values({
      id: newId(), userId, actor: 'user', entity: 'recovery_codes', entityId: rows[0]!.id,
      action: 'use', after: { used: true },
    });
    return true;
  });
}

export async function getTotpCredential(db: Db, userId: string) {
  const [row] = await db.select().from(totpCredentials).where(eq(totpCredentials.userId, userId)).limit(1);
  return row ?? null;
}

export async function saveTotpCredential(db: Db, userId: string, encryptedSecret: string): Promise<void> {
  const id = newId();
  await db.transaction(async (tx) => {
    await tx
      .insert(totpCredentials)
      .values({ id, userId, encryptedSecret, verifiedAt: new Date() })
      .onConflictDoUpdate({ target: totpCredentials.userId, set: { encryptedSecret, verifiedAt: new Date() } });
    await tx.insert(auditLogs).values({
      id: newId(), userId, actor: 'user', entity: 'totp_credentials', entityId: id,
      action: 'enable', after: { enabled: true },
    });
  });
}
