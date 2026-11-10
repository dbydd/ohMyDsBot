#!/usr/bin/env node
// Publish every active plugin under plugins/ to npm as @dbydd/<name>.
//
//   node scripts/publish-all.mjs [--dry-run] [--otp <code>] [--tag <dist-tag>] [--only <name> ...]
//
// npm runs a web-2FA ceremony per publish for passkey/biometric accounts.
// stdio is inherited so npm can open the browser itself: approve the first
// ceremony and check npmjs.com's "don't ask again for 5 minutes" box — the
// rest of the batch then passes without further prompts. `npm login` first.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const flag = name => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const dryRun = argv.includes('--dry-run')
const otp = flag('--otp')
const tag = flag('--tag')
const only = argv.includes('--only') ? argv.slice(argv.indexOf('--only') + 1).filter(a => !a.startsWith('--')) : null

const pluginsDir = new URL('../plugins/', import.meta.url).pathname
const skip = new Set(['archived', 'node_modules', 'npm-packages'])

/** @returns {string[]} absolute package directories, grouped or still flat */
function packageDirs() {
  const found = []
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || skip.has(entry.name) || entry.name.startsWith('.')) continue
    const dir = join(pluginsDir, entry.name)
    if (existsSync(join(dir, 'package.json'))) {
      if (entry.name.startsWith('omd-')) found.push(dir)
      continue
    }
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory() || !child.name.startsWith('omd-')) continue
      const childDir = join(dir, child.name)
      if (existsSync(join(childDir, 'package.json'))) found.push(childDir)
    }
  }
  return found.sort()
}

const packages = packageDirs().filter(dir => only === null || only.includes(basename(dir)))

if (packages.length === 0) {
  console.error('no packages matched')
  process.exit(1)
}

if (!dryRun) {
  const who = spawnSync('npm', ['whoami'], { encoding: 'utf8' })
  if (who.status !== 0) {
    console.error('npm whoami failed — run `npm login` first.')
    process.exit(1)
  }
  console.log(`publishing as npm user: ${who.stdout.trim()}\n`)
}

const results = []
for (const dir of packages) {
  const name = basename(dir)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (pkg.name !== `@dbydd/${name}` || pkg.private === true) {
    results.push({ dir: name, status: 'skip', detail: 'name mismatch or private' })
    continue
  }
  const args = ['publish', '--access', 'public']
  if (dryRun) args.push('--dry-run')
  if (tag !== undefined) args.push('--tag', tag)
  if (otp !== undefined) args.push('--otp', otp)
  const run = spawnSync('npm', args, {
    cwd: dir,
    stdio: dryRun ? ['ignore', 'ignore', 'pipe'] : 'inherit',
    encoding: 'utf8',
  })
  if (run.status === 0) {
    results.push({ dir: name, status: 'published', detail: `${pkg.name}@${pkg.version}` })
  } else {
    const detail = dryRun ? (run.stderr || '').trim().split('\n').slice(-2).join(' | ') : 'see npm output above — rerun with --only ' + name
    results.push({ dir: name, status: 'failed', detail })
  }
}

console.log('')
for (const r of results) console.log(`${r.status.padEnd(9)} ${r.dir}  ${r.detail}`)
const failed = results.filter(r => r.status === 'failed')
console.log(`\n${results.length - failed.length}/${results.length} ok${failed.length === 0 ? '' : `, ${failed.length} failed — rerun with --only <name> for the failures`}`)
process.exit(failed.length === 0 ? 0 : 1)
