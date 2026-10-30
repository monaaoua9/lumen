# Tooling

Everything goes through one entry point, `node src/cli.ts <command>`. Node 22.18 or newer; gcc, clang or cc only if you use the C engine.

## Running

```
lumen run prog.lum                 # js engine, the default
lumen run prog.lum --engine vm     # interp | vm | js | c
lumen run prog.lum -O              # constant folding before the backend
lumen build prog.lum -o prog       # native executable through C
lumen emit-js prog.lum             # print the JavaScript the js engine runs
lumen check prog.lum               # analyze only (--json, --Werror)
lumen run -e 'print(1 + 2);'       # code from the command line
lumen explain E003                 # long description of an error code
```

All engines print the same output, including runtime errors. If you are unsure which one to use: js for everyday work, c when you want the speed or a standalone binary, interp when you suspect a backend bug and want the reference behaviour.

## Format and test

```
lumen fmt prog.lum                 # print what would change
lumen fmt --write prog.lum         # rewrite in place
lumen fmt --check prog.lum         # exit 1 if it would change
lumen test prog.lum                # runs every fn test_*(), assert() marks failures
lumen repl
```

## Debugger

```
lumen debug prog.lum               # js engine
lumen debug prog.lum --engine interp
```

Commands are read from stdin, one per line: `step`, `next`, `continue`, `break <line>`, `delete [line]`, `print <name>`, `locals`, `bt`, `list`, `quit`. Only lines of the file you started with are stopped at, imported library code is stepped over. The debugger does not run on the VM or the C engine.

## Editor support

`lumen lsp` speaks the language server protocol on stdin/stdout: diagnostics, hover, go to definition, completion, document symbols and formatting. After an edit that does not compile, completion keeps using the last version that did.

## Packages

A project has a `lumen.toml`:

```
[package]
name = "report"

[dependencies]
geometry = "../geometry"                                  # local path
shapes   = "https://github.com/someone/shapes.git#v0.2.0" # git, tag or commit after #
mathx    = "^1.2"                                         # from the package index
```

```
lumen init [name]                  # write a lumen.toml in this directory
lumen install                      # fetch dependencies, as locked in lumen.lock
lumen update [name]                # fetch again from the refs, rewrite the lock
```

Use a dependency with `import "geometry/area.lum"`. Version requirements (`^1.2`, `~1.2`, exact, `*`) are looked up in a JSON index, by default the one in `registry/index.json` of this repository; set `LUMEN_REGISTRY` to point at another. `lumen.lock` records the exact commit of every git or registry dependency, commit it. Each package gets its own copy of its dependencies, there is no version solver.

## Benchmarks

```
node benchmarks/run.ts
```

Runs every program in `benchmarks/` on the four engines, checks the output is identical, and rewrites `benchmarks/RESULTS.md` with the medians and the machine they were measured on.
