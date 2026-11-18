const $ = (id) => document.getElementById(id)

const TEXT = {
  idle: ['ok', 'Ready - waiting for Viku prompts'],
  working: ['ok', 'Making a picture…'],
  signin: ['warn', 'Sign in to Google in the AI Studio tab'],
  paused: ['warn', 'Paused for a few minutes (AI Studio limit)'],
  off: ['', 'Turned off'],
  'no-viku': ['warn', 'Open Viku on this computer']
}

async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: 'status' })
  const s = r?.status || {}
  $('enabled').checked = r?.enabled !== false
  $('viku').className = `row ${s.viku && s.state !== 'no-viku' ? 'ok' : 'warn'}`
  $('vikuText').textContent = s.viku && s.state !== 'no-viku' ? `Connected to Viku${s.waiting ? ` · ${s.waiting} waiting` : ''}` : 'Viku is not open'
  const [tone, text] = TEXT[s.state] || TEXT.idle
  $('work').className = `row ${tone}`
  $('workText').textContent = s.note && s.state !== 'idle' ? `${text}: ${s.note}` : text
  $('done').textContent = r?.done ? `${r.done} made so far` : ''
}

$('enabled').addEventListener('change', async (e) => {
  await chrome.runtime.sendMessage({ type: 'enable', on: e.target.checked })
  void refresh()
})
$('show').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'show-tab' })
  window.close()
})
void refresh()
setInterval(() => void refresh(), 3000)
