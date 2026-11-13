import React, { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Check, Copy, KeyRound, Loader2, Mail, Pencil, RefreshCw, Store, X } from 'lucide-react';
import {
  AliasCheck,
  aliasAddress,
  checkAlias,
  enableMailbox,
  getMailbox,
  InboundInvoice,
  INBOUND_DOMAIN,
  InvoiceMailbox,
  normalizeAlias,
  regenerateMailboxCode,
  saveAlias,
  suggestAlias,
  updateMailbox,
} from '../services/inboundInvoicesService';

const ALIAS_MESSAGE: Record<AliasCheck, string> = {
  ok: 'Disponible',
  mine: 'Es la de tu hogar',
  invalid: 'Usa de 3 a 30 letras, números o guiones',
  reserved: 'Ese nombre está reservado',
  taken: 'Ya lo usa otro hogar',
};

interface EmailInvoicesSheetProps {
  sb: SupabaseClient;
  userId: string;
  householdId: string;
  householdName: string;
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
  householdName,
  confirmation,
  onToast,
  onMailboxChange,
  onClose,
}) => {
  const [mailbox, setMailbox] = useState<InvoiceMailbox | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasDraft, setAliasDraft] = useState('');
  const [aliasCheck, setAliasCheck] = useState<AliasCheck | 'checking' | null>(null);

  // Live availability while typing (debounced)
  useEffect(() => {
    if (!editingAlias) return;
    const candidate = normalizeAlias(aliasDraft);
    if (!candidate) {
      setAliasCheck(null);
      return;
    }
    setAliasCheck('checking');
    let active = true;
    const timer = window.setTimeout(() => {
      checkAlias(sb, candidate, householdId)
        .then((r) => active && setAliasCheck(r))
        .catch(() => active && setAliasCheck(null));
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [sb, householdId, aliasDraft, editingAlias]);

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
  // Only the named address receives invoices; without a name there is no address yet
  const address = mailbox?.alias ? aliasAddress(mailbox.alias) : '';

  const activate = () =>
    run(async () => {
      let next = await enableMailbox(sb, householdId, userId);
      // First time: give it a readable name right away; it can be changed later
      if (!next.alias) {
        const suggestion = await suggestAlias(sb, householdId, householdName);
        if (suggestion) {
          try {
            next = { ...next, alias: await saveAlias(sb, householdId, suggestion) };
          } catch {
            // no address until the household picks a name below
          }
        }
      }
      apply(next);
    });

  const startEditAlias = () => {
    setAliasDraft(mailbox?.alias ?? normalizeAlias(householdName));
    setEditingAlias(true);
  };

  const submitAlias = () => {
    const candidate = normalizeAlias(aliasDraft);
    if (!mailbox || !candidate) return;
    if (
      mailbox.alias &&
      !window.confirm(
        `Tu dirección pasará a ser ${aliasAddress(candidate)}. La anterior seguirá funcionando 30 días: cámbiala en el filtro de Gmail y en los comercios donde la diste. ¿Continuar?`
      )
    )
      return;
    setBusy(true);
    saveAlias(sb, householdId, candidate)
      .then((alias) => {
        apply({ ...mailbox, alias });
        setEditingAlias(false);
        onToast('Dirección guardada', 'success');
      })
      .catch((err: Error) => {
        const reason = err.message as AliasCheck;
        onToast(ALIAS_MESSAGE[reason] ?? 'No se pudo guardar. Intenta de nuevo.');
        if (reason in ALIAS_MESSAGE) setAliasCheck(reason);
      })
      .finally(() => setBusy(false));
  };

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
            onClick={() => void activate()}
            className="w-full min-h-[48px] rounded-xl liquid-lens-btn text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Activar facturas por correo
          </button>
        ) : (
          <>
            <section className="liquid-glass-subtle rounded-2xl p-3 space-y-2">
              <p className="text-xs font-semibold text-[var(--text-muted)]">Tu dirección de Canastica</p>
              {editingAlias ? (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitAlias();
                  }}
                >
                  <div className="flex items-center gap-1 rounded-lg liquid-glass px-2.5 min-h-[44px]">
                    <input
                      autoFocus
                      value={aliasDraft}
                      onChange={(e) => setAliasDraft(e.target.value)}
                      maxLength={40}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      aria-label="Nombre de tu dirección"
                      className="flex-1 min-w-0 bg-transparent text-sm font-bold outline-none"
                      placeholder="rodriguez"
                    />
                    <span className="text-xs text-[var(--text-muted)] truncate">@{INBOUND_DOMAIN}</span>
                  </div>
                  <p
                    className={`text-[11px] font-semibold ${
                      aliasCheck === 'ok' || aliasCheck === 'mine'
                        ? 'text-avocado-700 dark:text-avocado-400'
                        : aliasCheck && aliasCheck !== 'checking'
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-[var(--text-muted)]'
                    }`}
                  >
                    {aliasCheck === 'checking'
                      ? 'Revisando…'
                      : aliasCheck
                        ? `${normalizeAlias(aliasDraft)}: ${ALIAS_MESSAGE[aliasCheck]}`
                        : 'Solo letras, números y guiones. Sin tildes ni ñ.'}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingAlias(false)}
                      className="min-h-[40px] rounded-lg liquid-glass liquid-glass-interactive text-xs font-bold"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={busy || !(aliasCheck === 'ok' || aliasCheck === 'mine')}
                      className="min-h-[40px] rounded-lg liquid-lens-btn text-xs font-bold flex items-center justify-center gap-1 disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Guardar
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  {address ? (
                  <div className="flex items-center gap-2">
                    <code className="flex-1 min-w-0 break-all text-sm font-bold">{address}</code>
                    <button
                      onClick={() => void copy(address)}
                      className="min-h-[40px] px-3 rounded-lg liquid-glass liquid-glass-interactive text-xs font-bold flex items-center gap-1 shrink-0"
                    >
                      <Copy className="w-3.5 h-3.5" /> Copiar
                    </button>
                  </div>
                  ) : (
                    <p className="text-xs text-amber-700 dark:text-amber-300">Elige un nombre para tener tu dirección de facturas.</p>
                  )}
                  <button
                    onClick={startEditAlias}
                    className="text-xs font-semibold text-avocado-700 dark:text-avocado-400 flex items-center gap-1 min-h-[32px]"
                  >
                    <Pencil className="w-3.5 h-3.5" /> {mailbox?.alias ? 'Cambiar nombre' : 'Elegir un nombre fácil de recordar'}
                  </button>
                </>
              )}
            </section>

            <section className="rounded-2xl p-3 liquid-glass-subtle space-y-1 text-sm">
              <p className="font-bold flex items-center gap-1.5">
                <Store className="w-4 h-4" /> Dásela al comercio
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                Cuando te pidan un correo para la factura electrónica, dicta esta dirección. Llega directo a Canastica sin pasar por tu correo.
              </p>
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
              <p className="font-bold">O reenvíalas desde Gmail (una sola vez, desde una computadora)</p>
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
              <p className="text-xs text-[var(--text-muted)]">
                Cada factura electrónica trae tres archivos: el XML de la factura, el XML de respuesta de Hacienda y el PDF. Si llegan los tres y
                Hacienda la aceptó, se puede importar sola. Si falta alguno, queda en "Por revisar" con un aviso. Correos sin factura se rechazan.
              </p>
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
              Importar automáticamente las facturas completas (sin revisar)
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
