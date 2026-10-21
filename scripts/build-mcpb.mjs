// Pack freetabs-mcp as a Claude Desktop extension: release/freetabs.mcpb.
// It's staged in a clean folder with production dependencies only, and takes
// its version from mcp/package.json so the two never drift apart.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const mcp = path.join(root, 'mcp');
const release = path.join(root, 'release');
const stage = path.join(release, 'mcpb');
const out = path.join(release, 'freetabs.mcpb');

const pkg = JSON.parse(readFileSync(path.join(mcp, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(mcp, 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync(path.join(mcp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const file of [...pkg.files, 'package.json', 'package-lock.json', 'manifest.json', 'icon.png']) {
  cpSync(path.join(mcp, file), path.join(stage, file));
}
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
run(path.join(root, 'node_modules', '.bin', 'mcpb'), ['validate', path.join(stage, 'manifest.json')], root);
rmSync(out, { force: true });
run(path.join(root, 'node_modules', '.bin', 'mcpb'), ['pack', stage, out], root);
rmSync(stage, { recursive: true, force: true });
console.log(`Packed ${path.relative(root, out)} (v${pkg.version})`);
