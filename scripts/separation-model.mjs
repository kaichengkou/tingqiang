// The separation model ships inside both apps. It is downloaded once into the build cache and checked against the
// manifest the web build uses, so every copy is the same file.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export function separationModel(work) {
  const {url, bytes, sha256} = JSON.parse(readFileSync(join(root, 'dist', 'models', 'separation.json'), 'utf8'));
  const name = url.split('/').pop(), folder = join(work, 'cache', 'model'), file = join(folder, name);
  mkdirSync(folder, {recursive: true});
  if (!existsSync(file)) {
    console.log(`Downloading ${name} (${(bytes / 1e6).toFixed(1)} MB)`);
    const result = spawnSync('curl', ['-L', '--fail', '--silent', '--show-error', '-o', file, url], {stdio: 'inherit'});
    if (result.status !== 0) throw new Error(`Could not download ${url}`);
  }
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (actual !== sha256) { rmSync(file); throw new Error(`${name} failed its checksum: ${actual}`); }
  return {name, file};
}
