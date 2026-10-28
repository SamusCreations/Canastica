import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DevConsoleRoot } from './components/DevConsoleRoot'
import { ReportProblemRoot } from './components/ReportProblemRoot'
import { installGlobalErrorCapture } from './lib/appContext'

installGlobalErrorCapture()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <DevConsoleRoot />
    <ReportProblemRoot />
  </StrictMode>,
)
