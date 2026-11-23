import React, { useEffect, useState, useSyncExternalStore } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CheckCircle2, Download, Loader2, Share, Smartphone } from 'lucide-react';
import { getInstallState, promptInstall, subscribeInstallState } from '../lib/pwa';
import {
  DEFAULT_NOTIFICATION_PREFS,
  disablePush,
  enablePush,
  getCurrentSubscription,
  loadNotificationPrefs,
  NOTIFICATION_KIND_LABELS,
  NotificationKind,
  NotificationPrefs,
  pushSupport,
  saveNotificationPrefs,
  sendTestPush,
} from '../lib/pushNotifications';
import { Button, SwitchRow } from './ui/Form';

type Toast = (text: string, kind?: 'error' | 'success') => void;

/** "Instalar Canastica": native prompt on Android/desktop, steps on iPhone. */
export const InstallAppSettings: React.FC = () => {
  const installState = useSyncExternalStore(subscribeInstallState, getInstallState);
  const [showIosHelp, setShowIosHelp] = useState(false);

  if (installState === 'installed') {
    return (
      <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
        <CheckCircle2 className="w-4 h-4 text-avocado-600" /> Canastica ya está instalada en este dispositivo.
      </p>
    );
  }
  if (installState === 'unavailable') {
    return <p className="text-sm text-[var(--text-muted)]">Este navegador no permite instalar la app.</p>;
  }
  return (
    <div className="space-y-3">
      <Button
        variant="soft"
        block
        onClick={() => (installState === 'prompt' ? void promptInstall() : setShowIosHelp((v) => !v))}
      >
        <Download className="w-4 h-4" /> Instalar Canastica
      </Button>
      {showIosHelp && installState === 'ios' && (
        <ol className="rounded-xl bg-[var(--glass-bg-subtle)] p-4 text-sm space-y-1.5 list-decimal list-inside text-[var(--text-secondary)]">
          <li>
            Abre Canastica en <strong>Safari</strong>.
          </li>
          <li>
            Toca <Share className="inline w-4 h-4 -mt-0.5" /> <strong>Compartir</strong>.
          </li>
          <li>
            Elige <strong>Agregar a inicio</strong> y luego <strong>Agregar</strong>.
          </li>
        </ol>
      )}
    </div>
  );
};

interface NotificationSettingsProps {
  sb: SupabaseClient | null;
  userId?: string;
  onToast: Toast;
}

/** Push notifications for this device and which kinds to receive. */
export const NotificationSettings: React.FC<NotificationSettingsProps> = ({ sb, userId, onToast }) => {
  const support = pushSupport();
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);

  useEffect(() => {
    if (support !== 'supported') return;
    let active = true;
    void getCurrentSubscription().then((s) => active && setPushOn(Boolean(s) && Notification.permission === 'granted'));
    return () => {
      active = false;
    };
  }, [support]);

  useEffect(() => {
    if (!sb || !userId || !pushOn) return;
    let active = true;
    void loadNotificationPrefs(sb, userId).then((p) => active && setPrefs(p));
    return () => {
      active = false;
    };
  }, [sb, userId, pushOn]);

  if (!sb || !userId) {
    return (
      <p className="text-sm text-[var(--text-muted)]">
        Las notificaciones se activan al iniciar sesión con tu cuenta (no están disponibles en el modo prueba).
      </p>
    );
  }

  if (support === 'needs-install') {
    return (
      <p className="text-sm text-[var(--text-secondary)] flex gap-2">
        <Smartphone className="w-4 h-4 shrink-0 mt-0.5" /> En iPhone las notificaciones funcionan con Canastica instalada en la
        pantalla de inicio (iOS 16.4 o superior). Instálala desde Datos y dispositivo.
      </p>
    );
  }
  if (support !== 'supported') {
    return <p className="text-sm text-[var(--text-muted)]">Este dispositivo no admite notificaciones.</p>;
  }

  const togglePush = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (pushOn) {
        await disablePush(sb);
        setPushOn(false);
      } else {
        const result = await enablePush(sb, userId);
        if (result === 'ok') {
          setPushOn(true);
          onToast('Notificaciones activadas en este dispositivo', 'success');
        } else if (result === 'denied') {
          onToast('El permiso de notificaciones está bloqueado. Actívalo en los ajustes del navegador.');
        } else {
          onToast('Este dispositivo no admite notificaciones.');
        }
      }
    } catch {
      onToast('No pudimos cambiar las notificaciones. Intenta de nuevo.');
    } finally {
      setBusy(false);
    }
  };

  const changePref = (kind: NotificationKind, value: boolean) => {
    const next = { ...prefs, [kind]: value };
    setPrefs(next);
    saveNotificationPrefs(sb, userId, next).catch(() => onToast('No se guardó la preferencia.'));
  };

  return (
    <div className="divide-y divide-[var(--glass-border)]">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <SwitchRow
            label="Notificaciones en este dispositivo"
            description={pushOn ? 'Activadas' : 'Recibe avisos aunque la app esté cerrada'}
            checked={Boolean(pushOn)}
            disabled={busy || pushOn === null}
            onChange={() => void togglePush()}
          />
        </div>
        {busy && <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />}
      </div>
      {pushOn &&
        (Object.keys(NOTIFICATION_KIND_LABELS) as NotificationKind[]).map((k) => (
          <SwitchRow key={k} label={NOTIFICATION_KIND_LABELS[k]} checked={prefs[k]} onChange={(v) => changePref(k, v)} />
        ))}
      {pushOn && (
        <div className="pt-3">
          <Button
            variant="soft"
            size="sm"
            onClick={() =>
              void sendTestPush(sb)
                .then((n) =>
                  onToast(
                    n > 0 ? 'Notificación de prueba enviada' : 'No se envió: revisa la configuración',
                    n > 0 ? 'success' : 'error'
                  )
                )
                .catch(() => onToast('No se pudo enviar la prueba.'))
            }
          >
            Enviar una notificación de prueba
          </Button>
        </div>
      )}
    </div>
  );
};
