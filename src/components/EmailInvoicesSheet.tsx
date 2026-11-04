import React, { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Copy, KeyRound, Loader2, Mail, RefreshCw, X } from 'lucide-react';
import {
  enableMailbox,
  getMailbox,
  InboundInvoice,
  InvoiceMailbox,
  mailboxAddress,
  regenerateMailboxCode,
  updateMailbox,
} from '../services/inboundInvoicesService';

interface EmailInvoicesSheetProps {
  sb: SupabaseClient;
  userId: string;
  householdId: string;
  /** Latest Gmail confirmation received by the mailbox, if any */
  confirmation: InboundInvoice | null;
  onToast: (text: string, kind?: 'error' | 'success') => void;
  onMailboxChange: (mailbox: InvoiceMailbox | null) => void;
  onClose: () => void;
}

/** Settings > "Facturas por correo": address to forward to and the Gmail filter guide. */
export const EmailInvoicesSheet: React.FC<EmailInvoicesSheetProps> = ({
  sb,
  userId,
  householdId,
  confirmation,
  onToast,
  onMailboxChange,
  onClose,
}) => {
  const [mailbox, setMailbox] = useState<InvoiceMailbox | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void getMailbox(sb, householdId).then((m) => active && setMailbox(m));
    return () => {
      active = false;
    };
  }, [sb, householdId]);

  const apply = (next: InvoiceMailbox | null) => {
    setMailbox(next);
    onMailboxChange(next);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      onToast('No se pudo guardar. Intenta de nuevo.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast('Copiado', 'success');
    } catch {
      window.prompt('Copia:', text);
    }
  };

  const active = mailbox?.isActive;
  const address = mailbox ? mailboxAddress(mailbox.code) : '';

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Facturas por correo"
        className="relative w-full sm:max-w-md max-h-[90dvh] overflow-y-auto liquid-glass-elevated rounded-t-3xl sm:rounded-2xl p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] space-y-4 animate-spring-in"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl liquid-lens-btn flex items-center justify-center text-white shrink-0">
            <Mail className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-bold">Facturas por correo</p>
            <p className="text-xs text-[var(--text-muted)]">Reenvía tus facturas electrónicas y aparecen aquí para aprobarlas.</p>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-xl liquid-glass-subtle liquid-glass-interactive flex items-center justify-center shrink-0"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {mailbox === undefined ? (
          <Loader2 className="w-5 h-5 animate-spin mx-auto text-[var(--text-muted)]" />
        ) : !active ? (
          <button
            disabled={busy}
            onClick={() => run(async () => apply(await enableMailbox(sb, householdId, userId)))}
            className="w-full min-h-[48px] rounded-xl liquid-lens-btn text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Activar facturas por correo
          </button>
        ) : (
          <>
            <section className="liquid-glass-subtle rounded-2xl p-3 space-y-2">
              <p className="text-xs font-semibold text-[var(--text-muted)]">Tu dirección de Canastica</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate text-sm font-bold">{address}</code>
                <button
                  onClick={() => void copy(address)}
                  className="min-h-[40px] px-3 rounded-lg liquid-glass liquid-glass-interactive text-xs font-bold flex items-center gap-1"
                >
                  <Copy className="w-3.5 h-3.5" /> Copiar
                </button>
              </div>
            </section>

            {confirmation?.confirmationCode && (
              <section className="rounded-2xl p-3 border border-avocado-600/40 bg-avocado-600/10 space-y-1">
                <p className="text-sm font-bold flex items-center gap-1.5">
                  <KeyRound className="w-4 h-4" /> Código de confirmación de Gmail
                </p>
                <div className="flex items-center gap-2">
                  <code className="text-xl font-extrabold tracking-wider flex-1">{confirmation.confirmationCode}</code>
                  <button
                    onClick={() => void copy(confirmation.confirmationCode ?? '')}
                    className="min-h-[40px] px-3 rounded-lg liquid-glass liquid-glass-interactive text-xs font-bold"
                  >
                    Copiar
                  </button>
                </div>
                <p className="text-xs text-[var(--text-muted)]">Pégalo en Gmail para confirmar el reenvío.</p>
              </section>
            )}

            <section className="space-y-2 text-sm">
              <p className="font-bold">Configúralo en Gmail (una sola vez, desde una computadora)</p>
              <ol className="list-decimal list-inside space-y-1.5 text-[var(--text-secondary)]">
                <li>
                  Gmail › <strong>Configuración</strong> › <strong>Reenvío y correo POP/IMAP</strong> › › <strong>Agregar una dirección de reenvío</strong> y
                  pega tu dirección de Canastica.
                </li>
                <li>Gmail envía un código de confirmación: aparecerá arriba en unos segundos. Pégalo en Gmail.</li>
                <li>
                  En la búsqueda de Gmail escribe <code>has:attachment filename:xml</code> (o <code>asunto:"Factura electrónica"</code>), abre las
                  opciones de búsqueda y toca <strong>Crear filtro</strong>.
                </li>
                <li>
                  Marca <strong>Reenviarlo a</strong>, elige tu dirección de Canastica y toca <strong>Crear filtro</strong>.
                </li>
              </ol>
              <p className="text-xs text-[var(--text-muted)]">Las facturas nuevas llegan a "Por revisar" en el Inicio. Solo se aceptan XML válidos de Hacienda (o PDF para registrar a mano).</p>
            </section>

            <label className="flex items-center gap-2.5 min-h-[44px] text-sm font-medium">
              <input
                type="checkbox"
                checked={Boolean(mailbox?.autoImport)}
                onChange={(e) =>
                  void run(async () => {
                    await updateMailbox(sb, householdId, { auto_import: e.target.checked });
                    apply({ ...mailbox!, autoImport: e.target.checked });
                  })
                }
                className="w-5 h-5 accent-[#4f7f27]"
              />
              Importar automáticamente las facturas XML (sin revisar)
            </label>

            <div className="grid grid-cols-2 gap-2">
              <button
                disabled={busy}
                onClick={() => {
                  if (!window.confirm('La dirección actual dejará de funcionar y tendrás que cambiarla en el filtro de Gmail. ¿Continuar?')) return;
                  void run(async () => {
                    const code = await regenerateMailboxCode(sb, householdId);
                    apply({ ...mailbox!, code });
                  });
                }}
                className="min-h-[44px] rounded-xl liquid-glass-subtle liquid-glass-interactive text-xs font-bold flex items-center justify-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Nueva dirección
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await updateMailbox(sb, householdId, { is_active: false });
                    apply({ ...mailbox!, isActive: false });
                  })
                }
                className="min-h-[44px] rounded-xl text-xs font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
              >
                Desactivar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
