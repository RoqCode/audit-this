# package-check

Utility script for auditing which dependencies exist in an existing `node_modules` tree. It walks every `node_modules` directory under the working tree (or an optional subpath) and reports whether the packages listed in `packages.txt` are installed, along with the versions that were found.

## Requirements
- Node.js 18 or newer (uses `async` iterators and optional chaining syntax)

## Usage
```
node find-packages.js -f packages.txt [--json] [--no-color] [--path <dir>]
```

### Options
- `-f, --file` Path to a newline-delimited package list. Lines support `name`, `name@version`, and comments beginning with `#`.
- `--json` Emit machine-readable JSON that includes the scan summary.
- `--no-color` Disable ANSI colors in the text report.
- `-p, --path` Restrict the scan to a project subdirectory (defaults to the current working directory).

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
