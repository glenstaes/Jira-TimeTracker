import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import '@/styles/globals.css'
import { installRendererErrorLogging } from './lib/logging'

installRendererErrorLogging()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Use contextBridge
if (window.ipcRenderer) {
  window.ipcRenderer.on('main-process-message', (_event, message) => {
    console.log(message)
  })
} else {
  console.warn('window.ipcRenderer is not defined');
}
