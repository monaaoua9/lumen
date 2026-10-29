# Lumen for VS Code

Syntax highlighting for `.lum` files. To try it without packaging, copy this folder to
`~/.vscode/extensions/lumen-lang` and reload the window.

The grammar follows the lexer's keyword list; `test/robustness.test.ts` fails when a keyword is missing from it.

## Language server

`extension.js` starts `lumen lsp` (diagnostics, hover, go to definition, formatting). Run `npm install` in this folder
first (it needs `vscode-languageclient`), then set `lumen.path` to a `lumen` executable, or point `lumen.cli` at
`src/cli.ts` of a checkout (absolute path). Any other editor with LSP support can run `node src/cli.ts lsp` directly.
