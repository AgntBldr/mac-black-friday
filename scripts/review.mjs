// Reviews one pull request (up to 5 deal files) and leaves one comment on it, plus a "ready", "check by hand" or
// "needs changes" label. "check by hand" means the files pass but the bot couldn't confirm the deal on its page.
// Runs from the base branch (pull_request_target), so it never runs code from the pull request: the deal file is
// fetched through the GitHub API and only parsed as JSON.
import { readCategories, readDeals, validateDeal } from './lib.mjs'

const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, PR_AUTHOR } = process.env
const MARKER = '<!-- deal-review -->'

// The maintainer's own pull requests (seeding deals, house apps) aren't reviewed.
if (PR_AUTHOR && PR_AUTHOR === process.env.GITHUB_REPOSITORY_OWNER) {
  console.log(`Pull request by the maintainer @${PR_AUTHOR}: no review.`)
  process.exit(0)
}
const LABELS = {
  ready: { name: 'ready', color: '2da44e' },
  check: { name: 'check by hand', color: 'd4a72c' },
  changes: { name: 'needs changes', color: 'd93f0b' },
}

async function gh(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  if (!response.ok && response.status !== 404 && response.status !== 422)
    throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json().catch(() => null)
}

/** What the deal's own page shows, as far as a plain fetch can tell. Many pages render with JavaScript, so a miss is
 *  a note for the reviewer, not a failure. */
/** An App Store offer-code link (apps.apple.com/redeem?ctx=offercodes&id=…&code=…) opens the App Store's redeem
 *  sheet, which shows the offer and the standard price. Returns the app id and code, or null for any other link. */
function offerCodeLink(url) {
  try {
    const u = new URL(url)
    if (u.hostname !== 'apps.apple.com' || u.pathname.replace(/\/$/, '') !== '/redeem') return null
    if (u.searchParams.get('ctx') !== 'offercodes') return null
    const id = u.searchParams.get('id')
    return /^\d+$/.test(id || '') ? { id, code: u.searchParams.get('code') || '' } : null
  } catch {
    return null
  }
}

/** Checks an offer-code link: the app id must be a real App Store app and the code must match the deal's code. */
async function checkOfferCodeLink(deal, link) {
  if (!link.code) return { problem: 'the App Store offer-code link has no `code=` in it' }
  if (deal.code && deal.code.toLowerCase() !== link.code.toLowerCase()) {
    return { problem: `the code in the link (\`${link.code}\`) doesn't match \`code\` (\`${deal.code}\`)` }
  }
  try {
    const response = await fetch(`https://itunes.apple.com/lookup?id=${link.id}`, { signal: AbortSignal.timeout(15000) })
    const app = response.ok ? (await response.json()).results?.[0] : null
    if (!app) return { warn: `couldn't find App Store app ${link.id}` }
    return { app: app.trackName }
  } catch {
    return { warn: `couldn't look up App Store app ${link.id}` }
  }
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

/** The page's visible text after JavaScript has run, from a headless browser. Returns null when no browser is
 *  installed or it fails, so the caller falls back to a plain fetch. The browser only runs in the workflow's
 *  read-only job, never next to the token that can comment. */
let browserPromise
async function renderedText(url) {
  try {
    browserPromise ??= import('playwright').then((pw) => pw.chromium.launch())
    const browser = await browserPromise
    const page = await browser.newPage({ userAgent: UA, locale: 'en-US' })
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      if (response && !response.ok()) return { status: response.status() }
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
      return { text: await page.evaluate(() => document.body?.innerText || '') }
    } finally {
      await page.close()
    }
  } catch {
    return null
  }
}

async function closeBrowser() {
  if (browserPromise) await (await browserPromise.catch(() => null))?.close().catch(() => {})
}

async function checkPage(deal) {
  try {
    // Both the rendered page (text drawn by JavaScript) and the raw HTML (text the page keeps collapsed, like the
    // App Store's in-app purchase list) count.
    const rendered = await renderedText(deal.url)
    let html = ''
    let status = 0
    try {
      const response = await fetch(deal.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': UA },
      })
      status = response.status
      if (response.ok) html = (await response.text()).replace(/<[^>]+>/g, ' ')
    } catch {}
    if (!rendered?.text && !html) {
      const code = rendered?.status || status
      return { reachable: false, note: code ? `the page answered ${code}` : 'the page could not be opened' }
    }
    const raw = `${rendered?.text || ''} ${html}`
    const text = raw.replace(/\s+/g, ' ').toLowerCase()
    const sale = /black ?friday|cyber ?monday|bfcm|holiday sale/.test(text)
    const prices = (deal.prices || []).map((p) => p.after)
    const priceShown = prices.some((price) => {
      const fixed = Number.isInteger(price) ? String(price) : price.toFixed(2)
      return text.includes(`$${fixed}`) || text.includes(`$ ${fixed}`) || text.includes(`${fixed} usd`)
    })
    const codeShown = deal.code ? text.includes(deal.code.toLowerCase()) : null
    return { reachable: true, sale, priceShown, codeShown }
  } catch (error) {
    return { reachable: false, note: error.name === 'TimeoutError' ? 'the page took too long' : 'the page could not be opened' }
  }
}

const MAX_DEALS = 5

/** How many deal files this GitHub account has on the list now: files it added in merged pull requests that are
 *  still in deals/ on main, each counted once (a file re-added or later removed doesn't count twice). */
async function mergedDealCount(author) {
  const query = encodeURIComponent(`repo:${GITHUB_REPOSITORY} is:pr is:merged author:${author}`)
  const response = await fetch(`https://api.github.com/search/issues?q=${query}&per_page=50`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) return 0
  const onMain = new Set(readDeals().map((d) => 'deals/' + d.file))
  const added = new Set()
  for (const pr of (await response.json()).items || []) {
    const prFiles = await gh(`/pulls/${pr.number}/files?per_page=100`)
    for (const f of prFiles || []) if (/^deals\/[^/]+\.json$/.test(f.filename) && f.status === 'added') added.add(f.filename)
  }
  return [...added].filter((file) => onMain.has(file)).length
}

/** Checks one deal file. Returns its name, its problems, and notes about its page; a `warn` note means the deal
 *  couldn't be confirmed on its page and a maintainer should look. */
async function reviewDeal(file, existing, categoryIds) {
  const problems = []
  const notes = []
  const content = await gh(`/contents/${encodeURIComponent('deals/' + file).replace(/%2F/g, '/')}?ref=${HEAD_SHA}`)
  let deal
  try {
    deal = JSON.parse(Buffer.from(content.content, 'base64').toString('utf8'))
  } catch {
    return { name: file, problems: ['not valid JSON'], notes }
  }
  for (const error of validateDeal(file, deal, categoryIds)) problems.push(error)
  try {
    const key = (url) => {
      const link = offerCodeLink(url)
      if (link) return `apps.apple.com/app/${link.id}`
      return new URL(url).hostname.replace(/^www\./, '') + new URL(url).pathname.replace(/\/$/, '')
    }
    const same = existing.find((d) => d.file !== file && key(d.deal.url) === key(deal.url))
    if (same) problems.push(`already listed in \`deals/${same.file}\` (one entry per app)`)
  } catch {}
  if (deal.featured) problems.push('`featured` is set by the maintainers, please remove it')

  const link = deal.url ? offerCodeLink(deal.url) : null
  if (link) {
    const result = await checkOfferCodeLink(deal, link)
    if (result.problem) problems.push(result.problem)
    else if (result.warn) notes.push({ text: result.warn, warn: true })
    else notes.push({ text: `App Store offer-code link for ${result.app}; the redeem sheet shows the offer` })
  } else if (deal.url) {
    const page = await checkPage(deal)
    const startsLater = deal.starts && deal.starts > new Date().toISOString().slice(0, 10)
    if (!page.reachable) notes.push({ text: `couldn't open the page (${page.note})`, warn: true })
    else if (startsLater) notes.push({ text: `starts ${deal.starts}; the page can show the sale price from then` })
    else {
      if (!page.sale) notes.push({ text: "the page doesn't mention Black Friday yet", warn: true })
      if (deal.prices?.length && !page.priceShown) notes.push({ text: "the sale price isn't on the page yet, or it's drawn by JavaScript", warn: true })
      if (page.codeShown === false) notes.push({ text: `the code \`${deal.code}\` isn't on the page (fine if it's applied at checkout)` })
    }
  }
  return { name: deal.name || file, problems, notes }
}

async function main() {
  const files = await gh(`/pulls/${PR_NUMBER}/files?per_page=100`)
  const problems = []

  const dealFiles = files.filter((f) => /^deals\/[^/]+\.json$/.test(f.filename) && f.status !== 'removed')
  const others = files.filter((f) => !dealFiles.includes(f))
  if (dealFiles.length === 0) problems.push('Add your deal as a file in `deals/`, like `deals/your-app.json`.')
  if (dealFiles.length > MAX_DEALS) problems.push(`Up to ${MAX_DEALS} deals per developer: this pull request has ${dealFiles.length}.`)
  if (others.length) problems.push(`Only your deal files should change. Please remove: ${others.map((f) => '`' + f.filename + '`').join(', ')}.`)

  // The 5-apps-per-developer limit counts deals already merged from this account plus the new ones here.
  if (PR_AUTHOR && dealFiles.length && dealFiles.length <= MAX_DEALS) {
    const merged = await mergedDealCount(PR_AUTHOR)
    if (merged + dealFiles.filter((f) => f.status === 'added').length > MAX_DEALS)
      problems.push(`@${PR_AUTHOR} already has ${merged} deal${merged === 1 ? '' : 's'} listed. The limit is ${MAX_DEALS} per developer.`)
  }

  const results = []
  if (dealFiles.length && dealFiles.length <= MAX_DEALS) {
    const categoryIds = readCategories().map((c) => c.id)
    const existing = readDeals()
    for (const f of dealFiles) results.push(await reviewDeal(f.filename.replace(/^deals\//, ''), existing, categoryIds))
  }

  const passes = problems.length === 0 && results.every((r) => r.problems.length === 0)
  const unconfirmed = passes && results.some((r) => r.notes.some((n) => n.warn))
  const ready = passes && !unconfirmed
  const thanks = `Thanks${PR_AUTHOR ? ', @' + PR_AUTHOR : ''}!`
  const lines = [MARKER]
  lines.push(
    ready
      ? `${thanks} Everything passes the checks.`
      : unconfirmed
        ? `${thanks} The deal file passes the checks, but I couldn't confirm the deal on your page, so a maintainer will check it by hand.`
        : 'Thanks for adding your deal! A few things to fix first:'
  )
  if (problems.length) lines.push('', ...problems.map((p) => `- ${p}`))
  if (results.length) {
    lines.push('')
    for (const r of results) {
      const icon = r.problems.length ? '❌' : r.notes.some((n) => n.warn) ? '⚠️' : '✅'
      lines.push(`- ${icon} **${r.name}**${r.problems.length ? ': ' + r.problems.join('; ') : ''}`)
      for (const n of r.notes) lines.push(`  - ${n.text}`)
    }
  }
  lines.push(
    '',
    passes
      ? ready
        ? 'A maintainer will check it soon.'
        : "If your page shows the deal only after it starts or blocks bots, there's nothing to fix."
      : `Push a fix to this branch and I'll check again. Here are the [rules](https://github.com/${GITHUB_REPOSITORY}/blob/main/RULES.md).`
  )
  const body = lines.join('\n')
  const add = (ready ? LABELS.ready : unconfirmed ? LABELS.check : LABELS.changes).name
  return { body, label: add, passes }
}

/** Posts the review comment and label. Runs in the workflow's second job, which has write access and no browser. */
async function post({ body, label: add, passes }) {
  const comments = await gh(`/issues/${PR_NUMBER}/comments?per_page=100`)
  const mine = comments.find((c) => c.body?.startsWith(MARKER))
  if (mine) await gh(`/issues/comments/${mine.id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
  else await gh(`/issues/${PR_NUMBER}/comments`, { method: 'POST', body: JSON.stringify({ body }) })

  for (const label of Object.values(LABELS)) await gh('/labels', { method: 'POST', body: JSON.stringify(label) })
  for (const label of Object.values(LABELS))
    if (label.name !== add) await gh(`/issues/${PR_NUMBER}/labels/${encodeURIComponent(label.name)}`, { method: 'DELETE' })
  await gh(`/issues/${PR_NUMBER}/labels`, { method: 'POST', body: JSON.stringify({ labels: [add] }) })

  console.log(body)
  // A deal that couldn't be confirmed on its page isn't the maker's fault, so the check stays green; the label and the
  // comment say a maintainer looks by hand.
  if (!passes) process.exit(1)
}

// REVIEW_STEP=check: review and write the result to the job's outputs (read-only job, may use a browser).
// REVIEW_STEP=post: read REVIEW_RESULT and comment/label (write job). Unset: both, in one process (local runs).
// DRY_RUN=1 prints the review without posting.
async function run() {
  const step = process.env.REVIEW_STEP
  if (step === 'post' && !process.env.REVIEW_RESULT) return console.log('Nothing to post.')
  if (step === 'post') return post(JSON.parse(Buffer.from(process.env.REVIEW_RESULT || '', 'base64').toString('utf8')))
  const result = await main()
  await closeBrowser()
  if (step === 'check') {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.GITHUB_OUTPUT, `result=${Buffer.from(JSON.stringify(result)).toString('base64')}\n`)
    console.log(result.body)
    return
  }
  if (process.env.DRY_RUN) {
    console.log(`[${result.label}]\n${result.body}`)
    return
  }
  return post(result)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
