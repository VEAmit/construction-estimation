import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { useAppStore } from './store/useAppStore'
import { licenseService } from './services/licenseService'
import Layout from './components/layout/Layout'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import SystemSettingsPage from './pages/SystemSettingsPage'

const DrawingsPage = lazy(() => import('./pages/DrawingsPage'))

// Redirect logged-in users away from /login (avoids the blurred login flash on back-navigation)
function PublicRoute({ children }) {
  const token     = useAppStore(s => s.token)
  const _hydrated = useAppStore(s => s._hydrated)
  if (!_hydrated) return null
  if (token) return <Navigate to="/dashboard" replace />
  return children
}

function ProtectedRoute({ children }) {
  const token     = useAppStore(s => s.token)
  const _hydrated = useAppStore(s => s._hydrated)
  const clearAuth = useAppStore(s => s.clearAuth)
  const [checkingLicense, setCheckingLicense] = useState(true)
  const [licenseValid, setLicenseValid] = useState(false)

  useEffect(() => {
    let active = true
    if (!_hydrated || !token) {
      setCheckingLicense(false)
      setLicenseValid(false)
      return () => { active = false }
    }

    setCheckingLicense(true)
    licenseService.validateSession()
      .then(() => {
        if (active) setLicenseValid(true)
      })
      .catch(error => {
        if (!active) return
        const message = error?.response?.data?.message ??
          'Unable to validate license. Please check your internet connection or contact your administrator.'
        sessionStorage.setItem('buildtakeoff-license-message', message)
        clearAuth()
        setLicenseValid(false)
      })
      .finally(() => {
        if (active) setCheckingLicense(false)
      })

    return () => { active = false }
  }, [_hydrated, clearAuth, token])

  // Wait for the persist store to finish rehydrating from localStorage.
  // Without this guard, token is null for ~1 frame on every load, which
  // triggers a redirect to /login and flashes the blurred login background.
  if (!_hydrated) return null

  if (!token) return <Navigate to="/login" replace />
  if (checkingLicense) return null
  if (!licenseValid) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <BrowserRouter>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: '#111827',
            color: '#f1f5f9',
            border: '1px solid rgba(255,255,255,.1)',
            borderRadius: '8px',
            fontSize: '13px',
            boxShadow: '0 8px 24px rgba(0,0,0,.5)',
          },
          success: { iconTheme: { primary: '#22c55e', secondary: '#111827' } },
          error:   { iconTheme: { primary: '#EF233C', secondary: '#111827' } },
        }}
      />
      <Routes>
        <Route path="/login" element={<PublicRoute><LoginPage /></PublicRoute>} />
        <Route path="/system-settings" element={<SystemSettingsPage />} />
        <Route path="/" element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="drawings" element={
            <Suspense fallback={<div className="flex h-full items-center justify-center text-slate-400 text-sm">Loading drawings…</div>}>
              <DrawingsPage />
            </Suspense>
          } />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
