import React, { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Check, Link2Off, Loader2, Plus, Trash2 } from 'lucide-react';
import { BrandMark } from './BrandLogo';
import {
  fetchPublicList,
  publicAdd,
  publicDelete,
  publicToggle,
  PublicSharedList,
  SharedListApiError,
  SharedListError,
} from '../services/sharedListService';
import { translateCategory } from '../utils/formatters';

const GUEST_NAME_KEY = 'canastica_guest_name_v1';
const POLL_MS = 5000;

const ERROR_TEXT: Record<SharedListError, string> = {
  invalid_link: 'Este enlace venció o fue desactivado.',
  not_allowed: 'Quien compartió la lista no permite ese cambio.',
  rate_limited: 'Demasiados cambios seguidos. Espera un minuto.',
  name_required: 'Escribe tu nombre para hacer cambios.',
  network: 'No hay conexión. Intenta de nuevo.',
};

function readName(): string {
  try {
    return localStorage.getItem(GUEST_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Public, account-free view of a shared shopping list: /l/<token>. */
export const SharedListPage: React.FC<{ sb: SupabaseClient | null; token: string }> = ({ sb, token }) => {
  const [list, setList] = useState<PublicSharedList | null>(null);
  const [fatal, setFatal] = useState<SharedListError | null>(null);
  const [notice, setNotice] = useState('');
  const [name, setName] = useState(readName);
  const [askName, setAskName] = useState(false);
  const [pendingRun, setPendingRun] = useState<null | ((actor: string) => Promise<void>)>(null);
  const [draftName, setDraftName] = useState('');
  const [newItem, setNewItem] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sb) return;
    try {
      setList(await fetchPublicList(sb, token));
      setFatal(null);
    } catch (err) {
      const code = err instanceof SharedListApiError ? err.code : 'network';
      if (code === 'invalid_link') setFatal(code);
    }
  }, [sb, token]);

  // "Live": refresh every few seconds while the page is visible
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  /** Runs a change, asking for the visitor's name the first time. */
  const withName = (action: (actor: string) => Promise<unknown>, id: string | null = null) => {
    const run = async (actor: string) => {
      if (!sb) return;
      setBusyId(id ?? 'new');
      setNotice('');
      try {
        await action(actor);
        await load();
      } catch (err) {
        const code = err instanceof SharedListApiError ? err.code : 'network';
        if (code === 'invalid_link') setFatal(code);
        setNotice(ERROR_TEXT[code]);
      } finally {
        setBusyId(null);
      }
    };
    if (name.trim()) void run(name.trim());
    else {
      setPendingRun(() => run);
      setAskName(true);
    }
  };

  const saveName = () => {
    const clean = draftName.trim().slice(0, 40);
    if (!clean) return;
    try {
      localStorage.setItem(GUEST_NAME_KEY, clean);
    } catch {
      // ignore
    }
    setName(clean);
    setAskName(false);
    const run = pendingRun;
    setPendingRun(null);
    if (run) void run(clean);
  };

  if (!sb) return null;

  if (fatal === 'invalid_link') {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-3 p-6 text-center bg-[var(--bg-canvas)] text-[var(--text-primary)]">
        <Link2Off className="w-10 h-10 text-[var(--text-muted)]" />
        <p className="text-lg font-bold">{ERROR_TEXT.invalid_link}</p>
        <p className="text-sm text-[var(--text-muted)]">Pídele a quien te lo mandó un enlace nuevo.</p>
      </div>
    );
  }

  if (!list) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[var(--bg-canvas)] text-[var(--text-muted)]">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  const pending = list.items.filter((i) => !i.isChecked);
  const done = list.items.filter((i) => i.isChecked);
  const canEdit = list.canAdd || list.canCheck || list.canDelete;

  const row = (item: PublicSharedList['items'][number]) => (
    <li key={item.id} className={`rounded-2xl px-3 py-2.5 flex items-center gap-3 ${item.isChecked ? 'liquid-glass-subtle opacity-60' : 'liquid-glass'}`}>
      {list.canCheck ? (
        <button
          onClick={() => withName((actor) => publicToggle(sb, token, item.id, !item.isChecked, actor), item.id)}
          disabled={busyId === item.id}
          aria-pressed={item.isChecked}
          aria-label={item.isChecked ? `Destachar ${item.name}` : `Tachar ${item.name}`}
          className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center shrink-0 ${
            item.isChecked ? 'bg-avocado-600 border-avocado-600 text-white' : 'border-slate-300 dark:border-slate-500'
          }`}
        >
          {busyId === item.id ? <Loader2 className="w-4 h-4 animate-spin" /> : item.isChecked && <Check className="w-5 h-5" />}
        </button>
      ) : (
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${item.isChecked ? 'bg-avocado-600' : 'bg-slate-400'}`} />
      )}
      <div className="flex-1 min-w-0">
        <p className={`text-base font-semibold ${item.isChecked ? 'line-through' : ''}`}>{item.name}</p>
        <p className="text-xs text-[var(--text-muted)]">
          {item.quantity} {item.unit} · {translateCategory(item.category, 'es')}
          {item.store ? ` · ${item.store}` : ''}
        </p>
      </div>
      {list.canDelete && (
        <button
          onClick={() => withName((actor) => publicDelete(sb, token, item.id, actor), item.id)}
          className="w-9 h-9 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-rose-600 shrink-0"
          aria-label={`Quitar ${item.name}`}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </li>
  );

  return (
    <div className="min-h-dvh bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      <div className="max-w-lg mx-auto p-4 pb-[calc(env(safe-area-inset-bottom)+24px)] space-y-4">
        <header className="flex items-center gap-3 pt-[env(safe-area-inset-top)]">
          <BrandMark className="w-10 h-10 rounded-xl" />
          <div className="min-w-0">
            <h1 className="text-lg font-extrabold truncate">Lista de {list.householdName}</h1>
            <p className="text-xs text-[var(--text-muted)]">
              {canEdit ? (name ? `Editando como ${name}` : 'Puedes hacer cambios') : 'Solo lectura'} · se actualiza sola
            </p>
          </div>
        </header>

        {notice && <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">{notice}</p>}

        {list.canAdd && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = newItem.trim();
              if (!text) return;
              const m = text.match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml|unid)?\s+(.+)$/i);
              const qty = m ? parseFloat(m[1].replace(',', '.')) : 1;
              const unit = m?.[2] ?? 'unid';
              const itemName = m ? m[3] : text;
              withName(async (actor) => {
                await publicAdd(sb, token, itemName, qty, unit, actor);
                setNewItem('');
              });
            }}
            className="flex gap-2"
          >
            <input
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              maxLength={80}
              placeholder="Ej.: 2 kg arroz"
              className="liquid-input flex-1 min-h-[48px] px-3 rounded-xl text-base"
            />
            <button
              type="submit"
              disabled={!newItem.trim() || busyId === 'new'}
              className="liquid-lens-btn min-h-[48px] px-4 rounded-xl font-bold flex items-center gap-1.5 disabled:opacity-50"
            >
              {busyId === 'new' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Añadir
            </button>
          </form>
        )}

        {pending.length === 0 && <p className="text-center text-sm text-[var(--text-muted)] py-6">No hay nada pendiente.</p>}
        <ul className="space-y-2">{pending.map(row)}</ul>
        {done.length > 0 && (
          <>
            <p className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] pt-2">Ya comprado</p>
            <ul className="space-y-2">{done.map(row)}</ul>
          </>
        )}

        <p className="text-center text-xs text-[var(--text-muted)] pt-4">
          Hecho con <a href="/" className="font-semibold text-avocado-700 dark:text-avocado-400">Canastica</a>, las compras del hogar en orden.
        </p>
      </div>

      {askName && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setAskName(false)} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveName();
            }}
            className="relative w-full sm:max-w-sm liquid-glass-elevated rounded-t-3xl sm:rounded-2xl p-5 space-y-3"
          >
            <p className="text-base font-bold">¿Cómo te llamas?</p>
            <p className="text-sm text-[var(--text-muted)]">Así el hogar sabe quién hizo cada cambio.</p>
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              maxLength={40}
              placeholder="Ej.: Abuela"
              className="liquid-input w-full min-h-[48px] px-3 rounded-xl text-base"
            />
            <button type="submit" disabled={!draftName.trim()} className="w-full min-h-[48px] rounded-xl liquid-lens-btn font-bold disabled:opacity-50">
              Continuar
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
