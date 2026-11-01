import React, { useCallback, useEffect, useState } from 'react';
import { History, Loader2, RefreshCw } from 'lucide-react';
import type { HouseholdMember } from '../types/grocery';
import type { HouseholdActivityEntry } from '../services/householdRepository';
import { Avatar } from './Avatar';

interface HouseholdActivityViewProps {
  members: HouseholdMember[];
  /** Null when there is no server (demo mode) */
  loadActivity: (() => Promise<HouseholdActivityEntry[]>) | null;
}

const timeFormat = new Intl.DateTimeFormat('es-CR', { dateStyle: 'medium', timeStyle: 'short' });

/** Who did (or undid) what in the household, newest first. */
export const HouseholdActivityView: React.FC<HouseholdActivityViewProps> = ({ members, loadActivity }) => {
  const [entries, setEntries] = useState<HouseholdActivityEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(() => {
    if (!loadActivity) return;
    setFailed(false);
    loadActivity()
      .then(setEntries)
      .catch(() => setFailed(true));
  }, [loadActivity]);

  useEffect(refresh, [refresh]);

  if (!loadActivity) {
    return (
      <div className="liquid-glass rounded-xl p-4 text-sm text-[var(--text-muted)]">
        El historial está disponible al usar Canastica con tu cuenta.
      </div>
    );
  }

  return (
    <div className="liquid-glass rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
          <History className="w-3.5 h-3.5" /> Historial del hogar
        </h3>
        <button
          onClick={refresh}
          className="w-8 h-8 rounded-lg liquid-glass-subtle liquid-glass-interactive flex items-center justify-center"
          aria-label="Actualizar historial"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {failed && <p className="text-xs text-rose-600 dark:text-rose-400">No se pudo cargar el historial.</p>}
      {!entries && !failed && <Loader2 className="w-5 h-5 animate-spin mx-auto text-[var(--text-muted)]" />}
      {entries && entries.length === 0 && (
        <p className="text-sm text-[var(--text-muted)]">Todavía no hay acciones registradas.</p>
      )}

      {entries && entries.length > 0 && (
        <ol className="space-y-1.5">
          {entries.map((e) => {
            const actor = members.find((m) => m.id === e.actorId);
            return (
              <li key={e.id} className="liquid-glass-subtle rounded-lg px-3 py-2 flex items-start gap-2.5">
                {actor ? (
                  <Avatar name={actor.name} src={actor.avatarUrl} color={actor.accentColor} className="w-6 h-6 shrink-0" />
                ) : (
                  <span className="w-6 h-6 rounded-full bg-slate-500/20 shrink-0" />
                )}
                <div className="min-w-0 text-xs">
                  <p className="break-words">
                    <strong>{actor?.name.split(' ')[0] ?? (e.actorId ? 'Ex miembro' : 'Canastica')}</strong> {e.summary}
                  </p>
                  <time className="text-[10px] text-[var(--text-muted)]" dateTime={e.createdAt}>
                    {timeFormat.format(new Date(e.createdAt))}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};
