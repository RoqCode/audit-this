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
  if (a === "-h" || a === "--help") {
    console.log(`Usage:
  node find-packages.js -f packages.txt [--json] [--no-color] [--path <dir>]

Options:
  -f, --file     Path to the package list file (one line per name@version; version optional)
  --json         Output results as JSON (includes summary)
  --no-color     Disable ANSI colors in text output
  -p, --path     Restrict scan to a specific subdirectory (e.g. apps/web). Default: current working directory
`);
    process.exit(0);
  }
}

if (!file) {
  console.error("Error: please provide -f <file>");
  process.exit(2);
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

async function* walkDirs(rootDir) {
  const stack = [rootDir];
  const ignoredTop = new Set([
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

      if (!pathHasNodeModules(full) && ignoredTop.has(e.name)) continue;

      stack.push(full);
    }
  }
}

async function collectInstalled(rootDir) {
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
          await addPackage(pj, pkgDir, installed);
        }
      } else {
        // Unscoped
        const pkgDir = first;
        const pj = path.join(pkgDir, "package.json");
        await addPackage(pj, pkgDir, installed);
      }
    }
  }
  return installed;
}

async function addPackage(pjPath, pkgDir, installed) {
  try {
    const raw = await fsp.readFile(pjPath, "utf8");
    const pkg = JSON.parse(raw);
    if (!pkg.name || !pkg.version) return;
    if (!installed.has(pkg.name)) installed.set(pkg.name, new Map());
    const byVer = installed.get(pkg.name);
    if (!byVer.has(pkg.version)) byVer.set(pkg.version, []);
    byVer.get(pkg.version).push(pkgDir);
  } catch {
    // still quietly skip invalid package.json
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

  const installed = await collectInstalled(rootDir);

  const results = matchSpecs(specs, installed);

  if (jsonOut) {
    const summary = {
      checked: results.length,
      found: results.filter((r) => r.found).length,
      exactMatches: results.filter((r) => r.exact).length,
      notFound: results.filter((r) => !r.found).length,
      scannedRoot: rootDir,
    };
    console.log(
      JSON.stringify({ scannedRoot: rootDir, results, summary }, null, 2),
    );
  } else {
    console.log(`Scanning root: ${paint(rootDir, ANSI.bold)}`);
    printTable(results);
    const checked = results.length;
    const found = results.filter((r) => r.found).length;
    const exact = results.filter((r) => r.exact).length;
    const notFound = checked - found;
    console.log("");
    console.log(
      `Summary: ${paint(checked, ANSI.bold)} packages checked, ` +
        `${paint(found, ANSI.green)} found ` +
        `(${paint(exact, ANSI.blue)} exact matches, ` +
        `${paint(notFound, ANSI.red)} not found)`,
    );
  }

  process.exit(results.every((r) => r.found) ? 0 : 1);
})();
