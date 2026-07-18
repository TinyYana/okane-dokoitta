import type { ButtonHTMLAttributes } from 'react';

/**
 * shadcn 模式：元件原始碼 vendored（AGENTS §8）。自訂 class 前綴 odk-。
 * M1 元件全部走原生元素 + Tailwind；尚未需要 Radix primitive（需要浮層行為時再引入）。
 */

type Variant = 'primary' | 'ghost' | 'danger' | 'outline';

const styles: Record<Variant, string> = {
  primary:
    'bg-[var(--odk-accent)] text-[var(--odk-accent-ink)] font-semibold shadow-[0_1px_1px_rgba(0,0,0,0.05),0_6px_14px_-6px_color-mix(in_srgb,var(--odk-accent)_65%,transparent)] hover:brightness-110 active:shadow-none active:brightness-95 disabled:shadow-none disabled:opacity-40',
  ghost: 'text-[var(--odk-text)] hover:bg-[var(--odk-surface-2)] active:bg-[var(--odk-surface-2)]',
  danger: 'text-[var(--odk-negative)] hover:bg-[color-mix(in_srgb,var(--odk-negative)_10%,transparent)]',
  outline:
    'border border-[var(--odk-line)] text-[var(--odk-text)] hover:bg-[var(--odk-surface-2)] disabled:opacity-40',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({ variant = 'outline', className = '', type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`odk-button inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm transition-[background,color,filter,box-shadow,transform] duration-150 select-none active:scale-[0.97] ${styles[variant]} ${className}`}
      {...rest}
    />
  );
}
