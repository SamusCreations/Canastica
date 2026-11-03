import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DevConsoleRoot } from './components/DevConsoleRoot'
import { ReportProblemRoot } from './components/ReportProblemRoot'
import { installGlobalErrorCapture } from './lib/appContext'
import { setupPwa } from './lib/pwa'
import { captureSharedTextFromUrl } from './lib/sharedText'
import { SharedListPage } from './components/SharedListPage'
import { SHARED_LINK_PATH } from './services/sharedListService'
import { getSupabaseClient } from './services/geminiAndSupabaseService'

installGlobalErrorCapture()
setupPwa()
// A list shared from WhatsApp opens /compartir?text=...; keep it before anything else touches the URL
captureSharedTextFromUrl()

// /l/<token>: public shared shopping list, no account needed
const sharedListToken = window.location.pathname.match(SHARED_LINK_PATH)?.[1]

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {sharedListToken ? (
      <SharedListPage sb={getSupabaseClient()} token={sharedListToken} />
    ) : (
      <>
        <App />
        <DevConsoleRoot />
        <ReportProblemRoot />
      </>
    )}
  </StrictMode>,
)
