import { startRegistration } from '@simplewebauthn/browser';
import { Button, Field, Segmented, Select, TextInput, useToast } from '@okane-dokoitta/ui';
import { useCallback, useEffect, useState } from 'react';
import { applyAccentHue, getAccentHue } from '../accent.js';
import { api, ApiError, currentDeviceId, mutate, newEntityId, syncNow } from '../api.js';
import { discardDraft, listSyncIssues, resolveConflict } from '../offline.js';
import { currentPushSubscription, subscribeWebPush, unsubscribeWebPush } from '../push.js';
import { isActive, useAccounts } from '../store.js';
import { v7 as uuidv7 } from 'uuid';

type Theme = 'auto' | 'light' | 'dark';
type Me = { email: string; displayName: string | null; ledgerTimeZone: string; baseCurrency: string; isAdmin: boolean };
type PrivacyMode = 'full' | 'fuzzy' | 'anomaly_only' | 'hidden';
type NotificationPrefs = {
  privacyMode: PrivacyMode;
  discordEnabled: boolean;
  webPushEnabled: boolean;
  quietHoursStartMinute: number | null;
  quietHoursEndMinute: number | null;
  mutedEventTypes: string[];
  webPushVapidPublicKey: string | null;
};
type DiscordStatus = { linked: boolean; discordUsername: string | null; enabled: boolean };
type Device = { id: string; name: string; platform: string; lastSeenAt: string; revokedAt: string | null };
type Session = { id: string; deviceId: string | null; deviceName: string | null; platform: string | null; lastSeenAt: string; revokedAt: string | null };
type Invite = { id: string; createdAt: string; expiresAt: string; usedAt: string | null; revokedAt: string | null };
type InstanceUser = { id: string; email: string; displayName: string | null; isAdmin: boolean; createdAt: string };
type SyncIssues = Awaited<ReturnType<typeof listSyncIssues>>;

export function SettingsPage({ onLogout }: { onLogout: () => void }) {
  const toast = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [instanceUsers, setInstanceUsers] = useState<InstanceUser[]>([]);
  const [issues, setIssues] = useState<SyncIssues>({ conflicts: [], drafts: [] });
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [newInviteCode, setNewInviteCode] = useState('');
  const [totpSetup, setTotpSetup] = useState<{ challengeId: string; secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('odk-theme') as Theme) || 'auto');
  const [accentHue, setAccentHue] = useState<number | null>(() => getAccentHue());
  const [importing, setImporting] = useState(false);

  const loadSecurity = useCallback(async () => {
    const current = await api.get<Me>('/api/me');
    setMe(current);
    const [deviceResult, sessionResult, syncIssues] = await Promise.all([
      api.get<{ devices: Device[] }>('/api/sync/devices'),
      api.get<{ sessions: Session[] }>('/api/sync/sessions'),
      listSyncIssues(),
    ]);
    setDevices(deviceResult.devices);
    setSessions(sessionResult.sessions);
    setIssues(syncIssues);
    if (current.isAdmin) {
      const [inviteResult, userResult] = await Promise.all([
        api.get<{ invites: Invite[] }>('/api/account/invites'),
        api.get<{ users: InstanceUser[] }>('/api/account/users'),
      ]);
      setInvites(inviteResult.invites);
      setInstanceUsers(userResult.users);
    }
  }, []);

  useEffect(() => {
    void loadSecurity().catch((error: unknown) => toast(messageOf(error, '無法載入安全設定'), 'error'));
  }, [loadSecurity, toast]);

  function applyTheme(next: Theme) {
    setTheme(next);
    if (next === 'auto') {
      localStorage.removeItem('odk-theme');
      delete document.documentElement.dataset['theme'];
    } else {
      localStorage.setItem('odk-theme', next);
      document.documentElement.dataset['theme'] = next;
    }
  }

  async function registerPasskey() {
    try {
      const start = await api.post<{
        challengeId: string;
        options: Parameters<typeof startRegistration>[0]['optionsJSON'];
      }>('/api/auth/passkeys/register/options');
      const response = await startRegistration({ optionsJSON: start.options });
      const result = await api.post<{ verified: boolean; recoveryCodes: string[] }>('/api/auth/passkeys/register/verify', {
        challengeId: start.challengeId,
        response,
      });
      setRecoveryCodes(result.recoveryCodes);
      toast(result.recoveryCodes.length ? 'Passkey 已加入；請立刻保存恢復碼' : 'Passkey 已加入', 'ok');
    } catch (error) {
      toast(messageOf(error, 'Passkey 設定未完成'), 'error');
    }
  }

  async function createInvite() {
    try {
      const result = await api.post<{ code: string }>('/api/account/invites', { expiresInDays: 7 });
      setNewInviteCode(result.code);
      await loadSecurity();
      toast('邀請碼已建立，只會完整顯示這一次', 'ok');
    } catch (error) {
      toast(messageOf(error, '無法建立邀請碼'), 'error');
    }
  }

  async function beginTotpSetup() {
    try {
      setTotpSetup(await api.post('/api/auth/totp/setup/options'));
    } catch (error) {
      toast(messageOf(error, '無法開始設定驗證器'), 'error');
    }
  }

  async function verifyTotpSetup() {
    if (!totpSetup) return;
    try {
      await api.post('/api/auth/totp/setup/verify', { challengeId: totpSetup.challengeId, code: totpCode });
      setTotpSetup(null);
      setTotpCode('');
      toast('TOTP 備援登入已啟用', 'ok');
    } catch (error) {
      toast(messageOf(error, '驗證碼不正確，請重新開始設定'), 'error');
    }
  }

  async function solveConflict(id: string, choice: 'server' | 'local') {
    await resolveConflict(id, choice, choice === 'local' ? uuidv7() : undefined);
    if (choice === 'local') await syncNow();
    setIssues(await listSyncIssues());
  }

  async function logout() {
    await api.post('/api/auth/logout');
    onLogout();
  }

  async function importBackup(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const parsed = JSON.parse(await file.text()) as { formatVersion?: number; data?: unknown };
      const result = await api.post<{ imported: Record<string, number> }>('/api/import/json', parsed);
      const total = Object.values(result.imported).reduce((sum, n) => sum + n, 0);
      toast(`已還原 ${total} 筆資料 ✓ 重新載入中…`);
      setTimeout(() => location.reload(), 800);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '匯入失敗：請確認選的是完整 JSON 備份檔', 'error');
      setImporting(false);
    }
  }

  return (
    <div className="space-y-10">
      <div>
        <h1 className="odk-page-title text-2xl font-semibold">設定</h1>
        <p className="mt-1 text-sm text-[var(--odk-muted)]">帳號、安全、同步和資料都在這裡</p>
      </div>

      <SettingSection title="帳號">
        <div className="rounded-xl bg-[var(--odk-surface-2)] p-4 text-sm">
          <div className="font-medium">{me?.displayName ?? '未設定顯示名稱'}</div>
          <div className="text-[var(--odk-muted)]">{me?.email}</div>
          <div className="mt-1 text-xs text-[var(--odk-muted)]">帳本時區：{me?.ledgerTimeZone}</div>
        </div>
      </SettingSection>

      <NetWorthSection me={me} onBaseCurrencyChanged={loadSecurity} />

      <DiscordNotificationsSection />

      <AiSection />

      <SettingSection title="外觀">
        <Segmented
          options={[
            { value: 'auto' as const, label: '跟隨系統' },
            { value: 'light' as const, label: '亮色' },
            { value: 'dark' as const, label: '暗色' },
          ]}
          value={theme}
          onChange={applyTheme}
        />
        <div className="flex items-center gap-3 pt-1">
          <input
            type="range"
            min={0}
            max={359}
            value={accentHue ?? 168}
            onChange={(e) => { const hue = Number(e.target.value); setAccentHue(hue); applyAccentHue(hue); }}
            className="odk-hue-slider flex-1"
            aria-label="主題色相"
          />
          <span
            className="h-7 w-7 shrink-0 rounded-full border border-[var(--odk-line)]"
            style={{ background: `hsl(${accentHue ?? 168} 55% 45%)` }}
          />
        </div>
        {accentHue !== null ? (
          <button
            type="button"
            className="text-xs text-[var(--odk-muted)] underline"
            onClick={() => { setAccentHue(null); applyAccentHue(null); }}
          >
            恢復預設湖綠色
          </button>
        ) : null}
      </SettingSection>

      <SettingSection title="Passkey 與恢復">
        <p className="text-sm leading-6 text-[var(--odk-muted)]">Passkey 是主要登入方式，密碼保留作為自己架設時的備援</p>
        <Button variant="primary" onClick={() => void registerPasskey()}>在這台裝置加入 Passkey</Button>
        {recoveryCodes.length ? (
          <div className="rounded-xl bg-[var(--odk-surface-2)] p-4 text-sm">
            <strong>只顯示一次：請離線保存這 10 組恢復碼</strong>
            <pre className="mt-3 whitespace-pre-wrap font-mono text-xs leading-6">{recoveryCodes.join('\n')}</pre>
          </div>
        ) : null}
        <div className="pt-2">
          <p className="mb-2 text-sm text-[var(--odk-muted)]">也可以用 TOTP 驗證器備援登入</p>
          {!totpSetup ? <Button onClick={() => void beginTotpSetup()}>設定 TOTP</Button> : (
            <div className="space-y-3 rounded-xl bg-[var(--odk-surface-2)] p-4 text-sm">
              <p>在驗證器中輸入下列密鑰，再用產生的 6 位數確認：</p>
              <code className="block break-all font-mono">{totpSetup.secret}</code>
              <a className="block text-[var(--odk-accent)] underline" href={totpSetup.otpauthUrl}>在支援的驗證器中開啟</a>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <input className="min-h-10 min-w-0 flex-1 rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)] px-3" inputMode="numeric" value={totpCode} onChange={(event) => setTotpCode(event.target.value)} placeholder="000000" />
                <Button variant="primary" onClick={() => void verifyTotpSetup()}>確認</Button>
              </div>
            </div>
          )}
        </div>
      </SettingSection>

      <SettingSection title="裝置與 Session">
        <div className="rounded-xl bg-[var(--odk-surface-2)] px-4 py-1">
          {devices.map((device) => (
            <div key={device.id} className="flex flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{device.name}{device.id === currentDeviceId() ? '・這台裝置' : ''}</div>
                <div className="odk-break-anywhere text-xs text-[var(--odk-muted)]">{device.platform.slice(0, 60)}{device.revokedAt ? '・已撤銷' : ''}</div>
              </div>
              {!device.revokedAt && device.id !== currentDeviceId() ? (
                <Button className="self-start" variant="danger" onClick={() => void api.post(`/api/sync/devices/${device.id}/revoke`).then(loadSecurity)}>撤銷</Button>
              ) : null}
            </div>
          ))}
          {sessions.filter((session) => !session.revokedAt).map((session) => (
            <div key={session.id} className="flex flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0 flex-1">
                <div>Session・{session.deviceName ?? '尚未綁定裝置'}</div>
                <div className="text-xs text-[var(--odk-muted)]">最後使用 {formatDate(session.lastSeenAt)}</div>
              </div>
              {session.deviceId !== currentDeviceId() ? (
                <Button className="self-start" variant="danger" onClick={() => void api.post(`/api/sync/sessions/${session.id}/revoke`).then(loadSecurity)}>登出</Button>
              ) : null}
            </div>
          ))}
        </div>
      </SettingSection>

      {(issues.conflicts.length || issues.drafts.length) ? (
        <SettingSection title="同步待處理">
          {issues.conflicts.map((item) => (
            <div key={item.mutation.mutationId} className="space-y-3 rounded-xl bg-[color-mix(in_srgb,var(--odk-signal)_10%,transparent)] p-4 text-sm">
              <div><strong>{item.mutation.entity}</strong> 在別的裝置也被修改，請選擇要保留哪一份</div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void solveConflict(item.mutation.mutationId, 'server')}>保留伺服器版本</Button>
                <Button variant="primary" onClick={() => void solveConflict(item.mutation.mutationId, 'local')}>改用這台版本</Button>
              </div>
            </div>
          ))}
          {issues.drafts.map((item) => (
            <div key={item.mutation.mutationId} className="flex flex-col gap-2 rounded-xl bg-[var(--odk-surface-2)] p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0">{item.mutation.entity} 的離線變更未通過驗證，已保留為草稿</span>
              <Button variant="danger" onClick={() => void discardDraft(item.mutation.mutationId).then(loadSecurity)}>捨棄草稿</Button>
            </div>
          ))}
        </SettingSection>
      ) : null}

      {me?.isAdmin ? (
        <SettingSection title="邀請其他使用者">
          <p className="text-sm leading-6 text-[var(--odk-muted)]">架設者可選擇開放、邀請或關閉註冊<br />邀請模式由管理者建立一次性邀請碼</p>
          <Button onClick={() => void createInvite()}>建立 7 天邀請碼</Button>
          {newInviteCode ? <code className="block break-all rounded-lg bg-[var(--odk-surface-2)] p-3 text-sm">{newInviteCode}</code> : null}
          <div className="text-xs text-[var(--odk-muted)]">已建立 {invites.length} 組，使用或撤銷後不再顯示原碼</div>
          <div className="rounded-xl bg-[var(--odk-surface-2)] px-4 py-1">
            {instanceUsers.map((user) => (
              <div key={user.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                <span className="min-w-0 break-words">{user.displayName ?? user.email}<small className="ml-2 text-[var(--odk-muted)]">{user.displayName ? user.email : ''}</small></span>
                <span className="text-xs text-[var(--odk-muted)]">{user.isAdmin ? '管理者' : '使用者'}</span>
              </div>
            ))}
          </div>
        </SettingSection>
      ) : null}

      <SettingSection title="資料所有權">
        <p className="text-sm text-[var(--odk-muted)]">完整匯出包含帳本、規則與審計歷史，CSV 會打包成 zip</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <a href="/api/export/json" download className="rounded-lg bg-[var(--odk-surface-2)] px-4 py-2.5 text-center text-sm transition-colors hover:bg-[var(--odk-accent-soft)]">下載完整 JSON</a>
          <a href="/api/export/csv" download className="rounded-lg bg-[var(--odk-surface-2)] px-4 py-2.5 text-center text-sm transition-colors hover:bg-[var(--odk-accent-soft)]">下載 CSV zip</a>
          <label className={`block rounded-lg bg-[var(--odk-surface-2)] px-4 py-2.5 text-center text-sm transition-colors sm:col-span-2 ${importing ? 'text-[var(--odk-muted)]' : 'cursor-pointer hover:bg-[var(--odk-accent-soft)]'}`}>
            {importing ? '還原中…' : '匯入完整備份（JSON）'}
            <input type="file" accept=".json,application/json" className="hidden" disabled={importing} onChange={(e) => void importBackup(e)} />
          </label>
        </div>
        <p className="text-xs text-[var(--odk-muted)]">匯入會還原之前下載的完整 JSON 備份，只能在還沒記帳的全新帳號上執行</p>
      </SettingSection>

      <Button variant="danger" className="w-full" onClick={() => void logout().catch((error) => toast(messageOf(error, '登出失敗'), 'error'))}>登出</Button>
      <p className="pb-4 text-center text-xs text-[var(--odk-muted)]">okane-dokoitta ・ お金どこいった？ ・ AGPL-3.0</p>
    </div>
  );
}

/** 淨資產一覽的基準幣別與外幣匯率（M4）：首頁換算用。 */
function NetWorthSection({ me, onBaseCurrencyChanged }: { me: Me | null; onBaseCurrencyChanged: () => Promise<void> }) {
  const { accounts } = useAccounts();
  const toast = useToast();
  const [rates, setRates] = useState<Record<string, string>>({});
  const [busyCurrency, setBusyCurrency] = useState<string | null>(null);

  async function saveBaseCurrency(next: string) {
    try {
      await api.post('/api/me/base-currency', { currency: next });
      await onBaseCurrencyChanged();
      toast('基準幣別已更新 ✓');
    } catch (error) {
      toast(messageOf(error, '更新失敗'), 'error');
    }
  }

  async function saveRate(currency: string) {
    const rate = rates[currency];
    if (!me || !rate) return;
    setBusyCurrency(currency);
    try {
      await mutate('exchange_rates', 'create', newEntityId(), {
        base: currency,
        quote: me.baseCurrency,
        rate,
        asOf: new Date().toISOString(),
        source: 'manual',
      });
      toast(`${currency} → ${me.baseCurrency} 匯率已更新 ✓`);
    } catch (error) {
      toast(messageOf(error, '更新失敗'), 'error');
    } finally {
      setBusyCurrency(null);
    }
  }

  if (!me) return null;
  const foreignCurrencies = [...new Set(accounts.filter(isActive).map((a) => a.currency))].filter((c) => c !== me.baseCurrency);

  return (
    <SettingSection title="淨資產一覽">
      <Field label="換算基準幣別" hint="首頁淨資產與各幣別帳戶都會換算成這個幣別">
        <Select value={me.baseCurrency} onChange={(e) => void saveBaseCurrency(e.target.value)}>
          <option value="TWD">TWD</option>
          <option value="USD">USD</option>
          <option value="JPY">JPY</option>
        </Select>
      </Field>
      {foreignCurrencies.length ? (
        <div className="space-y-2">
          <p className="text-xs text-[var(--odk-muted)]">外幣帳戶需要匯率才能換算淨資產；沒有設定時該幣別會被跳過並標記資料不完整</p>
          {foreignCurrencies.map((currency) => (
            <div key={currency} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
              <Field label={`1 ${currency} = ? ${me.baseCurrency}`}>
                <TextInput
                  inputMode="decimal"
                  value={rates[currency] ?? ''}
                  onChange={(e) => setRates((prev) => ({ ...prev, [currency]: e.target.value }))}
                />
              </Field>
              <Button variant="primary" disabled={busyCurrency === currency} onClick={() => void saveRate(currency)}>
                更新
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </SettingSection>
  );
}

const PRIVACY_MODE_OPTIONS: Array<{ value: PrivacyMode; label: string }> = [
  { value: 'full', label: '完整金額' },
  { value: 'fuzzy', label: '模糊金額' },
  { value: 'anomaly_only', label: '只提異常' },
  { value: 'hidden', label: '隱藏金額' },
];

function minuteToTimeInput(minute: number | null): string {
  if (minute === null) return '';
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function timeInputToMinute(value: string): number | null {
  if (!value) return null;
  const [h, m] = value.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Discord 連結、隱私模式、quiet hours、Web Push 訂閱（M5，DISCORD_INTEGRATION）。 */
function DiscordNotificationsSection() {
  const toast = useToast();
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [discord, setDiscord] = useState<DiscordStatus | null>(null);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [commandsBusy, setCommandsBusy] = useState(false);

  const load = useCallback(async () => {
    const [prefsResult, discordResult, subscription] = await Promise.all([
      api.get<NotificationPrefs>('/api/notifications/preferences'),
      api.get<DiscordStatus>('/api/discord/status'),
      currentPushSubscription(),
    ]);
    setPrefs(prefsResult);
    setDiscord(discordResult);
    setPushSubscribed(subscription !== null);
  }, []);

  useEffect(() => {
    void load().catch(() => {});
    const params = new URLSearchParams(window.location.search);
    if (params.get('discordLinked')) toast('Discord 已連結 ✓');
    if (params.get('discordError')) toast('Discord 連結失敗，請再試一次', 'error');
    if (params.has('discordLinked') || params.has('discordError')) {
      params.delete('discordLinked');
      params.delete('discordError');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    }
  }, [load, toast]);

  async function linkDiscord() {
    try {
      const { url } = await api.post<{ url: string }>('/api/discord/oauth/start');
      window.location.href = url;
    } catch (error) {
      toast(messageOf(error, '無法開始連結'), 'error');
    }
  }

  async function revokeDiscord() {
    try {
      await api.post('/api/discord/revoke');
      await load();
      toast('已撤銷 Discord 連結');
    } catch (error) {
      toast(messageOf(error, '撤銷失敗'), 'error');
    }
  }

  // 註冊 /finance 指令（一次性，或指令定義更新後重跑）：直接用正式站已有的 Discord 設定，不用另外貼 Bot Token
  async function registerDiscordCommands() {
    setCommandsBusy(true);
    try {
      const result = await api.post<{ commandCount: number }>('/api/discord/admin/register-commands');
      toast(`已註冊 ${result.commandCount} 組指令，Discord 全域生效最多等 1 小時`, 'ok');
    } catch (error) {
      toast(messageOf(error, '指令註冊失敗'), 'error');
    } finally {
      setCommandsBusy(false);
    }
  }

  async function savePrefs(patch: Partial<NotificationPrefs>) {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      await api.post('/api/notifications/preferences', patch);
    } catch (error) {
      toast(messageOf(error, '設定未儲存'), 'error');
      await load();
    }
  }

  async function togglePush() {
    if (!prefs?.webPushVapidPublicKey) return;
    setPushBusy(true);
    try {
      if (pushSubscribed) {
        await unsubscribeWebPush();
        setPushSubscribed(false);
        toast('已關閉這台裝置的推播通知');
      } else {
        await subscribeWebPush(prefs.webPushVapidPublicKey);
        setPushSubscribed(true);
        toast('這台裝置已訂閱推播通知 ✓');
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : '推播設定失敗', 'error');
    } finally {
      setPushBusy(false);
    }
  }

  if (!prefs || !discord) return null;

  return (
    <SettingSection title="Discord 與通知">
      <div className="rounded-xl bg-[var(--odk-surface-2)] p-4 text-sm">
        {discord.linked ? (
          <div className="flex items-center justify-between gap-3">
            <span>已連結：{discord.discordUsername}</span>
            <Button variant="danger" onClick={() => void revokeDiscord()}>撤銷連結</Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-[var(--odk-muted)]">{discord.enabled ? '尚未連結 Discord' : '這裡還沒開通 Discord 整合'}</span>
            {discord.enabled ? <Button variant="primary" onClick={() => void linkDiscord()}>連結 Discord</Button> : null}
          </div>
        )}
        {discord.enabled ? (
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--odk-line)] pt-3 text-xs text-[var(--odk-muted)]">
            <span>指令定義有更新，或第一次設定時要註冊 /finance 指令</span>
            <Button disabled={commandsBusy} onClick={() => void registerDiscordCommands()}>
              {commandsBusy ? '註冊中…' : '重新註冊指令'}
            </Button>
          </div>
        ) : null}
      </div>

      <Field label="隱私模式" hint="套用到所有 Discord 指令與通知的金額顯示">
        <Segmented options={PRIVACY_MODE_OPTIONS} value={prefs.privacyMode} onChange={(value) => void savePrefs({ privacyMode: value })} />
      </Field>

      <Field label="Quiet hours" hint="這段時間不主動發通知（下一次排程再補發）">
        <div className="grid grid-cols-2 gap-2">
          <input
            type="time"
            className="min-h-10 rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)] px-3"
            value={minuteToTimeInput(prefs.quietHoursStartMinute)}
            onChange={(e) => void savePrefs({ quietHoursStartMinute: timeInputToMinute(e.target.value) })}
          />
          <input
            type="time"
            className="min-h-10 rounded-md border border-[var(--odk-line)] bg-[var(--odk-surface)] px-3"
            value={minuteToTimeInput(prefs.quietHoursEndMinute)}
            onChange={(e) => void savePrefs({ quietHoursEndMinute: timeInputToMinute(e.target.value) })}
          />
        </div>
      </Field>

      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-sm">Web Push（這台裝置）</span>
          <p className="text-xs text-[var(--odk-muted)]">提醒以 Discord 為主；沒連結 Discord 時才會用瀏覽器推播</p>
        </div>
        {prefs.webPushVapidPublicKey ? (
          <Button disabled={pushBusy} onClick={() => void togglePush()}>{pushSubscribed ? '關閉這台裝置的推播' : '開啟這台裝置的推播'}</Button>
        ) : (
          <span className="text-xs text-[var(--odk-muted)]">這裡還沒開通推播通知</span>
        )}
      </div>
    </SettingSection>
  );
}

interface AiSettingsJson {
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

/** M6 AI 輔助（BYOK）：接任何 OpenAI 相容端點——自己架的、Cloudflare Workers AI、OpenRouter 都行。 */
function AiSection() {
  const toast = useToast();
  const [settings, setSettings] = useState<AiSettingsJson | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api
      .get<AiSettingsJson>('/api/ai/settings')
      .then((s) => {
        setSettings(s);
        setBaseUrl(s.baseUrl);
        setModel(s.model);
      })
      .catch((error) => setLoadError(messageOf(error, 'AI 設定載入失敗；請確認資料庫 migration 已套用')));
  }, []);

  async function save(patch: { enabled?: boolean }) {
    setBusy(true);
    try {
      const s = await api.post<AiSettingsJson>('/api/ai/settings', {
        ...patch,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey ? { apiKey } : {}),
      });
      setSettings(s);
      setApiKey('');
      toast('AI 設定已儲存 ✓');
    } catch (error) {
      toast(messageOf(error, '儲存失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const saved = await api.post<AiSettingsJson>('/api/ai/settings', {
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey ? { apiKey } : {}),
      });
      setSettings(saved);
      setApiKey('');
      const result = await api.post<{ ok: boolean; reply: string }>('/api/ai/test', {});
      toast(result.ok ? `連線成功：${result.reply}` : '連線失敗', result.ok ? 'ok' : 'error');
    } catch (error) {
      toast(messageOf(error, '連線失敗——檢查端點、模型與 key'), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return (
      <SettingSection title="AI 輔助">
        <p className="rounded-md bg-[var(--odk-accent-soft)] p-3 text-sm text-[var(--odk-negative)]">
          {loadError || 'AI 設定載入中…'}
        </p>
      </SettingSection>
    );
  }

  return (
    <SettingSection title="AI 輔助">
      <p className="text-sm text-[var(--odk-muted)]">
        自己帶模型：貼上任何 OpenAI 相容端點就能用——自己電腦跑的（Ollama、LM Studio）、Cloudflare Workers
        AI、OpenRouter 都行。不設定也完全不影響記帳與對帳，AI 只是幫你整理帳單文字、解釋對帳結果，永遠不會自己動你的帳。
      </p>
      <Field label="端點" hint="可填 API 根路徑或完整 /chat/completions URL；OpenRouter 例：https://openrouter.ai/api/v1">
        <TextInput value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
      </Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="模型" hint="例：@cf/meta/llama-3.3-70b-instruct-fp8-fast">
          <TextInput value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型名稱" />
        </Field>
        <Field label="API key（選填）" hint={settings.hasApiKey ? '已設定；留空＝沿用，填入＝更換' : '本機模型通常不用'}>
          <TextInput type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={settings.hasApiKey ? '••••••••' : ''} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void save({})}>
          儲存
        </Button>
        <Button disabled={busy || !baseUrl.trim() || !model.trim()} onClick={() => void test()}>
          測試連線
        </Button>
        {settings.hasApiKey ? (
          <Button disabled={busy} onClick={() => {
            setBusy(true);
            void api.post<AiSettingsJson>('/api/ai/settings', { apiKey: null })
              .then((next) => { setSettings(next); toast('API key 已移除 ✓'); })
              .catch((error) => toast(messageOf(error, '移除 key 失敗'), 'error'))
              .finally(() => setBusy(false));
          }}>
            移除 API key
          </Button>
        ) : null}
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.enabled} disabled={busy} onChange={(e) => void save({ enabled: e.target.checked })} />
          啟用 AI 輔助
        </label>
      </div>
    </SettingSection>
  );
}

// 分區靠「標題層級＋大間距」表達，不畫分隔線（線條保留給表單輸入框）
function SettingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-3"><h2 className="text-base font-semibold">{title}</h2>{children}</section>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
