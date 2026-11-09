// Builds the Android app: node scripts/build-android.mjs [apk|debug|install|run]
//   apk      release/听腔-<version>.apk, for phones
//   debug    the same app with WebView debugging on, for tests (tests/android.mjs)
//   install  debug, then installs it on the phone or emulator adb sees (ANDROID_SERIAL picks one)
//   run      install, then opens it
// The app is one WebView screen, so it is built with the SDK's own tools (aapt2, javac, d8, apksigner) rather than Gradle.
// The toolchain, model and output live outside OneDrive, like the Windows build; README says how to set them up.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {separationModel} from './separation-model.mjs';

const BUILD_TOOLS = '36.1.0', PLATFORM = 'android-36', MIN_SDK = 26, TARGET_SDK = 36, PACKAGE = 'com.tingqiang.app';
// ONNX Runtime's Android build runs the separation model on the phone's cores (android/.../NativeModel.java).
const ORT = {version: '1.31.1', sha1: '3c0fccc45f50e684c9d79a8f016f674488377223'};
const root = fileURLToPath(new URL('..', import.meta.url));
const work = process.env.TINGQIANG_BUILD_DIR || join(process.env.LOCALAPPDATA || tmpdir(), 'tingqiang-build');
const toolchain = join(work, 'android'), out = join(toolchain, 'build');
const [mode = 'apk'] = process.argv.slice(2);
if (!['apk', 'debug', 'install', 'run'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
const debug = mode !== 'apk';

const firstFolder = folder => existsSync(folder) ? readdirSync(folder).map(name => join(folder, name)).find(path => statSync(path).isDirectory()) : undefined;
const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || join(toolchain, 'sdk');
const jdk = process.env.JAVA_HOME || firstFolder(join(toolchain, 'jdk'));
const windows = process.platform === 'win32';
const tool = (folder, name) => join(folder, windows ? `${name}.exe` : name);
const buildTools = join(sdk, 'build-tools', BUILD_TOOLS), androidJar = join(sdk, 'platforms', PLATFORM, 'android.jar');
const [java, javac, jar, keytool] = ['java', 'javac', 'jar', 'keytool'].map(name => tool(join(jdk || '', 'bin'), name));
const aapt2 = tool(buildTools, 'aapt2'), zipalign = tool(buildTools, 'zipalign');
const adb = existsSync(tool(join(sdk, 'platform-tools'), 'adb')) ? tool(join(sdk, 'platform-tools'), 'adb') : 'adb';

for (const [path, what] of [[jdk && javac, 'JDK 17 or later'], [aapt2, `build-tools ${BUILD_TOOLS}`], [androidJar, `platforms;${PLATFORM}`]]) {
  if (!path || !existsSync(path)) throw new Error(`Missing ${what}. See README.md, 「安卓 App」.`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args.map(String), {stdio: 'inherit', env: {...process.env, JAVA_HOME: jdk}, ...options});
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}
const files = folder => readdirSync(folder, {recursive: true, withFileTypes: true}).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));

const {version} = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const [major, minor, patch] = version.split('.').map(Number);
const versionCode = major * 10000 + minor * 100 + patch;
// Phones are ARM; the debug build also carries x86_64 for the emulator the tests run in.
const abis = debug ? ['arm64-v8a', 'x86_64'] : ['arm64-v8a'];

/** The unpacked AAR. The archive is downloaded once from Maven Central into the cache and checked. */
function onnxRuntime() {
  const folder = join(toolchain, `onnxruntime-${ORT.version}`), aar = join(toolchain, 'cache', 'onnxruntime', `onnxruntime-android-${ORT.version}.aar`);
  if (existsSync(join(folder, 'classes.jar'))) return folder;
  if (!existsSync(aar)) {
    const url = `https://repo1.maven.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/${ORT.version}/onnxruntime-android-${ORT.version}.aar`;
    mkdirSync(dirname(aar), {recursive: true});
    console.log(`Downloading ${url}`);
    run('curl', ['-L', '--fail', '--silent', '--show-error', '-o', aar, url]);
  }
  const actual = createHash('sha1').update(readFileSync(aar)).digest('hex');
  if (actual !== ORT.sha1) { rmSync(aar); throw new Error(`${aar} failed its checksum: ${actual}`); }
  rmSync(folder, {recursive: true, force: true});
  mkdirSync(folder, {recursive: true});
  run(jar, ['--extract', '--file', aar], {cwd: folder});
  return folder;
}

rmSync(out, {recursive: true, force: true});
// stage/ holds what goes into the APK beside the compiled resources: assets/web, lib/<abi> and classes.dex.
for (const folder of ['stage', 'classes', 'gen']) mkdirSync(join(out, folder), {recursive: true});

// The page, exactly as dist/ has it, plus the separation model the web build would download.
cpSync(join(root, 'dist'), join(out, 'stage', 'assets', 'web'), {recursive: true});
const model = separationModel(work);
cpSync(model.file, join(out, 'stage', 'assets', 'web', 'models', model.name));
const ort = onnxRuntime();
for (const abi of abis) cpSync(join(ort, 'jni', abi), join(out, 'stage', 'lib', abi), {recursive: true});

const unsigned = join(out, 'app.unsigned.apk'), aligned = join(out, 'app.aligned.apk');
run(aapt2, ['compile', '--dir', join(root, 'android', 'res'), '-o', join(out, 'res.zip')]);
run(aapt2, ['link', '-o', unsigned, '-I', androidJar, '--manifest', join(root, 'android', 'AndroidManifest.xml'), '--java', join(out, 'gen'),
  '--min-sdk-version', MIN_SDK, '--target-sdk-version', TARGET_SDK, '--version-code', versionCode, '--version-name', version,
  ...(debug ? ['--debug-mode'] : []), join(out, 'res.zip')]);

const sources = [...files(join(root, 'android', 'src')), ...files(join(out, 'gen'))].filter(file => file.endsWith('.java'));
// Java 8 source against android.jar, as Android's own build does for code this plain. android.jar has no lambda
// factory, so javac also gets the build tools' stub of it; d8 then turns the lambdas into ordinary classes.
const bootClasspath = [androidJar, join(buildTools, 'core-lambda-stubs.jar')].join(windows ? ';' : ':');
run(javac, ['-J-Duser.language=en', '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-Xlint:-options', '-bootclasspath', bootClasspath,
  '-classpath', join(ort, 'classes.jar'), '-d', join(out, 'classes'), ...sources]);
run(java, ['-cp', join(buildTools, 'lib', 'd8.jar'), 'com.android.tools.r8.D8', debug ? '--debug' : '--release', '--min-api', MIN_SDK,
  '--lib', androidJar, '--output', join(out, 'stage'), join(ort, 'classes.jar'), ...files(join(out, 'classes')).filter(file => file.endsWith('.class'))]);
// Not aapt2's -A: on Windows it stores assets as assets/web\index.html, which Android cannot find. Android's own build
// adds assets itself too. jar writes / separators and keeps resources.arsc uncompressed, as Android requires.
run(jar, ['--update', '--no-manifest', '--file', unsigned, '-C', join(out, 'stage'), '.']);
run(zipalign, ['-P', '16', '-f', '4', unsigned, aligned]);

// A development key unless a release key is given. Phones only update an app signed with the same key, so a published
// app must keep using one release key forever: see README.md.
function signingKey() {
  if (process.env.TINGQIANG_KEYSTORE) {
    return {file: process.env.TINGQIANG_KEYSTORE, alias: process.env.TINGQIANG_KEY_ALIAS || 'tingqiang', password: ['--ks-pass', 'env:TINGQIANG_KEYSTORE_PASSWORD']};
  }
  const file = join(toolchain, 'keys', 'development.jks');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), {recursive: true});
    run(keytool, ['-genkeypair', '-keystore', file, '-storepass', 'android', '-keypass', 'android', '-alias', 'development', '-keyalg', 'RSA',
      '-keysize', '3072', '-validity', '10000', '-dname', 'CN=TingQiang development build']);
  }
  return {file, alias: 'development', password: ['--ks-pass', 'pass:android']};
}
const key = signingKey(), apk = join(out, debug ? 'tingqiang-debug.apk' : 'tingqiang.apk');
const apksigner = ['-jar', join(buildTools, 'lib', 'apksigner.jar')];
run(java, [...apksigner, 'sign', '--ks', key.file, '--ks-key-alias', key.alias, ...key.password, '--out', apk, aligned]);
run(java, [...apksigner, 'verify', apk]);
console.log(`Built ${apk} (${(statSync(apk).size / 1e6).toFixed(1)} MB, version ${version} / ${versionCode}${debug ? ', debuggable' : ''})`);

if (mode === 'apk') {
  const release = join(root, 'release');
  mkdirSync(release, {recursive: true});
  cpSync(apk, join(release, `听腔-${version}.apk`));
  console.log(`Copied to ${join(release, `听腔-${version}.apk`)}`);
}
if (mode === 'install' || mode === 'run') run(adb, ['install', '-r', apk]);
if (mode === 'run') run(adb, ['shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`]);
