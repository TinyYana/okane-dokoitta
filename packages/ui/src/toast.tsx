import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

interface ToastItem {
  id: number;
  message: string;
  kind: 'ok' | 'error';
}

const ToastContext = createContext<(message: string, kind?: 'ok' | 'error') => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((message: string, kind: 'ok' | 'error' = 'ok') => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <div
            key={t.id}
            className={`odk-toast rounded-xl px-4 py-2.5 text-sm shadow-[var(--odk-shadow)] ${
              t.kind === 'ok'
                ? 'bg-[var(--odk-text)] text-[var(--odk-bg)]'
                : 'bg-[var(--odk-signal)] text-white'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
