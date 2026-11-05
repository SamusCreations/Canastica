import React, { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Copy, Link2, Loader2, Power, Share2, X } from 'lucide-react';
import {
  createSharedLink,
  isLinkUsable,
  LinkExpiry,
  listAsText,
  listSharedLinks,
  SharedLink,
  sharedLinkUrl,
  updateSharedLink,
} from '../services/sharedListService';
import type { ShoppingListItem } from '../types/grocery';

interface ShareListSheetProps {
  sb: SupabaseClient;
  userId: string;
  householdId: string;
  householdName: string;
  items: ShoppingListItem[];
  onToast: (text: string, kind?: 'error' | 'success') => void;
  onClose: () => void;
}

type Perms = { canCheck: boolean; canAdd: boolean; canDelete: boolean };

const PERM_LABELS: { key: keyof Perms; label: string }[] = [
  { key: 'canCheck', label: 'Tachar productos' },
  { key: 'canAdd', label: 'Añadir productos' },
  { key: 'canDelete', label: 'Eliminar productos' },
];

const dateFormat = new Intl.DateTimeFormat('es-CR', { dateStyle: 'medium', timeStyle: 'short' });

function PermBoxes({ value, onChange, disabled }: { value: Perms; onChange: (p: Perms) => void; disabled?: boolean }) {
  return (
    <div className="space-y-1">
      {PERM_LABELS.map(({ key, label }) => (
        <label key={key} className="flex items-center gap-2.5 min-h-[40px] text-sm font-medium">
          <input
            type="checkbox"
            checked={value[key]}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
            className="w-5 h-5 accent-[#4f7f27]"
          />
          {label}
        </label>
      ))}
    </div>
  );
}

/** "Compartir lista": create links with permissions for people outside the household and manage them. */
export const ShareListSheet: React.FC<ShareListSheetProps> = ({ sb, userId, householdId, householdName, items, onToast, onClose }) => {
  const [links, setLinks] = useState<SharedLink[] | null>(null);
  const [perms, setPerms] = useState<Perms>({ canCheck: false, canAdd: false, canDelete: false });
  const [expiry, setExpiry] = useState<LinkExpiry>('7d');
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    listSharedLinks(sb, householdId)
      .then(setLinks)
      .catch(() => {
        setLinks([]);
        onToast('No se pudieron cargar los enlaces.');
      });
  }, [sb, householdId, onToast]);

  useEffect(refresh, [refresh]);

  const share = async (link: SharedLink) => {
    const url = sharedLinkUrl(link.token);
    const text = listAsText(householdName, items, url);
    if (navigator.share) {
      try {
        await navigator.share({ title: `Lista de compras · ${householdName}`, text });
        return;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      }
    }
    await copy(text, 'Lista y enlace copiados');
  };

  const copy = async (text: string, okText = 'Enlace copiado') => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(okText, 'success');
    } catch {
      window.prompt('Copia el enlace:', text);
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const link = await createSharedLink(sb, householdId, userId, perms, expiry);
      setLinks((prev) => [link, ...(prev ?? [])]);
      await share(link);
    } catch {
      onToast('No se pudo crear el enlace.');
    } finally {
      setCreating(false);
    }
  };

  const patchLink = (link: SharedLink, patch: Partial<SharedLink>) => {
    setLinks((prev) => (prev ?? []).map((l) => (l.id === link.id ? { ...l, ...patch } : l)));
    updateSharedLink(sb, link.id, patch).catch(() => {
      onToast('No se guardó el cambio del enlace.');
      refresh();
    });
  };

  const activeLinks = (links ?? []).filter(isLinkUsable);

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Compartir lista"
        className="relative w-full sm:max-w-md max-h-[90dvh] overflow-y-auto liquid-glass-elevated rounded-t-3xl sm:rounded-2xl p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] space-y-4 animate-spring-in"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl liquid-lens-btn flex items-center justify-center text-white shrink-0">
            <Share2 className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-bold">Compartir lista</p>
            <p className="text-xs text-[var(--text-muted)]">Por WhatsApp, Telegram o donde quieras. No necesitan cuenta.</p>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-xl liquid-glass-subtle liquid-glass-interactive flex items-center justify-center shrink-0"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <section className="liquid-glass-subtle rounded-2xl p-3 space-y-2">
          <p className="text-sm font-bold">Enlace nuevo</p>
          <p className="text-xs text-[var(--text-muted)]">
            Siempre pueden ver la lista. Elige qué más puede hacer quien no es del hogar:
          </p>
          <PermBoxes value={perms} onChange={setPerms} />
          <label className="flex items-center gap-2 text-sm">
            <span className="text-[var(--text-muted)]">Vence:</span>
            <select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value as LinkExpiry)}
              className="liquid-input flex-1 min-h-[40px] px-2 rounded-lg text-sm font-semibold"
            >
              <option value="24h">En 24 horas</option>
              <option value="7d">En 7 días</option>
              <option value="never">Nunca</option>
            </select>
          </label>
          <button
            onClick={() => void handleCreate()}
            disabled={creating}
            className="w-full min-h-[48px] rounded-xl liquid-lens-btn text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />} Crear y compartir
          </button>
        </section>

        <section className="space-y-2">
          <p className="text-sm font-bold">Enlaces activos</p>
          {links === null && <Loader2 className="w-5 h-5 animate-spin mx-auto text-[var(--text-muted)]" />}
          {links && activeLinks.length === 0 && <p className="text-xs text-[var(--text-muted)]">No hay enlaces activos.</p>}
          {activeLinks.map((link) => (
            <div key={link.id} className="liquid-glass-subtle rounded-2xl p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <Link2 className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate flex-1">{sharedLinkUrl(link.token).replace(/^https?:\/\//, '')}</span>
              </div>
              <p className="text-[11px] text-[var(--text-muted)]">
                {link.expiresAt ? `Vence el ${dateFormat.format(new Date(link.expiresAt))}` : 'No vence'}
              </p>
              <PermBoxes value={link} onChange={(p) => patchLink(link, p)} />
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => void share(link)}
                  className="min-h-[40px] rounded-lg liquid-glass liquid-glass-interactive text-xs font-bold flex items-center justify-center gap-1"
                >
                  <Share2 className="w-3.5 h-3.5" /> Enviar
                </button>
                <button
                  onClick={() => void copy(sharedLinkUrl(link.token))}
                  className="min-h-[40px] rounded-lg liquid-glass liquid-glass-interactive text-xs font-bold flex items-center justify-center gap-1"
                >
                  <Copy className="w-3.5 h-3.5" /> Copiar
                </button>
                <button
                  onClick={() => patchLink(link, { isActive: false })}
                  className="min-h-[40px] rounded-lg text-xs font-bold flex items-center justify-center gap-1 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
                >
                  <Power className="w-3.5 h-3.5" /> Desactivar
                </button>
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
};
