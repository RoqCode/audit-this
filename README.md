# package-check

Utility script for auditing which dependencies exist in an existing `node_modules` tree *and* which ones are declared inside any `package-lock.json` files. It walks every `node_modules` directory (or an optional subpath) and inspects lockfiles so you can spot both installed and merely declared packages for the entries listed in `packages.txt`.

## Requirements

- Node.js 18 or newer (uses `async` iterators and optional chaining syntax)

## Usage

```
node find-packages.js -f packages.txt [--json] [--no-color] [--path <dir>] [--scan <sources>]
```

### Options

- `-f, --file` Path to a newline-delimited package list. Lines support `name`, `name@version`, and comments beginning with `#`.
- `--json` Emit machine-readable JSON that includes the scan summary.
- `--no-color` Disable ANSI colors in the text report.
- `-p, --path` Restrict the scan to a project subdirectory (defaults to the current working directory).
- `-s, --scan` Choose which data sources to inspect. Accepts `node_modules`, `lockfile`, or `both` (comma-separated or passed multiple times). Defaults to scanning both installed packages and lockfiles.

### Exit codes

- `0` All requested packages were found.
- `1` At least one package from the list is missing.
- `2` The script was invoked without the mandatory `--file` argument.

## Package list format

Place each requested package on its own line in `packages.txt`. Prefix `#` to leave comments; empty lines are ignored. A trailing `@` means "any version".

```text
# crowdstrike libraries to audit
@crowdstrike/glide-core@0.34.3
@crowdstrike/foundry-js@
```

## Example output

```
Package                Requested  Found   Exact  Installed Versions   One Location
---------------------  ---------  ------  -----  -------------------  --------------------------
@ctrl/tinycolor        4.1.2      yes     yes    4.1.2                ./node_modules/@ctrl/tinycolor
@teselagen/react-table 6.10.22    no      no     6.10.19, 6.10.20     ./node_modules/@teselagen/react-table

Summary: 312 packages checked, 280 found (255 exact matches, 32 not found)
[node_modules] Summary: 300 checked, 270 found (250 exact matches, 30 not found)
[lockfile] Summary: 312 checked, 280 found (255 exact matches, 32 not found)
```
