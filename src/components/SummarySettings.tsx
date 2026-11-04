import React, { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Loader2, Mail, Newspaper } from 'lucide-react';

type Frequency = 'weekly' | 'monthly' | 'none';

interface SummarySettingsProps {
  sb: SupabaseClient;
  userId: string;
  householdId: string;
  onToast: (text: string, kind?: 'error' | 'success') => void;
}

const OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'weekly', label: 'Semanal' },
  { value: 'monthly', label: 'Mensual' },
  { value: 'none', label: 'Ninguno' },
];

/** Weekly / monthly summary: how often and whether it also comes by email (push uses the notification switches). */
export const SummarySettings: React.FC<SummarySettingsProps> = ({ sb, userId, householdId, onToast }) => {
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [byEmail, setByEmail] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let active = true;
    sb.from('notification_preferences')
      .select('summary_frequency, summary_email')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!active) return;
        if (data) {
          setFrequency((data.summary_frequency as Frequency) ?? 'weekly');
          setByEmail(Boolean(data.summary_email));
        }
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [sb, userId]);

  const save = (patch: { summary_frequency?: Frequency; summary_email?: boolean }) => {
    sb.from('notification_preferences')
      .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      .then(({ error }) => error && onToast('No se guardó la preferencia del resumen.'));
  };

  const sendTest = async () => {
    setSending(true);
    try {
      const { data, error } = await sb.functions.invoke('summary', {
        body: { action: 'preview', householdId, period: frequency === 'monthly' ? 'monthly' : 'weekly' },
      });
      if (error) throw error;
      const sent = Number(data?.emails ?? 0) + Number(data?.pushes ?? 0);
      onToast(sent > 0 ? 'Te enviamos un resumen de prueba' : 'No se pudo enviar: revisa correo y notificaciones', sent > 0 ? 'success' : 'error');
    } catch {
      onToast('No se pudo generar el resumen.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-1.5 pt-1 border-t border-[var(--glass-border)]">
      <p className="text-xs font-semibold text-[var(--text-muted)] flex items-center gap-1.5 pt-1">
        <Newspaper className="w-3.5 h-3.5" /> Resumen del hogar
      </p>
      <div className="grid grid-cols-3 gap-1 p-1 rounded-xl liquid-glass-subtle">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            disabled={!loaded}
            onClick={() => {
              setFrequency(o.value);
              save({ summary_frequency: o.value });
            }}
            aria-pressed={frequency === o.value}
            className={`min-h-[40px] rounded-lg text-sm font-bold transition ${
              frequency === o.value ? 'liquid-lens-btn' : 'text-[var(--text-secondary)]'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {frequency !== 'none' && (
        <>
          <label className="flex items-center gap-2.5 min-h-[44px] px-1 text-sm font-medium">
            <input
              type="checkbox"
              checked={byEmail}
              onChange={(e) => {
                setByEmail(e.target.checked);
                save({ summary_email: e.target.checked });
              }}
              className="w-5 h-5 accent-[#4f7f27]"
            />
            <Mail className="w-4 h-4 text-[var(--text-muted)]" /> También por correo
          </label>
          <button
            onClick={() => void sendTest()}
            disabled={sending}
            className="w-full min-h-[40px] text-xs font-semibold text-avocado-700 dark:text-avocado-400 text-left px-1 flex items-center gap-1.5"
          >
            {sending && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Enviarme un resumen de prueba
          </button>
        </>
      )}
    </div>
  );
};
