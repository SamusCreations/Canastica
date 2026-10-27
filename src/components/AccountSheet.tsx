import React from 'react';
import { Check, Home, LogOut, Moon, RefreshCw, Repeat, Sun, X } from 'lucide-react';
import { HouseholdMembership } from '../services/householdRepository';
import { CurrencyCode, HouseholdMember, LanguageCode } from '../types/grocery';
import { Avatar } from './Avatar';

interface AccountSheetProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'demo' | 'cloud';
  member: HouseholdMember;
  householdName: string;
  householdId: string;
  memberships: HouseholdMembership[];
  currency: CurrencyCode;
  language: LanguageCode;
  theme: 'light' | 'dark';
  syncBadge: React.ReactNode;
  onChangeCurrency: (c: CurrencyCode) => void;
  onChangeLanguage: (l: LanguageCode) => void;
  onToggleTheme: () => void;
  onSwitchHousehold: (id: string) => void;
  onSwitchDemoMember?: () => void;
  onResetDemoData: () => void;
  onSignOut: () => void;
  onExitDemo: () => void;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid grid-flow-col auto-cols-fr gap-1 p-1 rounded-xl liquid-glass-subtle">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`min-h-[40px] rounded-lg text-sm font-bold flex items-center justify-center gap-1.5 transition ${
            value === o.value ? 'liquid-lens-btn' : 'text-[var(--text-secondary)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Account, household switcher and display preferences. Bottom sheet on phones, popover on desktop. */
export const AccountSheet: React.FC<AccountSheetProps> = ({
  isOpen,
  onClose,
  mode,
  member,
  householdName,
  householdId,
  memberships,
  currency,
  language,
  theme,
  syncBadge,
  onChangeCurrency,
  onChangeLanguage,
  onToggleTheme,
  onSwitchHousehold,
  onSwitchDemoMember,
  onResetDemoData,
  onSignOut,
  onExitDemo,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-start sm:justify-end">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-spring-in" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Cuenta y ajustes"
        className="relative w-full sm:w-96 sm:m-3 sm:mt-[calc(env(safe-area-inset-top)+60px)] lg:mt-auto lg:mb-3 lg:ml-3 lg:mr-auto max-h-[88dvh] overflow-y-auto liquid-glass-elevated rounded-t-3xl sm:rounded-2xl p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] space-y-4 animate-spring-in"
      >
        <div className="sm:hidden mx-auto w-10 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600 -mt-1" />

        <div className="flex items-center gap-3">
          <Avatar name={member.name} src={member.avatarUrl} color={member.accentColor} className="w-12 h-12" />
          <div className="min-w-0 flex-1">
            <p className="text-base font-bold truncate">{member.name}</p>
            <p className="text-sm text-[var(--text-muted)] truncate">
              {member.email || (member.role === 'admin' ? 'Administrador' : 'Miembro')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-xl liquid-glass-subtle liquid-glass-interactive flex items-center justify-center shrink-0"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="liquid-glass-subtle rounded-2xl p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Home className="w-4 h-4 text-avocado-600 dark:text-avocado-400 shrink-0" />
              <span className="text-sm font-bold truncate">{householdName}</span>
            </div>
            {syncBadge}
          </div>

          {mode === 'cloud' && memberships.length > 1 && (
            <div className="space-y-1 pt-1">
              <p className="text-xs font-semibold text-[var(--text-muted)]">Cambiar de hogar</p>
              {memberships.map((m) => (
                <button
                  key={m.householdId}
                  onClick={() => {
                    onSwitchHousehold(m.householdId);
                    onClose();
                  }}
                  className="w-full min-h-[44px] px-3 rounded-xl flex items-center justify-between text-sm font-semibold hover:bg-[var(--glass-bg-hover)]"
                >
                  <span className="truncate">{m.householdName}</span>
                  {m.householdId === householdId && <Check className="w-4 h-4 text-avocado-600" />}
                </button>
              ))}
            </div>
          )}

          {onSwitchDemoMember && (
            <button
              onClick={onSwitchDemoMember}
              className="w-full min-h-[44px] px-3 rounded-xl liquid-glass liquid-glass-interactive text-sm font-semibold flex items-center justify-center gap-2"
            >
              <Repeat className="w-4 h-4" /> Ver como otro miembro
            </button>
          )}
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-[var(--text-muted)]">Moneda</p>
            <Segmented
              value={currency}
              onChange={onChangeCurrency}
              options={[
                { value: 'CRC', label: '₡ Colones' },
                { value: 'USD', label: '$ Dólares' },
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-[var(--text-muted)]">Idioma</p>
            <Segmented
              value={language}
              onChange={onChangeLanguage}
              options={[
                { value: 'es', label: 'Español' },
                { value: 'en', label: 'English' },
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-[var(--text-muted)]">Tema</p>
            <Segmented
              value={theme}
              onChange={(t) => t !== theme && onToggleTheme()}
              options={[
                { value: 'light', label: <><Sun className="w-4 h-4" /> Claro</> },
                { value: 'dark', label: <><Moon className="w-4 h-4" /> Oscuro</> },
              ]}
            />
          </div>
        </div>

        <div className="space-y-1.5 pt-1 border-t border-[var(--glass-border)]">
          {mode === 'demo' ? (
            <>
              <button
                onClick={() => {
                  onResetDemoData();
                  onClose();
                }}
                className="w-full min-h-[48px] px-3 rounded-xl flex items-center gap-3 text-sm font-semibold hover:bg-[var(--glass-bg-hover)]"
              >
                <RefreshCw className="w-4 h-4 text-[var(--text-muted)]" /> Restablecer datos de ejemplo
              </button>
              <button
                onClick={onExitDemo}
                className="w-full min-h-[48px] px-3 rounded-xl flex items-center gap-3 text-sm font-bold text-avocado-600 dark:text-avocado-400 hover:bg-[var(--glass-bg-hover)]"
              >
                <LogOut className="w-4 h-4" /> Salir del modo prueba e iniciar sesión
              </button>
            </>
          ) : (
            <button
              onClick={onSignOut}
              className="w-full min-h-[48px] px-3 rounded-xl flex items-center gap-3 text-sm font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
            >
              <LogOut className="w-4 h-4" /> Cerrar sesión
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
