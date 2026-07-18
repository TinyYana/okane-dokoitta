import { useEffect, useRef, type ReactNode } from 'react';

/**
 * 原生 <dialog>（ponytail: 平台原生已涵蓋 modal 行為 — focus trap、Esc、backdrop）。
 * 需要更複雜的浮層（popover/menu）時再評估 Radix。
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        // 點 backdrop 關閉
        if (e.target === ref.current) onClose();
      }}
      className="odk-dialog m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-[var(--odk-line)] bg-[var(--odk-surface)] p-0 text-[var(--odk-text)] shadow-[var(--odk-shadow)]"
    >
      <div className="p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between border-b border-[var(--odk-line)] pb-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-xs text-[var(--odk-muted)] hover:bg-[var(--odk-surface-2)]">
            關閉
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
