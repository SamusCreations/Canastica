import React, { useRef, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, ImagePlus, Loader2, MessageSquareWarning, Send, X } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { Button } from './ui/Form';
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
    <Sheet
      onClose={closeReportProblem}
      title={t.title}
      subtitle={t.subtitle}
      icon={<MessageSquareWarning className="w-5 h-5" />}
      size="md"
      zIndex="z-[85]"
      footer={
        status === 'sent' ? (
          <Button size="lg" block onClick={closeReportProblem}>
            {t.close}
          </Button>
        ) : (
          <Button type="submit" form="report-problem-form" size="lg" block disabled={!canSend}>
            {status === 'sending' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> {t.sending}
              </>
            ) : (
              <>
                <Send className="w-4 h-4" /> {t.send}
              </>
            )}
          </Button>
        )
      }
    >
        {status === 'sent' ? (
          <div className="py-6 text-center space-y-3">
            <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-500" />
            <p className="text-base font-bold">{t.thanks}</p>
            <p className="text-sm text-[var(--text-muted)]">{t.thanksBody}</p>
          </div>
        ) : (
          <form id="report-problem-form" onSubmit={submit} className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-semibold text-[var(--text-secondary)]">{t.label}</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={MAX_CHARS}
                rows={5}
                placeholder={t.placeholder}
                className="w-full min-h-[120px] rounded-xl bg-[var(--input-glass-bg)] border border-[var(--input-border)] px-3.5 py-3 text-[15px] leading-relaxed resize-y focus:outline-none focus:border-avocado-500 focus:ring-4 focus:ring-avocado-500/15"
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

          </form>
        )}
    </Sheet>
  );
}

/** Mounted once; shows the report sheet whenever openReportProblem() is called. */
export function ReportProblemRoot() {
  const request = useSyncExternalStore(subscribeReportProblem, getReportProblemRequest);
  if (!request) return null;
  // A new request (e.g. another prefill) starts a fresh form
  return <ReportProblemSheet key={JSON.stringify(request)} request={request} />;
}
