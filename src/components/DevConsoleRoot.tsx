import { lazy, Suspense, useState, useSyncExternalStore } from 'react';
import { Bug, MessageSquareWarning, X } from 'lucide-react';
import { isDeveloperMode, subscribeDevConsole } from '../lib/devConsole';
import { getReportProblemRequest, openReportProblem, subscribeReportProblem } from '../lib/reportProblem';
import { getReportScreenContext } from '../lib/appContext';

// The panel is only downloaded for developer accounts
const DevConsolePanel = lazy(() => import('./DevConsolePanel'));

const FAB_POSITION = 'fixed z-[90] left-3 bottom-[calc(env(safe-area-inset-bottom)+84px)] sm:bottom-4';

/**
 * Floating button that is always visible: opens "Reportar un problema".
 * For developer accounts it opens a small menu that also holds the developer console.
 */
export function DevConsoleRoot() {
  const developer = useSyncExternalStore(subscribeDevConsole, isDeveloperMode);
  const reportOpen = useSyncExternalStore(subscribeReportProblem, getReportProblemRequest) !== null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const en = getReportScreenContext().language === 'en';

  const report = () => {
    setMenuOpen(false);
    openReportProblem();
  };

  return (
    <>
      {!consoleOpen && !reportOpen && (
        <div className={`${FAB_POSITION} flex flex-col-reverse items-start gap-2`}>
          <button
            onClick={developer ? () => setMenuOpen((v) => !v) : report}
            aria-label={en ? 'Report a problem' : 'Reportar un problema'}
            aria-expanded={developer ? menuOpen : undefined}
            className="w-10 h-10 rounded-full bg-slate-900/80 text-rose-300 border border-rose-500/40 shadow-lg flex items-center justify-center backdrop-blur"
          >
            {menuOpen ? <X className="w-5 h-5" /> : <MessageSquareWarning className="w-5 h-5" />}
          </button>
          {developer && menuOpen && (
            <div className="flex flex-col gap-1.5 animate-spring-in">
              <button
                onClick={report}
                className="px-3 h-9 rounded-full bg-slate-900/85 text-rose-200 border border-rose-500/40 shadow-lg text-xs font-bold flex items-center gap-1.5 backdrop-blur"
              >
                <MessageSquareWarning className="w-4 h-4" /> {en ? 'Report a problem' : 'Reportar problema'}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setConsoleOpen(true);
                }}
                className="px-3 h-9 rounded-full bg-slate-900/85 text-emerald-300 border border-emerald-500/40 shadow-lg text-xs font-bold flex items-center gap-1.5 backdrop-blur"
              >
                <Bug className="w-4 h-4" /> {en ? 'Developer console' : 'Consola developer'}
              </button>
            </div>
          )}
        </div>
      )}
      {developer && consoleOpen && (
        <Suspense fallback={null}>
          <DevConsolePanel onClose={() => setConsoleOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
