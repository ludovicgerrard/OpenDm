import React from 'react'
import ReactDOM from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import App from './App'
import Home from './pages/Home'
import NewDownload from './pages/NewDownload'
import SettingsPage from './pages/Settings'

// Tauri serves from a custom protocol: hash routing avoids 404 on reload (MIGRATE Phase 1 step 7).
const router = createHashRouter([{ path: '/', element: <App />, children: [
  { index: true, element: <Home /> }, { path: 'new', element: <NewDownload /> }, { path: 'settings', element: <SettingsPage /> },
] }])
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router} /></React.StrictMode>)
