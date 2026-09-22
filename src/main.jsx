import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { captureInvite } from './lib/invite.js'
import { watchInstallPrompt } from './lib/platform.js'
import './styles.css'

captureInvite()
watchInstallPrompt()
createRoot(document.getElementById('root')).render(<App />)
