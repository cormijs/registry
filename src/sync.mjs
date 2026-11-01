// Sync the index of the Cormi plugins from npm: dist/index.json.
//
//   node src/sync.mjs [--verify]
//
// Every package with the `cormi-plugin` keyword, at its latest version: its
// manifest (the `cormi` field of package.json, see @cormijs/core), whether
// it is official, its downloads of the last month. With --verify, each
// plugin is checked with `cormi plugin check` in a sandbox where every
// bundler and UI framework is installed.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conclude } from '@cormijs/core'

const REGISTRY = (process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/$/, '')
const verify = process.argv.includes('--verify')

/** The stack the sandbox checks plugins with: every bundler and UI framework, with their integrations. */
const STACK = {
  '@cormijs/cormi': 'next',
  '@cormijs/preset': 'next',
  '@cormijs/vite': 'next',
  '@cormijs/rsbuild': 'next',
  '@cormijs/react': 'next',
  '@cormijs/vue': 'next',
  '@vitejs/plugin-react': 'latest',
  '@rsbuild/plugin-react': 'latest',
  '@vitejs/plugin-vue': 'latest',
  '@rsbuild/plugin-vue': 'latest',
  'react': 'latest',
  'react-dom': 'latest',
  'vue': 'latest',
}

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

/** Packages that provide part of the stack (bundlers, UI frameworks, presets) are not checked as plugins. */
const isStack = manifest => manifest.service?.implements?.some(name => ['bundler', 'renderer', 'app'].includes(name))

/** Check the plugins in a sandbox that has every bundler and UI framework; their reports by name. */
function check(objects) {
  const dir = mkdtempSync(join(tmpdir(), 'cormi-registry-'))
  try {
    const dependencies = { ...STACK, ...Object.fromEntries(objects.map(object => [object.name, object.version])) }
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
        console.warn(`cannot check ${object.name}: ${(result.stderr || result.stdout).trim().split('\n').at(-1)}`)
      }
    }
    return reports
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const results = await search()
console.log(`${results.length} packages with the cormi-plugin keyword`)
const objects = []
for (const result of results) {
  const meta = await getJSON(`${REGISTRY}/${result.name.replace('/', '%2f')}/${result.version}`)
  if (!meta || meta.deprecated) continue
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

if (verify) {
  const time = new Date().toISOString()
  const plugins = objects.filter(object => !isStack(object.manifest))
  const reports = check(plugins)
  for (const object of plugins) {
    const report = reports[object.name]
    if (!report?.inferred) continue
    const exports = Object.keys(report.inferred.exports).length ? { exports: report.inferred.exports } : {}
    object.verified = { time, compat: { ...report.inferred.compat, ...exports }, matches: !report.mismatches.length }
  }
}

// official first, then the most downloaded
objects.sort((a, b) => Number(b.official) - Number(a.official) || (b.downloads?.lastMonth ?? 0) - (a.downloads?.lastMonth ?? 0) || a.name.localeCompare(b.name))
mkdirSync('dist', { recursive: true })
writeFileSync('dist/index.json', JSON.stringify({ version: 1, time: new Date().toISOString(), objects }, null, 2) + '\n')
console.log(`dist/index.json: ${objects.length} packages, ${objects.filter(object => object.verified).length} verified`)
