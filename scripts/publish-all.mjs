#!/usr/bin/env node
// Publish every active plugin under plugins/ to npm as @dbydd/<name>.
//
//   node scripts/publish-all.mjs [--dry-run] [--otp <code>] [--tag <dist-tag>] [--only <name> ...]
//
// npm requires a one-time password on every publish (2FA auth-and-writes).
// Pass --otp, or let the script prompt once and reuse it; when the code
// expires mid-run the script prompts again and retries the failed package.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import readline from 'node:readline/promises'

const argv = process.argv.slice(2)
const flag = name => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const dryRun = argv.includes('--dry-run')
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
  console.log(`publishing as npm user: ${who.stdout.trim()}`)
}

async function askOtp(reason) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(`npm OTP ${reason}: `)).trim()
  } finally {
    rl.close()
  }
}

function publish(dir, otp) {
  const args = ['publish', '--access', 'public']
  if (dryRun) args.push('--dry-run')
  if (tag !== undefined) args.push('--tag', tag)
  if (otp) args.push('--otp', otp)
  return spawnSync('npm', args, { cwd: join(pluginsDir, dir), encoding: 'utf8' })
}

const isOtpError = run => /EOTP|one-time password/i.test(`${run.stderr}\n${run.stdout}`)
const isAlreadyPublished = run => /EPUBLISHCONFLICT|cannot publish over/i.test(`${run.stderr}\n${run.stdout}`)

let otp = dryRun ? undefined : (flag('--otp') ?? (await askOtp('(authenticator code; reused while valid):')))
const results = []
for (const dir of packages) {
  const pkg = JSON.parse(readFileSync(join(pluginsDir, dir, 'package.json'), 'utf8'))
  if (pkg.name !== `@dbydd/${dir}`) {
    results.push({ dir, status: 'skip', detail: `name mismatch: ${pkg.name}` })
    continue
  }
  if (pkg.private === true) {
    results.push({ dir, status: 'skip', detail: 'package is private' })
    continue
  }
  let run = publish(dir, otp)
  if (run.status !== 0 && isOtpError(run)) {
    otp = await askOtp('(the previous code expired — enter a fresh one):')
    run = publish(dir, otp)
  }
  const output = `${run.stderr}\n${run.stdout}`.trim()
  if (run.status === 0) {
    results.push({ dir, status: 'published', detail: `${pkg.name}@${pkg.version}` })
  } else if (isAlreadyPublished(run)) {
    results.push({ dir, status: 'skip', detail: `${pkg.name}@${pkg.version} already on npm` })
  } else {
    results.push({ dir, status: 'failed', detail: output.split('\n').filter(l => l.includes('error')).slice(0, 3).join(' | ') || output.split('\n').slice(-3).join(' | ') })
  }
}

for (const r of results) console.log(`${r.status.padEnd(9)} ${r.dir}  ${r.detail}`)
const failed = results.filter(r => r.status === 'failed')
console.log(`\n${results.length - failed.length}/${results.length} ok${failed.length === 0 ? '' : `, ${failed.length} failed — rerun with --only <name> for the failures`}`)
process.exit(failed.length === 0 ? 0 : 1)
