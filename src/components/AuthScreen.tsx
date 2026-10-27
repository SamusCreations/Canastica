import React, { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ArrowLeft,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  MailCheck,
  PlayCircle,
  Receipt,
  ShoppingCart,
  Sparkles,
  User,
} from 'lucide-react';
import { describeSupabaseError } from '../services/householdRepository';
import { BrandMark } from './BrandLogo';

type AuthMode = 'signin' | 'signup' | 'verify' | 'reset' | 'new_password';

const RESEND_COOLDOWN_SECONDS = 60;

interface AuthScreenProps {
  sb: SupabaseClient | null;
  isRecovery?: boolean;
  pendingInviteCode?: string | null;
  onRecoveryDone?: () => void;
  onStartDemo: () => void;
}

const FEATURES = [
  { icon: Receipt, text: 'Escanea tus facturas con IA' },
  { icon: ShoppingCart, text: 'Lista de compras compartida en tiempo real' },
  { icon: Sparkles, text: 'Te avisa antes de que se acabe algo' },
];

export const AuthScreen: React.FC<AuthScreenProps> = ({
  sb,
  isRecovery = false,
  pendingInviteCode,
  onRecoveryDone,
  onStartDemo,
}) => {
  const [mode, setMode] = useState<AuthMode>(isRecovery ? 'new_password' : 'signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [otp, setOtp] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  const needsConfirm = mode === 'signup' || mode === 'new_password';
  const passwordsMismatch = needsConfirm && confirmPassword.length > 0 && confirmPassword !== password;

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    setConfirmPassword('');
    setOtp('');
  };

  const goToVerify = () => {
    switchMode('verify');
    setResendIn(RESEND_COOLDOWN_SECONDS);
  };

  const sendConfirmationEmail = async () => {
    if (!sb) return;
    const { error: err } = await sb.auth.resend({
      type: 'signup',
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    if (err) throw err;
  };

  const handleResend = async () => {
    if (!sb || resendIn > 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await sendConfirmationEmail();
      setNotice('Te enviamos un nuevo correo de confirmación.');
      setResendIn(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(describeSupabaseError(err));
    } finally {
      setBusy(false);
    }
  };

  /** Covers confirming from the link on another device: just try to sign in again. */
  const handleAlreadyConfirmed = async () => {
    if (!sb) return;
    if (!password) {
      switchMode('signin');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: err } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      if (err) throw err;
    } catch (err) {
      setError(describeSupabaseError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sb) return;
    if (needsConfirm && password !== confirmPassword) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'signin') {
        const { error: err } = await sb.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (err) {
          if (
            err.code === 'email_not_confirmed' ||
            err.message.toLowerCase().includes('email not confirmed')
          ) {
            goToVerify();
            try {
              await sendConfirmationEmail();
            } catch (resendErr) {
              setError(describeSupabaseError(resendErr));
            }
            return;
          }
          throw err;
        }
      } else if (mode === 'verify') {
        const { error: err } = await sb.auth.verifyOtp({
          email: email.trim(),
          token: otp.trim(),
          type: 'email',
        });
        if (err) throw err;
        // onAuthStateChange in App picks up the new session
      } else if (mode === 'signup') {
        const { data, error: err } = await sb.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { full_name: fullName.trim() },
            emailRedirectTo: window.location.origin + window.location.pathname,
          },
        });
        if (err) throw err;
        if (!data.session) goToVerify();
      } else if (mode === 'reset') {
        const { error: err } = await sb.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: window.location.origin + window.location.pathname,
        });
        if (err) throw err;
        setNotice('Si el correo existe, te llegará un enlace para crear una nueva contraseña.');
      } else if (mode === 'new_password') {
        const { error: err } = await sb.auth.updateUser({ password });
        if (err) throw err;
        onRecoveryDone?.();
      }
    } catch (err) {
      setError(describeSupabaseError(err));
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === 'signin'
      ? 'Inicia sesión'
      : mode === 'signup'
      ? 'Crea tu cuenta'
      : mode === 'verify'
      ? 'Confirma tu correo'
      : mode === 'reset'
      ? 'Recupera tu contraseña'
      : 'Nueva contraseña';

  const submitLabel =
    mode === 'signin'
      ? 'Entrar'
      : mode === 'signup'
      ? 'Crear cuenta'
      : mode === 'verify'
      ? 'Verificar'
      : mode === 'reset'
      ? 'Enviar enlace'
      : 'Guardar contraseña';

  return (
    <div className="min-h-dvh w-full flex flex-col lg:flex-row bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {/* Brand panel: compact header on mobile, full side panel on desktop */}
      <div className="relative overflow-hidden lg:w-[44%] bg-gradient-to-br from-avocado-600 via-avocado-700 to-avocado-900 text-white px-6 pt-[calc(env(safe-area-inset-top)+28px)] pb-10 lg:p-12 flex flex-col justify-between">
        <div className="absolute -top-16 -right-16 w-56 h-56 rounded-full bg-white/10 blur-2xl" />
        <div className="absolute bottom-0 -left-10 w-40 h-40 rounded-full bg-amber-300/25 blur-2xl" />

        <div className="relative flex items-center gap-2.5">
          <BrandMark className="w-10 h-10 rounded-xl" />
          <div>
            <p className="text-lg font-extrabold tracking-tight leading-none">Canastica</p>
            <p className="text-xs text-avocado-50">Las compras del hogar, en orden</p>
          </div>
        </div>

        <div className="relative mt-6 lg:mt-0 space-y-4">
          <h1 className="text-2xl lg:text-4xl font-extrabold leading-tight tracking-tight">
            Gasta menos y nunca te quedes sin lo básico.
          </h1>
          <ul className="hidden sm:block space-y-2.5">
            {FEATURES.map((f) => (
              <li key={f.text} className="flex items-center gap-2.5 text-sm text-avocado-50">
                <span className="w-7 h-7 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
                  <f.icon className="w-4 h-4" />
                </span>
                {f.text}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative hidden lg:block text-xs text-avocado-200">
          Tus datos se guardan de forma segura y privada.
        </p>
      </div>

      {/* Form panel: sheet overlapping the brand header on mobile */}
      <div className="flex-1 flex items-start lg:items-center justify-center -mt-5 lg:mt-0 px-4 pb-[calc(env(safe-area-inset-bottom)+24px)] lg:p-12">
        <div className="w-full max-w-sm liquid-glass rounded-2xl p-5 sm:p-6 space-y-5 shadow-xl lg:shadow-none">
          {(mode === 'reset' || mode === 'verify' || (mode === 'signup' && !isRecovery)) && (
            <button
              type="button"
              onClick={() => switchMode('signin')}
              className="-ml-1 inline-flex items-center gap-1 text-sm font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] min-h-[44px]"
            >
              <ArrowLeft className="w-4 h-4" /> Volver
            </button>
          )}

          <div className="space-y-1">
            <h2 className="text-xl font-extrabold tracking-tight">{title}</h2>
            {pendingInviteCode && mode !== 'new_password' && (
              <p className="text-sm text-avocado-700 dark:text-avocado-300 bg-avocado-500/10 rounded-lg px-3 py-2">
                Te invitaron a un hogar (código <strong>{pendingInviteCode}</strong>). Entra o crea
                tu cuenta para unirte.
              </p>
            )}
          </div>

          {!sb ? (
            <div className="space-y-3">
              <div className="p-3 rounded-xl bg-amber-500/10 text-sm text-amber-800 dark:text-amber-200">
                El servicio no está disponible en este momento. Inténtalo más tarde.
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
              {mode === 'signup' && (
                <label className="block space-y-1.5">
                  <span className="text-sm font-semibold text-[var(--text-secondary)]">
                    Tu nombre
                  </span>
                  <div className="relative">
                    <User className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                    <input
                      type="text"
                      autoComplete="name"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Ej. Ana Solís"
                      className="liquid-input w-full min-h-[48px] pl-10 pr-3 rounded-xl text-base"
                    />
                  </div>
                </label>
              )}

              {mode === 'verify' && (
                <div className="flex items-start gap-3 p-3 rounded-xl bg-avocado-500/10 text-sm text-[var(--text-secondary)]">
                  <MailCheck className="w-5 h-5 shrink-0 text-avocado-600 dark:text-avocado-400" />
                  <p>
                    Te enviamos un correo a <strong className="break-all">{email.trim()}</strong>.
                    Toca el botón del correo o escribe aquí el código.
                  </p>
                </div>
              )}

              {mode !== 'new_password' && mode !== 'verify' && (
                <label className="block space-y-1.5">
                  <span className="text-sm font-semibold text-[var(--text-secondary)]">Correo</span>
                  <div className="relative">
                    <Mail className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                    <input
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="tu@correo.com"
                      className="liquid-input w-full min-h-[48px] pl-10 pr-3 rounded-xl text-base"
                    />
                  </div>
                </label>
              )}

              {mode === 'verify' && (
                <label className="block space-y-1.5">
                  <span className="text-sm font-semibold text-[var(--text-secondary)]">
                    Código de confirmación
                  </span>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={10}
                      value={otp}
                      onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 10))}
                      placeholder="123456"
                      className="liquid-input w-full min-h-[56px] px-10 rounded-xl text-2xl text-center font-mono font-bold tracking-widest"
                    />
                  </div>
                </label>
              )}

              {mode !== 'reset' && mode !== 'verify' && (
                <label className="block space-y-1.5">
                  <span className="flex items-center justify-between text-sm font-semibold text-[var(--text-secondary)]">
                    Contraseña
                    {mode === 'signin' && (
                      <button
                        type="button"
                        onClick={() => switchMode('reset')}
                        className="text-xs font-semibold text-avocado-600 dark:text-avocado-400"
                      >
                        ¿La olvidaste?
                      </button>
                    )}
                  </span>
                  <div className="relative">
                    <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                      required
                      minLength={6}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={mode === 'signin' ? '••••••••' : 'Mínimo 6 caracteres'}
                      className="liquid-input w-full min-h-[48px] pl-10 pr-12 rounded-xl text-base"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center text-[var(--text-muted)]"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </label>
              )}

              {needsConfirm && (
                <label className="block space-y-1.5">
                  <span className="text-sm font-semibold text-[var(--text-secondary)]">
                    Confirmar contraseña
                  </span>
                  <div className="relative">
                    <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Repite tu contraseña"
                      aria-invalid={passwordsMismatch}
                      className="liquid-input w-full min-h-[48px] pl-10 pr-12 rounded-xl text-base"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center text-[var(--text-muted)]"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {passwordsMismatch && (
                    <span className="block text-xs font-semibold text-rose-600 dark:text-rose-400">
                      Las contraseñas no coinciden
                    </span>
                  )}
                </label>
              )}

              {error && (
                <p role="alert" className="text-sm text-rose-700 dark:text-rose-300 bg-rose-500/10 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}
              {notice && (
                <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 rounded-lg px-3 py-2">
                  {notice}
                </p>
              )}

              <button
                type="submit"
                disabled={
                  busy ||
                  (mode !== 'new_password' && !email.trim()) ||
                  (mode === 'verify'
                    ? otp.length < 6
                    : mode !== 'reset' && password.length < 6) ||
                  (needsConfirm && confirmPassword !== password) ||
                  (mode === 'signup' && !fullName.trim())
                }
                className="w-full liquid-lens-btn min-h-[48px] rounded-xl text-base font-bold flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                {submitLabel}
              </button>

              {mode === 'verify' && (
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => void handleResend()}
                    disabled={busy || resendIn > 0}
                    className="w-full liquid-glass-subtle liquid-glass-interactive min-h-[44px] rounded-xl text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    <Mail className="w-4 h-4" />
                    {resendIn > 0 ? `Reenviar en ${resendIn} s` : 'Reenviar correo'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleAlreadyConfirmed()}
                    disabled={busy}
                    className="w-full min-h-[44px] rounded-xl text-sm font-semibold text-avocado-600 dark:text-avocado-400 disabled:opacity-50"
                  >
                    Ya lo confirmé desde el enlace
                  </button>
                </div>
              )}
            </form>
          )}

          {sb && mode === 'signin' && (
            <p className="text-sm text-center text-[var(--text-muted)]">
              ¿No tienes cuenta?{' '}
              <button
                type="button"
                onClick={() => switchMode('signup')}
                className="font-bold text-avocado-600 dark:text-avocado-400 min-h-[40px]"
              >
                Regístrate
              </button>
            </p>
          )}

          {mode !== 'new_password' && mode !== 'verify' && (
            <div className="pt-4 border-t border-[var(--glass-border)] space-y-2">
              <button
                type="button"
                onClick={onStartDemo}
                className="w-full liquid-glass-subtle liquid-glass-interactive min-h-[44px] rounded-xl text-sm font-semibold flex items-center justify-center gap-2"
              >
                <PlayCircle className="w-4 h-4 text-avocado-600 dark:text-avocado-400" />
                Probar con datos de ejemplo
              </button>
              <p className="text-[11px] text-center text-[var(--text-muted)]">
                El modo de prueba guarda todo solo en este navegador.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
