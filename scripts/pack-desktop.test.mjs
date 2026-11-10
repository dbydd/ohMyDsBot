import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DS_BOT_PIN,
  graphProblems,
  moduleLoaderId,
  packPlan,
  rewriteTypeSpecifiers,
  copyOutsideSrc,
  profileProblems,
  relinkPackedAliases,
  secretProblems,
  stageDesktop,
} from './pack-desktop.mjs'

test('compiled plugin imports point at .js, not .ts', () => {
  const code = rewriteTypeSpecifiers("import { a } from './manager.ts'\nexport { b } from '../types.ts'\nimport './side.ts'\n")
  assert.match(code, /from '\.\/manager\.js'/)
  assert.match(code, /from '\.\.\/types\.js'/)
  assert.match(code, /import '\.\/side\.js'/)
  assert.doesNotMatch(code, /\.ts'/)
})

test('TypeScript outside src/ is compiled so rewritten relative imports resolve', () => {
  const source = mkdtempSync(join(tmpdir(), 'omd-sidecar-src-'))
  const dest = mkdtempSync(join(tmpdir(), 'omd-sidecar-dest-'))
  try {
    mkdirSync(join(source, 'ssot'), { recursive: true })
    mkdirSync(join(source, 'src'), { recursive: true })
    writeFileSync(join(source, 'ssot', 'spec.ts'), 'export const x: number = 1\n')
    writeFileSync(join(source, 'README.md'), 'hi\n')
    writeFileSync(join(source, 'src', 'index.ts'), 'export {}\n')
    const esbuild = { transformSync: (code) => ({ code: code.replace(': number', '') }) }
    copyOutsideSrc(source, dest, esbuild)
    assert.equal(existsSync(join(dest, 'ssot', 'spec.js')), true)
    assert.equal(existsSync(join(dest, 'ssot', 'spec.ts')), false)
    assert.equal(existsSync(join(dest, 'src', 'index.ts')), false)
    assert.match(readFileSync(join(dest, 'ssot', 'spec.js'), 'utf8'), /export const x = 1/)
    assert.equal(readFileSync(join(dest, 'README.md'), 'utf8'), 'hi\n')
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
  }
})

test('the client graph names match the package name', () => {
  assert.deepEqual(graphProblems(), [])
  assert.equal(moduleLoaderId("window.__ModuleLoader__.load({\n  id: '@dbydd/omd-skin',\n"), '@dbydd/omd-skin')
})

test('omd and omd-full rows name real packages and carry no secrets', () => {
  assert.deepEqual(profileProblems(), [])
  assert.deepEqual(secretProblems(), [])
})

test('the pack plan pins the modified ds-bot and aliases unscoped imports', () => {
  const plan = packPlan()
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.bundles.includes('ds-bot'), true)
  assert.equal(plan.bundles.includes('@dbydd/omd-internal-paths'), true)
  const skin = plan.aliases.find(item => item.alias === 'omd-skin')
  assert.equal(skin?.target, '@dbydd/omd-skin')
  assert.equal(plan.canonical.some(item => item.name === 'ds-bot'), true)
  assert.equal(plan.canonical.some(item => item.name === 'omd-onlyne'), true)
  assert.equal(plan.canonical.some(item => item.name === '@dbydd/omd-hindsight'), true)
  assert.equal(plan.canonical.some(item => item.name === '@dbydd/omd-bot-wizard'), true)
})

test('packed aliases become one module after electron-builder copies them', () => {
  const dest = mkdtempSync(join(tmpdir(), 'omd-relink-'))
  try {
    const modules = join(dest, 'node_modules')
    mkdirSync(join(modules, '@dbydd', 'omd-skin'), { recursive: true })
    writeFileSync(join(modules, '@dbydd', 'omd-skin', 'package.json'), '{"name":"@dbydd/omd-skin"}\n')
    mkdirSync(join(modules, 'omd-skin'), { recursive: true })
    writeFileSync(join(modules, 'omd-skin', 'package.json'), '{"name":"@dbydd/omd-skin"}\n')
    relinkPackedAliases(dest, { aliases: [{ alias: 'omd-skin', target: '@dbydd/omd-skin' }] })
    assert.equal(lstatSync(join(modules, 'omd-skin')).isSymbolicLink(), true)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('staging writes the overlay without installing or copying credentials', () => {
  const dest = mkdtempSync(join(tmpdir(), 'omd-pack-'))
  try {
    stageDesktop({ dest })
    const host = readFileSync(join(dest, 'src', 'host.mjs'), 'utf8')
    assert.match(host, /omdStackPatch\(\)/)
    const profile = readFileSync(join(dest, 'src', 'profile.mjs'), 'utf8')
    assert.match(profile, /'@dbydd\/omd-internal-paths'/)
    assert.match(profile, /'ds-bot'/)
    assert.doesNotMatch(profile, /dsh-motion-ui/)
    const build = JSON.parse(readFileSync(join(dest, 'src', 'omd-build.json'), 'utf8'))
    assert.equal(build.dsBotCommit, DS_BOT_PIN)
    assert.equal(build.credentials, 'outside-bundle')
    const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
    assert.equal(pkg.productName, 'OMD')
    assert.equal(pkg.dependencies['@dbydd/omd-workbench'].startsWith('file:'), true)
    assert.equal(pkg.dependencies['@dbydd/omd-hindsight'].startsWith('file:'), true)
    assert.equal(pkg.dependencies['@dbydd/omd-bot-wizard'].startsWith('file:'), true)
    assert.equal(pkg.dependencies['omd-hindsight'], pkg.dependencies['@dbydd/omd-hindsight'])
    assert.equal(pkg.dependencies['@onlyne/lib'], '^3.2.0')
    const builder = readFileSync(join(dest, 'electron-builder.yml'), 'utf8')
    assert.match(builder, /appId: io\.github\.dbydd\.omd/)
    assert.doesNotMatch(builder, /deepseek-bot/)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})
