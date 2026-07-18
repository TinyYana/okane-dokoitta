import type { MiddlewareHandler } from 'hono';

/**
 * 安全 middleware（SECURITY §5 M1）：
 * - CSP：禁 inline script（PWA 相容）
 * - Rate limiting：登入/寫入/全域三層（單 process in-memory，符合 ADR-004 單容器）
 * - Origin 檢查：state-changing 請求的 CSRF 第一道防線（第二道是 session CSRF token）
 */

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'", // 禁 inline script
      "style-src 'self' 'unsafe-inline'", // Radix/主題切換用 style 屬性；inline <style> 標籤仍被禁擋不了的部分由 script-src 保護
      "img-src 'self' data:",
      "connect-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
};

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * 固定窗口限流的計數狀態。**必須是模組層級**（不是 rateLimit() closure 內）：
 * Worker 的 fetch 每個請求都重新呼叫 createApp() → 若 Map 建在 closure 裡，計數每個請求都歸零，
 * 限流在 Cloudflare 上等於失效。放模組層級才能跨請求存活。
 * keyFn 各自加前綴（global:/auth:/ai:…）分命名空間，所有 limiter 共用這個 Map 不相撞。
 * ponytail: 單 isolate in-memory —— Node 單容器精確，Workers 多 isolate 為 best-effort（見 SECURITY §5 註）。
 *   要嚴格跨 isolate 限流（例如開放公開註冊時的登入端點）改用 Cloudflare Rate Limiting binding 或 Durable Object。
 */
const rateLimitBuckets = new Map<string, Bucket>();

export function rateLimit(options: { windowMs: number; max: number; keyFn: (c: Parameters<MiddlewareHandler>[0]) => string }): MiddlewareHandler {
  const buckets = rateLimitBuckets;
  return async (c, next) => {
    const now = Date.now();
    const key = options.keyFn(c);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      c.header('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return c.json({ error: { code: 'RATE_LIMITED', message: '請求過於頻繁，請稍後再試' } }, 429);
    }
    if (buckets.size > 10000) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    }
    await next();
  };
}

export function clientIp(c: Parameters<MiddlewareHandler>[0]): string {
  // Cloudflare 設定的 CF-Connecting-IP 用戶端無法偽造，優先採用 —— 否則攻擊者自帶
  // x-forwarded-for 就能每個請求換一個限流 key，登入爆破/全域限流全被繞過。
  const cfIp = c.req.header('cf-connecting-ip');
  if (cfIp) return cfIp.trim();
  // 自架反向代理（DEPLOYMENT §1）：代理須自行覆寫 x-forwarded-for，否則同樣可偽造。
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return 'local';
}

/** state-changing 請求的 Origin 檢查（SameSite=Lax 之外的保險） */
export function originCheck(allowedOrigins: () => string[]): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const origin = c.req.header('origin');
    if (origin && !allowedOrigins().includes(origin)) {
      return c.json({ error: { code: 'ORIGIN_MISMATCH', message: '來源不被允許' } }, 403);
    }
    return next();
  };
}
