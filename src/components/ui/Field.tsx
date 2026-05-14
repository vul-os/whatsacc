import {
  forwardRef,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';

type BaseInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'value' | 'size' | 'prefix'
>;

export type FieldProps = BaseInputProps & {
  label: string;
  hint?: ReactNode;
  /** content shown on the right of the label row (e.g. a "Forgot?" link) */
  labelTrailing?: ReactNode;
  /** inline content rendered inside the input on the left */
  prefix?: ReactNode;
  /** inline content rendered inside the input on the right */
  suffix?: ReactNode;
  /** error string — shown below the input and toggles error styling */
  error?: string | null;
  /** controlled value */
  value: string;
  onChange: (value: string) => void;
  /** for password fields, render a reveal toggle in the suffix slot */
  reveal?: boolean;
};

export const Field = forwardRef(function Field(
  {
    label,
    hint,
    labelTrailing,
    prefix,
    suffix,
    error,
    value,
    onChange,
    reveal,
    type = 'text',
    id,
    className,
    ...inputProps
  }: FieldProps,
  ref: Ref<HTMLInputElement>,
) {
  const reactId = useId();
  const inputId = id ?? `f-${reactId}`;
  const [showPassword, setShowPassword] = useState(false);
  const isPassword = type === 'password';
  const effectiveType = isPassword && showPassword ? 'text' : type;

  const trailingSuffix = isPassword && reveal !== false
    ? (
      <button
        type="button"
        onClick={() => setShowPassword((v) => !v)}
        aria-label={showPassword ? 'Hide password' : 'Show password'}
        aria-pressed={showPassword}
        className="grid place-items-center h-7 w-7 rounded-md text-ink/50 hover:text-ink hover:bg-ink/5 transition-colors"
        tabIndex={-1}
      >
        {showPassword ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    )
    : suffix;

  const ring = error
    ? 'border-terracotta/60 focus-within:border-terracotta focus-within:ring-terracotta/30'
    : 'border-ink/15 focus-within:border-ink/40 focus-within:ring-ink/20';

  return (
    <label htmlFor={inputId} className={`block ${className ?? ''}`}>
      <span className="flex items-baseline justify-between gap-3 mb-1.5">
        <span className="text-sm font-medium text-ink/85">{label}</span>
        {labelTrailing ?? (hint && <span className="text-xs text-ink/50">{hint}</span>)}
      </span>
      <span
        className={`flex items-center gap-2 h-11 rounded-xl bg-paper-cool border px-1 transition-colors focus-within:ring-2 ${ring}`}
      >
        {prefix && <span className="pl-2 grid place-items-center text-ink/55">{prefix}</span>}
        <input
          ref={ref}
          id={inputId}
          type={effectiveType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${inputId}-err` : undefined}
          className="flex-1 min-w-0 bg-transparent px-3 text-[15px] text-ink placeholder:text-ink/35 focus:outline-none"
          {...inputProps}
        />
        {trailingSuffix && <span className="pr-1.5">{trailingSuffix}</span>}
      </span>
      {error && (
        <span id={`${inputId}-err`} className="mt-1.5 block text-xs text-terracotta-deep" role="alert">
          {error}
        </span>
      )}
    </label>
  );
});

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.2A10.5 10.5 0 0 1 12 6c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7" />
      <path d="M6.7 7.4A17 17 0 0 0 2.5 12s3.5 7 9.5 7c1.5 0 2.9-.3 4.1-.8" />
      <path d="M9.6 10a3 3 0 0 0 4.4 4.1" />
    </svg>
  );
}
