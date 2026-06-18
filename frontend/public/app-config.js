// Client deployment settings — edit this file after build (no rebuild required).
// Copy is included in dist/ when you run: npm run build
window.__APP_CONFIG__ = {
  // API base URL (must end with /api)
  // Option A — same IIS site, proxy via web.config:
  apiBaseUrl: '/api',
  // Option B — direct backend URL (also update CORS on the API if needed):
  // apiBaseUrl: 'http://localhost:5000/api',
}
