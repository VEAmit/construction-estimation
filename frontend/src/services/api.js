import axios from 'axios'
import { useAppStore } from '../store/useAppStore'

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  const token = useAppStore.getState().token
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  (error) => {
    const url = error.config?.url ?? ''
    const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/register')
    const isLicenseConfigurationEndpoint =
      url.includes('/license/status') ||
      url.includes('/license/configuration')
    const responseData = error.response?.data
    const isLicenseError =
      responseData?.requiresLogout === true ||
      String(responseData?.code ?? '').startsWith('LICENSE_')

    if (isLicenseError && !isAuthEndpoint && !isLicenseConfigurationEndpoint) {
      const message = responseData?.message ?? 'Your license is no longer valid.'
      sessionStorage.setItem('buildtakeoff-license-message', message)
      useAppStore.getState().clearAuth()
      if (window.location.pathname !== '/system-settings') {
        window.location.replace('/system-settings')
      }
    } else if (error.response?.status === 401 && !isAuthEndpoint) {
      useAppStore.getState().clearAuth()
      if (window.location.pathname !== '/login') window.location.replace('/login')
    }
    return Promise.reject(error)
  }
)

export default api
