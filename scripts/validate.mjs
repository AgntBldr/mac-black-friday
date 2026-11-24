// Checks every deal file. Runs on each pull request; exits 1 with a list of problems.
import { readCategories, readDeals, validateDeal } from './lib.mjs'

const categoryIds = readCategories().map((c) => c.id)
const deals = readDeals()
let failed = false

const seenUrls = new Map()
const perMaker = new Map()
for (const { file, deal } of deals) {
  const errors = validateDeal(file, deal, categoryIds)
  if (deal.url) {
    const u = new URL(deal.url)
    const host = u.hostname + u.pathname.replace(/\/$/, '') + u.hash + (u.searchParams.get('id') ? `?id=${u.searchParams.get('id')}` : '')
    if (seenUrls.has(host)) errors.push(`same link as ${seenUrls.get(host)}: one entry per app`)
    seenUrls.set(host, file)
  }
  if (deal.maker) perMaker.set(deal.maker, [...(perMaker.get(deal.maker) || []), file])
  if (errors.length) {
    failed = true
    console.error(`deals/${file}`)
    for (const error of errors) console.error(`  - ${error}`)
  }
}

for (const [maker, files] of perMaker)
  if (files.length > 5 && !files.every((f) => deals.find((d) => d.file === f).deal.featured)) {
    failed = true
    console.error(`${maker} has ${files.length} entries; the limit is 5 per maker`)
  }

if (failed) process.exit(1)
console.log(`${deals.length} deals OK`)
