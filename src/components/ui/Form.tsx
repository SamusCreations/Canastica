import React, { useId } from 'react';
import { ChevronDown, Minus, Plus } from 'lucide-react';

/* ---------------------------------------------------------------------------
   Form building blocks shared by every sheet.
   Rules: labels above fields, 48px touch targets, 16px text on phones
   (no iOS zoom), one column on phones, numeric keyboards for numbers.
   --------------------------------------------------------------------------- */

const FIELD_BASE =
  'w-full min-h-12 rounded-xl bg-[var(--input-glass-bg)] border border-[var(--input-border)] text-[var(--text-primary)] text-[15px] placeholder:text-[var(--text-muted)]/80 transition focus:outline-none focus:border-avocado-500 focus:ring-4 focus:ring-avocado-500/15 disabled:opacity-60';

interface FieldProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  /** Text or control shown at the right of the label (e.g. "+ Nuevo") */
  action?: React.ReactNode;
  className?: string;
  children: (id: string) => React.ReactNode;
}

/** Label + control + hint/error. Pass a render function to get the input id. */
export const Field: React.FC<FieldProps> = ({ label, hint, error, action, className = '', children }) => {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1.5 min-w-0 ${className}`}>
      {(label || action) && (
        <div className="flex items-center justify-between gap-2 min-h-5">
          {label && (
            <label htmlFor={id} className="text-sm font-semibold text-[var(--text-secondary)]">
              {label}
            </label>
          )}
          {action}
        </div>
      )}
      {children(id)}
      {error ? (
        <p className="text-sm font-medium text-coral-500" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-[var(--text-muted)] leading-snug">{hint}</p>
      ) : null}
    </div>
  );
};

export const TextInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...rest }, ref) => <input ref={ref} className={`${FIELD_BASE} px-3.5 ${className}`} {...rest} />
);
TextInput.displayName = 'TextInput';

export const TextArea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = '', ...rest }, ref) => (
    <textarea ref={ref} className={`${FIELD_BASE} px-3.5 py-3 leading-relaxed resize-y ${className}`} {...rest} />
  )
);
TextArea.displayName = 'TextArea';

export const SelectInput = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className = '', children, ...rest }, ref) => (
    <div className="relative">
      <select ref={ref} className={`${FIELD_BASE} appearance-none pl-3.5 pr-10 ${className}`} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
    </div>
  )
);
SelectInput.displayName = 'SelectInput';

interface MoneyInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: number | '';
  onValueChange: (value: number) => void;
  symbol?: string;
}

/** Amount field with currency prefix and the numeric keyboard. */
export const MoneyInput: React.FC<MoneyInputProps> = ({ value, onValueChange, symbol = '₡', className = '', ...rest }) => (
  <div className="relative">
    <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[15px] font-semibold text-[var(--text-muted)]">
      {symbol}
    </span>
    <input
      type="number"
      inputMode="decimal"
      step="any"
      min={0}
      value={value}
      onChange={(e) => onValueChange(e.target.value === '' ? 0 : parseFloat(e.target.value) || 0)}
      onFocus={(e) => e.currentTarget.select()}
      className={`${FIELD_BASE} pl-8 pr-3.5 tabular-nums ${className}`}
      {...rest}
    />
  </div>
);

interface StepperProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
}

/** − value + : quantities without typing. */
export const Stepper: React.FC<StepperProps> = ({ value, onChange, min = 0, max = 9999, step = 1, label }) => {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Math.round(v * 1000) / 1000)));
  return (
    <div className="flex items-stretch h-12 rounded-xl border border-[var(--input-border)] bg-[var(--input-glass-bg)] overflow-hidden">
      <button
        type="button"
        onClick={() => set(value - step)}
        disabled={value <= min}
        className="w-12 flex items-center justify-center text-avocado-700 dark:text-avocado-300 hover:bg-[var(--glass-bg-hover)] disabled:opacity-30"
        aria-label={`Menos ${label ?? ''}`.trim()}
      >
        <Minus className="w-4 h-4" />
      </button>
      <input
        type="number"
        inputMode="decimal"
        step="any"
        value={value}
        onChange={(e) => set(parseFloat(e.target.value) || 0)}
        onFocus={(e) => e.currentTarget.select()}
        aria-label={label}
        className="flex-1 min-w-0 w-12 text-center bg-transparent text-[15px] font-bold tabular-nums focus:outline-none"
      />
      <button
        type="button"
        onClick={() => set(value + step)}
        disabled={value >= max}
        className="w-12 flex items-center justify-center text-avocado-700 dark:text-avocado-300 hover:bg-[var(--glass-bg-hover)] disabled:opacity-30"
        aria-label={`Más ${label ?? ''}`.trim()}
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
};

interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  'aria-label'?: string;
}

/** Few mutually exclusive choices: visible at once instead of hidden in a dropdown. */
export function Segmented<T extends string>({ value, options, onChange, disabled, ...rest }: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={rest['aria-label']}
      className="grid grid-flow-col auto-cols-fr gap-1 p-1 rounded-xl bg-[var(--glass-bg-subtle)] border border-[var(--glass-border)]"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`min-h-10 px-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 transition disabled:opacity-60 ${
            value === o.value
              ? 'bg-[var(--bg-primary)] text-avocado-700 dark:text-avocado-300 shadow-sm ring-1 ring-black/5 dark:ring-white/10'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Chips for picking one option from many (wraps, never scrolls sideways). */
export function ChipGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`min-h-10 px-3.5 rounded-full text-sm font-semibold border transition ${
            value === o.value
              ? 'bg-avocado-600 border-avocado-600 text-white'
              : 'bg-[var(--bg-primary)] border-[var(--input-border)] text-[var(--text-secondary)] hover:border-avocado-400'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-12 h-7 rounded-full transition shrink-0 disabled:opacity-50 ${
        checked ? 'bg-avocado-600' : 'bg-black/15 dark:bg-white/20'
      }`}
    >
      <span
        className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`}
      />
    </button>
  );
}

/** A whole row (label + description + switch) is the tap target. */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-4 min-h-14 py-2 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <span className="flex-1 min-w-0">
        <span className="block text-[15px] font-medium">{label}</span>
        {description && <span className="block text-xs text-[var(--text-muted)] mt-0.5">{description}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft';

const BTN: Record<ButtonVariant, string> = {
  primary: 'bg-avocado-600 hover:bg-avocado-700 text-white shadow-sm shadow-avocado-900/10',
  secondary:
    'bg-[var(--bg-primary)] border border-[var(--input-border)] text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]',
  soft: 'bg-avocado-50 hover:bg-avocado-100 text-avocado-800 dark:bg-avocado-500/10 dark:hover:bg-avocado-500/15 dark:text-avocado-200',
  ghost: 'text-[var(--text-secondary)] hover:bg-[var(--glass-bg-hover)]',
  danger: 'bg-coral-500/10 hover:bg-coral-500/15 text-coral-500',
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'md' | 'lg' | 'sm'; block?: boolean }
>(({ variant = 'primary', size = 'md', block = false, className = '', type = 'button', ...rest }, ref) => (
  <button
    ref={ref}
    type={type}
    className={`${BTN[variant]} ${
      size === 'lg' ? 'min-h-12 px-5 text-[15px]' : size === 'sm' ? 'min-h-9 px-3 text-sm' : 'min-h-11 px-4 text-sm'
    } ${block ? 'w-full' : ''} rounded-xl font-semibold inline-flex items-center justify-center gap-2 transition active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none ${className}`}
    {...rest}
  />
));
Button.displayName = 'Button';

/** Primary + secondary actions for a sheet footer: stacked full-width on phones. */
export function FormActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">{children}</div>;
}

/** Group of related fields with a small heading. */
export function FormSection({
  title,
  description,
  children,
  className = '',
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`space-y-3 ${className}`}>
      {(title || description) && (
        <div>
          {title && <h3 className="text-sm font-bold">{title}</h3>}
          {description && <p className="text-xs text-[var(--text-muted)] mt-0.5">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}
