// Every place that carries the version must agree (and match the release tag, if given).
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8')).version;
const versions = {
  'package.json': read('package.json'),
  'public/manifest.json': read('public/manifest.json'),
  'mcp/package.json': read('mcp/package.json'),
  'mcp/manifest.json': read('mcp/manifest.json'),
};
const expected = process.argv[2] ?? versions['package.json'];
const wrong = Object.entries(versions).filter(([, v]) => v !== expected);
if (wrong.length) {
  console.error(`Expected version ${expected}, but: ${wrong.map(([f, v]) => `${f} has ${v}`).join(', ')}`);
  process.exit(1);
}
console.log(`All versions are ${expected}`);
