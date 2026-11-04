// Sync the index of the Cormi plugins from npm: dist/index.json.
//
//   node src/sync.mjs [--verify]
//
// Every package with the `cormi-plugin` keyword, at its latest version: its
// manifest (the `cormi` field of package.json, see @cormijs/core), whether
// it is official, its downloads of the last month. Besides them, packages of
// the cordis ecosystem that work in Cormi apps without saying so (EXTERNAL),
// with the manifest this index gives them. With --verify, each
// plugin is checked with `cormi plugin check` in a sandbox where every
// bundler and UI framework is installed.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conclude } from '@cormijs/core'

const REGISTRY = (process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/$/, '')
const verify = process.argv.includes('--verify')

/** The stack the sandbox checks plugins with: every bundler and UI framework, with the integrations they declare as peers. */
const STACK = ['@cormijs/cormi', '@cormijs/preset', '@cormijs/vite', '@cormijs/rsbuild', '@cormijs/react', '@cormijs/vue']

async function getJSON(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (response.status === 404) return
      if (!response.ok) throw new Error(`${url} answered ${response.status}`)
      return await response.json()
    } catch (error) {
      if (attempt === 3) throw error
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
    }
  }
}

/** The packages with the `cormi-plugin` keyword, from the search of the registry. */
async function search() {
  const results = []
  for (let from = 0; ; from += 250) {
    const page = await getJSON(`${REGISTRY}/-/v1/search?text=keywords:cormi-plugin&size=250&from=${from}`)
    results.push(...page.objects.map(object => object.package))
    if (!page.objects.length || results.length >= page.total) return results
  }
}

const isOfficial = name => name.startsWith('@cormijs/')

/** The drivers of minato: plugins of cormi.yml next to @cormijs/database, which provides the `model` they wait for. */
const DRIVER = { category: 'database', service: { required: ['model'], implements: ['database'] } }

/** Packages of the cordis ecosystem that are Cormi plugins, by name: the manifests they do not declare. */
const EXTERNAL = {
  '@minatojs/driver-sqlite': DRIVER,
  '@minatojs/driver-postgres': DRIVER,
  '@minatojs/driver-mysql': DRIVER,
  '@minatojs/driver-mongo': DRIVER,
  '@minatojs/driver-memory': DRIVER,
}

/** Packages that provide part of the stack (bundlers, UI frameworks, presets) are not checked as plugins. */
const isStack = manifest => manifest.service?.implements?.some(name => ['bundler', 'renderer', 'app'].includes(name))

/**
 * The dependencies of the sandbox: the stack at `next`, the plugins, and the
 * peers of both at the ranges they declare, e.g. the integrations of each
 * bundler (`@vitejs/plugin-react`, `@tailwindcss/vite`).
 */
async function sandboxDependencies(objects) {
  const dependencies = {}
  const addPeers = (peers = {}) => {
    for (const [name, range] of Object.entries(peers)) {
      if (!name.startsWith('@cormijs/') && !(name in dependencies)) dependencies[name] = range
    }
  }
  for (const name of STACK) {
    dependencies[name] = 'next'
    addPeers((await getJSON(`${REGISTRY}/${name.replace('/', '%2f')}/next`))?.peerDependencies)
  }
  for (const object of objects) {
    dependencies[object.name] = object.version
    addPeers(peers.get(object.name))
  }
  return dependencies
}

/** Check the plugins in a sandbox that has every bundler and UI framework; their reports by name, or why they could not be checked. */
async function check(objects) {
  const dir = mkdtempSync(join(tmpdir(), 'cormi-registry-'))
  try {
    const dependencies = await sandboxDependencies(objects)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sandbox', private: true, type: 'module', dependencies }, null, 2))
    const install = spawnSync('npm', ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' })
    if (install.status) throw new Error('cannot install the sandbox')
    const reports = {}
    for (const object of objects) {
      const result = spawnSync(process.execPath, [join(dir, 'node_modules/@cormijs/cormi/bin/cormi.js'), 'plugin', 'check', '--json'], {
        cwd: join(dir, 'node_modules', object.name),
        encoding: 'utf8',
        timeout: 120_000,
      })
      try {
        reports[object.name] = JSON.parse(result.stdout.trim().split('\n').at(-1))
      } catch {
        const reason = result.error?.message ?? (result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).at(-1) ?? 'no output'
        reports[object.name] = { error: reason }
        console.warn(`cannot check ${object.name}: ${reason}`)
      }
    }
    return reports
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** the peer dependencies of the packages, for the sandbox */
const peers = new Map()

const results = await search()
console.log(`${results.length} packages with the cormi-plugin keyword`)
const objects = []
for (const result of results) {
  const meta = await getJSON(`${REGISTRY}/${result.name.replace('/', '%2f')}/${result.version}`)
  if (!meta || meta.deprecated) continue
  peers.set(result.name, meta.peerDependencies)
  const downloads = await getJSON(`https://api.npmjs.org/downloads/point/last-month/${result.name}`).catch(() => undefined)
  objects.push({
    name: result.name,
    version: result.version,
    description: result.description,
    keywords: result.keywords ?? [],
    date: result.date,
    links: { npm: `https://www.npmjs.com/package/${result.name}`, ...result.links },
    manifest: conclude(meta),
    official: isOfficial(result.name),
    downloads: downloads ? { lastMonth: downloads.downloads } : undefined,
  })
}

for (const [name, manifest] of Object.entries(EXTERNAL)) {
  if (objects.some(object => object.name === name)) continue
  const packument = await getJSON(`${REGISTRY}/${name.replace('/', '%2f')}`)
  const version = packument?.['dist-tags']?.latest
  const meta = packument?.versions?.[version]
  if (!meta || meta.deprecated) continue
  const downloads = await getJSON(`https://api.npmjs.org/downloads/point/last-month/${name}`).catch(() => undefined)
  objects.push({
    name,
    version,
    description: meta.description,
    keywords: meta.keywords ?? [],
    date: packument.time?.[version],
    links: { npm: `https://www.npmjs.com/package/${name}`, ...meta.homepage && { homepage: meta.homepage } },
    // compatible with every bundler and UI framework: they run on the server
    manifest: { ...conclude(meta), ...manifest, source: 'declared' },
    official: false,
    external: true,
    downloads: downloads ? { lastMonth: downloads.downloads } : undefined,
  })
}

if (verify) {
  const time = new Date().toISOString()
  // the manifests of external packages are this index's, not theirs to check against
  const plugins = objects.filter(object => !object.external && !isStack(object.manifest))
  const reports = await check(plugins)
  for (const object of plugins) {
    const report = reports[object.name]
    if (!report?.inferred) {
      // why it could not be checked: the error of the check, or the export that loads nowhere
      object.checkError = report?.error ?? report?.exports?.find(item => item.error)?.error ?? 'not checked'
      continue
    }
    const exports = Object.keys(report.inferred.exports).length ? { exports: report.inferred.exports } : {}
    object.verified = { time, compat: { ...report.inferred.compat, ...exports }, matches: !report.mismatches.length }
  }
}

// official first, then the most downloaded
objects.sort((a, b) => Number(b.official) - Number(a.official) || (b.downloads?.lastMonth ?? 0) - (a.downloads?.lastMonth ?? 0) || a.name.localeCompare(b.name))
mkdirSync('dist', { recursive: true })
writeFileSync('dist/index.json', JSON.stringify({ version: 1, time: new Date().toISOString(), objects }, null, 2) + '\n')
console.log(`dist/index.json: ${objects.length} packages, ${objects.filter(object => object.verified).length} verified`)
