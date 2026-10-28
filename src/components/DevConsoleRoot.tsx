import { lazy, Suspense, useState, useSyncExternalStore } from 'react';
import { Bug } from 'lucide-react';
import { isDeveloperMode, subscribeDevConsole } from '../lib/devConsole';

// The panel is only downloaded for developer accounts
const DevConsolePanel = lazy(() => import('./DevConsolePanel'));

/** Floating entry point to the developer console; renders nothing for regular accounts. */
export function DevConsoleRoot() {
  const developer = useSyncExternalStore(subscribeDevConsole, isDeveloperMode);
  const [open, setOpen] = useState(false);
  if (!developer) return null;

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Abrir consola developer"
          className="fixed z-[90] left-3 bottom-[calc(env(safe-area-inset-bottom)+84px)] sm:bottom-4 w-10 h-10 rounded-full bg-slate-900/80 text-emerald-300 border border-emerald-500/40 shadow-lg flex items-center justify-center backdrop-blur"
        >
          <Bug className="w-5 h-5" />
        </button>
      )}
      {open && (
        <Suspense fallback={null}>
          <DevConsolePanel onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
