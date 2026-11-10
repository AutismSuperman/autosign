import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { AuthWindow } from './AuthWindow'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get('window') === 'auth' ? <AuthWindow /> : <App />}
  </React.StrictMode>
)
