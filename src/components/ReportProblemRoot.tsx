import React, { useRef, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, ImagePlus, Loader2, MessageSquareWarning, Send, X } from 'lucide-react';
import {
  closeReportProblem,
  getReportProblemRequest,
  subscribeReportProblem,
  type ReportProblemRequest,
} from '../lib/reportProblem';
import { getReportScreenContext } from '../lib/appContext';
import { sendProblemReport } from '../services/bugReportService';

const MIN_CHARS = 10;
const MAX_CHARS = 2000;

const TEXT = {
  es: {
    title: 'Reportar un problema',
    subtitle: 'Cuéntanos qué pasó y lo revisamos.',
    label: '¿Qué pasó?',
    placeholder: 'Ej.: Al escanear la factura de Palí la fecha salió mal y el total no cuadra…',
    tooShort: (n: number) => `Escribe al menos ${MIN_CHARS} caracteres (${n}/${MIN_CHARS}).`,
    attach: 'Adjuntar captura o foto (opcional)',
    remove: 'Quitar imagen',
    privacy:
      'Se incluyen datos técnicos para ayudarnos a encontrar el error: tu usuario y hogar, la pantalla en la que estás, tu dispositivo y navegador, la versión de la app y los últimos errores. No se envían contraseñas ni el contenido de tus facturas.',
    send: 'Enviar reporte',
    sending: 'Enviando…',
    thanks: '¡Gracias! Recibimos tu reporte',
    thanksBody: 'Lo vamos a revisar lo antes posible.',
    close: 'Cerrar',
  },
  en: {
    title: 'Report a problem',
    subtitle: 'Tell us what happened and we will look into it.',
    label: 'What happened?',
    placeholder: 'E.g.: When I scanned my receipt the date was wrong and the total did not match…',
    tooShort: (n: number) => `Write at least ${MIN_CHARS} characters (${n}/${MIN_CHARS}).`,
    attach: 'Attach a screenshot or photo (optional)',
    remove: 'Remove image',
    privacy:
      'Technical details are included to help us find the issue: your user and household, the screen you are on, your device and browser, the app version and recent errors. Passwords and receipt contents are never sent.',
    send: 'Send report',
    sending: 'Sending…',
    thanks: 'Thank you! We received your report',
    thanksBody: 'We will look into it as soon as possible.',
    close: 'Close',
  },
};

function ReportProblemSheet({ request }: { request: ReportProblemRequest }) {
  const lang = getReportScreenContext().language === 'en' ? 'en' : 'es';
  const t = TEXT[lang];
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [description, setDescription] = useState(request.prefill ?? '');
  const [image, setImage] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const trimmedLength = description.trim().length;
  const canSend = trimmedLength >= MIN_CHARS && trimmedLength <= MAX_CHARS && status === 'idle';

  const pickImage = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => setImage(reader.result as string);
    reader.readAsDataURL(file);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    setStatus('sending');
    setError(null);
    const result = await sendProblemReport(description, image);
    if (result.ok) {
      setStatus('sent');
    } else {
      setStatus('idle');
      setError(result.message);
    }
  };

  return (
    <div className="fixed inset-0 z-[85] flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={closeReportProblem} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-problem-title"
        className="relative liquid-glass-elevated w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl overflow-hidden max-h-[92dvh] flex flex-col animate-spring-in"
      >
        <div className="px-4 sm:px-5 py-3.5 border-b border-[var(--glass-border)] flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-rose-500/15 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0">
              <MessageSquareWarning className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 id="report-problem-title" className="text-base font-bold truncate">
                {t.title}
              </h3>
              <p className="text-xs text-[var(--text-muted)] truncate">{t.subtitle}</p>
            </div>
          </div>
          <button
            onClick={closeReportProblem}
            className="w-10 h-10 rounded-xl liquid-glass-subtle liquid-glass-interactive flex items-center justify-center shrink-0"
            aria-label={t.close}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {status === 'sent' ? (
          <div className="p-6 text-center space-y-3 pb-[calc(env(safe-area-inset-bottom)+24px)]">
            <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-500" />
            <p className="text-base font-bold">{t.thanks}</p>
            <p className="text-sm text-[var(--text-muted)]">{t.thanksBody}</p>
            <button
              onClick={closeReportProblem}
              className="w-full liquid-lens-btn min-h-[48px] rounded-xl text-base font-bold"
            >
              {t.close}
            </button>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="p-4 sm:p-5 overflow-y-auto space-y-4 pb-[calc(env(safe-area-inset-bottom)+16px)]"
          >
            <label className="block space-y-1.5">
              <span className="text-sm font-semibold text-[var(--text-secondary)]">{t.label}</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={MAX_CHARS}
                rows={5}
                placeholder={t.placeholder}
                className="liquid-input w-full px-3.5 py-2.5 rounded-xl text-sm resize-y min-h-[120px]"
              />
              <span className="flex justify-between text-[11px] text-[var(--text-muted)]">
                <span>{trimmedLength > 0 && trimmedLength < MIN_CHARS ? t.tooShort(trimmedLength) : ''}</span>
                <span>
                  {description.length}/{MAX_CHARS}
                </span>
              </span>
            </label>

            <div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  pickImage(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              {image ? (
                <div className="relative liquid-glass-subtle rounded-xl p-2 flex justify-center">
                  <img src={image} alt="" className="max-h-48 rounded-lg" />
                  <button
                    type="button"
                    onClick={() => setImage(null)}
                    className="absolute top-2 right-2 w-8 h-8 rounded-full bg-slate-900/70 text-white flex items-center justify-center"
                    aria-label={t.remove}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="w-full min-h-[48px] rounded-xl border-2 border-dashed border-[var(--glass-border-strong)] text-sm font-semibold text-[var(--text-secondary)] flex items-center justify-center gap-2 hover:border-avocado-500/60"
                >
                  <ImagePlus className="w-4 h-4" /> {t.attach}
                </button>
              )}
            </div>

            <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{t.privacy}</p>

            {error && (
              <div className="p-3 rounded-xl bg-rose-500/10 text-sm text-rose-700 dark:text-rose-300">{error}</div>
            )}

            <button
              type="submit"
              disabled={!canSend}
              className="w-full liquid-lens-btn min-h-[48px] rounded-xl text-base font-bold flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {status === 'sending' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> {t.sending}
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" /> {t.send}
                </>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Mounted once; shows the report sheet whenever openReportProblem() is called. */
export function ReportProblemRoot() {
  const request = useSyncExternalStore(subscribeReportProblem, getReportProblemRequest);
  if (!request) return null;
  // A new request (e.g. another prefill) starts a fresh form
  return <ReportProblemSheet key={JSON.stringify(request)} request={request} />;
}
