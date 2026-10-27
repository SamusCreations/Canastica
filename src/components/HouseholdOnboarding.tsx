import React, { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Home, KeyRound, Loader2, LogOut, Users } from 'lucide-react';
import { INITIAL_HOUSEHOLD } from '../data/seedHousehold';
import {
  createHousehold,
  describeSupabaseError,
  joinHousehold,
} from '../services/householdRepository';
import { BrandMark } from './BrandLogo';

interface HouseholdOnboardingProps {
  sb: SupabaseClient;
  userName: string;
  initialInviteCode?: string | null;
  onReady: (householdId: string) => void;
  onSignOut: () => void;
}

export const HouseholdOnboarding: React.FC<HouseholdOnboardingProps> = ({
  sb,
  userName,
  initialInviteCode,
  onReady,
  onSignOut,
}) => {
  const [tab, setTab] = useState<'create' | 'join'>(initialInviteCode ? 'join' : 'create');
  const [name, setName] = useState(userName ? `Hogar de ${userName.split(' ')[0]}` : '');
  const [budget, setBudget] = useState('580000');
  const [code, setCode] = useState(initialInviteCode ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const id = await createHousehold(sb, {
        name: name.trim(),
        monthlyBudget: Math.max(0, Number(budget) || 0),
        supermarkets: INITIAL_HOUSEHOLD.supermarkets,
      });
      onReady(id);
    } catch (err) {
      setError(describeSupabaseError(err));
      setBusy(false);
    }
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const id = await joinHousehold(sb, code.trim());
      onReady(id);
    } catch (err) {
      setError(describeSupabaseError(err));
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh w-full flex items-start sm:items-center justify-center bg-[var(--bg-canvas)] text-[var(--text-primary)] px-4 pt-[calc(env(safe-area-inset-top)+24px)] pb-[calc(env(safe-area-inset-bottom)+24px)]">
      <div className="w-full max-w-md space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BrandMark className="w-10 h-10 rounded-xl" />
            <div>
              <p className="text-base font-extrabold leading-none">¡Hola{userName ? `, ${userName.split(' ')[0]}` : ''}!</p>
              <p className="text-sm text-[var(--text-muted)]">Configura tu hogar para empezar</p>
            </div>
          </div>
          <button
            onClick={onSignOut}
            className="min-h-[40px] px-3 rounded-xl text-sm font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1.5"
          >
            <LogOut className="w-4 h-4" /> Salir
          </button>
        </div>

        <div className="liquid-glass rounded-2xl p-5 space-y-5">
          <div className="grid grid-cols-2 gap-1 p-1 rounded-xl liquid-glass-subtle">
            <button
              onClick={() => {
                setTab('create');
                setError(null);
              }}
              className={`min-h-[44px] rounded-lg text-sm font-bold flex items-center justify-center gap-1.5 transition ${
                tab === 'create' ? 'liquid-lens-btn' : 'text-[var(--text-secondary)]'
              }`}
            >
              <Home className="w-4 h-4" /> Crear hogar
            </button>
            <button
              onClick={() => {
                setTab('join');
                setError(null);
              }}
              className={`min-h-[44px] rounded-lg text-sm font-bold flex items-center justify-center gap-1.5 transition ${
                tab === 'join' ? 'liquid-lens-btn' : 'text-[var(--text-secondary)]'
              }`}
            >
              <Users className="w-4 h-4" /> Unirme
            </button>
          </div>

          {tab === 'create' ? (
            <form onSubmit={handleCreate} className="space-y-4">
              <p className="text-sm text-[var(--text-secondary)]">
                Serás el administrador. Después podrás invitar a tu familia o roomies con un código.
              </p>
              <label className="block space-y-1.5">
                <span className="text-sm font-semibold text-[var(--text-secondary)]">
                  Nombre del hogar
                </span>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ej. Casa Solís"
                  className="liquid-input w-full min-h-[48px] px-3.5 rounded-xl text-base"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-semibold text-[var(--text-secondary)]">
                  Presupuesto mensual de súper (₡)
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={5000}
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  className="liquid-input w-full min-h-[48px] px-3.5 rounded-xl text-base"
                />
              </label>
              {error && (
                <p role="alert" className="text-sm text-rose-700 dark:text-rose-300 bg-rose-500/10 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="w-full liquid-lens-btn min-h-[48px] rounded-xl text-base font-bold flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Crear mi hogar
              </button>
            </form>
          ) : (
            <form onSubmit={handleJoin} className="space-y-4">
              <p className="text-sm text-[var(--text-secondary)]">
                Pídele el código de invitación a quien administra el hogar. Lo encuentra en la
                pestaña <strong>Hogar</strong>.
              </p>
              <label className="block space-y-1.5">
                <span className="text-sm font-semibold text-[var(--text-secondary)]">
                  Código de invitación
                </span>
                <div className="relative">
                  <KeyRound className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                  <input
                    type="text"
                    required
                    autoCapitalize="characters"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder="GLS-XXXXX"
                    className="liquid-input w-full min-h-[48px] pl-10 pr-3 rounded-xl text-base font-mono uppercase tracking-wider"
                  />
                </div>
              </label>
              {error && (
                <p role="alert" className="text-sm text-rose-700 dark:text-rose-300 bg-rose-500/10 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={busy || code.trim().length < 4}
                className="w-full liquid-lens-btn min-h-[48px] rounded-xl text-base font-bold flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Unirme al hogar
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
