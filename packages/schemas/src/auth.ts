import { z } from 'zod';

/** M1 最簡 auth（OPEN_QUESTIONS Q6）：單使用者密碼 + session cookie；Passkey 在 M2。 */

export const zPassword = z.string().min(10, '密碼至少 10 字元').max(200);

export const zSetupRequest = z.object({
  email: z.email(),
  password: zPassword,
  displayName: z.string().min(1).max(100).optional(),
});

export const zLoginRequest = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
});

export const zRegisterRequest = z.object({
  email: z.email(),
  password: zPassword,
  displayName: z.string().trim().min(1).max(80).optional(),
  inviteCode: z.string().trim().min(16).max(200).optional(),
});

export const zInviteCreate = z.object({ expiresInDays: z.number().int().min(1).max(90).default(7) });

export const zAuthStatus = z.object({
  needsSetup: z.boolean(),
  authenticated: z.boolean(),
});
export type AuthStatus = z.infer<typeof zAuthStatus>;

export const zMeResponse = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  ledgerTimeZone: z.string(),
  csrfToken: z.string(),
  isAdmin: z.boolean(),
});
export type MeResponse = z.infer<typeof zMeResponse>;
