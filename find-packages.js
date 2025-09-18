#!/usr/bin/env node
/**
 * Deep dependency finder for node_modules (direct + transitive, any package manager).
 * Features:
 *  - Scans installed packages (direct + transitive) inside node_modules
 *  - Reads npm (package-lock.json, npm-shrinkwrap.json), Yarn classic (yarn.lock), pnpm (pnpm-lock.yaml/.yml) lockfiles, and package.json manifests
 *  - Matches against name@version (version optional)
 *  - Colored output (disable with --no-color)
 *  - Restrict scan to a subdirectory via --path <dir>
 *
 * Usage:
 *   node find-packages.js -f packages.txt
 *   node find-packages.js -f packages.txt --json
 *   node find-packages.js -f packages.txt --path apps/web
 *   node find-packages.js -f packages.txt --no-color
 *   node find-packages.js -f packages.txt --scan lockfile
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// --- ANSI colors (toggle via --no-color) ---
let USE_COLOR = true;
const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  bold: "\x1b[1m",
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const paint = (txt, color) =>
  USE_COLOR ? color + txt + ANSI.reset : String(txt);

// --- args ---
const args = process.argv.slice(2);
let file = null;
let jsonOut = false;
let scanPath = null;
const DEFAULT_SCAN_SOURCES = ["node_modules", "lockfile"];
const VALID_SCAN_SOURCES = new Set(DEFAULT_SCAN_SOURCES);
const LOCKFILE_PARSERS = new Map([
  ["package-lock.json", parseNpmLockfile],
  ["npm-shrinkwrap.json", parseNpmLockfile],
  ["package.json", parsePackageManifest],
  ["yarn.lock", parseYarnLockfile],
  ["pnpm-lock.yaml", parsePnpmLockfile],
  ["pnpm-lock.yml", parsePnpmLockfile],
]);
const SUPPORTED_LOCKFILENAMES = new Set(LOCKFILE_PARSERS.keys());
const scanSources = new Set(DEFAULT_SCAN_SOURCES);
let scanSpecified = false;
let verbose = false;
const versionRangeWarnings = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if ((a === "-f" || a === "--file") && args[i + 1]) {
    file = args[++i];
    continue;
  }
  if (a === "--json") {
    jsonOut = true;
    continue;
  }
  if (a === "--no-color") {
    USE_COLOR = false;
    continue;
  }
  if (a === "--verbose" || a === "-v") {
    verbose = true;
    continue;
  }
  if ((a === "--path" || a === "-p") && args[i + 1]) {
    scanPath = args[++i];
    continue;
  }
  if ((a === "--scan" || a === "-s") && args[i + 1]) {
    const raw = args[++i];
    const parts = raw
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    if (!parts.length) continue;
    if (parts.includes("both")) {
      scanSources.clear();
      for (const src of DEFAULT_SCAN_SOURCES) scanSources.add(src);
      scanSpecified = true;
      continue;
    }
    const invalid = parts.filter((p) => !VALID_SCAN_SOURCES.has(p));
    if (invalid.length) {
      console.error(
        `Error: invalid --scan value(s): ${invalid.join(", ")}. ` +
          `Valid options are: node_modules, lockfile, both`,
      );
      process.exit(2);
    }
    if (!scanSpecified) {
      scanSources.clear();
      scanSpecified = true;
    }
    for (const p of parts) scanSources.add(p);
    continue;
  }
  if (a === "-h" || a === "--help") {
    console.log(`Usage:
  node find-packages.js -f packages.txt [--json] [--no-color] [--path <dir>] [--scan <sources>] [--verbose]

Options:
  -f, --file     Path to the package list file (one line per name@version; version optional)
  --json         Output results as JSON (includes summary)
  --no-color     Disable ANSI colors in text output
  -v, --verbose  Print the full table of all packages (default shows only matches)
  -p, --path     Restrict scan to a specific subdirectory (e.g. apps/web). Default: current working directory
  -s, --scan     Select data sources: node_modules, lockfile, both. Default: both (option can be repeated or comma-separated)
                 Lockfile scanning understands package-lock.json, npm-shrinkwrap.json, package.json, yarn.lock, and pnpm-lock.yaml/.yml
`);
    process.exit(0);
  }
}

if (!file) {
  console.error("Error: please provide -f <file>");
  process.exit(2);
}

if (!scanSources.size) {
  for (const src of DEFAULT_SCAN_SOURCES) scanSources.add(src);
}

// --- core helpers ---
const parsedSemverCache = new Map();
const versionRangeWarningSet = new Set();

function parseSemver(version) {
  if (parsedSemverCache.has(version)) return parsedSemverCache.get(version);
  if (typeof version !== "string") {
    parsedSemverCache.set(version, null);
    return null;
  }
  const trimmed = version.trim();
  const match = trimmed.match(
    /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/,
  );
  if (!match) {
    parsedSemverCache.set(version, null);
    return null;
  }
  const [, maj, min, pat, pre, build] = match;
  const toInt = (v) => (v == null ? 0 : Number.parseInt(v, 10));
  const major = toInt(maj);
  const minor = toInt(min);
  const patch = toInt(pat);
  if (
    Number.isNaN(major) ||
    Number.isNaN(minor) ||
    Number.isNaN(patch)
  ) {
    parsedSemverCache.set(version, null);
    return null;
  }
  const prerelease = pre ? pre.split(/[.-]/).filter(Boolean) : [];
  const buildMeta = build ? build.split(/[.-]/).filter(Boolean) : [];
  const result = {
    major,
    minor,
    patch,
    prerelease,
    build: buildMeta,
    raw: trimmed,
  };
  parsedSemverCache.set(version, result);
  return result;
}

function cloneVersion(v) {
  return {
    major: v.major,
    minor: v.minor,
    patch: v.patch,
    prerelease: Array.from(v.prerelease || []),
    build: Array.from(v.build || []),
    raw: v.raw || `${v.major}.${v.minor}.${v.patch}`,
  };
}

function compareIdentifiers(a, b) {
  if (a === b) return 0;
  const isNumeric = /^\d+$/;
  const aNum = isNumeric.test(a);
  const bNum = isNumeric.test(b);
  if (aNum && bNum) {
    const aInt = Number.parseInt(a, 10);
    const bInt = Number.parseInt(b, 10);
    if (aInt === bInt) return 0;
    return aInt < bInt ? -1 : 1;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : 1;
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  const aPre = a.prerelease || [];
  const bPre = b.prerelease || [];
  if (!aPre.length && !bPre.length) return 0;
  if (!aPre.length) return 1;
  if (!bPre.length) return -1;
  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    const aId = aPre[i];
    const bId = bPre[i];
    if (aId == null) return -1;
    if (bId == null) return 1;
    const cmp = compareIdentifiers(aId, bId);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function isWildcardToken(token) {
  if (!token) return false;
  const lower = token.toLowerCase();
  return lower === "*" || lower === "x";
}

function parseVersionToken(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("empty version segment");
  if (isWildcardToken(trimmed)) {
    return { any: true, raw: trimmed };
  }

  let base = trimmed;
  let build = null;
  let prerelease = null;

  const plusIndex = base.indexOf("+");
  if (plusIndex !== -1) {
    build = base.slice(plusIndex + 1);
    base = base.slice(0, plusIndex);
  }
  const hyphenIndex = base.indexOf("-");
  if (hyphenIndex !== -1) {
    prerelease = base.slice(hyphenIndex + 1);
    base = base.slice(0, hyphenIndex);
  }

  const rawParts = base.split(".");
  if (rawParts.length > 3) throw new Error(`too many version segments in "${trimmed}"`);
  const precision = rawParts.length;
  const parts = rawParts.slice();
  while (parts.length < 3) parts.push("0");

  if (isWildcardToken(parts[0])) {
    return { any: true, raw: trimmed };
  }

  const wildcardLevels = { minor: false, patch: false };

  const parsePart = (value, label) => {
    if (isWildcardToken(value)) {
      if (label === "minor") wildcardLevels.minor = true;
      if (label === "patch") wildcardLevels.patch = true;
      return 0;
    }
    if (!/^\d+$/.test(value)) throw new Error(`invalid numeric value in "${trimmed}"`);
    return Number.parseInt(value, 10);
  };

  const major = parsePart(parts[0], "major");
  const minor = parsePart(parts[1], "minor");
  const patch = parsePart(parts[2], "patch");

  if (!Number.isSafeInteger(major) || major < 0)
    throw new Error(`invalid major version in "${trimmed}"`);
  if (!Number.isSafeInteger(minor) || minor < 0)
    throw new Error(`invalid minor version in "${trimmed}"`);
  if (!Number.isSafeInteger(patch) || patch < 0)
    throw new Error(`invalid patch version in "${trimmed}"`);

  if (precision === 1) wildcardLevels.minor = true;
  if (precision <= 2) wildcardLevels.patch = wildcardLevels.patch || precision === 2;

  const prereleaseParts = prerelease
    ? prerelease.split(/[.-]/).filter(Boolean)
    : [];
  const buildParts = build ? build.split(/[.-]/).filter(Boolean) : [];

  return {
    any: false,
    precision,
    wildcardMinor: wildcardLevels.minor,
    wildcardPatch: wildcardLevels.patch,
    version: {
      major,
      minor,
      patch,
      prerelease: prereleaseParts,
      build: buildParts,
      raw: trimmed,
    },
  };
}

function normalizeBase(version, { resetMinor = false, resetPatch = false } = {}) {
  const v = cloneVersion(version);
  if (resetMinor) v.minor = 0;
  if (resetPatch) v.patch = 0;
  v.prerelease = [];
  v.build = [];
  v.raw = `${v.major}.${v.minor}.${v.patch}`;
  return v;
}

function incrementVersion(version, level) {
  const v = normalizeBase(version, { resetPatch: level !== "patch", resetMinor: level === "major" });
  if (level === "major") {
    v.major += 1;
    v.minor = 0;
    v.patch = 0;
  } else if (level === "minor") {
    v.minor += 1;
    v.patch = 0;
  } else {
    v.patch += 1;
  }
  v.prerelease = [];
  v.raw = `${v.major}.${v.minor}.${v.patch}`;
  return v;
}

function createComparator(op, version) {
  return { op, version };
}

function expandTilde(token) {
  if (token.any) return [];
  const base = cloneVersion(token.version);
  const lower = createComparator(">=", normalizeBase(base));
  let upperVersion;
  if (token.precision <= 1) {
    upperVersion = incrementVersion(base, "major");
  } else {
    upperVersion = incrementVersion(base, "minor");
  }
  const upper = createComparator("<", normalizeBase(upperVersion));
  return [lower, upper];
}

function expandCaret(token) {
  if (token.any) return [];
  const base = cloneVersion(token.version);
  const lower = createComparator(">=", normalizeBase(base));
  let upperVersion;
  if (base.major > 0) {
    upperVersion = { major: base.major + 1, minor: 0, patch: 0, prerelease: [], build: [], raw: `${base.major + 1}.0.0` };
  } else if (base.minor > 0) {
    upperVersion = { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [], build: [], raw: `${base.major}.${base.minor + 1}.0` };
  } else {
    upperVersion = { major: base.major, minor: base.minor, patch: base.patch + 1, prerelease: [], build: [], raw: `${base.major}.${base.minor}.${base.patch + 1}` };
  }
  const upper = createComparator("<", upperVersion);
  return [lower, upper];
}

function expandBareVersion(token) {
  if (token.any) return [];
  const base = cloneVersion(token.version);
  if (token.wildcardMinor || token.precision === 1) {
    const lower = createComparator(">=", normalizeBase(base, { resetMinor: false, resetPatch: true }));
    const upper = createComparator(
      "<",
      normalizeBase({
        major: base.major + 1,
        minor: 0,
        patch: 0,
        prerelease: [],
        build: [],
        raw: `${base.major + 1}.0.0`,
      }),
    );
    return [lower, upper];
  }
  if (token.wildcardPatch || token.precision === 2) {
    const lower = createComparator(">=", normalizeBase(base, { resetPatch: true }));
    const upper = createComparator(
      "<",
      normalizeBase({
        major: base.major,
        minor: base.minor + 1,
        patch: 0,
        prerelease: [],
        build: [],
        raw: `${base.major}.${base.minor + 1}.0`,
      }),
    );
    return [lower, upper];
  }
  return [createComparator("=", normalizeBase(base))];
}

function comparatorFromOperator(op, token) {
  if (token.any) return [];
  const version = normalizeBase(token.version);
  return [createComparator(op, version)];
}

function hyphenComparators(aToken, bToken) {
  if (aToken.any && bToken.any) return [];
  const comparators = [];
  if (!aToken.any) {
    const lower = createComparator(">=", normalizeBase(aToken.version));
    comparators.push(lower);
  }
  if (!bToken.any) {
    let upperVersion;
    if (bToken.precision === 1 || bToken.wildcardMinor) {
      upperVersion = normalizeBase({
        major: bToken.version.major + 1,
        minor: 0,
        patch: 0,
        prerelease: [],
        build: [],
        raw: `${bToken.version.major + 1}.0.0`,
      });
      comparators.push(createComparator("<", upperVersion));
    } else if (bToken.precision === 2 || bToken.wildcardPatch) {
      upperVersion = normalizeBase({
        major: bToken.version.major,
        minor: bToken.version.minor + 1,
        patch: 0,
        prerelease: [],
        build: [],
        raw: `${bToken.version.major}.${bToken.version.minor + 1}.0`,
      });
      comparators.push(createComparator("<", upperVersion));
    } else {
      upperVersion = normalizeBase(bToken.version);
      comparators.push(createComparator("<=", upperVersion));
    }
  }
  return comparators;
}

function parseComparatorToken(token) {
  const trimmed = token.trim();
  if (!trimmed) return [];
  const operators = [">=", "<=", ">", "<", "=", "^", "~"];
  let op = null;
  let rest = trimmed;
  for (const candidate of operators) {
    if (trimmed.startsWith(candidate)) {
      op = candidate;
      rest = trimmed.slice(candidate.length).trim();
      break;
    }
  }
  if (op == null) {
    op = "";
    rest = trimmed;
  }
  const tokenInfo = parseVersionToken(rest);
  if (tokenInfo.any) {
    if (op && op !== "=" && op !== "") return [];
    return [];
  }
  switch (op) {
    case "^":
      return expandCaret(tokenInfo);
    case "~":
      return expandTilde(tokenInfo);
    case ">=":
    case "<=":
    case ">":
    case "<":
    case "=":
      return comparatorFromOperator(op || "=", tokenInfo);
    case "":
      return expandBareVersion(tokenInfo);
    default:
      throw new Error(`unsupported range operator "${op}"`);
  }
}

function buildRangeSets(raw) {
  const orParts = raw
    .split("||")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!orParts.length) throw new Error("empty range expression");
  return orParts.map((part) => {
    const hyphen = part.match(/^(.*)\s+-\s+(.*)$/);
    if (hyphen) {
      const fromToken = parseVersionToken(hyphen[1]);
      const toToken = parseVersionToken(hyphen[2]);
      return { comparators: hyphenComparators(fromToken, toToken) };
    }
    const tokens = part.split(/\s+/).filter(Boolean);
    if (!tokens.length) return { comparators: [] };
    const comparators = tokens.flatMap((token) => parseComparatorToken(token));
    return { comparators };
  });
}

function parseVersionRange(raw) {
  if (raw == null) {
    return { type: "any", raw: null, sets: [] };
  }
  const trimmed = String(raw).trim();
  if (!trimmed || isWildcardToken(trimmed)) {
    return { type: "any", raw: trimmed || null, sets: [] };
  }
  try {
    const sets = buildRangeSets(trimmed);
    const allEmpty = sets.every((set) => !set.comparators.length);
    if (allEmpty) {
      return { type: "any", raw: trimmed, sets };
    }
    const isExact =
      sets.length === 1 &&
      sets[0].comparators.length === 1 &&
      sets[0].comparators[0].op === "=";
    return {
      type: isExact ? "exact" : "range",
      raw: trimmed,
      sets,
      exactVersion: isExact ? sets[0].comparators[0].version.raw : null,
    };
  } catch (err) {
    const message = `Warning: could not parse version range "${trimmed}": ${err.message}`;
    if (!versionRangeWarningSet.has(message)) {
      versionRangeWarningSet.add(message);
      versionRangeWarnings.push(message);
    }
    return { type: "literal", raw: trimmed, sets: [] };
  }
}

function satisfiesComparator(version, comparator) {
  const cmp = compareSemver(version, comparator.version);
  switch (comparator.op) {
    case "=":
      return cmp === 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    default:
      return false;
  }
}

function satisfiesRange(versionString, range) {
  if (!range || range.type === "any") return true;
  if (range.type === "literal") return versionString === range.raw;
  const parsed = parseSemver(versionString);
  if (!parsed) return false;
  if (!Array.isArray(range.sets) || !range.sets.length) return true;
  return range.sets.some((set) => {
    if (!set.comparators || !set.comparators.length) return true;
    return set.comparators.every((comp) => satisfiesComparator(parsed, comp));
  });
}

function parseSpec(line) {
  const s = line.trim();
  if (!s || s.startsWith("#") || s === "---") return null;
  const lastAt = s.lastIndexOf("@");
  if (lastAt > 0) {
    const name = s.slice(0, lastAt);
    const version = s.slice(lastAt + 1).trim();
    if (version === "")
      return { name, version: null, range: parseVersionRange(null) };
    return { name, version, range: parseVersionRange(version) };
  }
  return { name: s, version: null, range: parseVersionRange(null) };
}
function specKey({ name, version }) {
  return version ? `${name}@${version}` : name;
}
async function readLines(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}
function isNodeModulesDir(p) {
  return path.basename(p) === "node_modules";
}
function pathHasNodeModules(p) {
  return p.split(path.sep).includes("node_modules");
}
const IGNORED_TOP_LEVEL = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "dist",
  "build",
  "out",
  "coverage",
]);

function isInsideRoot(candidate, root) {
  const rel = path.relative(root, candidate);
  if (!rel) return true;
  if (rel.startsWith("..")) return false;
  return !path.isAbsolute(rel);
}

async function safeRealpath(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

function addLocationEntry(arr, entry) {
  if (!entry || typeof entry.location !== "string" || !entry.location) return;
  if (!arr.some((existing) => existing.location === entry.location)) {
    arr.push(entry);
  }
}

function addFoundPackage(store, name, version, entry) {
  if (!name || !version || !entry) return;
  if (typeof entry === "string") {
    entry = { location: entry };
  }
  if (!entry.location) return;
  if (!store.has(name)) store.set(name, new Map());
  const byVersion = store.get(name);
  if (!byVersion.has(version)) byVersion.set(version, []);
  const list = byVersion.get(version);
  addLocationEntry(list, entry);
}

function nameFromPackagePath(pkgPath) {
  if (!pkgPath) return null;
  const parts = pkgPath.split("/");
  const idx = parts.lastIndexOf("node_modules");
  if (idx === -1) return null;
  const rest = parts.slice(idx + 1).filter(Boolean);
  if (!rest.length) return null;
  if (rest[0].startsWith("@")) {
    if (rest.length < 2) return null;
    return `${rest[0]}/${rest[1]}`;
  }
  return rest[0];
}

async function* walkDirs(rootDir) {
  const stack = [rootDir];
  const visited = new Set();
  const rootReal = await safeRealpath(rootDir);
  while (stack.length) {
    const dir = stack.pop();
    const realDir = await safeRealpath(dir);
    if (visited.has(realDir)) continue;
    visited.add(realDir);

    if (!isInsideRoot(realDir, rootReal)) continue;

    if (isNodeModulesDir(realDir)) {
      yield realDir;
    }

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!(e.isDirectory() || e.isSymbolicLink())) continue;
      const full = path.join(dir, e.name);

      if (!pathHasNodeModules(full) && IGNORED_TOP_LEVEL.has(e.name)) continue;

      stack.push(full);
    }
  }
}

async function* walkLockfiles(rootDir) {
  const stack = [rootDir];
  const visited = new Set();
  const rootReal = await safeRealpath(rootDir);
  while (stack.length) {
    const dir = stack.pop();
    const realDir = await safeRealpath(dir);
    if (visited.has(realDir)) continue;
    visited.add(realDir);

    if (!isInsideRoot(realDir, rootReal)) continue;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && SUPPORTED_LOCKFILENAMES.has(entry.name)) {
        yield full;
        continue;
      }
      if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
      if (entry.name === "node_modules") continue;
      if (!pathHasNodeModules(full) && IGNORED_TOP_LEVEL.has(entry.name))
        continue;
      stack.push(full);
    }
  }
}

async function collectFromNodeModules(rootDir) {
  /** Map<string pkgName, Map<string version, Array<string locations>>> */
  const installed = new Map();

  for await (const nm of walkDirs(rootDir)) {
    let entries;
    try {
      entries = await fsp.readdir(nm, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!(e.isDirectory() || e.isSymbolicLink())) continue;

      const first = path.join(nm, e.name);

      // Scoped namespace (@scope/*)
      if (e.name.startsWith("@")) {
        let scopedEntries;
        try {
          scopedEntries = await fsp.readdir(first, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const se of scopedEntries) {
          if (!(se.isDirectory() || se.isSymbolicLink())) continue;
          const pkgDir = path.join(first, se.name);
          const pj = path.join(pkgDir, "package.json");
          await addPackageFromNodeModules(pj, pkgDir, installed);
        }
      } else {
        // Unscoped
        const pkgDir = first;
        const pj = path.join(pkgDir, "package.json");
        await addPackageFromNodeModules(pj, pkgDir, installed);
      }
    }
  }
  return installed;
}

async function addPackageFromNodeModules(pjPath, pkgDir, installed) {
  try {
    const raw = await fsp.readFile(pjPath, "utf8");
    const pkg = JSON.parse(raw);
    addFoundPackage(installed, pkg.name, pkg.version, {
      location: pkgDir,
      metadata: { source: "node_modules", manifest: pjPath },
    });
  } catch {
    // still quietly skip invalid package.json
  }
}

async function collectFromLockfiles(rootDir) {
  const collected = new Map();
  const lockfiles = [];
  for await (const lockPath of walkLockfiles(rootDir)) {
    lockfiles.push(lockPath);
    let raw;
    try {
      raw = await fsp.readFile(lockPath, "utf8");
    } catch {
      continue;
    }
    const relLock = path.relative(rootDir, lockPath) || path.basename(lockPath);
    const locationPrefix = `lockfile:${relLock}`;
    const base = path.basename(lockPath);
    const parser = LOCKFILE_PARSERS.get(base);
    if (!parser) continue;

    let entries = [];
    try {
      entries = parser(raw, locationPrefix) || [];
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry || !entry.name || !entry.version) continue;
      addFoundPackage(collected, entry.name, entry.version, {
        location: entry.location,
        metadata: entry.metadata || null,
      });
    }
  }
  return { packages: collected, lockfiles };
}

function parseNpmLockfile(raw, locationPrefix) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }

  const entries = [];

  if (
    data &&
    typeof data === "object" &&
    data.packages &&
    typeof data.packages === "object"
  ) {
    for (const [pkgPathKey, meta] of Object.entries(data.packages)) {
      if (!meta || typeof meta !== "object") continue;
      const { name, version } = meta;
      const derivedName = name || nameFromPackagePath(pkgPathKey);
      if (!derivedName || !version) continue;
      const suffix = pkgPathKey ? pkgPathKey : "root";
      const metadata = pruneMetadata({
        resolved: meta.resolved,
        integrity: meta.integrity,
        registry: deriveRegistry(meta.resolved),
        dev: meta.dev === true,
        optional: meta.optional === true,
        bundled: meta.bundled === true,
        from: meta.from || null,
        source: "package-lock.json",
      });
      entries.push({
        name: derivedName,
        version,
        location: `${locationPrefix}#${suffix}`,
        metadata,
      });
    }
  }

  if (
    data &&
    typeof data === "object" &&
    data.dependencies &&
    typeof data.dependencies === "object"
  ) {
    collectLegacyLockDeps(data.dependencies, locationPrefix, [], entries);
  }

  return entries;
}

function parsePackageManifest(raw, locationPrefix) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const sections = [
    ["dependencies", "dependencies"],
    ["devDependencies", "devDependencies"],
    ["optionalDependencies", "optionalDependencies"],
    ["peerDependencies", "peerDependencies"],
  ];
  const records = [];
  for (const [field, label] of sections) {
    const deps = data && typeof data === "object" ? data[field] : null;
    if (!deps || typeof deps !== "object") continue;
    for (const [name, versionRaw] of Object.entries(deps)) {
      if (!name) continue;
      const version = String(versionRaw || "").trim();
      if (!version) continue;
      const metadata = pruneMetadata({
        specifier: version,
        source: "package.json",
        section: label,
      });
      records.push({
        name,
        version,
        location: `${locationPrefix}#${label}/${name}`,
        metadata,
      });
    }
  }
  return records;
}

function collectLegacyLockDeps(tree, locationPrefix, trail, out) {
  if (!tree || typeof tree !== "object") return;
  for (const [depName, meta] of Object.entries(tree)) {
    if (!meta || typeof meta !== "object") continue;
    const version = meta.version;
    if (!version) continue;
    const location = `${locationPrefix}#deps/${[...trail, depName].join("/")}`;
    const metadata = pruneMetadata({
      resolved: meta.resolved,
      integrity: meta.integrity,
      registry: deriveRegistry(meta.resolved),
      dev: meta.dev === true,
      optional: meta.optional === true,
      bundled: meta.bundled === true,
      source: "package-lock.json",
    });
    out.push({ name: depName, version, location, metadata });
    if (meta.dependencies && typeof meta.dependencies === "object") {
      collectLegacyLockDeps(
        meta.dependencies,
        locationPrefix,
        [...trail, depName],
        out,
      );
    }
  }
}

function parseYarnLockfile(raw, locationPrefix) {
  const records = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith(" ")) continue;
    if (!line.endsWith(":")) continue;

    const keySource = line.slice(0, -1).trim();
    if (!keySource) continue;
    const selectors = keySource
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!selectors.length) continue;

    let version = null;
    let resolved = null;
    let integrity = null;
    let checksum = null;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const body = lines[j];
      if (!body.startsWith("  ")) break;
      const trimmed = body.trim();
      if (trimmed.startsWith("version ")) {
        const match = trimmed.match(/^version\s+"?([^"\s]+)"?/);
        if (match) version = match[1];
      }
      if (trimmed.startsWith("resolved ")) {
        const rawResolved = stripQuotes(trimmed.slice("resolved ".length).trim());
        resolved = rawResolved;
      }
      if (trimmed.startsWith("integrity ")) {
        const rawIntegrity = trimmed.slice("integrity ".length).trim();
        integrity = stripQuotes(rawIntegrity);
      }
      if (trimmed.startsWith("checksum ")) {
        checksum = stripQuotes(trimmed.slice("checksum ".length).trim());
      }
    }

    if (version) {
      for (const selector of selectors) {
        const name = extractNameFromYarnSelector(selector);
        if (!name) continue;
        const key = selector.replace(/^['"]|['"]$/g, "");
        const metadata = pruneMetadata({
          resolved,
          integrity,
          checksum,
          registry: deriveRegistry(resolved),
          source: "yarn.lock",
        });
        records.push({
          name,
          version,
          location: `${locationPrefix}#${key}`,
          metadata,
        });
      }
    }

    i = j - 1;
  }
  return records;
}

function extractNameFromYarnSelector(selector) {
  let s = selector.trim();
  if (!s) return null;
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  if (!s) return null;

  const protocolMatch = s.match(/^(.*)@([a-z][-a-z0-9+]*):/i);
  if (protocolMatch) {
    return protocolMatch[1];
  }

  if (s.startsWith("@")) {
    const slashIndex = s.indexOf("/");
    if (slashIndex === -1) return null;
    const nextAt = s.indexOf("@", slashIndex);
    if (nextAt === -1) return s;
    return s.slice(0, nextAt);
  }

  const atIndex = s.indexOf("@");
  if (atIndex === -1) return s;
  return s.slice(0, atIndex);
}

function parsePnpmLockfile(raw, locationPrefix) {
  const records = [];
  const lines = raw.split(/\r?\n/);
  let inPackages = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!line.startsWith(" ")) {
      inPackages = line.trim() === "packages:";
      continue;
    }
    if (!inPackages) continue;
    if (!line.startsWith("  ")) continue;
    const trimmed = line.trim();
    if (!trimmed.endsWith(":")) continue;
    const parsed = parsePnpmPackageKey(trimmed.slice(0, -1));
    if (!parsed) continue;
    const metadataBucket = {};
    let j = i + 1;
    for (; j < lines.length; j++) {
      const body = lines[j];
      if (!body.startsWith("    ")) break;
      const inner = body.trim();
      if (inner.startsWith("resolution:")) {
        const rest = inner.slice("resolution:".length).trim();
        const integrityVal = extractField(rest, "integrity");
        const tarballVal = extractField(rest, "tarball");
        const registryVal = extractField(rest, "registry");
        if (integrityVal) metadataBucket.integrity = stripQuotes(integrityVal);
        if (tarballVal) metadataBucket.tarball = stripQuotes(tarballVal);
        if (registryVal) metadataBucket.registry = stripQuotes(registryVal);
      } else if (inner.startsWith("integrity:")) {
        metadataBucket.integrity = stripQuotes(inner.slice("integrity:".length).trim());
      } else if (inner.startsWith("tarball:")) {
        metadataBucket.tarball = stripQuotes(inner.slice("tarball:".length).trim());
      } else if (inner.startsWith("registry:")) {
        metadataBucket.registry = stripQuotes(inner.slice("registry:".length).trim());
      } else if (inner.startsWith("specifier:")) {
        metadataBucket.specifier = stripQuotes(inner.slice("specifier:".length).trim());
      }
    }
    const registryHost = metadataBucket.registry
      ? deriveRegistry(metadataBucket.registry) || stripQuotes(metadataBucket.registry)
      : deriveRegistry(metadataBucket.tarball || undefined);
    const metadata = pruneMetadata({
      resolved: metadataBucket.tarball || null,
      integrity: metadataBucket.integrity || null,
      tarball: metadataBucket.tarball || null,
      registry: registryHost || null,
      specifier: metadataBucket.specifier || null,
      source: "pnpm-lock.yaml",
    });
    records.push({
      name: parsed.name,
      version: parsed.version,
      location: `${locationPrefix}#${parsed.key}`,
      metadata,
    });
    i = j - 1;
  }
  return records;
}

function parsePnpmPackageKey(rawKey) {
  let key = rawKey.trim();
  if (!key) return null;
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  const locationKey = key;
  if (key.startsWith("/")) {
    key = key.replace(/^\/+/, "");
    if (!key) return null;
    const parts = key.split("/");
    if (parts.length < 2) return null;
    const versionPart = parts[parts.length - 1];
    if (!versionPart) return null;
    const underscore = versionPart.indexOf("_");
    const version =
      underscore === -1 ? versionPart : versionPart.slice(0, underscore);
    const name = parts.slice(0, parts.length - 1).join("/");
    if (!name || !version) return null;
    return { name, version, key: locationKey };
  }

  const atIndex = key.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === key.length - 1) return null;
  const name = key.slice(0, atIndex);
  let version = key.slice(atIndex + 1);
  if (!name || !version) return null;
  const colonIndex = version.indexOf(":");
  if (colonIndex !== -1 && colonIndex < version.length - 1) {
    version = version.slice(colonIndex + 1);
  }
  if (!version) return null;
  return { name, version, key: locationKey };
}

function mergePackageMaps(target, source) {
  for (const [name, versions] of source) {
    if (!target.has(name)) target.set(name, new Map());
    const targetVersions = target.get(name);
    for (const [version, locations] of versions) {
      if (!targetVersions.has(version)) targetVersions.set(version, []);
      const store = targetVersions.get(version);
      for (const loc of locations) addLocationEntry(store, loc);
    }
  }
}

function sortVersions(versions) {
  return versions.slice().sort((a, b) => {
    const av = parseSemver(a);
    const bv = parseSemver(b);
    if (av && bv) {
      const cmp = compareSemver(av, bv);
      if (cmp !== 0) return cmp;
    } else if (av) {
      return 1;
    } else if (bv) {
      return -1;
    }
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  });
}

function matchSpecs(specs, installed) {
  const results = [];
  for (const spec of specs) {
    const byVer = installed.get(spec.name) || new Map();
    const installedVersionKeys = Array.from(byVer.keys());
    const installedVersions = sortVersions(installedVersionKeys);
    const matchedVersions = [];
    const matchDetails = [];
    const allLocations = [];
    const nonSemverVersions = [];
    const rangeInfo = spec.range || parseVersionRange(spec.version);

    for (const version of installedVersions) {
      const locationsForVersion = byVer.get(version) || [];
      const parsed = parseSemver(version);
      if (!parsed && !nonSemverVersions.includes(version)) {
        nonSemverVersions.push(version);
      }
      const satisfies = satisfiesRange(version, rangeInfo);
      if (satisfies) {
        matchedVersions.push(version);
        matchDetails.push({ version, locations: locationsForVersion });
        for (const loc of locationsForVersion) {
          if (!allLocations.includes(loc.location)) {
            allLocations.push(loc.location);
          }
        }
      }
    }

    const found = matchedVersions.length > 0;
    const exact =
      rangeInfo &&
      (rangeInfo.type === "exact" || rangeInfo.type === "literal") &&
      found;
    const requestedVersion =
      spec.version && spec.version.trim()
        ? spec.version.trim()
        : rangeInfo && rangeInfo.raw
          ? rangeInfo.raw
          : "(any)";

    results.push({
      request: specKey(spec),
      name: spec.name,
      requestedVersion,
      found,
      exact,
      installedVersions,
      matchedVersions,
      matchDetails,
      allLocations,
      nonSemverVersions,
      rangeInfo,
    });
  }
  return results;
}

function summarizeResults(results) {
  const checked = results.length;
  const found = results.filter((r) => r.found).length;
  const exactMatches = results.filter((r) => r.exact).length;
  const notFound = checked - found;
  return { checked, found, exactMatches, notFound };
}

function printTable(rows, { sourcesOrder = [] } = {}) {
  const header = [
    "Package",
    "Requested",
    "Found",
    "Exact",
    "Matching Versions",
  ];
  if (sourcesOrder.length) header.push("Sources");
  const lines = [header];
  for (const r of rows) {
    const matchText = r.matchedVersions && r.matchedVersions.length
      ? r.matchedVersions.join(", ")
      : "-";
    const row = [
      r.name,
      r.requestedVersion,
      r.found ? paint("yes", ANSI.green) : paint("no", ANSI.red),
      r.exact ? paint("yes", ANSI.blue) : paint("no", ANSI.yellow),
      matchText,
    ];
    if (sourcesOrder.length) {
      const parts = sourcesOrder.map((source) => {
        const info = r.sources ? r.sources[source] : null;
        if (!info) return `${source}:n/a`;
        if (!info.found) {
          const installedHint = info.installedVersions && info.installedVersions.length
            ? ` (installed: ${info.installedVersions.join(", ")})`
            : "";
          return `${source}:missing${installedHint}`;
        }
        const versions = info.matchedVersions && info.matchedVersions.length
          ? info.matchedVersions.join(", ")
          : info.installedVersions && info.installedVersions.length
            ? info.installedVersions.join(", ")
            : "-";
        const locationCount = info.allLocations
          ? info.allLocations.length
          : info.matchDetails
            ? info.matchDetails.reduce((sum, d) => sum + (d.locations ? d.locations.length : 0), 0)
            : 0;
        return `${source}:${versions}${locationCount ? ` (${locationCount} loc)` : ""}`;
      });
      row.push(parts.join("; "));
    }
    lines.push(row);
  }
  const widths = lines[0].map((_, i) =>
    Math.max(...lines.map((row) => stripAnsi(row[i]).length)),
  );
  const fmt = (row) =>
    row
      .map((c, i) => {
        const pad = widths[i] - stripAnsi(c).length;
        return String(c) + " ".repeat(Math.max(0, pad));
      })
      .join("  ");
  console.log(fmt(lines[0]));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (let i = 1; i < lines.length; i++) console.log(fmt(lines[i]));
}

function deriveRegistry(resolved) {
  if (!resolved) return null;
  try {
    const url = new URL(resolved);
    return url.host || null;
  } catch {
    return null;
  }
}

function pruneMetadata(meta) {
  if (!meta || typeof meta !== "object") return null;
  const cleaned = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value == null || value === "" || value === false) continue;
    cleaned[key] = value;
  }
  return Object.keys(cleaned).length ? cleaned : null;
}

function stripQuotes(value) {
  if (typeof value !== "string") return value;
  return value.replace(/^['"]|['"]$/g, "");
}

function extractField(text, field) {
  if (!text) return null;
  const regex = new RegExp(`${field}\\s*[:=]\\s*"?([^",}\\s]+)`, "i");
  const match = text.match(regex);
  return match ? stripQuotes(match[1]) : null;
}

function formatLocationMetadata(meta) {
  if (!meta || typeof meta !== "object") return "";
  const parts = [];
  const flagParts = [];
  if (meta.dev) flagParts.push("dev");
  if (meta.optional) flagParts.push("optional");
  if (meta.bundled) flagParts.push("bundled");
  if (meta.peer) flagParts.push("peer");
  if (meta.extraneous) flagParts.push("extraneous");
  if (flagParts.length) parts.push(flagParts.join("+"));
  if (meta.integrity) parts.push(`integrity=${meta.integrity}`);
  if (meta.resolved) parts.push(`resolved=${meta.resolved}`);
  if (meta.tarball) parts.push(`tarball=${meta.tarball}`);
  if (meta.registry) parts.push(`registry=${meta.registry}`);
  if (meta.checksum) parts.push(`checksum=${meta.checksum}`);
  if (meta.source) parts.push(`source=${meta.source}`);
  if (meta.section) parts.push(`section=${meta.section}`);
  if (meta.specifier) parts.push(`specifier=${meta.specifier}`);
  if (meta.reference) parts.push(`reference=${meta.reference}`);
  if (meta.from) parts.push(`from=${meta.from}`);
  if (!parts.length && meta.type) parts.push(`type=${meta.type}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

(async () => {
  const specs = (await readLines(file)).map(parseSpec).filter(Boolean);
  if (versionRangeWarnings.length) {
    for (const warning of versionRangeWarnings) {
      console.warn(paint(warning, ANSI.yellow));
    }
  }

  const cwd = process.cwd();
  const rootDir = scanPath ? path.resolve(cwd, scanPath) : cwd;
  const installed = new Map();
  let lockfileInfo = { packages: new Map(), lockfiles: [] };
  const perSourcePackages = new Map();
  if (scanSources.has("node_modules")) {
    const nodeModulesPackages = await collectFromNodeModules(rootDir);
    mergePackageMaps(installed, nodeModulesPackages);
    perSourcePackages.set("node_modules", nodeModulesPackages);
  }
  if (scanSources.has("lockfile")) {
    lockfileInfo = await collectFromLockfiles(rootDir);
    mergePackageMaps(installed, lockfileInfo.packages);
    perSourcePackages.set("lockfile", lockfileInfo.packages);
  }

  const results = matchSpecs(specs, installed);
  const sortedSources = Array.from(scanSources).sort();
  const lockfilesRel = lockfileInfo.lockfiles.map(
    (lf) => path.relative(rootDir, lf) || path.basename(lf),
  );
  const perSourceResults = new Map();
  for (const [source, pkgMap] of perSourcePackages) {
    perSourceResults.set(source, matchSpecs(specs, pkgMap));
  }

  const resultsByRequest = new Map(results.map((r) => [r.request, r]));
  for (const [source, resList] of perSourceResults) {
    for (const res of resList) {
      const agg = resultsByRequest.get(res.request);
      if (!agg) continue;
      if (!agg.sources) agg.sources = {};
      agg.sources[source] = {
        found: res.found,
        exact: res.exact,
        installedVersions: res.installedVersions,
        matchedVersions: res.matchedVersions,
        matchDetails: res.matchDetails,
        allLocations: res.allLocations,
        nonSemverVersions: res.nonSemverVersions,
        requestedVersion: res.requestedVersion,
        rangeInfo: res.rangeInfo,
      };
    }
  }

  if (jsonOut) {
    const summary = {
      ...summarizeResults(results),
      scannedRoot: rootDir,
      scanSources: sortedSources,
      lockfiles: lockfilesRel,
      sourceSummaries: Object.fromEntries(
        Array.from(perSourceResults).map(([source, res]) => [
          source,
          summarizeResults(res),
        ]),
      ),
    };
    console.log(
      JSON.stringify({ scannedRoot: rootDir, results, summary }, null, 2),
    );
  } else {
    console.log(
      `Scanning root: ${paint(rootDir, ANSI.bold)} (sources: ${sortedSources.join(", ")})`,
    );
    if (scanSources.has("lockfile")) {
      console.log(
        `Lockfiles: ${lockfilesRel.length ? lockfilesRel.join(", ") : "none"}`,
      );
    }
    const displayResults = verbose ? results : results.filter((r) => r.found);
    if (!verbose) {
      if (displayResults.length) {
        console.log("Matched packages:");
        printTable(displayResults, { sourcesOrder: sortedSources });
      } else {
        console.log("No matching packages found. Run with --verbose to inspect all entries.");
      }
    } else {
      printTable(displayResults, { sourcesOrder: sortedSources });
    }
    const { checked, found, exactMatches, notFound } =
      summarizeResults(results);
    console.log("");
    console.log(
      `Summary: ${paint(checked, ANSI.bold)} packages checked, ` +
        `${paint(found, ANSI.green)} found ` +
        `(${paint(exactMatches, ANSI.blue)} exact matches, ` +
        `${paint(notFound, ANSI.red)} not found)`,
    );
    for (const source of sortedSources) {
      const res = perSourceResults.get(source) || [];
      const {
        checked: ck,
        found: fd,
        exactMatches: em,
        notFound: nf,
      } = summarizeResults(res);
      const label = source === "node_modules" ? "node_modules" : source;
      console.log(
        `[${label}] Summary: ${paint(ck, ANSI.bold)} checked, ` +
          `${paint(fd, ANSI.green)} found ` +
          `(${paint(em, ANSI.blue)} exact matches, ${paint(nf, ANSI.red)} not found)`,
      );
    }
    const breakdownResults = displayResults.filter((r) => r.found);
    if (breakdownResults.length) {
      console.log("");
      console.log("Per-package breakdown:");
      for (const result of breakdownResults) {
        console.log(
          `${paint(result.name, ANSI.bold)} (requested: ${result.requestedVersion})`,
        );
        if (result.sources) {
          for (const source of sortedSources) {
            const info = result.sources[source];
            if (!info) {
              console.log(`  ${source}: not scanned`);
              continue;
            }
            if (!info.found) {
              const hint = info.installedVersions && info.installedVersions.length
                ? ` (available versions: ${info.installedVersions.join(", ")})`
                : "";
              console.log(`  ${source}: missing${hint}`);
              continue;
            }
            const versionsLabel = info.matchedVersions && info.matchedVersions.length
              ? info.matchedVersions.join(", ")
              : "-";
            console.log(`  ${source}: ${versionsLabel}`);
            for (const detail of info.matchDetails || []) {
              console.log(`    ${detail.version}:`);
              for (const locEntry of detail.locations || []) {
                const metaSuffix = formatLocationMetadata(locEntry.metadata);
                console.log(`      - ${locEntry.location}${metaSuffix}`);
              }
            }
            if (info.nonSemverVersions && info.nonSemverVersions.length) {
              console.log(
                `    Note: non-semver versions observed: ${info.nonSemverVersions.join(", ")}`,
              );
            }
          }
        } else {
          console.log("  No per-source details available.");
        }
        if (result.allLocations && result.allLocations.length) {
          console.log(
            `  Combined locations (${result.allLocations.length}): ${result.allLocations.join(", ")}`,
          );
        }
      }
    }
  }

  process.exit(results.every((r) => r.found) ? 0 : 1);
})();
