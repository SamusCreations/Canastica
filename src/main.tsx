import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DevConsoleRoot } from './components/DevConsoleRoot'
import { ReportProblemRoot } from './components/ReportProblemRoot'
import { installGlobalErrorCapture } from './lib/appContext'
import { setupPwa } from './lib/pwa'
import { captureSharedTextFromUrl } from './lib/sharedText'

installGlobalErrorCapture()
setupPwa()
// A list shared from WhatsApp opens /compartir?text=...; keep it before anything else touches the URL
captureSharedTextFromUrl()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <DevConsoleRoot />
    <ReportProblemRoot />
  </StrictMode>,
)
