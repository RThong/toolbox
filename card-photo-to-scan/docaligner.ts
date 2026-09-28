// 选 fastvit_t8:实测四张证件照粗定位最大误差为短边 1.5%,在精修搜索窗(6%)内;lcnet100 到 3.9%,余量太小
// 只要 CPU(wasm)后端:默认入口带 WebGPU,会多拉 27MB 的 jsep.wasm
import * as ort from 'onnxruntime-web/wasm';
import { heatmapCorners, type Pt } from './core';

const N = 256;

// wasm 与页面同源托管(构建时拷进 dist),不请求任何第三方
ort.env.wasm.wasmPaths = new URL('./', location.href).href;
// GitHub Pages 不带跨域隔离响应头,开不了多线程
ort.env.wasm.numThreads = 1;

let session: Promise<ort.InferenceSession> | undefined;

// 自己下载模型而不是把 URL 交给 onnxruntime:这样才拿得到进度,慢网络下用户知道还要等多久
async function fetchModel(onProgress?: (ratio: number) => void): Promise<Uint8Array> {
  const res = await fetch(new URL('./models/fastvit_t8.onnx', location.href));
  if (!res.ok || !res.body) throw new Error(`模型下载失败:HTTP ${res.status}`);
  // 传输被 gzip 时 content-length 是压缩后大小、读到的是解压后字节,比值会超 1,故封顶 99%
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total) onProgress?.(Math.min(loaded / total, 0.99));
  }
  const buf = new Uint8Array(loaded);
  chunks.reduce((off, c) => (buf.set(c, off), off + c.length), 0);
  return buf;
}

export const loadModel = (onProgress?: (ratio: number) => void) => {
  session ??= fetchModel(onProgress).then((buf) => ort.InferenceSession.create(buf));
  return session;
};

// 返回原图像素坐标的四角(左上/右上/右下/左下);模型认不出时返回 null
// 逐次对半缩到接近 N 再缩到 N×N。一步 drawImage 缩 10 倍会混叠,
// 实测一张照片的粗定位因此偏了短边 20%(超出精修搜索窗);对半缩每步近似 2×2 平均
function shrink(bitmap: ImageBitmap): OffscreenCanvasRenderingContext2D {
  let src: CanvasImageSource = bitmap;
  let [w, h] = [bitmap.width, bitmap.height];
  while (w >= 4 * N && h >= 4 * N) {
    [w, h] = [Math.round(w / 2), Math.round(h / 2)];
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d')!.drawImage(src, 0, 0, w, h);
    src = c;
  }
  const ctx = new OffscreenCanvas(N, N).getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, N, N);
  return ctx;
}

export async function detect(bitmap: ImageBitmap): Promise<Pt[] | null> {
  const ctx = shrink(bitmap);
  const { data } = ctx.getImageData(0, 0, N, N);
  const x = new Float32Array(3 * N * N);
  for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) x[c * N * N + i] = data[i * 4 + c] / 255;

  const out = await (await loadModel()).run({ img: new ort.Tensor('float32', x, [1, 3, N, N]) });
  const hm = out.heatmap;
  const [, , h, w] = hm.dims as number[];
  const pts = heatmapCorners(hm.data as Float32Array, w, h);
  if (pts.some((p) => !p)) return null;

  return pts.map((p): Pt => [p![0] * bitmap.width, p![1] * bitmap.height]);
}
