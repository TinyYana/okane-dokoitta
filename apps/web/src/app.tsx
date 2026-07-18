import { ToastProvider } from '@okane-dokoitta/ui';
import gsap from 'gsap';
import { FileSearch, List, Plus, Repeat2, Settings, Wallet, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, clearUserContext, configureUserContext, getSyncStatus, setCsrfToken, startSync, stopSync, subscribeSyncStatus, type SyncStatus } from './api.js';
import { AccountsContext, useAccountsProvider } from './store.js';
import { AccountsPage } from './pages/accounts.jsx';
import { LoginPage } from './pages/login.jsx';
import { QuickAddPage } from './pages/quick-add.jsx';
import { RecurringPage } from './pages/recurring.jsx';
import { SettingsPage } from './pages/settings.jsx';
import { TransactionsPage } from './pages/transactions.jsx';
import { AuditPage } from './pages/audit.jsx';

/** hash router（ponytail: 6 個 view 用 20 行路由，不引 react-router） */
function useHashRoute(): string {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setRoute(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

type AuthState = 'loading' | 'needs-setup' | 'login' | 'ready';

export function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [registrationMode, setRegistrationMode] = useState<'open' | 'invite' | 'closed'>('invite');

  const checkAuth = useCallback(async () => {
    const status = await api.get<{ needsSetup: boolean; authenticated: boolean; registrationMode: 'open' | 'invite' | 'closed' }>('/api/auth/status');
    setRegistrationMode(status.registrationMode);
    if (status.needsSetup) return setAuthState('needs-setup');
    if (!status.authenticated) return setAuthState('login');
    const me = await api.get<{ userId: string; csrfToken: string }>('/api/me');
    await configureUserContext(me.userId);
    setCsrfToken(me.csrfToken);
    setAuthState('ready');
  }, []);

  useEffect(() => {
    checkAuth().catch(() => setAuthState('login'));
  }, [checkAuth]);

  if (authState === 'loading') {
    return <div className="flex min-h-dvh items-center justify-center text-[var(--odk-muted)]">載入中…</div>;
  }
  if (authState === 'needs-setup' || authState === 'login') {
    return (
      <ToastProvider>
        <LoginPage
          mode={authState === 'needs-setup' ? 'setup' : 'login'}
          registrationMode={registrationMode}
          onDone={() => void checkAuth()}
        />
      </ToastProvider>
    );
  }
  return (
    <ToastProvider>
      <Shell onLogout={() => { stopSync(); clearUserContext(); setCsrfToken(''); setAuthState('login'); }} />
    </ToastProvider>
  );
}

const TABS: Array<{ path: string; label: string; icon: LucideIcon }> = [
  { path: '/', label: '記一筆', icon: Plus },
  { path: '/transactions', label: '明細', icon: List },
  { path: '/accounts', label: '帳戶', icon: Wallet },
  { path: '/audit', label: '對帳', icon: FileSearch },
  { path: '/recurring', label: '週期', icon: Repeat2 },
  { path: '/settings', label: '設定', icon: Settings },
];

function Shell({ onLogout }: { onLogout: () => void }) {
  const route = useHashRoute();
  const accountsState = useAccountsProvider();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(getSyncStatus);
  const pageRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const unsubscribe = subscribeSyncStatus(setSyncStatus);
    void startSync().catch((error: unknown) => {
      console.warn('同步初始化失敗', error instanceof Error ? error.name : 'UnknownError');
    });
    return () => { unsubscribe(); stopSync(); };
  }, []);

  // 隱私遮蔽切換：formatAmount 讀模組旗標，這裡只負責讓整棵樹重新渲染
  const [, setMaskTick] = useState(0);
  useEffect(() => {
    const onMask = () => setMaskTick((v) => v + 1);
    window.addEventListener('odk-privacy-mask', onMask);
    return () => window.removeEventListener('odk-privacy-mask', onMask);
  }, []);

  useLayoutEffect(() => {
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(
        pageRef.current,
        { autoAlpha: 0, y: 10 },
        { autoAlpha: 1, y: 0, duration: 0.28, ease: 'power2.out', clearProps: 'opacity,visibility,transform' },
      );
    });
    return () => media.revert();
  }, [route]);

  let page;
  if (route === '/') page = <QuickAddPage />;
  else if (route === '/transactions') page = <TransactionsPage />;
  else if (route.startsWith('/accounts')) page = <AccountsPage route={route} />;
  else if (route.startsWith('/audit')) page = <AuditPage route={route} />;
  else if (route === '/recurring') page = <RecurringPage />;
  else if (route === '/settings') page = <SettingsPage onLogout={onLogout} />;
  else page = <QuickAddPage />;

  return (
    <AccountsContext.Provider value={accountsState}>
      <div className="odk-app-shell mx-auto min-h-dvh max-w-6xl md:grid md:grid-cols-[12rem_minmax(0,1fr)] md:gap-10 md:px-6">
        <aside className="hidden py-8 md:block">
          <div className="sticky top-8">
            <a href="#/" className="block" aria-label="okane-dokoitta 首頁">
              <img src="/logo.png" alt="" className="mb-2 h-9 w-9" />
              <div className="text-lg font-semibold tracking-tight">okane-dokoitta</div>
              <div className="mt-1 text-xs text-[var(--odk-muted)]">お金どこいった？</div>
              <SyncBadge status={syncStatus} />
            </a>
            <Nav route={route} desktop />
          </div>
        </aside>
        <div className="min-w-0">
          <header className="flex items-center justify-between px-4 py-3 md:hidden">
            <a href="#/" className="flex items-center gap-2 text-sm font-semibold tracking-tight"><img src="/logo.png" alt="" className="h-6 w-6" />okane-dokoitta</a>
            <SyncBadge status={syncStatus} compact />
          </header>
          <main ref={pageRef} className="mx-auto w-full max-w-3xl px-4 pb-28 pt-2 md:px-0 md:pb-12 md:pt-8">{page}</main>
        </div>
        <nav className="odk-mobile-nav pointer-events-none fixed inset-x-0 bottom-0 z-40 px-2 md:hidden" aria-label="主要導覽">
          <div className="pointer-events-auto mx-auto max-w-md rounded-[1.4rem] border border-[color-mix(in_srgb,var(--odk-line)_72%,transparent)] bg-[color-mix(in_srgb,var(--odk-surface)_88%,transparent)] p-1.5 shadow-[0_14px_40px_hsl(176_36%_7%/0.18),0_2px_8px_hsl(176_36%_7%/0.10)] backdrop-blur-xl">
            <Nav route={route} />
          </div>
        </nav>
      </div>
    </AccountsContext.Provider>
  );
}

function SyncBadge({ status, compact = false }: { status: SyncStatus; compact?: boolean }) {
  const pending = status.queued + status.conflicts + status.drafts;
  const label = status.phase === 'offline'
    ? `離線${status.queued ? `・待傳 ${status.queued}` : ''}`
    : status.phase === 'syncing'
      ? '同步中'
      : pending
        ? `同步待處理 ${pending}`
        : '已同步';
  return (
    <div className={`${compact ? 'text-[10px]' : 'mt-4 text-xs'} flex items-center gap-1.5 text-[var(--odk-muted)]`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status.phase === 'offline' || pending ? 'bg-[var(--odk-signal)]' : 'bg-[var(--odk-accent)]'}`} />
      {label}
    </div>
  );
}

function Nav({ route, desktop = false }: { route: string; desktop?: boolean }) {
  return (
    <div className={desktop ? 'mt-8 space-y-1' : 'flex items-center gap-0.5'}>
            {TABS.map((tab) => {
              const active = tab.path === '/' ? route === '/' : route.startsWith(tab.path);
              const Icon = tab.icon;
              return (
                <a
                  key={tab.path}
                  href={`#${tab.path}`}
                  aria-current={active ? 'page' : undefined}
                  className={`${desktop ? 'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm' : 'flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[1rem] px-0.5 py-1 text-[10px] leading-none transition-[background,color,transform] duration-150 active:scale-95'} ${
                    active
                      ? desktop
                        ? 'bg-[var(--odk-accent-soft)] font-semibold text-[var(--odk-accent)]'
                        : 'bg-[var(--odk-accent)] font-semibold text-[var(--odk-accent-ink)] shadow-[0_3px_10px_color-mix(in_srgb,var(--odk-accent)_35%,transparent)]'
                      : 'text-[var(--odk-muted)] hover:bg-[var(--odk-surface-2)] hover:text-[var(--odk-text)]'
                  }`}
                >
                  <Icon className={desktop ? 'h-4 w-4' : 'h-[18px] w-[18px]'} strokeWidth={active ? 2.5 : 2} aria-hidden="true" />
                  {tab.label}
                </a>
              );
            })}
    </div>
  );
}
