#!/usr/bin/env node
/**
 * Deep dependency finder for node_modules (direct + transitive, any package manager).
 * Features:
 *  - Scans installed packages (direct + transitive) inside node_modules
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
const scanSources = new Set(DEFAULT_SCAN_SOURCES);
let scanSpecified = false;

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
  node find-packages.js -f packages.txt [--json] [--no-color] [--path <dir>] [--scan <sources>]

Options:
  -f, --file     Path to the package list file (one line per name@version; version optional)
  --json         Output results as JSON (includes summary)
  --no-color     Disable ANSI colors in text output
  -p, --path     Restrict scan to a specific subdirectory (e.g. apps/web). Default: current working directory
  -s, --scan     Select data sources: node_modules, lockfile, both. Default: both (option can be repeated or comma-separated)
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
function parseSpec(line) {
  const s = line.trim();
  if (!s || s.startsWith("#") || s === "---") return null;
  const lastAt = s.lastIndexOf("@");
  if (lastAt > 0) {
    const name = s.slice(0, lastAt);
    const version = s.slice(lastAt + 1).trim();
    if (version === "") return { name, version: null };
    return { name, version };
  }
  return { name: s, version: null };
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

function pushUnique(arr, value) {
  if (value == null) return;
  if (!arr.includes(value)) arr.push(value);
}

function addFoundPackage(store, name, version, location) {
  if (!name || !version) return;
  if (!store.has(name)) store.set(name, new Map());
  const byVersion = store.get(name);
  if (!byVersion.has(version)) byVersion.set(version, []);
  const list = byVersion.get(version);
  pushUnique(list, location);
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
      if (entry.isFile() && entry.name === "package-lock.json") {
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
    addFoundPackage(installed, pkg.name, pkg.version, pkgDir);
  } catch {
    // still quietly skip invalid package.json
  }
}

function walkLegacyLockDeps(tree, store, locationPrefix, trail) {
  if (!tree || typeof tree !== "object") return;
  for (const [depName, meta] of Object.entries(tree)) {
    if (!meta || typeof meta !== "object") continue;
    const version = meta.version;
    if (!version) continue;
    const location = `${locationPrefix}#deps/${[...trail, depName].join("/")}`;
    addFoundPackage(store, depName, version, location);
    if (meta.dependencies && typeof meta.dependencies === "object") {
      walkLegacyLockDeps(meta.dependencies, store, locationPrefix, [
        ...trail,
        depName,
      ]);
    }
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
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const relLock = path.relative(rootDir, lockPath) || path.basename(lockPath);
    const locationPrefix = `lockfile:${relLock}`;

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
        addFoundPackage(
          collected,
          derivedName,
          version,
          `${locationPrefix}#${suffix}`,
        );
      }
    }

    if (
      data &&
      typeof data === "object" &&
      data.dependencies &&
      typeof data.dependencies === "object"
    ) {
      walkLegacyLockDeps(data.dependencies, collected, locationPrefix, []);
    }
  }
  return { packages: collected, lockfiles };
}

function mergePackageMaps(target, source) {
  for (const [name, versions] of source) {
    if (!target.has(name)) target.set(name, new Map());
    const targetVersions = target.get(name);
    for (const [version, locations] of versions) {
      if (!targetVersions.has(version)) targetVersions.set(version, []);
      const store = targetVersions.get(version);
      for (const loc of locations) pushUnique(store, loc);
    }
  }
}

function matchSpecs(specs, installed) {
  const results = [];
  for (const spec of specs) {
    const byVer = installed.get(spec.name) || new Map();
    const installedVersions = Array.from(byVer.keys()).sort();
    let found = false,
      exact = false,
      locations = [];
    if (spec.version) {
      if (byVer.has(spec.version)) {
        found = true;
        exact = true;
        locations = byVer.get(spec.version);
      }
    } else {
      if (installedVersions.length) {
        found = true;
        locations = installedVersions.flatMap((v) => byVer.get(v));
      }
    }
    results.push({
      request: specKey(spec),
      name: spec.name,
      requestedVersion: spec.version || "(any)",
      found,
      exact,
      installedVersions,
      locations,
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

function printTable(rows) {
  const header = [
    "Package",
    "Requested",
    "Found",
    "Exact",
    "Installed Versions",
    "One Location",
  ];
  const lines = [header];
  for (const r of rows) {
    lines.push([
      r.name,
      r.requestedVersion,
      r.found ? paint("yes", ANSI.green) : paint("no", ANSI.red),
      r.exact ? paint("yes", ANSI.blue) : paint("no", ANSI.yellow),
      r.installedVersions.join(", ") || "-",
      r.locations[0] || "-",
    ]);
  }
  // Breite ohne ANSI rechnen
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

(async () => {
  const specs = (await readLines(file)).map(parseSpec).filter(Boolean);

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
    printTable(results);
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
  }

  process.exit(results.every((r) => r.found) ? 0 : 1);
})();
