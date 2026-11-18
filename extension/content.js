// Viku extension - content script on aistudio.google.com.
//
// Only the "Viku tab" (opened by this extension) does anything: it asks Viku for the next waiting prompt, types it
// into AI Studio's prompt box, presses Run, waits for the picture, and hands the picture back to Viku. One prompt per
// fresh chat, one at a time. Any other AI Studio tab the user has open is left completely alone.
;(() => {
  if (window.top !== window || window.__vikuLoaded) return
  window.__vikuLoaded = true

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let timer = 0
  // after the extension is reloaded or updated, a copy of this script left in an open tab loses its link to it:
  // stop quietly instead of throwing "Extension context invalidated" every few seconds
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id)
    } catch {
      return false
    }
  }
  const send = async (msg) => {
    if (!alive()) {
      clearInterval(timer)
      return { error: 'extension reloaded' }
    }
    try {
      return await chrome.runtime.sendMessage(msg)
    } catch (e) {
      if (!alive()) clearInterval(timer)
      return { error: String(e) }
    }
  }
  let busy = false
  let model = 'gemini-3.1-flash-image'

  const freshUrl = () => `https://aistudio.google.com/prompts/new_chat?model=${encodeURIComponent(model)}`
  const promptBox = () =>
    document.querySelector('textarea[aria-label="Enter a prompt"]') ||
    document.querySelector('textarea[placeholder*="prompt" i]') ||
    document.querySelector('ms-prompt-box textarea, ms-chunk-input textarea')
  const bigImages = () => [...document.querySelectorAll('img')].filter((i) => /^(blob|data):/.test(i.src) && i.naturalWidth >= 512 && i.naturalHeight >= 512)
  // real error messages only: AI Studio also shows adverts like "...more quota, frontier models and more", which
  // must not stop the queue
  const ERR =
    /(no image generated[^\n]*|permission denied[^\n]*|failed to generate[^\n]*|(exceeded|reached|out of)[^\n]{0,40}quota[^\n]*|quota (exceeded|reached)[^\n]*|rate limit (exceeded|reached)[^\n]*|resource (has been )?exhausted[^\n]*|too many requests[^\n]*|internal error[^\n]*|try again later[^\n]*|blocked[^\n]*safety[^\n]*|violat[^\n]*polic[^\n]*)/gi
  const errors = () => (document.body?.innerText.match(ERR) || []).map((s) => s.trim()).filter((s) => !/upgrade|frontier models|get more/i.test(s))
  // a clean chat: nothing has been asked in it yet (each prompt gets its own chat, so a retry never piles up in an old one)
  const isFresh = () => location.pathname === '/prompts/new_chat' && document.querySelectorAll('ms-chat-turn').length === 0 && bigImages().length === 0 && errors().length === 0

  /** Run settings -> Output format -> "Images only", so the image model draws instead of answering in words.
   *  AI Studio resets it for every new chat. */
  async function imagesOnly() {
    for (let i = 0; i < 10; i++) {
      const b = [...document.querySelectorAll('button[role="radio"], [role="radio"]')].find((e) => /images only/i.test(e.textContent || ''))
      if (b) {
        if (b.getAttribute('aria-checked') !== 'true') b.click()
        await sleep(300)
        return b.getAttribute('aria-checked') === 'true'
      }
      await sleep(400)
    }
    return false // run settings panel closed or renamed: the prompt itself also asks for a picture
  }

  function runButton() {
    const btns = [...document.querySelectorAll('button')]
    return btns.find((b) => b.classList.contains('ctrl-enter-submits')) || btns.find((b) => /^\s*Run\b/.test(b.textContent || '') && !/rerun/i.test(b.getAttribute('aria-label') || ''))
  }

  // AI Studio shows "1,619 tokens" with a hover card estimating what the same request would cost through the PAID
  // API ("Usage on AI Studio is free when no API key is selected"). In the Viku tab that only confuses people, so the
  // counter is hidden there. Other AI Studio tabs are left as they are.
  let tokenObserver = null
  function hideTokenCounter() {
    if (tokenObserver) return
    const hide = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (/^\s*[\d,.]+\s*tokens?\s*$/i.test(n.nodeValue || '')) {
          const el = n.parentElement?.closest('button, [role="button"], span, div')
          if (el && el.style.display !== 'none' && el.textContent.trim().length < 24) el.style.display = 'none'
        }
      }
    }
    hide()
    let pending = 0
    tokenObserver = new MutationObserver(() => {
      if (!pending) pending = setTimeout(() => ((pending = 0), hide()), 400)
    })
    tokenObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
  }

  function classify(text) {
    if (/no image generated/i.test(text)) return 'noimage' // AI Studio could not draw this prompt
    if (/quota|rate limit|exhausted|too many|permission denied/i.test(text)) return 'limit' // stop for now, try later
    if (/safety|polic/i.test(text)) return 'content' // this prompt will not work: skip it
    return 'error'
  }

  async function toBase64(img) {
    try {
      const blob = await (await fetch(img.src)).blob()
      const b64 = await new Promise((ok, ko) => {
        const fr = new FileReader()
        fr.onload = () => ok(String(fr.result).split(',')[1])
        fr.onerror = () => ko(fr.error)
        fr.readAsDataURL(blob)
      })
      return { b64, mime: blob.type || 'image/png' }
    } catch {
      // fallback: re-encode through a canvas (same-origin blob, so the canvas is not tainted)
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext('2d').drawImage(img, 0, 0)
      return { b64: c.toDataURL('image/png').split(',')[1], mime: 'image/png' }
    }
  }

  async function run(item) {
    // 1. the prompt box (if it never shows up, AI Studio wants something from the user: terms, sign-in...)
    let box = null
    for (let i = 0; i < 60 && !box; i++) {
      box = promptBox()
      if (!box) await sleep(500)
    }
    if (!box) return { error: 'AI Studio did not show its prompt box. Open the Viku tab and check AI Studio (sign-in or terms).', kind: 'attention' }
    // a page that has only just loaded shows its prompt box before Run works (first try in a new tab missed twice)
    if (performance.now() < 10000) await sleep(10000 - performance.now())
    const imgsBefore = bigImages().length
    const errsBefore = errors().length

    // 2. type the prompt the way a person would (native setter + input event, so Angular sees it), then Run
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    box.focus()
    setter.call(box, item.prompt)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await imagesOnly()
    // 3. press Run, and make sure AI Studio took it: the prompt shows up as a chat turn (on a page that has only just
    //    loaded, the button can exist before it works). Up to 3 presses, then give up quickly so Viku retries.
    const head = item.prompt.slice(0, 40)
    const submitted = () => (document.body?.innerText || '').includes(head) || bigImages().length > imgsBefore || errors().length > errsBefore
    for (let attempt = 0; attempt < 3 && !submitted(); attempt++) {
      if (attempt) {
        // the box may have been cleared by a re-render: put the prompt back
        const b = promptBox()
        if (b && !b.value) {
          setter.call(b, item.prompt)
          b.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }
      await sleep(attempt ? 1500 : 800)
      const btn = runButton()
      if (btn && !btn.disabled) btn.click()
      else (promptBox() || box).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true }))
      for (let i = 0; i < 16 && !submitted(); i++) await sleep(500)
    }
    if (!submitted()) return { error: 'AI Studio did not take the prompt', kind: 'error' }

    // 4. wait for the picture (or an error) - up to 3 minutes
    const t0 = Date.now()
    while (Date.now() - t0 < 180000) {
      await sleep(1500)
      const imgs = bigImages()
      if (imgs.length > imgsBefore) {
        const img = imgs[imgs.length - 1]
        for (let i = 0; i < 20 && !(img.complete && img.naturalWidth); i++) await sleep(250)
        await sleep(800)
        const data = await toBase64(img)
        return { ...data, width: img.naturalWidth, height: img.naturalHeight }
      }
      const errs = errors()
      if (errs.length > errsBefore) {
        // give a picture that is still arriving a few seconds to win over an error banner
        for (let i = 0; i < 6 && bigImages().length <= imgsBefore; i++) await sleep(1000)
        if (bigImages().length > imgsBefore) continue
        const text = errs[errs.length - 1]
        return { error: `AI Studio: ${text}`, kind: classify(text) }
      }
    }
    return { error: 'No picture after 3 minutes', kind: 'error' }
  }

  async function claimAndRun() {
    if (busy) return
    busy = true
    try {
      const who = await send({ type: 'whoami' })
      if (!who || !who.worker) return // not the Viku tab: stay out of the way
      hideTokenCounter()
      if (who.model) model = who.model
      if (!who.waiting) return
      if (!isFresh()) {
        // only claim on a clean chat, so the picture we read is the one for this prompt
        location.assign(freshUrl())
        return
      }
      const r = await send({ type: 'claim' })
      if (!r || !r.item) return
      const out = await run(r.item)
      if (out.error) {
        const res = await send({ type: 'fail', id: r.item.id, name: r.item.name, error: out.error, kind: out.kind })
        if (res?.pause || out.kind === 'attention') return // stay on this page; the next alarm tries again later
      } else {
        await send({ type: 'result', id: r.item.id, name: r.item.name, mime: out.mime, b64: out.b64 })
      }
      await sleep(2500) // gentle pace: one picture at a time
      location.assign(freshUrl())
    } finally {
      busy = false
    }
  }

  const safeRun = () => {
    if (!alive()) return clearInterval(timer)
    claimAndRun().catch(() => undefined)
  }
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== 'poke') return
    // answer, so the background knows this script is alive (no answer = it reloads the tab)
    reply({ ok: true, busy })
    safeRun()
  })
  setTimeout(safeRun, 2500)
  timer = setInterval(safeRun, 20000)
})()
