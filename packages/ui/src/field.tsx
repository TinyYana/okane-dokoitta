import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string | undefined }) {
  return (
    <label className="odk-field block space-y-1">
      <span className="block text-xs font-semibold text-[var(--odk-muted)]">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-[var(--odk-muted)]">{hint}</span> : null}
    </label>
  );
}

const controlClass =
  'w-full min-h-10 rounded-lg border border-[var(--odk-line)] bg-[var(--odk-surface)] px-3 py-2 text-sm text-[var(--odk-text)] outline-none transition-colors focus:border-[var(--odk-accent)] focus:bg-[var(--odk-accent-soft)]';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input className={`${controlClass} ${className}`} {...rest} />;
}

/** 原生 select（ponytail: 平台原生 > 自訂下拉；行動裝置體驗更好） */
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props;
  return <select className={`${controlClass} appearance-none ${className}`} {...rest} />;
}
