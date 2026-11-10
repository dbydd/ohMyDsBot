// Link the host runtime packages a plugin needs at run time into
// `plugins/node_modules` and `external-plugins/node_modules`, so a bare import
// inside `plugins/<pkg>/src` or `external-plugins/<pkg>` resolves. In-tree
// packages that a sibling imports by name are linked the same way, for the
// same reason: a profile link resolves them from the importer's real path.
//
// The Onlyne packages (`omd-onlyne`, `omd-compute`, `omd-issue-runner`) live
// in this tree under `plugins/`. They import each other, and the siblings
// `omd-internal-paths` and `omd-sandbox-vm`, by package specifier, so those
// names are linked here too. `@onlyne/lib` is not in this repository: when
// `ONLYNE_ROOT` points at an Onlyne checkout, its `packages/lib` is linked
// as well. A missing checkout skips only that specifier.
//
// Why this exists
// ---------------
// `dsh plugin --profile <p> add <dir>` installs an out-of-tree package as a
// `link:` dependency of the profile, so Node resolves the plugin's *own* bare
// imports from its real path (`<repo>/plugins/<pkg>/src`), walking up through
// `<repo>/plugins/<pkg>/node_modules`, `<repo>/plugins/node_modules`, … and
// never reaching `$DSH_HOME/profiles/node_modules`, which is the layer the
// profile itself resolves against. Verified on dsh 0.1.5-rc.3: a plugin under
// this repo importing `@deepseek-ai/cordis` fails with `ERR_MODULE_NOT_FOUND`
// at entry-import time.
//
// Symlinks, not copies, and not `pnpm install`: Node resolves a symlinked
// package to its realpath, so the plugin ends up holding the very same module
// instance the host holds. A second copy of a package with module-level symbol
// identity is the failure this avoids.
//
// Usage: `node plugins/link-host-runtime.mjs [--dsh-home <dir>]`
// Idempotent: an existing correct link is left alone.

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Packages every plugin in this tree may import at run time. */
const RUNTIME_PACKAGES = [
	'zod',
	'@deepseek-ai/cordis',
	'@deepseek-ai/schemastery',
	'@deepseek-ai/dsh-tools',
	'@deepseek-ai/dsh-commands',
	'@deepseek-ai/dsh-llm',
	'@deepseek-ai/dsh-agent',
	'@deepseek-ai/dsh-scope',
	'@deepseek-ai/dsh-session',
	'@deepseek-ai/dsh-session-projection',
	'@deepseek-ai/dsh-system-prompt',
	'@deepseek-ai/dsh-brand',
	'@deepseek-ai/dsh-web',
	'@deepseek-ai/dsh-home-paths',
]

/**
 * Community plugins that our own plugins import directly, and that a profile —
 * not the shared interception layer — installs. They are linked from one
 * profile's `node_modules`, because that is where pnpm put them.
 */
const PROFILE_PACKAGES = [
	'dsh-tool-lsp',
	'dsh-tool-ast-grep',
]

/**
 * In-tree packages a sibling in this repository imports by name. They resolve
 * from the importer's real path (`<repo>/plugins/<pkg>/src`), which the profile
 * never sees, so `plugins/node_modules` has to hold them too.
 */
const SIBLING_PACKAGES = [
	'omd-judge-context',
	'omd-todo',
	'omd-chart-plan',
	'omd-internal-paths',
	'omd-sandbox-vm',
	'omd-context-tavern',
	'omd-judgment',
]

const pluginsRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(pluginsRoot)

/**
 * An Onlyne checkout, whose `packages/lib` is `@onlyne/lib`. The plugins that
 * bind it live in this repository; this path is only the library.
 */
const onlyneRoot = process.env.ONLYNE_ROOT ?? join(homedir(), 'Documents', 'progs', 'onlyne')

/** In-tree Onlyne packages that import each other by package specifier. */
const ONLYNE_PACKAGES = ['omd-onlyne', 'omd-compute', 'omd-issue-runner']

/**
 * `$DSH_HOME/profiles/node_modules`, the interception layer every profile
 * resolves a missing dependency against.
 * @param {string | undefined} home
 * @returns {string}
 */
function interceptionLayer(home) {
  return join(home && home.length > 0 ? home : join(homedir(), '.dsh'), 'profiles', 'node_modules')
}

/**
 * The host packages, which every tree needs: one module instance per process.
 * @returns {Array<[string, string]>} specifier and the directory it names.
 */
function runtimeLinks() {
  return RUNTIME_PACKAGES.map(name => [name, join(layer, name)])
}

/**
 * @param {string} from link path
 * @param {string} to existing directory or file
 * @returns {'linked' | 'already' | 'repaired' | 'missing-source'}
 */
function link(from, to) {
  if (!existsSync(to)) return 'missing-source'
  const present = lstatSync(from, { throwIfNoEntry: false }) !== undefined
  if (present) {
    if (resolve(dirname(from), readlinkSync(from)) === resolve(to)) return 'already'
    rmSync(from, { recursive: true, force: true })
  }
  mkdirSync(dirname(from), { recursive: true })
  symlinkSync(to, from, 'dir')
  return present ? 'repaired' : 'linked'
}

const flagIndex = process.argv.indexOf('--dsh-home')
const dshHome = flagIndex >= 0 ? process.argv[flagIndex + 1] : process.env.DSH_HOME
const layer = interceptionLayer(dshHome)
const profileFlag = process.argv.indexOf('--from-profile')
const profile = profileFlag >= 0 ? process.argv[profileFlag + 1] : 'omd'
const profileModules = join(dirname(layer), profile, 'node_modules')

/**
 * One `node_modules` and every specifier that has to resolve inside it. A bare
 * import resolves from the importer's real path, so each tree only needs the
 * specifiers its own files name.
 * @type {Array<{ modules: string, packages: Array<[string, string]> }>}
 */
const trees = [
	{
		modules: join(pluginsRoot, 'node_modules'),
		packages: [
			...runtimeLinks(),
			...PROFILE_PACKAGES.map(name => [name, join(profileModules, name)]),
			...SIBLING_PACKAGES.map(name => [name, join(pluginsRoot, name)]),
			...ONLYNE_PACKAGES.map(name => [name, join(pluginsRoot, name)]),
			['@onlyne/lib', join(onlyneRoot, 'packages', 'lib')],
		],
	},
	...(existsSync(join(repoRoot, 'external-plugins'))
		? [{ modules: join(repoRoot, 'external-plugins', 'node_modules'), packages: runtimeLinks() }]
		: []),
	...(existsSync(join(repoRoot, 'ds-bot'))
		? [{ modules: join(repoRoot, 'node_modules'), packages: runtimeLinks() }]
		: []),
]

if (!existsSync(layer)) {
  console.error(`link-host-runtime: no interception layer at ${layer}`)
  console.error('boot a dsh profile once, or pass --dsh-home <dir>')
  process.exit(1)
}

/** Absent only when no Onlyne checkout is available. The plugins themselves are in this tree. */
const optionalOnlyne = new Set(['@onlyne/lib'])

let failed = false
for (const tree of trees) {
  for (const [specifier, to] of tree.packages) {
    const from = join(tree.modules, specifier)
    const state = link(from, to)
    if (state === 'missing-source') {
      if (optionalOnlyne.has(specifier)) {
        console.log(`${specifier}: skipped, no source at ${to}`)
      } else {
        failed = true
        console.error(`link-host-runtime: ${dirname(to)} holds no ${specifier}`)
      }
    } else {
      console.log(`${specifier}: ${state} -> ${to}`)
    }
  }
}

if (failed) process.exit(1)
console.log(
	`linked ${RUNTIME_PACKAGES.length} host package(s) from ${layer} into ${trees.length} tree(s), `
	+ `${PROFILE_PACKAGES.length} profile package(s) from ${profileModules}, `
	+ `${SIBLING_PACKAGES.length + ONLYNE_PACKAGES.length} in-tree sibling package(s), `
	+ `and @onlyne/lib from ${join(onlyneRoot, 'packages', 'lib')} when that checkout is present`,
)
