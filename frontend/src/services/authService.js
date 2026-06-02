import api from './api'

export const authService = {
  async login(email, password) {
    const res = await api.post('/auth/login', { email, password })
    return res.data.data
  },
  async register(firstName, lastName, email, password) {
    const res = await api.post('/auth/register', { firstName, lastName, email, password })
    return res.data.data
  },
}
