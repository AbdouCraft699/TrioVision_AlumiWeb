// ═══════════════════════════════════════════════════════════════════════════
// Thin client for automation-api.
//
// Every request carries the signed-in user's JWT. There is deliberately no
// anon-key fallback: if there is no session, there is no request.
// ═══════════════════════════════════════════════════════════════════════════

export const SUPABASE_URL = 'https://jcosfmoulzsfqibksnro.supabase.co'
export const SUPABASE_ANON_KEY = 'sb_publishable_g7paPP8KKvqGFxtu31NcKQ_k7GXcPji'

const API_BASE = `${SUPABASE_URL}/functions/v1/automation-api`

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** Supabase client, created once. Requires the UMD script from the CDN. */
let client = null
export function sb() {
  if (!client) {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      throw new Error('supabase-js failed to load from the CDN')
    }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  }
  return client
}

/** Non-null session or a redirect to the login page. */
export async function requireSession() {
  const { data, error } = await sb().auth.getSession()
  if (error) throw error
  if (!data || !data.session) {
    location.replace('admin.html')
    // never resolves; the redirect is the outcome
    return new Promise(() => {})
  }
  return data.session
}

async function token() {
  const { data } = await sb().auth.getSession()
  // refresh if it is about to expire
  const session = data && data.session
  if (!session) {
    location.replace('admin.html')
    throw new ApiError(401, 'unauthenticated', 'signed out')
  }
  return session.access_token
}

export async function api(path, options = {}) {
  const method = options.method || 'GET'
  const accessToken = await token()
  const headers = { Authorization: `Bearer ${accessToken}` }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  let response
  try {
    response = await fetch(API_BASE + path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch (networkError) {
    throw new ApiError(0, 'unreachable', 'Cannot reach automation-api. Is the function deployed?')
  }

  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
  }

  if (!response.ok) {
    const err = (payload && payload.error) || {}
    throw new ApiError(response.status, err.code || 'http_error', err.message || `HTTP ${response.status}`)
  }
  return payload
}

export const Api = {
  health: () => api('/health'),
  catalog: () => api('/catalog'),
  listWorkflows: () => api('/workflows'),
  getWorkflow: (id) => api(`/workflows/${id}`),
  createWorkflow: (body) => api('/workflows', { method: 'POST', body }),
  updateWorkflow: (id, body) => api(`/workflows/${id}`, { method: 'PUT', body }),
  deleteWorkflow: (id) => api(`/workflows/${id}`, { method: 'DELETE' }),
  enable: (id) => api(`/workflows/${id}/enable`, { method: 'POST' }),
  disable: (id) => api(`/workflows/${id}/disable`, { method: 'POST' }),
  plan: (id) => api(`/workflows/${id}/plan`),
  run: (id, payload) => api(`/workflows/${id}/run`, { method: 'POST', body: { payload: payload || {} } }),
  webhookToken: (id) => api(`/workflows/${id}/webhook-token`, { method: 'POST' }),
  listRuns: (workflowId) => api(`/runs?limit=25${workflowId ? `&workflow_id=${workflowId}` : ''}`),
  getRun: (id) => api(`/runs/${id}`),
  retry: (id) => api(`/runs/${id}/retry`, { method: 'POST' }),
}
