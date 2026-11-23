import React, { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Loader2, Mail, Newspaper } from 'lucide-react';
import { Button, Field, Segmented, SwitchRow } from './ui/Form';

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
    <div className="space-y-4">
      <Field label="¿Cada cuánto quieres el resumen del hogar?">
        {() => (
          <Segmented
            aria-label="Frecuencia del resumen"
            value={frequency}
            disabled={!loaded}
            onChange={(v) => {
              setFrequency(v);
              save({ summary_frequency: v });
            }}
            options={OPTIONS}
          />
        )}
      </Field>
      {frequency !== 'none' && (
        <>
          <SwitchRow
            label={
              <span className="inline-flex items-center gap-2">
                <Mail className="w-4 h-4 text-[var(--text-muted)]" /> También por correo
              </span>
            }
            description="Por notificación llega si las tienes activadas en este dispositivo."
            checked={byEmail}
            onChange={(v) => {
              setByEmail(v);
              save({ summary_email: v });
            }}
          />
          <Button variant="soft" size="sm" onClick={() => void sendTest()} disabled={sending}>
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Newspaper className="w-4 h-4" />} Enviarme un
            resumen de prueba
          </Button>
        </>
      )}
    </div>
  );
};
