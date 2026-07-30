import api from './api'

export const licenseService = {
  async getStatus() {
    const response = await api.get('/license/status')
    return response.data.data
  },

  async validateStartup() {
    const response = await api.get('/license/startup')
    return response.data.data
  },

  async saveConfiguration(configuration) {
    const response = await api.post('/license/configuration', configuration)
    return response.data.data
  },

  async validateSession() {
    const response = await api.get('/license/session')
    return response.data.data
  },
}
