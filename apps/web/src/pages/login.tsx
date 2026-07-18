import { startAuthentication } from '@simplewebauthn/browser';
import { Button, Field, TextInput, useToast } from '@okane-dokoitta/ui';
import { useState } from 'react';
import { api, ApiError, setCsrfToken } from '../api.js';

type RegistrationMode = 'open' | 'invite' | 'closed';

export function LoginPage({
  mode,
  registrationMode,
  onDone,
}: {
  mode: 'setup' | 'login';
  registrationMode: RegistrationMode;
  onDone: () => void;
}) {
  const [action, setAction] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpChallengeId, setTotpChallengeId] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const isRegister = mode === 'login' && action === 'register';

  async function submit() {
    setBusy(true);
    try {
      const path = mode === 'setup' ? '/api/auth/setup' : isRegister ? '/api/auth/register' : '/api/auth/login';
      const body = mode === 'setup'
        ? { email, password, ...(displayName ? { displayName } : {}) }
        : isRegister
          ? { email, password, ...(displayName ? { displayName } : {}), ...(inviteCode ? { inviteCode } : {}) }
          : { email, password };
      const res = await api.post<{ csrfToken?: string; requiresTotp?: boolean; challengeId?: string }>(path, body);
      if (res.requiresTotp && res.challengeId) {
        setTotpChallengeId(res.challengeId);
        return toast('密碼正確，請輸入驗證器的 6 位數完成登入', 'ok');
      }
      if (!res.csrfToken) throw new ApiError('AUTH_RESPONSE_INVALID', '登入回應不完整', 500);
      setCsrfToken(res.csrfToken);
      onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '無法登入', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function loginWithPasskey() {
    if (!email) return toast('先輸入 Email，才能找到你的 Passkey', 'error');
    setBusy(true);
    try {
      const start = await api.post<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>(
        '/api/auth/passkeys/login/options',
        { email },
      );
      const response = await startAuthentication({ optionsJSON: start.options });
      const verified = await api.post<{ csrfToken: string }>('/api/auth/passkeys/login/verify', {
        challengeId: start.challengeId,
        response,
      });
      setCsrfToken(verified.csrfToken);
      onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Passkey 登入未完成', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function loginWithRecoveryCode() {
    if (!email || !recoveryCode) return toast('請輸入 Email 與恢復碼', 'error');
    setBusy(true);
    try {
      const result = await api.post<{ csrfToken: string }>('/api/auth/recovery/login', { email, code: recoveryCode });
      setCsrfToken(result.csrfToken);
      onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '恢復碼登入失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function loginWithTotp() {
    if (!totpChallengeId || !/^\d{6}$/.test(totpCode)) return toast('請先以密碼登入，再輸入 6 位驗證碼', 'error');
    setBusy(true);
    try {
      const result = await api.post<{ csrfToken: string }>('/api/auth/totp/login', { challengeId: totpChallengeId, code: totpCode });
      setCsrfToken(result.csrfToken);
      onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'TOTP 登入失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid min-h-dvh max-w-4xl content-center gap-10 px-6 py-12 md:grid-cols-[1fr_22rem] md:items-center">
      <div>
        <img src="/logo.png" alt="" className="mb-4 h-14 w-14" />
        <img src="/wordmark.png" alt="お金どこいった？" className="h-12 w-auto max-w-full" />
        <p className="mt-5 text-xl font-medium">{mode === 'setup' ? '先把帳本建起來' : '錢花去哪，打開就知道'}</p>
        <p className="mt-2 max-w-sm text-sm leading-6 text-[var(--odk-muted)]">
          {mode === 'setup' ? '第一個帳號會成為管理者' : '登入後就能接著記帳、分類和對帳'}
        </p>
      </div>
      <form
        className="space-y-4 rounded-2xl border border-[var(--odk-line)] bg-[var(--odk-surface)] p-6 shadow-[var(--odk-shadow)]"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        {mode === 'setup' ? (
          <p className="rounded-lg bg-[var(--odk-accent-soft)] p-3 text-sm text-[var(--odk-muted)]">第一次使用，先建立管理者帳號</p>
        ) : (
          <div className="flex border-b border-[var(--odk-line)] text-sm">
            <button type="button" className={`flex-1 pb-2 ${!isRegister ? 'font-semibold text-[var(--odk-accent)]' : 'text-[var(--odk-muted)]'}`} onClick={() => setAction('login')}>登入</button>
            {registrationMode !== 'closed' ? (
              <button type="button" className={`flex-1 pb-2 ${isRegister ? 'font-semibold text-[var(--odk-accent)]' : 'text-[var(--odk-muted)]'}`} onClick={() => setAction('register')}>建立帳號</button>
            ) : null}
          </div>
        )}
        <Field label="Email">
          <TextInput type="email" required autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        {(mode === 'setup' || isRegister) ? (
          <Field label="顯示名稱（選填）"><TextInput value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
        ) : null}
        <Field label="密碼" hint={mode === 'setup' || isRegister ? '至少 10 個字元' : undefined}>
          <TextInput
            type="password"
            required
            minLength={mode === 'setup' || isRegister ? 10 : 1}
            autoComplete={mode === 'setup' || isRegister ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {isRegister && registrationMode === 'invite' ? (
          <Field label="邀請碼"><TextInput required value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} /></Field>
        ) : null}
        <Button variant="primary" type="submit" disabled={busy} className="w-full py-2.5">
          {busy ? '處理中…' : mode === 'setup' ? '建立管理者帳號' : isRegister ? '建立帳號' : '登入'}
        </Button>
        {mode === 'login' && !isRegister ? (
          <div className="space-y-2 border-t border-[var(--odk-line)] pt-4">
            <Button type="button" className="w-full" disabled={busy} onClick={() => void loginWithPasskey()}>使用 Passkey</Button>
            <details className="text-sm text-[var(--odk-muted)]">
              <summary className="cursor-pointer py-1">改用一次性恢復碼</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <TextInput aria-label="恢復碼" placeholder="ODK-…" value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} />
                <Button type="button" disabled={busy} onClick={() => void loginWithRecoveryCode()}>登入</Button>
              </div>
            </details>
            {totpChallengeId ? <div className="text-sm text-[var(--odk-muted)]">
              <p className="py-1">第二步：驗證器代碼（TOTP）</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <TextInput inputMode="numeric" aria-label="6 位驗證碼" placeholder="000000" value={totpCode} onChange={(event) => setTotpCode(event.target.value)} />
                <Button type="button" disabled={busy} onClick={() => void loginWithTotp()}>完成登入</Button>
              </div>
            </div> : null}
          </div>
        ) : null}
      </form>
    </div>
  );
}
