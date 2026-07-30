import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { licenseService } from '../services/licenseService'
import { APP_VERSION } from '../version'
import './SystemSettingsPage.css'

const emptyForm = {
  licenseKey: '',
}

function Field({ label, hint, children }) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      {children}
      {hint && <span className="settings-field-hint">{hint}</span>}
    </label>
  )
}

export default function SystemSettingsPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState(emptyForm)
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showLicense, setShowLicense] = useState(false)
  const [replacingLicenseKey, setReplacingLicenseKey] = useState(false)

  useEffect(() => {
    let active = true
    licenseService.getStatus()
      .then(data => {
        if (!active) return
        setStatus(data)
        setForm({
          licenseKey: data?.isConfigured ? (data.maskedLicenseKey ?? '') : '',
        })
        setReplacingLicenseKey(false)
        setShowLicense(false)
      })
      .catch(() => {
        if (active) toast.error('Unable to load license settings. Please check that the API is running.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => { active = false }
  }, [])

  const configuredStatus = useMemo(() => {
    if (!status?.isConfigured) return { label: 'Setup required', className: 'settings-status missing' }
    if (String(status.status).toLowerCase() === 'valid') {
      return { label: 'License valid', className: 'settings-status valid' }
    }
    return { label: status.status || 'Configured', className: 'settings-status configured' }
  }, [status])
  const licenseIsValid = String(status?.status).toLowerCase() === 'valid'

  const update = field => event => {
    setForm(current => ({ ...current, [field]: event.target.value }))
  }

  const handleSubmit = async event => {
    event.preventDefault()
    setSaving(true)
    try {
      await licenseService.saveConfiguration({
        licenseKey: replacingLicenseKey
          ? (form.licenseKey.trim() || null)
          : null,
      })
      toast.success('License validated and settings saved.')
      window.location.replace('/login')
    } catch (error) {
      toast.error(
        error?.response?.data?.message ??
        'Unable to save license settings. Please verify the values and try again.',
        { duration: 6000 },
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="settings-page">
      <section className="settings-story">
        <div className="settings-grid" />
        <div className="settings-glow settings-glow-top" />
        <div className="settings-glow settings-glow-bottom" />

        <div className="settings-brand">
          <span className="settings-logo"><img src="/small-logo.png" alt="" /></span>
          <span>
            <strong>BuildTakeoff <em>Pro</em></strong>
            <small>Configuration Portal</small>
          </span>
        </div>

        <div className="settings-story-copy">
          <span className="settings-eyebrow">Administrator setup</span>
          <h1>System<br/><b>Settings</b></h1>
          <p>
            Enter the administrator-provided license once. The application securely
            loads and validates it automatically on every startup and login.
          </p>
          <ul>
            <li>Secure encrypted license storage</li>
            <li>Automatic login-time validation</li>
            <li>Central protection for every authenticated request</li>
            <li>Friendly expiry and connection notifications</li>
          </ul>
        </div>

        <div className="settings-version">BuildTakeoff Pro · v{APP_VERSION}</div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-inner">
          <header className="settings-panel-header">
            <div>
              <span className="settings-panel-kicker">System configuration</span>
              <h2>Configure License</h2>
              <p>Enter the administrator-provided license key.</p>
            </div>
            {!loading && <span className={configuredStatus.className}>{configuredStatus.label}</span>}
          </header>

          {loading ? (
            <div className="settings-loading">
              <span className="settings-spinner" />
              Loading configuration…
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="settings-form">
              <Field
                label="License Key"
                hint={status?.isConfigured
                  ? `Stored securely as ${status.maskedLicenseKey ?? 'an encrypted value'}. Click Change to replace it.`
                  : 'Required. The value is encrypted before it is saved.'}
              >
                <div className="settings-secret-wrap">
                  <input
                    className="settings-input"
                    type={status?.isConfigured && !replacingLicenseKey
                      ? 'text'
                      : (showLicense ? 'text' : 'password')}
                    value={form.licenseKey}
                    onChange={update('licenseKey')}
                    readOnly={Boolean(status?.isConfigured && !replacingLicenseKey)}
                    required={!status?.isConfigured}
                    autoComplete="off"
                    placeholder={status?.isConfigured
                      ? 'Stored license key'
                      : 'Enter license key'}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (status?.isConfigured && !replacingLicenseKey) {
                        setForm({ licenseKey: '' })
                        setReplacingLicenseKey(true)
                        setShowLicense(false)
                        return
                      }
                      setShowLicense(value => !value)
                    }}
                  >
                    {status?.isConfigured && !replacingLicenseKey
                      ? 'Change'
                      : (showLicense ? 'Hide' : 'Show')}
                  </button>
                </div>
              </Field>

              <div className="settings-security-note">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="10" rx="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                The license key is encrypted. API connection details are loaded from
                secure server configuration and are never exposed here.
              </div>

              <button className="settings-apply" type="submit" disabled={saving}>
                {saving ? <span className="settings-spinner" /> : null}
                {saving ? 'Validating…' : 'Validate & Apply Settings'}
              </button>
              {licenseIsValid && (
                <button
                  className="settings-cancel"
                  type="button"
                  onClick={() => navigate('/login')}
                  disabled={saving}
                >
                  Cancel
                </button>
              )}
            </form>
          )}
        </div>
      </section>
    </main>
  )
}
