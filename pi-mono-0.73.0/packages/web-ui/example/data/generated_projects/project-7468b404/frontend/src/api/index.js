import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// Records API
export const getRecords = (params = {}) => {
  return api.get('/records', { params })
}

export const createRecord = (data) => {
  return api.post('/records', data)
}

export const updateRecord = (id, data) => {
  return api.put(`/records/${id}`, data)
}

export const deleteRecord = (id) => {
  return api.delete(`/records/${id}`)
}

// Categories API
export const getCategories = (params = {}) => {
  return api.get('/categories', { params })
}

export const createCategory = (data) => {
  return api.post('/categories', data)
}

export const deleteCategory = (id) => {
  return api.delete(`/categories/${id}`)
}

// Payment Methods API
export const getPaymentMethods = () => {
  return api.get('/payment-methods')
}

export const createPaymentMethod = (data) => {
  return api.post('/payment-methods', data)
}

export const deletePaymentMethod = (id) => {
  return api.delete(`/payment-methods/${id}`)
}

// Statistics API
export const getStatistics = (params = {}) => {
  return api.get('/statistics', { params })
}