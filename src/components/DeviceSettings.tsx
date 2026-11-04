import React, { useEffect, useState, useSyncExternalStore } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Bell, BellOff, Download, Loader2, Share, Smartphone } from 'lucide-react';
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

interface DeviceSettingsProps {
  sb: SupabaseClient | null;
  userId?: string;
  onToast: (text: string, kind?: 'error' | 'success') => void;
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="w-full min-h-[44px] px-1 flex items-center justify-between gap-3 text-sm font-medium text-left"
    >
      <span>{label}</span>
      <span
        className={`relative w-11 h-6 rounded-full transition shrink-0 ${checked ? 'bg-avocado-600' : 'bg-slate-300 dark:bg-slate-600'}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

/** "Instalar Canastica" and push notification settings for this device. */
export const DeviceSettings: React.FC<DeviceSettingsProps> = ({ sb, userId, onToast }) => {
  const installState = useSyncExternalStore(subscribeInstallState, getInstallState);
  const [showIosHelp, setShowIosHelp] = useState(false);

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

  const togglePush = async () => {
    if (!sb || !userId || busy) return;
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
    if (!sb || !userId) return;
    const next = { ...prefs, [kind]: value };
    setPrefs(next);
    saveNotificationPrefs(sb, userId, next).catch(() => onToast('No se guardó la preferencia.'));
  };

  return (
    <div className="space-y-2 pt-1 border-t border-[var(--glass-border)]">
      {installState !== 'installed' && installState !== 'unavailable' && (
        <div className="space-y-2">
          <button
            onClick={() => (installState === 'prompt' ? void promptInstall() : setShowIosHelp((v) => !v))}
            className="w-full min-h-[48px] px-3 rounded-xl flex items-center gap-3 text-sm font-bold text-avocado-700 dark:text-avocado-400 hover:bg-[var(--glass-bg-hover)]"
          >
            <Download className="w-4 h-4" /> Instalar Canastica
          </button>
          {showIosHelp && installState === 'ios' && (
            <ol className="liquid-glass-subtle rounded-xl p-3 text-sm space-y-1 list-decimal list-inside text-[var(--text-secondary)]">
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
      )}

      {sb && userId && (
        <div className="space-y-1">
          {support === 'supported' ? (
            <>
              <button
                onClick={() => void togglePush()}
                disabled={busy || pushOn === null}
                className="w-full min-h-[48px] px-3 rounded-xl flex items-center gap-3 text-sm font-semibold hover:bg-[var(--glass-bg-hover)] disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : pushOn ? (
                  <BellOff className="w-4 h-4 text-[var(--text-muted)]" />
                ) : (
                  <Bell className="w-4 h-4 text-[var(--text-muted)]" />
                )}
                {pushOn ? 'Desactivar notificaciones en este dispositivo' : 'Activar notificaciones'}
              </button>
              {pushOn && (
                <div className="liquid-glass-subtle rounded-xl px-3 py-1">
                  {(Object.keys(NOTIFICATION_KIND_LABELS) as NotificationKind[]).map((k) => (
                    <Switch key={k} label={NOTIFICATION_KIND_LABELS[k]} checked={prefs[k]} onChange={(v) => changePref(k, v)} />
                  ))}
                  <button
                    onClick={() =>
                      void sendTestPush(sb)
                        .then((n) => onToast(n > 0 ? 'Notificación de prueba enviada' : 'No se envió: revisa la configuración', n > 0 ? 'success' : 'error'))
                        .catch(() => onToast('No se pudo enviar la prueba.'))
                    }
                    className="w-full min-h-[40px] text-xs font-semibold text-avocado-700 dark:text-avocado-400 text-left"
                  >
                    Enviar una notificación de prueba
                  </button>
                </div>
              )}
            </>
          ) : support === 'needs-install' ? (
            <p className="px-3 py-2 text-xs text-[var(--text-muted)] flex gap-2">
              <Smartphone className="w-4 h-4 shrink-0" /> En iPhone las notificaciones funcionan con Canastica instalada en la pantalla de
              inicio (iOS 16.4 o superior).
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
};
