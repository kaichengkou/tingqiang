import {build} from 'esbuild';
await build({stdin: {contents: "export {pinyin} from 'pinyin-pro';", resolveDir: new URL('..', import.meta.url).pathname}, outfile: new URL('../dist/vendor/pinyin.mjs', import.meta.url).pathname, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, banner: {js: '/* pinyin-pro, MIT. See ../licenses/pinyin-pro-MIT.txt. */'}});
