import { z } from 'zod';

export const zPrivacyMode = z.enum(['full', 'fuzzy', 'anomaly_only', 'hidden']);

export const zNotificationPreferencesUpdate = z
  .object({
    privacyMode: zPrivacyMode.optional(),
    discordEnabled: z.boolean().optional(),
    webPushEnabled: z.boolean().optional(),
    quietHoursStartMinute: z.number().int().min(0).max(1439).nullable().optional(),
    quietHoursEndMinute: z.number().int().min(0).max(1439).nullable().optional(),
    mutedEventTypes: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict();

export const zWebPushSubscribeRequest = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

export const zWebPushUnsubscribeRequest = z.object({
  endpoint: z.url().max(2000),
});
