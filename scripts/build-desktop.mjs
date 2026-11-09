// Builds the Windows client: node scripts/build-desktop.mjs [installer|dir|run] [app arguments]
// node_modules and output stay outside OneDrive, which would sync thousands of files and hold locks that break the build.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {separationModel} from './separation-model.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = process.env.TINGQIANG_BUILD_DIR || join(process.env.LOCALAPPDATA || tmpdir(), 'tingqiang-build');
const app = join(work, 'app');
const [mode = 'installer', ...appArguments] = process.argv.slice(2);
if (!['installer', 'dir', 'run'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);

const env = {...process.env};
if (env.HTTPS_PROXY) Object.assign(env, {ELECTRON_GET_USE_PROXY: '1', GLOBAL_AGENT_HTTPS_PROXY: env.HTTPS_PROXY});
function run(command, args, cwd = app) {
  const result = spawnSync(command, args, {cwd, env, stdio: 'inherit', shell: process.platform === 'win32'});
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function syncSources() {
  mkdirSync(app, {recursive: true});
  rmSync(join(app, 'web'), {recursive: true, force: true});
  cpSync(join(root, 'dist'), join(app, 'web'), {recursive: true});
  cpSync(join(root, 'desktop'), app, {recursive: true});
  const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  manifest.version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  writeFileSync(join(app, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function installDependencies() {
  const lock = join(app, 'package-lock.json'), marker = join(app, 'node_modules', '.installed-lock');
  const fingerprint = existsSync(lock) ? sha256(lock) : '';
  if (!fingerprint || !existsSync(marker) || readFileSync(marker, 'utf8') !== fingerprint) {
    run('npm', [fingerprint ? 'ci' : 'install', '--no-audit', '--no-fund']);
    writeFileSync(marker, fingerprint || sha256(lock));
    if (!fingerprint) cpSync(lock, join(root, 'desktop', 'package-lock.json'));
  }
  // Electron no longer downloads itself on install.
  run('node', ['node_modules/electron/install.js']);
}

function bundleModel() {
  const {name, file} = separationModel(work);
  cpSync(file, join(app, 'web', 'models', name));
}

syncSources();
installDependencies();
bundleModel();
if (mode === 'run') run('npx', ['electron', '.', ...appArguments]);
else {
  rmSync(join(app, 'out'), {recursive: true, force: true});
  // The Electron npm installed above, so packaging does not fetch it again (and cannot fail on the network).
  // On a tag in CI electron-builder would try to publish by itself; the workflow does that.
  run('npx', ['electron-builder', '--win', ...(mode === 'dir' ? ['--dir'] : ['nsis']), '--publish', 'never', '-c.electronDist=node_modules/electron/dist']);
  if (mode === 'installer') {
    const release = join(root, 'release');
    mkdirSync(release, {recursive: true});
    for (const name of readdirSync(join(app, 'out')).filter(name => name.endsWith('.exe'))) {
      cpSync(join(app, 'out', name), join(release, name));
      console.log(`Built ${join(release, name)}`);
    }
  }
}
