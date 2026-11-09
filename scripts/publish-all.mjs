#!/usr/bin/env node
// Publish every active plugin under plugins/ to npm as @dbydd/<name>.
//
//   node scripts/publish-all.mjs [--dry-run] [--otp <code>] [--tag <dist-tag>] [--only <name> ...]
//
// npm runs a web-2FA ceremony per publish for passkey/biometric accounts.
// stdio is inherited so npm can open the browser itself: approve the first
// ceremony and check npmjs.com's "don't ask again for 5 minutes" box — the
// rest of the batch then passes without further prompts. `npm login` first.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
const packages = readdirSync(pluginsDir, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name.startsWith('omd-'))
  .map(e => e.name)
  .sort()
  .filter(name => only === null || only.includes(name))

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
  const pkg = JSON.parse(readFileSync(join(pluginsDir, dir, 'package.json'), 'utf8'))
  if (pkg.name !== `@dbydd/${dir}` || pkg.private === true) {
    results.push({ dir, status: 'skip', detail: 'name mismatch or private' })
    continue
  }
  const args = ['publish', '--access', 'public']
  if (dryRun) args.push('--dry-run')
  if (tag !== undefined) args.push('--tag', tag)
  if (otp !== undefined) args.push('--otp', otp)
  const run = spawnSync('npm', args, {
    cwd: join(pluginsDir, dir),
    stdio: dryRun ? ['ignore', 'ignore', 'pipe'] : 'inherit',
    encoding: 'utf8',
  })
  if (run.status === 0) {
    results.push({ dir, status: 'published', detail: `${pkg.name}@${pkg.version}` })
  } else {
    const detail = dryRun ? (run.stderr || '').trim().split('\n').slice(-2).join(' | ') : 'see npm output above — rerun with --only ' + dir
    results.push({ dir, status: 'failed', detail })
  }
}

console.log('')
for (const r of results) console.log(`${r.status.padEnd(9)} ${r.dir}  ${r.detail}`)
const failed = results.filter(r => r.status === 'failed')
console.log(`\n${results.length - failed.length}/${results.length} ok${failed.length === 0 ? '' : `, ${failed.length} failed — rerun with --only <name> for the failures`}`)
process.exit(failed.length === 0 ? 0 : 1)
