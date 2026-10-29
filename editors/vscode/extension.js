const { workspace } = require('vscode');
const { LanguageClient } = require('vscode-languageclient/node');

let client;

exports.activate = () => {
  const cfg = workspace.getConfiguration('lumen');
  const command = cfg.get('path') || 'node';
  const args = cfg.get('path') ? ['lsp'] : [cfg.get('cli') || 'src/cli.ts', 'lsp'];
  client = new LanguageClient('lumen', 'Lumen', { command, args }, { documentSelector: [{ language: 'lumen' }] });
  client.start();
};

exports.deactivate = () => (client ? client.stop() : undefined);
