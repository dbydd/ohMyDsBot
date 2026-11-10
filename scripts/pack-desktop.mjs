#!/usr/bin/env node
/**
 * Pack a desktop app that boots the omd-full stack on the pinned ds-bot.
 *
 * The Electron project is ds-bot/app (fork commit 95602e97). This script does
 * not change that submodule. It copies the app, points it at this checkout's
 * plugins, and overlays profiles/omd-full so the window is not stock DS Bot.
 *
 * Credentials stay out of the bundle. The app reads `$DSH_HOME/.credentials.yaml`
 * and `apiKeyEnv` the way dsh already does. Nothing in this script writes a key.
 *
 * @module scripts/pack-desktop
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Fork commit the desktop host must be. Public npm ds-bot does not provide ctx.dsBot. */
export const DS_BOT_PIN = '95602e97e8edbbf77e7840950daa0ebc69a612e9'

/** Display name of the packed app, distinct from an installed DS Bot. */
export const PRODUCT_NAME = 'OMD'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_DIR = join(REPO, 'profiles', 'omd-full')

/**
 * Host packages the plugins import and the app must hoist to one copy.
 * Versions match the lockfile of ds-bot/app at the pinned commit.
 */
export const HOST_PEERS = {
  '@deepseek-ai/cordis': '4.1.0',
  '@deepseek-ai/schemastery': '3.19.0',
  '@deepseek-ai/dsh-agent': '0.2.2-rc.1',
  '@deepseek-ai/dsh-commands': '0.2.2-rc.1',
  '@deepseek-ai/dsh-llm': '0.2.2-rc.1',
  '@deepseek-ai/dsh-scope': '0.2.2-rc.1',
  '@deepseek-ai/dsh-session': '0.2.2-rc.1',
  '@deepseek-ai/dsh-session-projection': '0.2.2-rc.1',
  '@deepseek-ai/dsh-system-prompt': '0.2.2-rc.1',
  '@deepseek-ai/dsh-tools': '0.2.2-rc.1',
  '@deepseek-ai/dsh-web': '0.2.2-rc.1',
  '@deepseek-ai/dsh-skill': '0.2.2-rc.1',
  '@deepseek-ai/dsh-attachment': '0.2.2-rc.1',
  '@deepseek-ai/dsh-fs': '0.2.2-rc.1',
  '@deepseek-ai/dsh-working-directory': '0.2.2-rc.1',
  '@deepseek-ai/dsh-session-query': '0.2.2-rc.1',
  '@deepseek-ai/dsh-home-paths': '0.2.2-rc.1',
  '@deepseek-ai/dsh-jobs': '0.2.2-rc.1',
  '@deepseek-ai/dsh-user-questions': '0.2.2-rc.1',
  zod: '4.6.7',
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
]

const OMD_STACK_SOURCE = `import { fileURLToPath } from 'node:url'

/** The omd-full overlay shipped in the app. DSH reads it only through patchFiles. */
export function omdStackPatch() {
  return [fileURLToPath(new URL('./omd-full.patch.yml', import.meta.url))]
}
`

/**
 * @param {string} repo
 * @returns {string} full commit of the ds-bot submodule
 */
export function readDsBotCommit(repo = REPO) {
  const result = spawnSync('git', ['-C', join(repo, 'ds-bot'), 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`ds-bot submodule is not checked out (${result.stderr.trim() || 'git rev-parse failed'})`)
  }
  return result.stdout.trim()
}

/**
 * @param {string} repo
 * @returns {string[]}
 */
export function pinProblems(repo = REPO) {
  let commit
  try {
    commit = readDsBotCommit(repo)
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
  if (commit !== DS_BOT_PIN) {
    return [`ds-bot is ${commit}, the pack requires ${DS_BOT_PIN} (modified fork, not public npm ds-bot)`]
  }
  return []
}

/**
 * @param {string} dir plugin directory
 * @returns {{ name: string, dir: string, client?: string, patchName?: string } | undefined}
 */
function pluginRecord(dir) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return undefined
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (typeof pkg.name !== 'string') return undefined
  const clientRel = pkg.exports?.['./client']
  const record = { name: pkg.name, dir }
  if (typeof clientRel === 'string') record.client = join(dir, clientRel)
  const patchPath = join(dir, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    const match = readFileSync(patchPath, 'utf8').match(/^\s*name:\s*['"]?([^'"\n]+)['"]?\s*$/m)
    if (match) record.patchName = match[1]
  }
  return record
}

/**
 * @param {string} repo
 * @returns {Array<{ name: string, dir: string, client?: string, patchName?: string }>}
 */
export function localPlugins(repo = REPO) {
  const root = join(repo, 'plugins')
  const records = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'archived' || entry.name === 'node_modules' || entry.name === 'npm-packages') continue
    const record = pluginRecord(join(root, entry.name))
    if (record) records.push(record)
  }
  return records
}

/**
 * The id a client registers with, which dsh uses as the graph row id.
 * @param {string} source
 * @returns {string | undefined}
 */
export function moduleLoaderId(source) {
  const match = source.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/)
  return match?.[1]
}

/**
 * Three names must match or dsh drops the browser half: package.json `name`,
 * the profile row `name` (checked separately), and `__ModuleLoader__.load({ id })`.
 * @param {string} repo
 * @returns {string[]}
 */
export function graphProblems(repo = REPO) {
  const problems = []
  for (const plugin of localPlugins(repo)) {
    if (plugin.client === undefined) continue
    if (!existsSync(plugin.client)) {
      problems.push(`${plugin.name} declares ./client but ${plugin.client} is missing`)
      continue
    }
    const id = moduleLoaderId(readFileSync(plugin.client, 'utf8'))
    if (id !== plugin.name) {
      problems.push(`${plugin.name} client id is ${id ?? '(missing)'}, package name is ${plugin.name}`)
    }
    if (plugin.patchName !== undefined && plugin.patchName !== plugin.name) {
      problems.push(`${plugin.name} cordis.patch.yml name is ${plugin.patchName}`)
    }
  }
  return problems
}

/**
 * @param {string} yaml
 * @returns {Array<{ id?: string, name?: string }>}
 */
export function patchRows(yaml) {
  const rows = []
  let current
  for (const line of yaml.split('\n')) {
    const id = line.match(/^\s*- id:\s*['"]?([^'"\s]+)['"]?/)
    const named = line.match(/^\s*name:\s*['"]?([^'"\n]+?)['"]?\s*$/)
    if (id) {
      current = { id: id[1] }
      rows.push(current)
      continue
    }
    if (named && current && current.name === undefined) current.name = named[1]
  }
  return rows
}

/**
 * @param {string} repo
 * @returns {string[]}
 */
export function profileProblems(repo = REPO) {
  const problems = []
  const byName = new Map(localPlugins(repo).map(plugin => [plugin.name, plugin]))
  for (const profile of ['omd', 'omd-full']) {
    const file = join(repo, 'profiles', profile, 'cordis.patch.yml')
    if (!existsSync(file)) {
      problems.push(`profiles/${profile}/cordis.patch.yml is missing`)
      continue
    }
    for (const row of patchRows(readFileSync(file, 'utf8'))) {
      if (row.name === undefined) continue
      if (!row.name.startsWith('@dbydd/omd-') && !row.name.startsWith('omd-')) continue
      const plugin = byName.get(row.name)
      if (plugin === undefined) {
        problems.push(`profiles/${profile} row ${row.id ?? '(no id)'} names ${row.name}, which is not a plugin in plugins/`)
        continue
      }
      if (plugin.client !== undefined) {
        const id = moduleLoaderId(readFileSync(plugin.client, 'utf8'))
        if (id !== row.name) {
          problems.push(`profiles/${profile} row ${row.id} name ${row.name} does not match client id ${id ?? '(missing)'}`)
        }
      }
    }
  }
  const manifestPath = join(repo, 'profiles', 'omd-full', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const deps = manifest.dependencies ?? {}
  for (const plugin of byName.values()) {
    if (!Object.values(deps).some(spec => typeof spec === 'string' && spec.endsWith(`/plugins/${basename(plugin.dir)}`))) continue
    if (deps[plugin.name] === undefined) {
      problems.push(`profiles/omd-full/package.json does not depend on ${plugin.name}`)
    }
    const unscoped = basename(plugin.dir)
    if (unscoped !== plugin.name && deps[unscoped] !== deps[plugin.name]) {
      problems.push(`profiles/omd-full/package.json alias ${unscoped} does not point at the same spec as ${plugin.name}`)
    }
  }
  return problems
}

/**
 * @param {string} repo
 * @returns {string[]}
 */
export function secretProblems(repo = REPO) {
  const problems = []
  const files = [
    join(repo, 'profiles', 'omd-full', 'cordis.patch.yml'),
    join(repo, 'profiles', 'omd-full', 'package.json'),
    join(repo, 'profiles', 'omd', 'cordis.patch.yml'),
  ]
  for (const file of files) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) problems.push(`${relative(repo, file)} matches ${pattern}`)
    }
  }
  return problems
}

/**
 * @param {string} repo
 * @returns {{ problems: string[], bundles: string[], canonical: Array<{ name: string, abs: string }>, aliases: Array<{ alias: string, target: string }>, ranges: Array<{ name: string, spec: string }> }}
 */
export function packPlan(repo = REPO) {
  const problems = [
    ...pinProblems(repo),
    ...graphProblems(repo),
    ...profileProblems(repo),
    ...secretProblems(repo),
  ]
  const manifest = JSON.parse(readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8'))
  const groups = new Map()
  const ranges = []
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof spec !== 'string') continue
    if (!spec.startsWith('link:')) {
      ranges.push({ name, spec })
      continue
    }
    const abs = resolve(PROFILE_DIR, spec.slice('link:'.length))
    const names = groups.get(abs) ?? []
    names.push(name)
    groups.set(abs, names)
  }
  const canonical = []
  const aliases = []
  for (const [abs, names] of groups) {
    const target = names.find(name => name.includes('/')) ?? names[0]
    canonical.push({ name: target, abs })
    for (const alias of names) {
      if (alias !== target) aliases.push({ alias, target })
    }
  }
  return {
    problems,
    bundles: manifest.dsh?.profile?.bundles ?? [],
    canonical,
    aliases,
    ranges,
  }
}

/**
 * Node will not strip TypeScript under `node_modules`. The desktop host is that
 * Node, so each plugin is emitted as JavaScript before it is installed.
 * Relative `.ts` specifiers are rewritten to `.js`. Package imports stay external.
 * @param {string} repo
 * @param {string} compiledRoot
 * @returns {Promise<Map<string, string>>} source directory to compiled directory
 */
export async function compileOmdPlugins(repo, compiledRoot) {
  const esbuildDir = join(repo, 'build', 'esbuild-tool')
  if (!existsSync(join(esbuildDir, 'node_modules', 'esbuild', 'package.json'))) {
    mkdirSync(esbuildDir, { recursive: true })
    writeFileSync(join(esbuildDir, 'package.json'), '{"private":true}\n')
    const installed = spawnSync('npm', ['install', '--silent', 'esbuild@0.28.2'], {
      cwd: esbuildDir,
      stdio: 'inherit',
      env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
    })
    if (installed.status !== 0) throw new Error('could not install esbuild to compile omd plugins')
  }
  const esbuild = await import(pathToFileURL(join(esbuildDir, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  rmSync(compiledRoot, { recursive: true, force: true })
  mkdirSync(compiledRoot, { recursive: true })
  const map = new Map()
  for (const plugin of localPlugins(repo)) {
    const dest = join(compiledRoot, basename(plugin.dir))
    mkdirSync(dest, { recursive: true })
    const pkg = JSON.parse(readFileSync(join(plugin.dir, 'package.json'), 'utf8'))
    rewriteTree(plugin.dir, dest, esbuild)
    for (const entry of readdirSync(plugin.dir, { withFileTypes: true })) {
      if (entry.name === 'src' || entry.name === 'node_modules' || entry.name === 'tsconfig.json') continue
      cpSync(join(plugin.dir, entry.name), join(dest, entry.name), { recursive: true })
    }
    pkg.exports = rewriteExports(pkg.exports)
    writeFileSync(join(dest, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    map.set(plugin.dir, dest)
  }
  return map
}

/**
 * @param {string} sourceDir
 * @param {string} destDir
 * @param {{ transformSync: Function }} esbuild
 */
function rewriteTree(sourceDir, destDir, esbuild) {
  const src = join(sourceDir, 'src')
  if (!existsSync(src)) return
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const from = join(dir, entry.name)
      const rel = relative(src, from)
      if (entry.isDirectory()) {
        walk(from)
        continue
      }
      if (entry.name.endsWith('.ts')) {
        const transformed = esbuild.transformSync(readFileSync(from, 'utf8'), {
          loader: 'ts',
          format: 'esm',
          target: 'node22',
          sourcefile: from,
        })
        const out = join(destDir, 'dist', rel).replace(/\.ts$/, '.js')
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, rewriteTypeSpecifiers(transformed.code))
      } else {
        // Client bundles are already JavaScript and the export still names src/.
        const out = join(destDir, 'src', rel)
        mkdirSync(dirname(out), { recursive: true })
        cpSync(from, out)
      }
    }
  }
  walk(src)
}

/**
 * @param {string} code
 * @returns {string}
 */
export function rewriteTypeSpecifiers(code) {
  return code.replace(/(from\s+|import\s+|import\s*\(\s*)(['"])(\.\.?\/[^'"]+?)\.ts\2/g, '$1$2$3.js$2')
}

/**
 * @param {unknown} exportsField
 * @returns {unknown}
 */
function rewriteExports(exportsField) {
  if (typeof exportsField === 'string') {
    if (!exportsField.endsWith('.ts')) return exportsField
    return exportsField.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '.js')
  }
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return exportsField
  const next = {}
  for (const [key, value] of Object.entries(exportsField)) next[key] = rewriteExports(value)
  return next
}

/**
 * Copy ds-bot/app and point it at omd-full. Does not install or pack.
 * @param {{ repo?: string, dest: string }} options
 * @returns {ReturnType<typeof packPlan>}
 */
export function stageDesktop(options) {
  const repo = options.repo ?? REPO
  const plan = packPlan(repo)
  if (plan.problems.length > 0) {
    throw new Error(`omd desktop pack refused:\n${plan.problems.join('\n')}`)
  }
  const app = join(repo, 'ds-bot', 'app')
  rmSync(options.dest, { recursive: true, force: true })
  mkdirSync(options.dest, { recursive: true })
  cpSync(app, options.dest, {
    recursive: true,
    filter: (source) => {
      const name = basename(source)
      return name !== 'node_modules' && name !== 'dist-pack' && name !== 'build'
    },
  })
  writeFileSync(join(options.dest, 'src', 'omd-stack.mjs'), OMD_STACK_SOURCE)
  cpSync(join(PROFILE_DIR, 'cordis.patch.yml'), join(options.dest, 'src', 'omd-full.patch.yml'))
  writeFileSync(join(options.dest, 'src', 'omd-build.json'), `${JSON.stringify({
    profile: 'omd-full',
    product: PRODUCT_NAME,
    dsBotCommit: DS_BOT_PIN,
    credentials: 'outside-bundle',
  }, null, 2)}\n`)

  const hostPath = join(options.dest, 'src', 'host.mjs')
  const host = readFileSync(hostPath, 'utf8')
  if (!host.includes("from './app-patch.mjs'")) throw new Error('ds-bot host.mjs has no app-patch import to anchor the omd overlay')
  writeFileSync(hostPath, host
    .replace("import { writeAppPatch } from './app-patch.mjs'\n", "import { writeAppPatch } from './app-patch.mjs'\nimport { omdStackPatch } from './omd-stack.mjs'\n")
    .replace(
      'patchFiles: check === undefined ? [...writeAppPatch(profile),',
      'patchFiles: check === undefined ? [...omdStackPatch(), ...writeAppPatch(profile),',
    ))

  const profilePath = join(options.dest, 'src', 'profile.mjs')
  const profile = readFileSync(profilePath, 'utf8')
  const bundlesLine = profile.match(/export const BUNDLES = \[([^\]]+)\]/)
  if (bundlesLine === null) throw new Error('ds-bot profile.mjs has no BUNDLES list')
  const present = bundlesLine[1].split(',').map(part => part.trim().replace(/['"]/g, ''))
  // dsh-motion-ui 0.8.9 declares compatibility only through dsh 0.2.1-rc.5.
  // The pinned desktop host is dsh 0.2.2-rc.1, and an own bundle that the
  // loader skips aborts startup. Ship the package, do not require the bundle.
  const skippedBundles = new Set(['dsh-motion-ui'])
  const extra = plan.bundles.filter(name => !present.includes(name) && !skippedBundles.has(name))
  const nextBundles = [...present, ...extra].map(name => `'${name}'`).join(', ')
  writeFileSync(profilePath, profile.replace(bundlesLine[0], `export const BUNDLES = [${nextBundles}]`))

  const pkgPath = join(options.dest, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.productName = PRODUCT_NAME
  pkg.description = 'OMD desktop: pinned ds-bot plus the omd-full plugin stack. Credentials stay in the app data directory.'
  pkg.dependencies ??= {}
  for (const [name, spec] of Object.entries(HOST_PEERS)) pkg.dependencies[name] = spec
  for (const item of plan.canonical) pkg.dependencies[item.name] = `file:${item.abs}`
  for (const item of plan.aliases) pkg.dependencies[item.alias] = `file:${plan.canonical.find(entry => entry.name === item.target)?.abs}`
  for (const item of plan.ranges) {
    if (item.name === 'ds-bot' || item.name === 'dsh-motion-ui') continue
    pkg.dependencies[item.name] = item.spec
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

  const builderPath = join(options.dest, 'electron-builder.yml')
  writeFileSync(builderPath, readFileSync(builderPath, 'utf8')
    .replace('appId: io.github.fei2411.dsbot', 'appId: io.github.dbydd.omd')
    .replace('productName: DS Bot', `productName: ${PRODUCT_NAME}`)
    .replace('executableName: dsbot', 'executableName: omd')
    .replace("fpm: ['--replaces', 'deepseek-bot', '--conflicts', 'deepseek-bot'] # legacy package\n", ''))
  return plan
}

/**
 * The staged package.json first points at plugin source. Swap those for the
 * compiled trees so Node is not asked to strip TypeScript inside node_modules.
 * @param {string} dest
 * @param {Map<string, string>} compiled source directory to compiled directory
 */
export function pointStagedPluginsAtCompiled(dest, compiled) {
  const pkgPath = join(dest, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue
    const abs = spec.slice('file:'.length)
    const next = compiled.get(abs)
    if (next !== undefined) pkg.dependencies[name] = `file:${next}`
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

/**
 * Install the staged app and point unscoped import names at the scoped package.
 * ds-bot stays a copy (`install-links=true` in the app's .npmrc) so its own
 * imports resolve inside the app. Plugin aliases are symlinks onto that copy
 * so `omd-internal-paths` and `@dbydd/omd-internal-paths` are one module.
 * @param {string} dest
 * @param {ReturnType<typeof packPlan>} plan
 */
export function installStaged(dest, plan) {
  const npm = (args) => {
    const result = spawnSync('npm', args, { cwd: dest, stdio: 'inherit', env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' } })
    if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed in ${dest}`)
  }
  // The pinned app's lockfile is already one patch behind its package.json
  // (`ws` is required and not locked), so `npm ci` cannot install a clean
  // checkout. `npm install` resolves that and the omd file: dependencies.
  // The app's .npmrc copies file: packages (`install-links=true`); aliases are
  // replaced with symlinks afterwards.
  // The copied lock pins `ds-bot` as `file:../ds-bot`, which is correct next to
  // the submodule and wrong once the app has been copied under build/. Drop it
  // and resolve from the staged package.json, whose file: URLs are absolute.
  rmSync(join(dest, 'package-lock.json'), { force: true })
  // Plugin peer ranges are `*`. A strict install resolves those to ancient
  // prereleases (`dsh-skill@0.0.1-rc.1`) and then conflicts with 0.2.2-rc.1.
  // The versions above are already direct dependencies; peers are not a second copy.
  npm(['install', '--legacy-peer-deps'])
  const modules = join(dest, 'node_modules')
  for (const { alias, target } of plan.aliases) {
    const from = join(modules, ...alias.split('/'))
    const to = join(modules, ...target.split('/'))
    if (!existsSync(to)) throw new Error(`scoped package ${target} was not installed`)
    rmSync(from, { recursive: true, force: true })
    mkdirSync(dirname(from), { recursive: true })
    symlinkSync(relative(dirname(from), to), from)
  }
}

/**
 * electron-builder copies a symlink as a second directory. Put the unscoped
 * import names back on top of the scoped packages so both specifiers are one module.
 * @param {string} appDir
 * @param {ReturnType<typeof packPlan>} plan
 */
export function relinkPackedAliases(appDir, plan) {
  const modules = join(appDir, 'node_modules')
  for (const { alias, target } of plan.aliases) {
    const from = join(modules, ...alias.split('/'))
    const to = join(modules, ...target.split('/'))
    if (!existsSync(to)) throw new Error(`packed app is missing ${target}`)
    rmSync(from, { recursive: true, force: true })
    mkdirSync(dirname(from), { recursive: true })
    symlinkSync(relative(dirname(from), to), from)
  }
}

/**
 * @param {string} stageDir
 * @returns {string | undefined} the packed application directory
 */
export function findPackedApp(stageDir) {
  const dist = join(stageDir, 'dist-pack')
  if (!existsSync(dist)) return undefined
  const candidates = []
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (existsSync(join(path, 'src', 'omd-build.json'))) candidates.push(path)
        else walk(path, depth + 1)
      }
    }
  }
  walk(dist, 0)
  return candidates[0]
}

/**
 * @param {string} appDir packed app root (the directory that contains package.json and src/)
 * @returns {string[]}
 */
export function packedProblems(appDir) {
  const problems = []
  const build = JSON.parse(readFileSync(join(appDir, 'src', 'omd-build.json'), 'utf8'))
  if (build.dsBotCommit !== DS_BOT_PIN) problems.push(`packed pin is ${build.dsBotCommit}`)
  if (build.credentials !== 'outside-bundle') problems.push('packed build does not declare credentials outside the bundle')
  const patch = readFileSync(join(appDir, 'src', 'omd-full.patch.yml'), 'utf8')
  if (!patch.includes('name: "@dbydd/omd-workbench"')) problems.push('packed overlay does not mount @dbydd/omd-workbench')
  if (!patch.includes('name: "@dbydd/omd-chat-shell"')) problems.push('packed overlay does not mount @dbydd/omd-chat-shell')
  if (!patch.includes('name: "@dbydd/omd-project-config"')) problems.push('packed overlay does not mount @dbydd/omd-project-config')
  if (!patch.includes('name: "@dbydd/omd-context-notes"')) problems.push('packed overlay does not mount @dbydd/omd-context-notes')
  const host = readFileSync(join(appDir, 'src', 'host.mjs'), 'utf8')
  if (!host.includes('omdStackPatch()')) problems.push('packed host does not load the omd-full overlay')
  const client = readFileSync(join(appDir, 'node_modules', '@dbydd', 'omd-workbench', 'src', 'client', 'index.js'), 'utf8')
  if (moduleLoaderId(client) !== '@dbydd/omd-workbench') problems.push('packed workbench client id does not match its package name')
  const dsBotPkg = JSON.parse(readFileSync(join(appDir, 'node_modules', 'ds-bot', 'package.json'), 'utf8'))
  if (dsBotPkg.name !== 'ds-bot') problems.push('packed ds-bot package is missing')
  const alias = join(appDir, 'node_modules', 'omd-internal-paths')
  if (!existsSync(alias)) problems.push('unscoped omd-internal-paths alias is missing')
  else if (!lstatSync(alias).isSymbolicLink()) problems.push('omd-internal-paths is a second copy, not an alias of @dbydd/omd-internal-paths')
  const forbidden = []
  const scan = (dir, depth) => {
    if (depth > 3) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist-pack') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) scan(path, depth + 1)
      else if (entry.name === '.credentials.yaml' || entry.name === '.env') forbidden.push(path)
    }
  }
  scan(appDir, 0)
  for (const file of forbidden) problems.push(`credential file packed: ${file}`)
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(patch)) problems.push(`packed overlay matches ${pattern}`)
  }
  return problems
}

/**
 * @param {string[]} argv
 */
export async function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check')
  const stageOnly = argv.includes('--stage-only')
  const plan = packPlan(REPO)
  if (plan.problems.length > 0) {
    console.error(plan.problems.join('\n'))
    process.exitCode = 1
    return
  }
  console.log(`ds-bot ${DS_BOT_PIN}`)
  console.log(`bundles: ${plan.bundles.join(', ')}`)
  console.log(`plugins: ${plan.canonical.map(item => item.name).join(', ')}`)
  console.log(`aliases: ${plan.aliases.map(item => `${item.alias} -> ${item.target}`).join(', ')}`)
  if (check) return

  const dest = join(REPO, 'build', 'omd-desktop')
  const compiled = await compileOmdPlugins(REPO, join(REPO, 'build', 'compiled-plugins'))
  console.log(`staging ${dest}`)
  stageDesktop({ repo: REPO, dest })
  pointStagedPluginsAtCompiled(dest, compiled)
  if (!existsSync(join(REPO, 'external-plugins', 'dsh-motion-ui', 'package.json'))) {
    const sub = spawnSync('git', ['submodule', 'update', '--init', 'external-plugins/dsh-motion-ui'], { cwd: REPO, stdio: 'inherit' })
    if (sub.status !== 0) throw new Error('dsh-motion-ui submodule is not available')
  }
  console.log('installing the staged app')
  installStaged(dest, plan)
  if (stageOnly) {
    console.log(`staged ${dest}`)
    return
  }
  const forward = argv.filter(arg => arg !== '--stage-only' && arg !== '--check')
  const builderArgs = forward.length > 0 ? forward : ['--dir', '--linux', '--publish', 'never']
  if (!builderArgs.includes('--publish')) builderArgs.push('--publish', 'never')
  console.log(`electron-builder ${builderArgs.join(' ')}`)
  const built = spawnSync('npx', ['electron-builder', ...builderArgs], { cwd: dest, stdio: 'inherit' })
  if (built.status !== 0) throw new Error('electron-builder failed')
  const appDir = findPackedApp(dest)
  if (appDir === undefined) throw new Error(`no packed app under ${join(dest, 'dist-pack')}`)
  relinkPackedAliases(appDir, plan)
  const packed = packedProblems(appDir)
  if (packed.length > 0) throw new Error(`packed app failed checks:\n${packed.join('\n')}`)
  console.log(`packed ${appDir}`)
  console.log('Credentials were not packed. After launch, keys belong in that app\'s DSH_HOME (.credentials.yaml or apiKeyEnv), never in the bundle.')
  console.log('Linux binary: dist-pack/linux-unpacked/omd (the resources/app directory above is the host, not the executable).')
  console.log('A display is required to judge the workbench. This script proves the bundle; open the binary and check the top bar, chat shell, project config, and details tabs.')
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
