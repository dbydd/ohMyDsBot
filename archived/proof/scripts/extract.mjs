#!/usr/bin/env node
/*
Extract the `omd-kernel` composition into Lean data.

Sources, in read order:

1. `dsh --profile omd-kernel --dump-config` (profile at
   `~/.dsh/profiles/omd-kernel`). Saved verbatim to
   `proof/generated/dump.yml`; the row order, ids, package names, `disabled:`
   guards and row-level `inject:` lists come from there.
2. Installed packages, first under `~/.dsh/profiles/node_modules/@deepseek-ai/`,
   then under the dsh installation's own `node_modules/@deepseek-ai/` (the
   profile tree resolves base packages from there). The entry module is
   resolved through the package's `exports` map; its declared
   `static inject = [...]` or `const inject = [...]` gives its requirements,
   and its plugin surface gives its provides: a class it exports as default or
   mounts itself, every class that class extends — in the same module, another
   file of the package, or another installed package — and the module's own
   `ctx.provide("literal", ...)` calls.
3. `refs/deepseek-harness/docs/capability-seams.md` at commit
   687f282e8625c6b8d11ff58211a90524be2e4317, table at the `ctx key` header.
   Read only as the comparison baseline for the changed-provides report; it
   feeds no emitted data.

Modelled: which rows mount (the `disabled:` guard), what each row declares as
required services, which packages register each `ctx.*` key, the service keys
the launcher supplies before the profile tree mounts, and one dependency order
over the rows.

Left outside the model: `config:` bodies, the activation scheduler itself (the
emitted order is a rank witness, not a startup trace), dynamic
`ctx.inject(...)` calls made after activation, service names registered by
subpath entry modules or by helper modules the entry imports, `ctx.provide`
keys computed by a call rather than written as a literal or a module-level
string constant, and any package whose `inject` is computed at runtime.
*/

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const PROOF = resolve(dirname(SCRIPT), '..');
const ROOT = resolve(PROOF, '..');
const DUMP_PATH = join(PROOF, 'generated', 'dump.yml');
const SEAMS_PATH = join(ROOT, 'refs', 'deepseek-harness', 'docs', 'capability-seams.md');
const PROFILE_NM = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai');
const OUT_PATH = join(PROOF, 'Omd', 'Kernel', 'Generated.lean');

/*
 * Keys the profile rows do not provide because the launcher provides them
 * before the tree mounts. Each has to be cited when it is actually required.
 */
const EXTERNAL_SERVICES = [
  { key: 'loader', package: 'cordis-plugin-loader', file: 'lib/index.js', needle: 'provide("loader"' },
  { key: 'cmdlineArgs', package: 'dsh-cmdline', file: 'lib/index.js', needle: 'provide("cmdlineArgs"' },
  { key: 'profileContext', launcher: true, needle: 'provide("profileContext"' },
];

/* ---------------------------------------------------------------- dump.yml */

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return JSON.parse(t);
  }
  return t;
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/** Parse the dump's YAML sequence. Only the keys this model needs are read. */
function parseDump(text) {
  const rows = [];
  let row = null;
  let collectingDisabled = false;
  let disabledParts = [];
  let collectingInject = false;

  const finishDisabled = () => {
    if (!collectingDisabled || !row) return;
    row.disabled = { js: collapse(disabledParts.join(' ')) };
    collectingDisabled = false;
    disabledParts = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (line === '' || /^\s*#/.test(line)) continue;

    if (line.startsWith('- id: ')) {
      finishDisabled();
      collectingInject = false;
      row = { id: unquote(line.slice(6)), name: null, disabled: null, inject: [] };
      rows.push(row);
      continue;
    }
    if (!row) continue;

    if (collectingDisabled) {
      if (/^\s{4,}\S/.test(line)) {
        disabledParts.push(line.trim());
        continue;
      }
      finishDisabled();
    }

    if (collectingInject) {
      const item = line.match(/^ {4}- (.+)$/);
      if (item) {
        row.inject.push(unquote(item[1]));
        continue;
      }
      collectingInject = false;
    }

    const key = line.match(/^ {2}([A-Za-z][A-Za-z0-9]*):(.*)$/);
    if (!key) continue;
    const name = key[1];
    const rest = key[2].trim();

    if (name === 'name') {
      row.name = unquote(rest);
    } else if (name === 'disabled') {
      if (rest === 'true' || rest === 'false') {
        row.disabled = { literal: rest === 'true' };
      } else if (rest.startsWith('!!js')) {
        const expr = rest.slice(4).trim();
        if (expr === '' || expr === '>-' || expr === '>' || expr === '|' || expr === '|-') {
          collectingDisabled = true;
          disabledParts = [];
        } else {
          row.disabled = { js: collapse(expr) };
        }
      } else if (rest !== '') {
        throw new Error(`row ${row.id}: unrecognised disabled value: ${rest}`);
      }
    } else if (name === 'inject') {
      collectingInject = true;
    }
  }
  finishDisabled();

  for (const r of rows) {
    if (!r.name) throw new Error(`row ${r.id}: missing name`);
  }
  return rows;
}

/* ------------------------------ capability-seams.md (comparison baseline) */

/*
 * Read only to report which rows' `provides` moved. Nothing here reaches the
 * emitted Lean, so a stale table cannot make a gap look closed.
 */

function normaliseIdent(s) {
  return s
    .replace(/`/g, '')
    .trim()
    .replace(/^@deepseek-ai\//, '')
    .replace(/^dsh-/, '');
}

function collectIdents(cell, into) {
  const withoutLinks = cell.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, target) => {
    into.add(normaliseIdent(label));
    const clean = target.replace(/[#?].*$/, '').replace(/\/+$/, '');
    into.add(normaliseIdent(basename(clean)));
    return ' ';
  });
  for (const m of withoutLinks.matchAll(/`([^`]+)`/g)) {
    into.add(normaliseIdent(m[1]));
  }
}

function parseSeams(text) {
  const seams = new Map();
  let inTable = false;
  for (const line of text.split(/\r?\n/)) {
    if (!inTable) {
      if (/^\|\s*ctx key\s*\|/i.test(line)) inTable = true;
      continue;
    }
    if (!line.startsWith('|')) break;
    if (/^\|\s*-/.test(line)) continue;
    const cells = line.replace(/\|\s*$/, '').split('|').slice(1).map((s) => s.trim());
    const key = cells[0] && cells[0].match(/^`ctx\.([A-Za-z0-9_]+)`$/);
    if (!key) continue;
    const idents = new Set();
    collectIdents(cells[2] ?? '', idents);
    collectIdents(cells[3] ?? '', idents);
    idents.delete('');
    seams.set(key[1], idents);
  }
  if (seams.size === 0) throw new Error(`no ctx.* rows found in ${SEAMS_PATH}`);
  return seams;
}

/* ---------------------------------------------------------- package sources */

function splitPackageName(name) {
  const m = name.match(/^(@[^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!m) throw new Error(`not a scoped package name: ${name}`);
  return { dir: m[2], subpath: m[3] ?? null };
}

function pickTarget(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    for (const k of ['default', 'import', 'node', 'require']) {
      if (typeof v[k] === 'string') return v[k];
    }
    for (const k of Object.keys(v)) {
      const found = pickTarget(v[k]);
      if (found) return found;
    }
  }
  return null;
}

function resolveEntry(pkgDir, subpath) {
  const pkgPath = join(pkgDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const ex = pkg.exports;
  let rel = null;
  if (typeof ex === 'string') {
    rel = subpath ? null : ex;
  } else if (ex && typeof ex === 'object') {
    const key = subpath ? `./${subpath}` : '.';
    if (Object.prototype.hasOwnProperty.call(ex, key)) rel = pickTarget(ex[key]);
  }
  if (!rel && !subpath) rel = pkg.main ?? 'lib/index.js';
  return rel ? join(pkgDir, rel) : null;
}

function declaredInject(source) {
  const m = source.match(/(?:static\s+inject|(?:const|let|var)\s+inject)\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  const out = [];
  for (const s of m[1].matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    if (s[2].includes('${')) continue;
    out.push(s[2]);
  }
  return out;
}

/** Both package roots, filled by `main` before anything is resolved. */
let packageRoots = [];

function findPackageDir(name) {
  for (const root of packageRoots) {
    const dir = join(root, name);
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return null;
}

/** Resolve a module specifier the way the package loader does: entry via `exports`. */
function resolveSpecifier(fromFile, spec) {
  if (spec.startsWith('.')) {
    const base = resolve(dirname(fromFile), spec);
    for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  }
  const parts = spec.match(/^(@[^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!parts) return null;
  const dir = findPackageDir(parts[2]);
  return dir ? resolveEntry(dir, parts[3] ?? null) : null;
}

/* ---------------------------------------------------------- module reading */

/*
 * `provides` is read off the code that registers a service. The surface is a
 * class the module exports as default or mounts itself (`new X(...)`,
 * `ctx.plugin(X)`), plus the module's own `ctx.provide` calls. A class
 * registers what `super(ctx, "key")` in its body registers, otherwise what its
 * parent registers, following `extends` into other installed packages. Only a
 * class descending from Cordis's `Service` takes `(ctx, key)` in its
 * constructor, which is what separates a registration from an error class
 * calling `super(message, "CODE")`.
 *
 * Bundled dependencies that sit in the file without being exported or mounted
 * stay out: a dead copy of a service class must not claim its key. A
 * `super(...)` call belongs to the nearest preceding class header, the
 * innermost class it can be written in.
 */

const MODULE_CACHE = new Map();

const CLASS_DEF =
  /(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)?\s*=\s*class(?:\s+([A-Za-z_$][\w$]*))?(?:\s+extends\s+([A-Za-z_$][\w$]*))?\s*\{|\bclass\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*))?\s*\{/g;

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Blank out comments, so a `provide(...)` quoted in a doc block is not read as code. */
function stripComments(text) {
  const out = text.split('');
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 2;
      else {
        if (c === quote) quote = null;
        i += 1;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < text.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function readModule(file) {
  const cached = MODULE_CACHE.get(file);
  if (cached) return cached;

  const text = readFileSync(file, 'utf8');
  const starts = lineIndex(text);
  const code = stripComments(text);

  const imports = new Map();
  for (const m of code.matchAll(/\bimport\s+(?!\()([\s\S]*?)\s+from\s*(["'])([^"']+)\2/g)) {
    const spec = m[3];
    const clause = m[1].trim();
    const braces = clause.match(/\{([\s\S]*)\}/);
    const outside = braces ? clause.replace(braces[0], ' ') : clause;
    for (const part of outside.split(',')) {
      const t = part.trim();
      const ns = t.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (ns) imports.set(ns[1], { spec, imported: null });
      else if (/^[A-Za-z_$][\w$]*$/.test(t)) imports.set(t, { spec, imported: 'default' });
    }
    if (!braces) continue;
    for (const part of braces[1].split(',')) {
      const t = part.trim();
      const as = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (as) imports.set(as[2], { spec, imported: as[1] });
      else if (/^[A-Za-z_$][\w$]*$/.test(t)) imports.set(t, { spec, imported: t });
    }
  }

  const exported = new Map();
  const reexports = new Map();
  const star = [];
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}(?:\s*from\s*(["'])([^"']+)\2)?/g)) {
    const from = m[3] ?? null;
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t || t.startsWith('type ')) continue;
      const as = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      const local = as ? as[1] : /^[A-Za-z_$][\w$]*$/.test(t) ? t : null;
      const name = as ? as[2] : local;
      if (!name || !local) continue;
      if (from) reexports.set(name, { local, from });
      else exported.set(name, local);
    }
  }
  for (const m of code.matchAll(/\bexport\s*\*\s*from\s*(["'])([^"']+)\1/g)) star.push(m[2]);
  for (const m of code.matchAll(/\bexport\s+(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (!exported.has(m[1])) exported.set(m[1], m[1]);
  }
  const defaultRef = code.match(/\bexport\s+default\s+(?:class\s+|function\s+)?([A-Za-z_$][\w$]*)/);
  if (defaultRef) exported.set('default', defaultRef[1]);

  const defs = [];
  for (const m of code.matchAll(CLASS_DEF)) {
    const parent = m[3] ?? m[5] ?? null;
    if (m[1]) defs.push({ name: m[1], parent, index: m.index });
    if (m[2] && m[2] !== m[1]) defs.push({ name: m[2], parent, index: m.index });
    if (m[4]) defs.push({ name: m[4], parent, index: m.index });
  }
  defs.sort((a, b) => a.index - b.index);

  const aliases = new Map();
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g,
  )) {
    aliases.set(m[1], m[2]);
  }

  const supers = [];
  for (const m of code.matchAll(
    /\bsuper\(\s*[A-Za-z_$][\w$]*\s*,\s*(['"`])([A-Za-z0-9_$]+)\1\s*\)/g,
  )) {
    supers.push({ key: m[2], index: m.index, line: lineAt(starts, m.index), owner: null });
  }
  for (const s of supers) {
    for (const d of defs) {
      if (d.index < s.index) s.owner = d.name;
      else break;
    }
  }

  const stringConstants = new Map();
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([A-Za-z0-9_$]+)\2\s*;/g,
  )) {
    stringConstants.set(m[1], m[3]);
  }
  const provides = [];
  for (const m of code.matchAll(
    /\.provide\(\s*(?:([A-Za-z_$][\w$]*)(?:\s*,|\s*\))|(['"`])([A-Za-z0-9_$]+)\2)/g,
  )) {
    const key = m[1] ? stringConstants.get(m[1]) : m[3];
    if (key) provides.push({ key, index: m.index, line: lineAt(starts, m.index) });
  }

  const mod = { file, code, imports, exported, reexports, star, defs, aliases, supers, provides };
  MODULE_CACHE.set(file, mod);
  return mod;
}

/**
 * Whether `name` descends from Cordis's `Service`. Only a Service constructor
 * takes `(ctx, key)`, so this separates a registration from an error class
 * whose constructor calls `super(message, "CODE")`.
 */
function isServiceClass(mod, name, seen, depth) {
  const id = `${mod.file}#${name}`;
  if (seen.has(id) || depth > 8) return false;
  seen.add(id);

  for (const def of mod.defs.filter((d) => d.name === name)) {
    if (!def.parent) continue;
    const parent =
      !mod.defs.some((d) => d.name === def.parent) && mod.aliases.has(def.parent)
        ? mod.aliases.get(def.parent)
        : def.parent;
    if (mod.defs.some((d) => d.name === parent)) {
      if (isServiceClass(mod, parent, seen, depth + 1)) return true;
      continue;
    }
    const imported = mod.imports.get(parent);
    if (!imported) continue;
    if (parent === 'Service' && /^@deepseek-ai\/cordis$/.test(imported.spec)) return true;
    const target = resolveSpecifier(mod.file, imported.spec);
    if (!target) continue;
    const targetMod = readModule(target);
    const local = targetMod.exported.get(parent) ?? parent;
    if (isServiceClass(targetMod, local, seen, depth + 1)) return true;
  }
  return false;
}

/** Keys a class registers itself, or else the keys its parent registers. */
function classKeys(mod, name, seen, depth) {
  const id = `${mod.file}#${name}`;
  if (seen.has(id) || depth > 8) return null;
  seen.add(id);

  const defs = mod.defs.filter((d) => d.name === name);
  if (defs.length === 0) {
    const re = mod.reexports.get(name);
    const candidates = re ? [re.from] : mod.star;
    for (const from of candidates) {
      const target = resolveSpecifier(mod.file, from);
      if (!target) continue;
      const found = classKeys(readModule(target), re?.local ?? name, seen, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const keys = new Map();
  if (isServiceClass(mod, name, new Set(), 0)) {
    for (const def of defs) {
      for (const s of mod.supers) {
        if (s.owner === def.name) {
          keys.set(s.key, { key: s.key, file: mod.file, line: s.line, via: [name] });
        }
      }
    }
  }
  for (const def of defs) {
    if (!def.parent) continue;
    let up = null;
    const parent =
      !mod.defs.some((d) => d.name === def.parent) && mod.aliases.has(def.parent)
        ? mod.aliases.get(def.parent)
        : def.parent;
    if (mod.defs.some((d) => d.name === parent)) {
      up = classKeys(mod, parent, seen, depth + 1);
    } else {
      const imported = mod.imports.get(parent);
      const target = imported ? resolveSpecifier(mod.file, imported.spec) : null;
      if (target) up = classKeys(readModule(target), parent, seen, depth + 1);
    }
    if (!up) continue;
    for (const k of up.keys) {
      if (!keys.has(k.key)) keys.set(k.key, { ...k, via: [name, ...k.via] });
    }
  }
  if (keys.size === 0) return null;
  return { keys: [...keys.values()] };
}

/** Service keys the row's entry module registers, with the line that registers each. */
function codeProvides(entryPath) {
  const mod = readModule(entryPath);
  const out = new Map();

  const surface = new Set();
  const exportedDefault = mod.exported.get('default');
  if (exportedDefault) surface.add(exportedDefault);
  for (const m of mod.code.matchAll(/(?:\bnew\s+|\.plugin\(\s*)([A-Za-z_$][\w$]*)/g)) {
    if (mod.defs.some((d) => d.name === m[1])) surface.add(m[1]);
  }
  for (const name of surface) {
    const found = classKeys(mod, name, new Set(), 0);
    for (const k of found?.keys ?? []) if (!out.has(k.key)) out.set(k.key, k);
  }
  for (const p of mod.provides) {
    if (!out.has(p.key)) out.set(p.key, { key: p.key, file: mod.file, line: p.line });
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/* --------------------------------------------------------------- citations */

/** First line of `file` containing `needle`, as `file:line`. */
function cite(file, needle) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`citation not found in ${file}: ${needle}`);
  return `${file}:${index + 1}`;
}

function citeInDir(dir, pattern, needle) {
  for (const name of readdirSync(dir).sort()) {
    if (!pattern.test(name)) continue;
    const file = join(dir, name);
    if (readFileSync(file, 'utf8').includes(needle)) return cite(file, needle);
  }
  throw new Error(`citation not found in ${dir} matching ${pattern}: ${needle}`);
}

/* ------------------------------------------------------------------ guards */

const leanString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const leanStrings = (xs) => `[${xs.map(leanString).join(', ')}]`;

const ALWAYS = { op: 'always' };
const NEVER = { op: 'never' };
const atom = (name) => ({ op: 'atom', name });
const neg = (c) => ({ op: 'neg', c });
const all = (a, b) => ({ op: 'all', a, b });

function leanCond(c) {
  switch (c.op) {
    case 'always':
      return '.always';
    case 'never':
      return '.never';
    case 'atom':
      return `.atom ${leanString(c.name)}`;
    case 'neg':
      return `.neg (${leanCond(c.c)})`;
    case 'all':
      return `.all (${leanCond(c.a)}) (${leanCond(c.b)})`;
    case 'any':
      return `.any (${leanCond(c.a)}) (${leanCond(c.b)})`;
    default:
      throw new Error(`unknown condition: ${JSON.stringify(c)}`);
  }
}

function atomsOf(c, into) {
  if (c.op === 'atom') into.add(c.name);
  else if (c.op === 'neg') atomsOf(c.c, into);
  else if (c.op === 'all' || c.op === 'any') {
    atomsOf(c.a, into);
    atomsOf(c.b, into);
  }
  return into;
}

function evalCond(c, asg) {
  switch (c.op) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'atom':
      return asg.get(c.name) ?? false;
    case 'neg':
      return !evalCond(c.c, asg);
    case 'all':
      return evalCond(c.a, asg) && evalCond(c.b, asg);
    case 'any':
      return evalCond(c.a, asg) || evalCond(c.b, asg);
    default:
      throw new Error(`unknown condition: ${JSON.stringify(c)}`);
  }
}

const GUARD_TABLE = new Map([
  ["process.platform === 'win32'", { cond: atom('win32') }],
  ["process.platform !== 'win32'", { cond: neg(atom('win32')) }],
  ["!ctx.get('profileContext')", { cond: NEVER }],
  [
    '!(process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME)',
    { cond: neg(atom('primary-runtime')) },
  ],
  [
    '!(process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME) && !process.env.DSH_BUNDLED_OFFICE_CLI',
    { cond: all(neg(atom('primary-runtime')), neg(atom('office-cli'))) },
  ],
]);

/** Follow unplaced providers from one stalled row until an id repeats. */
function findCycle(pending, placed, externalKeys, providersOf) {
  const pendingIds = new Set(pending.map((r) => r.id));
  const byId = new Map(pending.map((r) => [r.id, r]));
  const edges = new Map();
  const seen = new Map();
  let current = pending[0].id;
  while (!seen.has(current)) {
    seen.set(current, seen.size);
    const row = byId.get(current);
    const key = row.requires.find(
      (k) => !externalKeys.includes(k) && !providersOf(k).some((p) => placed.has(p.id)),
    );
    const provider = key === undefined ? undefined : providersOf(key).find((p) => pendingIds.has(p.id));
    if (provider === undefined) {
      return [{ id: current, key: key ?? '(all requirements met)', next: '(no pending provider)' }];
    }
    edges.set(current, { id: current, key, next: provider.id });
    current = provider.id;
  }
  const ids = [...seen.keys()].slice(seen.get(current));
  return ids.map((id) => edges.get(id));
}

/* -------------------------------------------------------------------- main */

function main() {
  const dumpRaw = execFileSync('dsh', ['--profile', 'omd-kernel', '--dump-config'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  mkdirSync(dirname(DUMP_PATH), { recursive: true });
  writeFileSync(DUMP_PATH, dumpRaw);

  const dshBin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
  const dshRoot = resolve(dirname(realpathSync(dshBin)), '..');
  packageRoots = [PROFILE_NM, join(dshRoot, 'node_modules', '@deepseek-ai')];

  const rows = parseDump(dumpRaw);

  for (const row of rows) {
    if (row.disabled && row.disabled.js !== undefined) {
      const entry = GUARD_TABLE.get(row.disabled.js);
      if (!entry) {
        console.error(`row ${row.id}: no guard mapping for: ${row.disabled.js}`);
        process.exit(1);
      }
      row.guard = entry.cond;
    } else if (row.disabled && row.disabled.literal === true) {
      row.guard = ALWAYS;
    } else {
      row.guard = NEVER;
    }
  }

  /* Comparison baseline only: the seam table no longer decides any emitted key. */
  const seams = parseSeams(readFileSync(SEAMS_PATH, 'utf8'));

  const problems = [];
  for (const row of rows) {
    const { dir, subpath } = splitPackageName(row.name);
    row.alias = normaliseIdent(dir);
    row.packageDir = findPackageDir(dir);

    if (!row.packageDir) {
      row.source = `missing: ${row.name}`;
      row.moduleInject = null;
      row.moduleNote = 'package not installed in either package root';
      problems.push(`row ${row.id}: package not installed: ${row.name}`);
      continue;
    }
    let entryPath = null;
    try {
      entryPath = resolveEntry(row.packageDir, subpath);
    } catch (err) {
      problems.push(`row ${row.id}: unreadable package.json: ${err.message}`);
    }
    if (!entryPath || !existsSync(entryPath)) {
      row.source = `missing: ${row.name}`;
      row.moduleInject = null;
      row.moduleNote = 'entry module not resolvable from exports';
      problems.push(`row ${row.id}: entry module not resolvable: ${row.name} (${entryPath})`);
      continue;
    }
    row.source = entryPath;
    row.entryPath = entryPath;
    const moduleInject = declaredInject(readFileSync(entryPath, 'utf8'));
    row.moduleInject = moduleInject ?? [];
    row.moduleNote = moduleInject === null ? 'no declared inject in entry module' : null;
  }

  const provideEvidence = new Map();
  for (const row of rows) {
    const keys = row.entryPath ? codeProvides(row.entryPath) : [];
    provideEvidence.set(row.id, keys);
    row.provides = keys.map((k) => k.key).sort();
    row.requires = [...new Set([...row.inject, ...(row.moduleInject ?? [])])].sort();
  }

  const providesBefore = new Map(
    rows.map((row) => {
      const keys = [...seams].filter(([, idents]) => idents.has(row.alias)).map(([key]) => key);
      return [row.id, [...new Set(keys)].sort()];
    }),
  );
  const providesChanged = rows.filter(
    (row) => JSON.stringify(providesBefore.get(row.id)) !== JSON.stringify(row.provides),
  );

  const externalCites = new Map();
  for (const service of EXTERNAL_SERVICES) {
    try {
      if (service.launcher) {
        externalCites.set(service.key, citeInDir(join(dshRoot, 'lib'), /^profile-boot.*\.js$/, service.needle));
      } else {
        const dir = findPackageDir(service.package);
        externalCites.set(
          service.key,
          dir ? cite(join(dir, service.file), service.needle) : `missing: @deepseek-ai/${service.package}`,
        );
      }
    } catch (err) {
      externalCites.set(service.key, `uncited: ${err.message}`);
    }
  }

  const requiredKeys = [...new Set(rows.flatMap((r) => r.requires))].sort();
  const rowProvides = (key) => rows.some((r) => r.provides.includes(key));
  const externalKeys = EXTERNAL_SERVICES.filter(
    (service) => requiredKeys.includes(service.key) && !rowProvides(service.key),
  ).map((service) => service.key);

  const requirementReport = [];
  const unresolved = [];
  for (const row of rows) {
    for (const key of row.requires) {
      const providers = rows.filter((p) => p.provides.includes(key));
      const external = externalKeys.includes(key);
      if (providers.length === 0 && !external) unresolved.push({ row: row.id, key });
      requirementReport.push({ row: row.id, key, providers, external });
    }
  }

  const atoms = [...new Set(rows.flatMap((r) => [...atomsOf(r.guard, new Set())]))].sort();
  const isEnabled = (row, asg) => !evalCond(row.guard, asg);
  const closureGaps = [];
  for (let bits = 0; bits < 1 << atoms.length; bits += 1) {
    const asg = new Map(atoms.map((name, i) => [name, Boolean(bits & (1 << i))]));
    for (const row of rows) {
      if (!isEnabled(row, asg)) continue;
      for (const key of row.requires) {
        if (externalKeys.includes(key)) continue;
        if (!rows.some((p) => isEnabled(p, asg) && p.provides.includes(key))) {
          closureGaps.push({ asg, row: row.id, key });
        }
      }
    }
  }

  const providersOf = (key) => rows.filter((p) => p.provides.includes(key));
  const placed = new Set();
  const order = [];
  let pending = rows.slice();
  let cycle = null;
  while (pending.length > 0) {
    const next = pending.find((e) =>
      e.requires.every(
        (k) => externalKeys.includes(k) || providersOf(k).some((p) => placed.has(p.id)),
      ),
    );
    if (!next) {
      cycle = findCycle(pending, placed, externalKeys, providersOf);
      break;
    }
    placed.add(next.id);
    order.push(next.id);
    pending = pending.filter((r) => r !== next);
  }
  if (cycle === null) {
    for (const row of rows) {
      for (const key of row.requires) {
        if (externalKeys.includes(key)) continue;
        const positions = providersOf(key).map((p) => order.indexOf(p.id));
        if (!positions.some((i) => i < order.indexOf(row.id))) {
          throw new Error(`order does not precede row ${row.id} with a provider of ${key}`);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- report */

  const assignmentLabel = (asg) =>
    atoms.length === 0 ? '(no atoms)' : atoms.map((name) => `${name}=${asg.get(name) ? 1 : 0}`).join(', ');
  const evidenceOf = (rowId, key) => {
    const found = (provideEvidence.get(rowId) ?? []).find((k) => k.key === key);
    return found ? `${found.file}:${found.line}` : '(uncited)';
  };
  const out = [];
  out.push(`dump:  ${DUMP_PATH}`);
  out.push(`seam table (comparison baseline only): ${SEAMS_PATH} (commit 687f282e8625c6b8d11ff58211a90524be2e4317)`);
  out.push(`package roots: ${packageRoots.join(', ')}`);
  out.push(`rows:  ${rows.length}`);
  out.push(`enabled rows (guard not .always): ${rows.filter((r) => r.guard.op !== 'always').length}`);
  out.push(`atoms: ${atoms.join(', ') || '(none)'}`);
  out.push('');
  out.push('rows (dump order):');
  for (const row of rows) {
    out.push(
      `  ${row.id}  package=${row.name}  guard=${leanCond(row.guard)}  ` +
        `provides=[${row.provides.join(',')}]  requires=[${row.requires.join(',')}]  source=${row.source}`,
    );
    if (row.moduleNote) out.push(`    note: ${row.moduleNote}`);
  }
  out.push('');
  out.push('provides read from code:');
  if (rows.every((row) => (provideEvidence.get(row.id) ?? []).length === 0)) out.push('  (none)');
  for (const row of rows) {
    for (const k of provideEvidence.get(row.id) ?? []) {
      const via = k.via && k.via.length > 1 ? `  via ${k.via.join(' -> ')}` : '';
      out.push(`  row ${row.id} -> ${k.key} <- ${k.file}:${k.line}${via}`);
    }
  }
  out.push('');
  out.push('requires:');
  for (const { row, key, providers, external } of requirementReport) {
    const by = providers.length
      ? providers
          .map((p) => `${p.name} (row ${p.id}, guard ${leanCond(p.guard)}, provides at ${evidenceOf(p.id, key)})`)
          .join(', ')
      : external
        ? `external ${key}: ${externalCites.get(key)}`
        : 'no provider';
    out.push(`  ${row}: ${key} <- ${by}`);
  }
  out.push('');
  out.push('provided outside the profile rows:');
  if (externalKeys.length === 0) out.push('  (none required)');
  for (const key of externalKeys) out.push(`  ${key} <- ${externalCites.get(key)}`);
  out.push('');
  out.push('provides changed from the seam-table derivation:');
  if (providesChanged.length === 0) out.push('  (none)');
  for (const row of providesChanged) {
    out.push(`  ${row.id}: [${providesBefore.get(row.id).join(',')}] -> [${row.provides.join(',')}]`);
  }
  out.push('');
  const selfLoops = rows.flatMap((row) =>
    row.requires.filter((key) => row.provides.includes(key)).map((key) => ({ row, key })),
  );
  out.push('rows that provide a key they require:');
  if (selfLoops.length === 0) out.push('  (none)');
  for (const { row, key } of selfLoops) {
    const others = providersOf(key).filter((p) => p.id !== row.id).map((p) => p.id);
    out.push(
      `  row ${row.id} requires and provides ${key}; other providers of ${key}: ` +
        `${others.length ? others.join(', ') : '(none)'}`,
    );
  }
  out.push('');
  out.push(`closure over assignments (${atoms.length} atoms, ${1 << atoms.length} assignments):`);
  if (closureGaps.length === 0) out.push('  none');
  for (const gap of closureGaps) {
    out.push(`  ${assignmentLabel(gap.asg)}: row ${gap.row} requires ${gap.key}: every provider disabled`);
  }
  out.push('');
  if (cycle === null) {
    out.push(`topological order: ${order.length} entries`);
    out.push(`  ${order.join(', ')}`);
  } else {
    out.push('topological order: CYCLE');
    for (const step of cycle) out.push(`  ${step.id} -[${step.key}]-> ${step.next}`);
  }
  out.push('');
  if (unresolved.length) {
    out.push(`unresolved requirements: ${unresolved.length}`);
    for (const u of unresolved) out.push(`  row ${u.row} requires ${u.key}: no row provider and not external`);
  } else {
    out.push('unresolved requirements: none');
  }
  for (const p of problems) out.push(`problem: ${p}`);

  if (cycle !== null) {
    console.log(out.join('\n'));
    console.log('');
    console.log('no Generated.lean written: the requirement graph has a cycle');
    process.exit(1);
  }

  /* ------------------------------------------------------------- Lean data */

  const lean = [];
  lean.push('import Omd.Basic');
  lean.push('namespace Omd.Kernel');
  lean.push('');
  lean.push('/-- Platform atoms the composed guards depend on. -/');
  lean.push(`def atoms : List String := ${leanStrings(atoms)}`);
  lean.push('');
  lean.push('/-- Service keys a mounted row does not provide because the launcher does.');
  lean.push('');
  lean.push('Each entry names the module that provides it; the kernel\'s closure statement is');
  lean.push('"provided by a row, or in this list", so nothing is treated as provided by');
  lean.push('silence. -/');
  lean.push(`def external : List String := ${leanStrings(externalKeys)}`);
  lean.push('');
  lean.push('/-- Entry ids in dependency order: for every row and each of its required');
  lean.push('keys outside `external`, at least one provider of that key appears strictly');
  lean.push('earlier in this list. Generated from the same graph as `requires` and `provides`. -/');
  lean.push(`def order : List String := ${leanStrings(order)}`);
  lean.push('');
  lean.push('/-- The composed rows of the `omd-kernel` profile, in dump order. -/');
  lean.push('def kernel : List Entry := [');
  for (const row of rows) {
    lean.push(
      `  { id := ${leanString(row.id)}, package := ${leanString(row.name)}, ` +
        `provides := ${leanStrings(row.provides)}, requires := ${leanStrings(row.requires)}, ` +
        `guard := ${leanCond(row.guard)} },`,
    );
  }
  lean.push(']');
  lean.push('');
  lean.push('/-- For each row, the entry module its `requires` and `provides` were read from. -/');
  lean.push(
    `def sources : List (String × String) := [${rows
      .map((row) => `(${leanString(row.id)}, ${leanString(row.source)})`)
      .join(', ')}]`,
  );
  lean.push('end Omd.Kernel');
  lean.push('');

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, lean.join('\n'));

  console.log(out.join('\n'));
  console.log('');
  console.log(`wrote ${OUT_PATH}`);

  if (unresolved.length) process.exit(1);
}

main();
