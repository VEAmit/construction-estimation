import api from './api'

export const projectService = {
  async getAll() {
    const res = await api.get('/projects')
    return res.data.data
  },
  async create(data) {
    const res = await api.post('/projects', {
      name: data.name ?? '',
      projectNumber: data.projectNumber ?? '',
      description: data.description ?? '',
      clientName: data.clientName ?? '',
      location: data.location ?? '',
    })
    return res.data.data
  },
  async update(id, data) {
    const res = await api.put(`/projects/${id}`, {
      name: data.name ?? '',
      projectNumber: data.projectNumber ?? '',
      description: data.description ?? '',
      clientName: data.clientName ?? '',
      location: data.location ?? '',
      status: data.status ?? 'Active',
    })
    return res.data.data
  },
  async delete(id) {
    await api.post(`/projects/${id}/delete`)
  },
}
