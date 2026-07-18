export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="tablist" className="odk-segmented flex rounded-xl bg-[var(--odk-surface-2)] p-1">
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          type="button"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          className={`flex-1 rounded-lg px-3 py-2 text-sm transition-[background,color,transform] active:scale-[0.98] ${
            option.value === value
              ? 'bg-[var(--odk-accent)] font-semibold text-[var(--odk-accent-ink)]'
              : 'text-[var(--odk-muted)]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
