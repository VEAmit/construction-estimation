import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { licenseService } from '../services/licenseService'
import { useAppStore } from '../store/useAppStore'
import { APP_VERSION } from '../version'
import './SystemSettingsPage.css'

const emptyForm = {
  licenseKey: '',
  apiBaseUrl: '',
  validationEndpoint: 'api/license/validate',
  apiKey: '',
  applicationIdentifier: 'BuildTakeoffPro',
  machineIdentifier: '',
  customerName: '',
  companyName: '',
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
  const token = useAppStore(state => state.token)
  const [form, setForm] = useState(emptyForm)
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [showLicense, setShowLicense] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)

  useEffect(() => {
    let active = true
    licenseService.getStatus()
      .then(data => {
        if (!active) return
        setStatus(data)
        setForm(current => ({
          ...current,
          apiBaseUrl: data.apiBaseUrl ?? '',
          validationEndpoint: data.validationEndpoint || current.validationEndpoint,
          applicationIdentifier: data.applicationIdentifier || current.applicationIdentifier,
          machineIdentifier: data.machineIdentifier ?? '',
          customerName: data.customerName ?? '',
          companyName: data.companyName ?? '',
        }))
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

  const update = field => event => {
    setForm(current => ({ ...current, [field]: event.target.value }))
  }

  const handleSubmit = async event => {
    event.preventDefault()
    setSaving(true)
    try {
      await licenseService.saveConfiguration({
        licenseKey: form.licenseKey.trim() || null,
        apiBaseUrl: form.apiBaseUrl.trim(),
        validationEndpoint: form.validationEndpoint.trim(),
        apiKey: form.apiKey.trim() || null,
        applicationIdentifier: form.applicationIdentifier.trim(),
        machineIdentifier: form.machineIdentifier.trim() || null,
        customerName: form.customerName.trim() || null,
        companyName: form.companyName.trim() || null,
      })
      toast.success('License validated and settings saved.')
      navigate(token ? '/dashboard' : '/login', { replace: true })
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
            Configure the license provider once. The application securely loads and
            validates these settings automatically on every startup and login.
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
              <p>Enter the administrator-provided license server details.</p>
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
                  ? `Stored securely as ${status.maskedLicenseKey}. Leave blank to keep it.`
                  : 'Required. The value is encrypted before it is saved.'}
              >
                <div className="settings-secret-wrap">
                  <input
                    className="settings-input"
                    type={showLicense ? 'text' : 'password'}
                    value={form.licenseKey}
                    onChange={update('licenseKey')}
                    required={!status?.isConfigured}
                    autoComplete="off"
                    placeholder={status?.isConfigured ? 'Keep existing license key' : 'Enter license key'}
                  />
                  <button type="button" onClick={() => setShowLicense(value => !value)}>
                    {showLicense ? 'Hide' : 'Show'}
                  </button>
                </div>
              </Field>

              <Field label="API Base URL" hint="Example: https://license.company.com/">
                <input
                  className="settings-input"
                  type="url"
                  value={form.apiBaseUrl}
                  onChange={update('apiBaseUrl')}
                  required
                  placeholder="https://license.company.com/"
                />
              </Field>

              <div className="settings-row">
                <Field label="Validation Endpoint">
                  <input
                    className="settings-input"
                    value={form.validationEndpoint}
                    onChange={update('validationEndpoint')}
                    required
                    placeholder="api/license/validate"
                  />
                </Field>
                <Field label="Application Identifier">
                  <input
                    className="settings-input"
                    value={form.applicationIdentifier}
                    onChange={update('applicationIdentifier')}
                    required
                    placeholder="BuildTakeoffPro"
                  />
                </Field>
              </div>

              <Field
                label="API Key (optional)"
                hint={status?.hasApiKey
                  ? 'An API key is already stored. Leave blank to keep it.'
                  : 'Only required when your license provider uses an API key.'}
              >
                <div className="settings-secret-wrap">
                  <input
                    className="settings-input"
                    type={showApiKey ? 'text' : 'password'}
                    value={form.apiKey}
                    onChange={update('apiKey')}
                    autoComplete="off"
                    placeholder={status?.hasApiKey ? 'Keep existing API key' : 'Enter API key if required'}
                  />
                  <button type="button" onClick={() => setShowApiKey(value => !value)}>
                    {showApiKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </Field>

              <button
                className="settings-advanced-toggle"
                type="button"
                onClick={() => setAdvancedOpen(value => !value)}
                aria-expanded={advancedOpen}
              >
                <span>Company & machine details</span>
                <span>{advancedOpen ? '−' : '+'}</span>
              </button>

              {advancedOpen && (
                <div className="settings-advanced">
                  <Field label="Machine Identifier" hint="Leave blank to use this machine's secure generated identifier.">
                    <input
                      className="settings-input"
                      value={form.machineIdentifier}
                      onChange={update('machineIdentifier')}
                      placeholder="Automatically generated"
                    />
                  </Field>
                  <div className="settings-row">
                    <Field label="Customer Name">
                      <input
                        className="settings-input"
                        value={form.customerName}
                        onChange={update('customerName')}
                        placeholder="Customer name"
                      />
                    </Field>
                    <Field label="Company Name">
                      <input
                        className="settings-input"
                        value={form.companyName}
                        onChange={update('companyName')}
                        placeholder="Company name"
                      />
                    </Field>
                  </div>
                </div>
              )}

              <div className="settings-security-note">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="10" rx="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                License and API keys are encrypted and are never returned by the API or written to logs.
              </div>

              <button className="settings-apply" type="submit" disabled={saving}>
                {saving ? <span className="settings-spinner" /> : null}
                {saving ? 'Validating…' : 'Validate & Apply Settings'}
              </button>
              <button
                className="settings-cancel"
                type="button"
                onClick={() => navigate(token ? '/dashboard' : '/login')}
                disabled={saving}
              >
                Cancel
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
  )
}
