// Writes dist/deals.json (read by boltai.com/blackfriday) and the deal tables in README.md.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCategories, readDeals, root } from './lib.mjs'

const categories = readCategories()

// addedAt: when the deal file landed on main (the merge commit for pull requests), newest add wins if a file was re-added.
// The page sorts by it. Needs full history (fetch-depth: 0 in the workflow); files not committed yet get the build time.
const addedAt = {}
let when = null
for (const line of execFileSync('git', ['log', '--first-parent', '--diff-filter=A', '--name-only', '--format=@%cI', '--', 'deals'], { cwd: root, encoding: 'utf8' }).split('\n')) {
  if (line.startsWith('@')) when = new Date(line.slice(1)).toISOString()
  else if (line.startsWith('deals/') && !addedAt[line]) addedAt[line] = when
}
const now = new Date().toISOString()
const deals = readDeals().map(({ file, deal }) => ({ id: file.replace(/\.json$/, ''), ...deal, addedAt: addedAt[`deals/${file}`] || now }))

// updatedAt only moves when a deal or category changes, so README-only pushes don't produce a rebuild commit.
mkdirSync(join(root, 'dist'), { recursive: true })
const distPath = join(root, 'dist/deals.json')
const previous = existsSync(distPath) ? JSON.parse(readFileSync(distPath, 'utf8')) : null
const unchanged = previous && JSON.stringify({ categories: previous.categories, deals: previous.deals }) === JSON.stringify({ categories, deals })
const updatedAt = unchanged ? previous.updatedAt : new Date().toISOString()
writeFileSync(distPath, JSON.stringify({ updatedAt, categories, deals }, null, 2) + '\n')

const money = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ')
function offer(deal) {
  // Launch Deals show the regular price next to the launch price instead of striking it through.
  const price = (p) =>
    deal.category === 'launch'
      ? `${p.plan} ${money(p.after)}${p.before ? ` (regular ${money(p.before)})` : ''}`
      : `${p.plan} ${p.before ? `~~${money(p.before)}~~ ` : ''}${money(p.after)}`
  // When the headline is one of the prices ("Lifetime $149"), show that price once, struck through if it has one.
  const same = (deal.prices || []).find((p) => `${p.plan} ${money(p.after)}`.toLowerCase() === deal.discount.toLowerCase())
  const parts = [`**${same ? price(same) : deal.discount}**`]
  if (deal.code) parts.push(`code **${deal.code}**`)
  for (const p of deal.prices || []) if (p !== same) parts.push(price(p))
  if (deal.terms) parts.push(deal.terms.replace(/\.$/, ''))
  parts.push(`until ${new Date(deal.ends + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`)
  return parts.join(' · ')
}

const sections = []
for (const category of categories) {
  const rows = deals.filter((d) => d.category === category.id).sort((a, b) => Number(!!b.featured) - Number(!!a.featured) || a.name.localeCompare(b.name))
  if (!rows.length) continue
  sections.push(`### ${category.name}\n\n| App | Platforms | What it does | Deal |\n| --- | --- | --- | --- |\n` +
    rows.map((d) => `| [${cell(d.name)}](${d.url}) | ${d.platforms.join(', ')} | ${cell(d.description || '')} | ${cell(offer(d))} |`).join('\n'))
}

const readmePath = join(root, 'README.md')
const readme = readFileSync(readmePath, 'utf8')
const start = '<!-- deals:start -->'
const end = '<!-- deals:end -->'
const body = `${start}\n\n${sections.join('\n\n') || '_No deals yet. Be the first: see [CONTRIBUTING.md](CONTRIBUTING.md)._'}\n\n${end}`
writeFileSync(readmePath, readme.replace(new RegExp(`${start}[\\s\\S]*${end}`), body))
console.log(`${deals.length} deals in ${sections.length} categories`)
