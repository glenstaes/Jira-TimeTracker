import React from 'react'
import ReactDOM from 'react-dom/client'
import { MiniPlayerApp } from './MiniPlayerApp'
import '../styles/mini-player.css'
import { installRendererErrorLogging } from '../lib/logging'

installRendererErrorLogging()

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <MiniPlayerApp />
    </React.StrictMode>,
)
