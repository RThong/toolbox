import { cp, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ['index.html', 'card-photo-to-scan/index.html'],
  outdir: 'dist',
  minify: true,
});
if (!result.success) {
  result.logs.forEach((l) => console.error(l));
  process.exit(1);
}

// 模型与 wasm 不经打包器:docaligner.ts 按页面相对路径取它们
const ORT = 'node_modules/onnxruntime-web/dist';
await cp('card-photo-to-scan/models', 'dist/card-photo-to-scan/models', { recursive: true });
await Promise.all(
  ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'].map((f) => cp(`${ORT}/${f}`, `dist/card-photo-to-scan/${f}`)),
);
console.log(result.outputs.map((o) => o.path.replace(`${process.cwd()}/`, '')).join('\n'));
