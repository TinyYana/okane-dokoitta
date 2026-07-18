import { z } from 'zod';
import { zUuidV7 } from './common.js';

export const zDeviceRegistration = z.object({
  id: zUuidV7,
  name: z.string().trim().min(1).max(80),
  platform: z.string().trim().min(1).max(80),
});

export const zDeviceRename = z.object({ name: z.string().trim().min(1).max(80) });

export const zChangeCursor = z.string().regex(/^\d+$/, 'cursor 必須是非負整數').transform(BigInt);

export const zRestoreRequest = z.object({
  formatVersion: z.number().int().positive(),
  exportedAt: z.string(),
  data: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
