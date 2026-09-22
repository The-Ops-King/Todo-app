import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { captureInvite } from './lib/invite.js'
import './styles.css'

captureInvite()
createRoot(document.getElementById('root')).render(<App />)
