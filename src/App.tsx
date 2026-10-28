import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { AuthScreen } from './components/AuthScreen';
import { HouseholdOnboarding } from './components/HouseholdOnboarding';
import { HouseholdWorkspace } from './HouseholdWorkspace';
import {
  getSupabaseClient,
  loadDevStatus,
  refreshAiQuota,
} from './services/geminiAndSupabaseService';
import { devLog, setDevContext, setDevStatus } from './lib/devConsole';
import {
  describeSupabaseError,
  HouseholdMembership,
  joinHousehold,
  listMyHouseholds,
} from './services/householdRepository';
import { BrandMark } from './components/BrandLogo';

const DEMO_MODE_KEY = 'glasscart_demo_mode_v1';
const ACTIVE_HOUSEHOLD_KEY = 'glasscart_active_household_v1';
const PENDING_INVITE_KEY = 'glasscart_pending_invite_v1';
const THEME_KEY = 'glasscart_theme_v1';

function readStorage(key: string, storage: Storage = localStorage): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null, storage: Storage = localStorage) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // ignore
  }
}

/** Invite links look like https://app/?join=GLS-XXXXX — keep the code until the user is signed in. */
function captureInviteFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('join');
  if (code) {
    writeStorage(PENDING_INVITE_KEY, code.toUpperCase(), sessionStorage);
    params.delete('join');
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  }
  return readStorage(PENDING_INVITE_KEY, sessionStorage);
}

function initialTheme(): 'light' | 'dark' {
  const saved = readStorage(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function Splash({ label }: { label: string }) {
  return (
    <div className="h-dvh w-full flex flex-col items-center justify-center gap-3 bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      <BrandMark className="w-12 h-12 rounded-2xl" />
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin" /> {label}
      </div>
    </div>
  );
}

export function App() {
  const sb = useMemo(() => getSupabaseClient(), []);

  const [theme, setTheme] = useState<'light' | 'dark'>(initialTheme);
  const [isDemo, setIsDemo] = useState<boolean>(() => readStorage(DEMO_MODE_KEY) === '1');
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(!sb);
  const [isRecovery, setIsRecovery] = useState(false);
  const [memberships, setMemberships] = useState<HouseholdMembership[] | null>(null);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [activeHouseholdId, setActiveHouseholdId] = useState<string | null>(() =>
    readStorage(ACTIVE_HOUSEHOLD_KEY)
  );
  const [pendingInvite, setPendingInvite] = useState<string | null>(captureInviteFromUrl);

  // Light / dark mode on <html>, remembered per device
  useEffect(() => {
    const htmlEl = document.documentElement;
    htmlEl.classList.toggle('dark', theme === 'dark');
    htmlEl.classList.toggle('light', theme !== 'dark');
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#0d131f' : '#ffffff');
    writeStorage(THEME_KEY, theme);
  }, [theme]);

  // Supabase Auth session
  useEffect(() => {
    if (!sb) return;
    let active = true;
    sb.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = sb.auth.onAuthStateChange((event, newSession) => {
      devLog('info', 'Sesión', event);
      if (event === 'PASSWORD_RECOVERY') setIsRecovery(true);
      setSession(newSession);
      setAuthReady(true);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [sb]);

  const userId = session?.user.id ?? null;
  const userEmail = session?.user.email ?? null;

  // The server decides whether this account may see the developer console
  useEffect(() => {
    if (!userId) {
      setDevStatus(null);
      return;
    }
    setDevContext({ userId, email: userEmail });
    void loadDevStatus();
    void refreshAiQuota();
  }, [userId, userEmail]);

  useEffect(() => {
    setDevContext({ householdId: activeHouseholdId });
  }, [activeHouseholdId]);

  const refreshMemberships = useCallback(async () => {
    if (!sb || !userId) return;
    try {
      const list = await listMyHouseholds(sb, userId);
      setMemberships(list);
      setMembershipError(null);
    } catch (err) {
      setMembershipError(describeSupabaseError(err));
    }
  }, [sb, userId]);

  useEffect(() => {
    if (!userId) {
      setMemberships(null);
      return;
    }
    void refreshMemberships();
  }, [userId, refreshMemberships]);

  const selectHousehold = useCallback((id: string | null) => {
    setActiveHouseholdId(id);
    writeStorage(ACTIVE_HOUSEHOLD_KEY, id);
  }, []);

  // Accept a pending invite link right after signing in (only if the user already has a household;
  // brand-new users see it pre-filled in onboarding instead)
  useEffect(() => {
    if (!sb || !userId || !pendingInvite || !memberships || memberships.length === 0) return;
    const code = pendingInvite;
    setPendingInvite(null);
    writeStorage(PENDING_INVITE_KEY, null, sessionStorage);
    joinHousehold(sb, code)
      .then((id) => {
        selectHousehold(id);
        return refreshMemberships();
      })
      .catch(() => {
        // An invalid or reused link should not block the app
      });
  }, [sb, userId, pendingInvite, memberships, selectHousehold, refreshMemberships]);

  const handleSignOut = async () => {
    await sb?.auth.signOut();
    setMemberships(null);
    selectHousehold(null);
  };

  const handleJoinFromWorkspace = async (code: string): Promise<string | null> => {
    if (!sb) return 'El servicio no está disponible en este momento.';
    try {
      const id = await joinHousehold(sb, code);
      selectHousehold(id);
      await refreshMemberships();
      return null;
    } catch (err) {
      return describeSupabaseError(err);
    }
  };

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));


  // ------------------------------------------------------------------------
  // Demo mode: local sample data, no account needed
  // ------------------------------------------------------------------------
  if (isDemo) {
    return (
      <>
        <HouseholdWorkspace
          key="demo"
          mode="demo"
          sb={null}
          memberships={[]}
          theme={theme}
          onToggleTheme={toggleTheme}
          onSwitchHousehold={() => undefined}
          onJoinHousehold={async () => null}
          onSignOut={() => undefined}
          onExitDemo={() => {
            writeStorage(DEMO_MODE_KEY, null);
            setIsDemo(false);
          }}
        />
      </>
    );
  }

  const startDemo = () => {
    writeStorage(DEMO_MODE_KEY, '1');
    setIsDemo(true);
  };

  if (!authReady) return <Splash label="Iniciando…" />;

  if (!sb || !session || isRecovery) {
    return (
      <>
        <AuthScreen
          sb={sb}
          isRecovery={isRecovery}
          pendingInviteCode={pendingInvite}
          onRecoveryDone={() => setIsRecovery(false)}
          onStartDemo={startDemo}
        />
      </>
    );
  }

  if (membershipError && !memberships) {
    return (
      <div className="h-dvh w-full flex items-center justify-center p-4 bg-[var(--bg-canvas)] text-[var(--text-primary)]">
        <div className="liquid-glass rounded-2xl p-5 max-w-sm w-full space-y-3 text-center">
          <AlertTriangle className="w-8 h-8 mx-auto text-amber-500" />
          <p className="text-base font-bold">No pudimos cargar tu cuenta</p>
          <p className="text-sm text-[var(--text-muted)]">{membershipError}</p>
          <div className="flex gap-2">
            <button
              onClick={() => void handleSignOut()}
              className="flex-1 min-h-[44px] rounded-xl liquid-glass-subtle liquid-glass-interactive text-sm font-semibold"
            >
              Cerrar sesión
            </button>
            <button
              onClick={() => void refreshMemberships()}
              className="flex-1 min-h-[44px] rounded-xl liquid-lens-btn text-sm font-bold flex items-center justify-center gap-1.5"
            >
              <RefreshCw className="w-4 h-4" /> Reintentar
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!memberships) return <Splash label="Cargando tus hogares…" />;

  const userName =
    (session.user.user_metadata?.full_name as string | undefined) ||
    session.user.email?.split('@')[0] ||
    '';

  if (memberships.length === 0) {
    return (
      <HouseholdOnboarding
        sb={sb}
        userName={userName}
        initialInviteCode={pendingInvite}
        onReady={(id) => {
          setPendingInvite(null);
          writeStorage(PENDING_INVITE_KEY, null, sessionStorage);
          selectHousehold(id);
          void refreshMemberships();
        }}
        onSignOut={() => void handleSignOut()}
      />
    );
  }

  const householdId =
    memberships.find((m) => m.householdId === activeHouseholdId)?.householdId ??
    memberships[0].householdId;

  return (
    <>
      <HouseholdWorkspace
        key={householdId}
        mode="cloud"
        sb={sb}
        userId={session.user.id}
        userEmail={session.user.email}
        householdId={householdId}
        memberships={memberships}
        theme={theme}
        onToggleTheme={toggleTheme}
        onSwitchHousehold={selectHousehold}
        onJoinHousehold={handleJoinFromWorkspace}
        onSignOut={() => void handleSignOut()}
        onExitDemo={() => undefined}
      />
    </>
  );
}

export default App;
