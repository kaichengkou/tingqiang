// Syntax-checks every hand-written module, so a new file can't be forgotten.
import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';

for (const dir of ['dist', 'dist/lib', 'desktop', 'scripts', 'tests']) {
  for (const name of readdirSync(dir)) if (/\.[cm]js$/.test(name)) execFileSync(process.execPath, ['--check', `${dir}/${name}`], {stdio: 'inherit'});
}
console.log('All modules parse.');
