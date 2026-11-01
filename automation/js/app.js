// ═══════════════════════════════════════════════════════════════════════════
// Automation dashboard logic.
//
// Phase 2 scope: list workflows, edit the definition as JSON (validated
// server-side before it is stored), see a plain-language plan, run it, read
// the execution history step by step, retry a failure, toggle enable/disable.
// A visual node editor is phase 3; the JSON view is deliberately honest about
// what exists rather than pretending to be one.
// ═══════════════════════════════════════════════════════════════════════════

import { Api, ApiError, requireSession } from './api.js'

const state = {
  health: null,
  workflows: [],
  selectedId: null,
  detail: null,
  plan: null,
  runs: [],
  runDetail: null,
  tab: 'definition',
  notice: null,
  error: null,
  unreachable: false,
  forbidden: false,
}

const $ = (id) => document.getElementById(id)
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function ago(iso) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function toast(message, kind = 'ok') {
  state.notice = { message, kind }
  renderNotice()
  setTimeout(() => {
    if (state.notice && state.notice.message === message) {
      state.notice = null
      renderNotice()
    }
  }, 6000)
}

function setError(error) {
  if (error instanceof ApiError) {
    if (error.code === 'unreachable') state.unreachable = true
    if (error.status === 403) state.forbidden = true
    state.error = `${error.message}${error.code ? ` (${error.code})` : ''}`
  } else {
    state.error = String(error && error.message ? error.message : error)
  }
  renderNotice()
}

function renderNotice() {
  const box = $('notice')
  if (!box) return
  if (state.unreachable) {
    box.className = 'notice bad'
    box.innerHTML =
      '<strong>automation-api is not reachable.</strong> The function is probably not deployed yet. ' +
      'Nothing here can work until <code>supabase functions deploy automation-api</code> has run.'
    box.hidden = false
    return
  }
  if (state.forbidden) {
    box.className = 'notice bad'
    box.innerHTML =
      '<strong>This account is not authorised.</strong> Your user is not in <code>admin_users</code>. ' +
      'Add it in the SQL editor, then reload.'
    box.hidden = false
    return
  }
  if (state.error) {
    box.className = 'notice bad'
    box.innerHTML = `<strong>Error.</strong> ${esc(state.error)} <button class="link" id="dismissError">dismiss</button>`
    box.hidden = false
    const btn = $('dismissError')
    if (btn) btn.onclick = () => { state.error = null; renderNotice() }
    return
  }
  if (state.notice) {
    box.className = `notice ${state.notice.kind === 'bad' ? 'bad' : 'ok'}`
    box.textContent = state.notice.message
    box.hidden = false
    return
  }
  box.hidden = true
}

// ── data ───────────────────────────────────────────────────────────────────
async function refreshWorkflows() {
  const data = await Api.listWorkflows()
  state.workflows = data.workflows || []
  if (state.selectedId && !state.workflows.some((w) => w.id === state.selectedId)) state.selectedId = null
  if (!state.selectedId && state.workflows.length) state.selectedId = state.workflows[0].id
}

async function selectWorkflow(id) {
  state.selectedId = id
  state.runDetail = null
  state.plan = null
  state.detail = null
  renderList()
  renderMain()
  if (!id) return
  try {
    const [detail, plan, runs] = await Promise.all([
      Api.getWorkflow(id),
      Api.plan(id).catch(() => null),
      Api.listRuns(id),
    ])
    state.detail = detail.workflow
    state.plan = plan ? { lines: plan.plan, warnings: plan.warnings } : null
    state.runs = runs.runs || []
  } catch (error) {
    setError(error)
  }
  renderMain()
}

// ── rendering ──────────────────────────────────────────────────────────────
function renderHealth() {
  const box = $('health')
  if (!box) return
  const h = state.health
  if (!h) {
    box.innerHTML = '<span class="chip off">AI: unknown</span><span class="chip off">service: unknown</span>'
    return
  }
  const ai = h.ai && h.ai.provider && h.ai.provider !== 'none' ? h.ai.provider : null
  const chips = [
    ai
      ? `<span class="chip ok">AI: ${esc(ai)}</span>`
      : '<span class="chip off" title="Configured in settings -> automation.ai (phase 4)">AI: not configured</span>',
    h.secrets && h.secrets.discord
      ? '<span class="chip ok">Discord: ready</span>'
      : '<span class="chip off">Discord: no secret</span>',
    h.secrets && h.secrets.email
      ? '<span class="chip ok">Email: ready</span>'
      : '<span class="chip off">Email: no secret</span>',
    `<span class="chip">${h.workflows ?? 0} workflow(s)</span>`,
  ]
  box.innerHTML = chips.join('')
}

function renderList() {
  const box = $('workflowList')
  if (!box) return
  if (!state.workflows.length) {
    box.innerHTML = '<p class="empty">No workflows yet.</p>'
    return
  }
  box.innerHTML = state.workflows
    .map(
      (w) => `
      <button class="wf ${w.id === state.selectedId ? 'active' : ''}" data-id="${esc(w.id)}">
        <span class="wf-name">${esc(w.name)}</span>
        <span class="wf-meta">
          <span class="chip ${w.enabled ? 'ok' : 'off'}">${w.enabled ? 'enabled' : 'draft'}</span>
          <span class="subtle">v${esc(w.version)} · ${ago(w.updated_at)}</span>
        </span>
      </button>`,
    )
    .join('')
  box.querySelectorAll('.wf').forEach((btn) => {
    btn.addEventListener('click', () => selectWorkflow(btn.dataset.id))
  })
}

function runStatusChip(status) {
  const map = { succeeded: 'ok', failed: 'bad', timeout: 'warn', cancelled: 'off', running: 'warn', rejected: 'bad', duplicate: 'off' }
  return `<span class="chip ${map[status] || ''}">${esc(status)}</span>`
}

function renderMain() {
  const box = $('main')
  if (!box) return
  const w = state.detail
  if (!w) {
    box.innerHTML = state.workflows.length
      ? '<p class="empty">Select a workflow.</p>'
      : '<div class="empty-state"><h2>No workflows yet</h2><p>Create one to get started. A new workflow is always a draft — nothing runs until you enable it.</p></div>'
    return
  }

  const tabs = ['definition', 'plan', 'runs']
  const tabBar = tabs
    .map((t) => `<button class="tab ${state.tab === t ? 'active' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`)
    .join('')

  let body = ''
  if (state.tab === 'definition') {
    body = `
      <label class="field">
        <span>Name</span>
        <input id="wfName" value="${esc(w.name)}" maxlength="120">
      </label>
      <label class="field">
        <span>Description</span>
        <input id="wfDesc" value="${esc(w.description || '')}" maxlength="2000">
      </label>
      <label class="field">
        <span>Definition (JSON) — validated on save; a rejected save changes nothing</span>
        <textarea id="wfJson" spellcheck="false" rows="22">${esc(JSON.stringify(w.definition, null, 2))}</textarea>
      </label>
      <div class="row">
        <button class="btn primary" id="saveBtn">Save &amp; validate</button>
        <button class="btn" id="planBtn">Explain</button>
        <span class="subtle" id="dirtyHint"></span>
      </div>`
  } else if (state.tab === 'plan') {
    body = state.plan
      ? `<pre class="plan">${esc(state.plan.lines.join('\n'))}</pre>
         ${
           state.plan.warnings && state.plan.warnings.length
             ? `<div class="warn"><strong>Warnings</strong><ul>${state.plan.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
             : ''
         }`
      : '<p class="empty">This workflow has not been saved in a valid state yet.</p>'
  } else {
    const rows = state.runs.length
      ? state.runs
          .map(
            (r) => `
        <tr class="run-row" data-run="${esc(r.id)}">
          <td>${runStatusChip(r.status)}</td>
          <td>${esc(r.trigger_type)}</td>
          <td>${esc(ago(r.started_at))}</td>
          <td>${r.duration_ms != null ? `${r.duration_ms} ms` : '—'}</td>
          <td class="ellipsis">${esc(r.error || '')}</td>
        </tr>`,
          )
          .join('')
      : '<tr><td colspan="5" class="empty">No runs yet.</td></tr>'

    body = `
      <div class="row">
        <button class="btn primary" id="runBtn">Run now</button>
        <button class="btn" id="refreshRuns">Refresh</button>
        <span class="subtle">Manual runs are recorded like any other run.</span>
      </div>
      <table class="runs">
        <thead><tr><th>Status</th><th>Trigger</th><th>Started</th><th>Duration</th><th>Error</th></tr></thead>
        <tbody id="runsBody">${rows}</tbody>
      </table>
      <div id="runDetail"></div>`
  }

  box.innerHTML = `
    <header class="main-head">
      <div>
        <h1>${esc(w.name)}</h1>
        <p class="subtle">v${esc(w.version)} · ${w.enabled ? 'enabled' : 'disabled'} · updated ${ago(w.updated_at)}</p>
      </div>
      <div class="row">
        <button class="btn" id="toggleBtn">${w.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn" id="webhookBtn">Webhook token</button>
        <button class="btn danger" id="deleteBtn">Delete</button>
      </div>
    </header>
    <nav class="tabs">${tabBar}</nav>
    <section class="tab-body">${body}</section>`

  box.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab
      renderMain()
    })
  })

  const toggle = $('toggleBtn')
  if (toggle)
    toggle.onclick = async () => {
      try {
        await (w.enabled ? Api.disable(w.id) : Api.enable(w.id))
        toast(w.enabled ? 'Disabled' : 'Enabled')
        await selectWorkflow(w.id)
        await refreshWorkflows()
        renderList()
      } catch (error) {
        setError(error)
      }
    }

  const webhook = $('webhookBtn')
  if (webhook)
    webhook.onclick = async () => {
      if (!confirm('Generate a new webhook token? Any existing token stops working immediately.')) return
      try {
        const data = await Api.webhookToken(w.id)
        state.notice = {
          message: `Webhook: POST ${data.url}  header ${data.header}: ${data.token} — copy it now, it is stored hashed.`,
          kind: 'ok',
        }
        renderNotice()
      } catch (error) {
        setError(error)
      }
    }

  const del = $('deleteBtn')
  if (del)
    del.onclick = async () => {
      if (!confirm(`Delete "${w.name}" and all of its run history? This cannot be undone.`)) return
      try {
        await Api.deleteWorkflow(w.id)
        state.selectedId = null
        state.detail = null
        await refreshWorkflows()
        renderList()
        renderMain()
        toast('Workflow deleted')
      } catch (error) {
        setError(error)
      }
    }

  const save = $('saveBtn')
  if (save)
    save.onclick = async () => {
      let definition
      try {
        definition = JSON.parse($('wfJson').value)
      } catch (e) {
        state.error = `That is not valid JSON: ${e.message}`
        renderNotice()
        return
      }
      try {
        const result = await Api.updateWorkflow(w.id, {
          name: $('wfName').value,
          description: $('wfDesc').value,
          definition,
        })
        toast(
          `Saved as v${result.workflow.version}` +
            (result.warnings && result.warnings.length ? ` · ${result.warnings.length} warning(s)` : ''),
        )
        await refreshWorkflows()
        renderList()
        await selectWorkflow(w.id)
      } catch (error) {
        setError(error)
      }
    }

  const planBtn = $('planBtn')
  if (planBtn)
    planBtn.onclick = () => {
      state.tab = 'plan'
      renderMain()
    }

  const run = $('runBtn')
  if (run)
    run.onclick = async () => {
      run.disabled = true
      run.textContent = 'Running…'
      try {
        const result = await Api.run(w.id, {})
        toast(`Run ${result.status}${result.error ? `: ${result.error}` : ''}`, result.status === 'succeeded' ? 'ok' : 'bad')
        const runs = await Api.listRuns(w.id)
        state.runs = runs.runs || []
        renderMain()
        if (result.runId) await showRun(result.runId)
      } catch (error) {
        setError(error)
        renderMain()
      }
    }

  const refresh = $('refreshRuns')
  if (refresh)
    refresh.onclick = async () => {
      const runs = await Api.listRuns(w.id)
      state.runs = runs.runs || []
      renderMain()
    }

  box.querySelectorAll('.run-row').forEach((row) => {
    row.addEventListener('click', () => showRun(row.dataset.run))
  })
}

async function showRun(runId) {
  try {
    const data = await Api.getRun(runId)
    state.runDetail = data
    const box = $('runDetail')
    if (!box) return
    const steps = (data.steps || [])
      .map(
        (s) => `
      <tr>
        <td>${esc(s.node_id)}<br><span class="subtle">${esc(s.node_type)}</span></td>
        <td>${runStatusChip(s.status)}${s.attempt > 1 ? ` <span class="subtle">attempt ${s.attempt}</span>` : ''}</td>
        <td>${s.duration_ms != null ? `${s.duration_ms} ms` : '—'}</td>
        <td class="ellipsis">${esc(s.error || '')}</td>
      </tr>`,
      )
      .join('')
    box.innerHTML = `
      <div class="row">
        <h3>Run ${esc(data.run.id.slice(0, 8))}</h3>
        ${runStatusChip(data.run.status)}
        <button class="btn" id="retryBtn">Retry</button>
      </div>
      <p class="subtle">${esc(data.run.error || 'no error')}</p>
      <table class="runs">
        <thead><tr><th>Node</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
        <tbody>${steps || '<tr><td colspan="4" class="empty">No steps recorded.</td></tr>'}</tbody>
      </table>`
    const retry = $('retryBtn')
    if (retry)
      retry.onclick = async () => {
        try {
          const result = await Api.retry(runId)
          toast(`Retry ${result.status}`)
          const runs = await Api.listRuns(state.selectedId)
          state.runs = runs.runs || []
          renderMain()
        } catch (error) {
          setError(error)
        }
      }
  } catch (error) {
    setError(error)
  }
}

// ── actions ────────────────────────────────────────────────────────────────
async function createWorkflow() {
  const name = prompt('Name for the new workflow?')
  if (!name) return
  try {
    const definition = {
      nodes: [
        { id: 'start', type: 'manual_trigger', params: {} },
        { id: 'done', type: 'output', params: { value: 'finished' } },
      ],
      edges: [{ from: 'start', to: 'done' }],
    }
    const created = await Api.createWorkflow({ name, definition })
    await refreshWorkflows()
    renderList()
    await selectWorkflow(created.workflow.id)
    toast('Draft created — nothing runs until you enable it')
  } catch (error) {
    setError(error)
  }
}

// ── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await requireSession()
  } catch (error) {
    setError(error)
    return
  }

  try {
    state.health = await Api.health()
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) state.forbidden = true
    if (error instanceof ApiError && error.code === 'unreachable') state.unreachable = true
    if (!state.forbidden && !state.unreachable) setError(error)
  }
  renderHealth()

  if (!state.unreachable && !state.forbidden) {
    try {
      await refreshWorkflows()
      renderList()
      if (state.selectedId) await selectWorkflow(state.selectedId)
      else renderMain()
    } catch (error) {
      setError(error)
    }
  } else {
    renderNotice()
  }

  const create = $('createBtn')
  if (create) create.onclick = createWorkflow
  const refresh = $('refreshBtn')
  if (refresh)
    refresh.onclick = async () => {
      try {
        state.health = await Api.health()
        renderHealth()
        await refreshWorkflows()
        renderList()
        await selectWorkflow(state.selectedId)
      } catch (error) {
        setError(error)
      }
    }
}

boot()
