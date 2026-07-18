/** Discord REST API client（ADR-005：無 gateway，全部走 HTTPS REST）。 */
export const DISCORD_API_BASE = 'https://discord.com/api/v10';

export interface DiscordOAuthConfig {
  appId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface DiscordTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}

export class DiscordApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function exchangeDiscordOAuthCode(config: DiscordOAuthConfig, code: string): Promise<DiscordTokenResult> {
  const res = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.appId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  if (!res.ok) throw new DiscordApiError(res.status, 'Discord OAuth token 交換失敗');
  const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
  };
}

export async function fetchDiscordUser(accessToken: string): Promise<{ id: string; username: string }> {
  const res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new DiscordApiError(res.status, '無法取得 Discord 使用者資料');
  const body = (await res.json()) as { id: string; username: string };
  return { id: body.id, username: body.username };
}

/** DM 傳訊：先開（或取得既有）DM channel，再送訊息（Discord 無法直接對 user id 送訊息）。 */
export async function sendDiscordDirectMessage(botToken: string, discordUserId: string, content: string): Promise<void> {
  const dmRes = await fetch(`${DISCORD_API_BASE}/users/@me/channels`, {
    method: 'POST',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_id: discordUserId }),
  });
  if (!dmRes.ok) throw new DiscordApiError(dmRes.status, '無法建立 Discord DM 頻道');
  const dmChannel = (await dmRes.json()) as { id: string };
  const sendRes = await fetch(`${DISCORD_API_BASE}/channels/${dmChannel.id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!sendRes.ok) throw new DiscordApiError(sendRes.status, '無法送出 Discord DM');
}
