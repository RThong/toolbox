// 证件正反面照片 → 实际尺寸的 A4 扫描件 PDF(ID-1 卡:在留卡 / 身份证 / 驾照等,85.6×54mm)
// 1. detect.swift(macOS Vision)粗定位四角  2. 每条粗边附近的窄带里找最强「暗→亮」台阶精修
// 3. 透视拉正 → 缩到输出 DPI → 圆角外涂白 → 按实际尺寸嵌进 A4
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

type Pt = [number, number];

const CARD_MM: Pt = [85.6, 54];
const A4_MM: Pt = [210, 297];
const CORNER_MM = 3.18; // ID-1 标准圆角半径
const WARP_DPI = 600; // 先按 600dpi 拉正,再 lanczos 缩到输出 DPI,比直接出小图清楚
const OUT_DPI = 300; // 扫描仪默认档,实测最小字(约 1.5mm 高)仍清晰;600dpi 体积约 ×3
const QUALITY = 85; // JPEG 质量;300dpi 下 75→85 只多 ~80KB,取 85 给字边留余量
const F = 2; // 精修时降采样倍数
const K = 4; // 台阶两侧各取 K 像素求均值,平掉背景纹理
const BAND = 0.06; // 精修搜索半宽(占画面短边比例);实测 Vision 最大偏差约为短边 5%

const px = (mm: number, dpi: number) => Math.round((mm / 25.4) * dpi);
const pt = (mm: number) => (mm / 25.4) * 72;

async function rough(path: string): Promise<Pt[]> {
  const p = Bun.spawn(['swift', `${import.meta.dir}/detect.swift`, path], { stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code) throw new Error(`${path}: ${err.trim()}`);

  return JSON.parse(out);
}

// step[i] = 后 K 像素均值 − 前 K 像素均值,对应位置 i+K
export function step(a: number[]): number[] {
  const c = a.reduce((acc, v) => (acc.push(acc[acc.length - 1] + v), acc), [0]);
  const win = c.slice(K).map((v, i) => (v - c[i]) / K);

  return win.slice(K).map((v, i) => v - win[i]);
}

type Gray = { data: Buffer; w: number; h: number };

// 沿法线由外向内取一段亮度,最强的「暗→亮」台阶就是卡边
function hit(img: Gray, p: Pt, inward: Pt, band: number): Pt {
  const clamp = (v: number, hi: number) => Math.min(Math.max(Math.round(v), 0), hi);
  const s = Array.from({ length: 2 * band }, (_, i) => i - band);
  const profile = s.map((t) => {
    const x = clamp(p[0] + inward[0] * t, img.w - 1);
    const y = clamp(p[1] + inward[1] * t, img.h - 1);
    return img.data[y * img.w + x];
  });
  const d = step(profile);
  const at = s[d.indexOf(Math.max(...d)) + K];

  return [p[0] + inward[0] * at, p[1] + inward[1] * at];
}

function percentile(a: number[], q: number): number {
  const s = [...a].sort((x, y) => x - y);
  const i = (q / 100) * (s.length - 1);
  const lo = Math.floor(i);

  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

// 最小二乘拟合 u = k*v + b,三轮剔除离群点
export function fit(pts: Pt[]): Pt {
  const line = (p: Pt[]): Pt => {
    const n = p.length;
    const [sv, su] = p.reduce(([a, b], [v, u]) => [a + v, b + u], [0, 0]);
    const svv = p.reduce((a, [v]) => a + v * v, 0);
    const svu = p.reduce((a, [v, u]) => a + v * u, 0);
    const k = (n * svu - sv * su) / (n * svv - sv * sv);
    return [k, (su - k * sv) / n];
  };
  const trim = (p: Pt[]) => {
    const [k, b] = line(p);
    const r = p.map(([v, u]) => Math.abs(u - (k * v + b)));
    const cut = Math.max(2, percentile(r, 80));
    return p.filter((_, i) => r[i] <= cut);
  };

  return line(trim(trim(trim(pts))));
}

// 竖边 x = a*y + c 与横边 y = d*x + e 的交点
function meet([a, c]: Pt, [d, e]: Pt): Pt {
  const y = (d * c + e) / (1 - d * a);
  return [a * y + c, y];
}

async function corners(path: string): Promise<Pt[]> {
  const { width, height } = await sharp(path).metadata();
  const { data, info } = await sharp(path)
    .greyscale()
    .resize(Math.floor(width / F), Math.floor(height / F), { fit: 'fill' })
    .blur(2)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const img: Gray = { data, w: info.width, h: info.height };
  const band = Math.floor(Math.min(img.w, img.h) * BAND);
  const [tl, tr, br, bl] = (await rough(path)).map(([x, y]): Pt => [x / F, y / F]);

  // 每条边:两端点、由外向内的法线、拟合时哪一维当自变量(横边 y=f(x),竖边 x=f(y))
  const edges: [Pt, Pt, Pt, 0 | 1][] = [
    [tl, tr, [0, 1], 0],
    [tr, br, [-1, 0], 1],
    [bl, br, [0, -1], 0],
    [tl, bl, [1, 0], 1],
  ];
  const [T, R, B, L] = edges.map(([a, b, n, v]) =>
    fit(
      Array.from({ length: 150 }, (_, i) => 0.15 + (0.7 * i) / 149)
        .map((t) => hit(img, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], n, band))
        .map((q): Pt => [q[v], q[1 - v]]),
    ),
  );
  const c = [meet(L, T), meet(R, T), meet(R, B), meet(L, B)].map(([x, y]): Pt => [x * F, y * F]);

  const len = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const ratio = (len(c[0], c[1]) + len(c[3], c[2])) / (len(c[0], c[3]) + len(c[1], c[2]));
  if (Math.abs(ratio / (CARD_MM[0] / CARD_MM[1]) - 1) > 0.08)
    console.warn(`  ⚠ 找到的四边形长宽比 ${ratio.toFixed(2)},ID-1 卡应为 1.59:检查输出,可能没找准边`);

  return c;
}

// 高斯-约当消元解 Ax = b
function solve(A: number[][], b: number[]): number[] {
  const M = A.map((row, i) => [...row, b[i]]);
  const n = b.length;
  for (let c = 0; c < n; c++) {
    const p = M.reduce((best, row, r) => (r >= c && Math.abs(row[c]) > Math.abs(M[best][c]) ? r : best), c);
    [M[c], M[p]] = [M[p], M[c]];
    M.forEach((row, r) => {
      if (r === c) return;
      const f = row[c] / M[c][c];
      M[r] = row.map((v, j) => v - f * M[c][j]);
    });
  }

  return M.map((row, i) => row[n] / row[i]);
}

// 透视变换 8 系数:输出坐标 (x,y) → 输入坐标 (u,v)
export function homography(dst: Pt[], src: Pt[]): number[] {
  const rows = dst.flatMap(([x, y], i) => {
    const [u, v] = src[i];
    return [
      [x, y, 1, 0, 0, 0, -u * x, -u * y],
      [0, 0, 0, x, y, 1, -v * x, -v * y],
    ];
  });

  return solve(rows, src.flat());
}

// 按系数把源图反向采样到 w×h(双线性)
function warp(src: Buffer, sw: number, sh: number, [a, b, c, d, e, f, g, h]: number[], w: number, hh: number) {
  const out = Buffer.alloc(w * hh * 3);
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < w; x++) {
      const [ox, oy] = [x + 0.5, y + 0.5];
      const z = g * ox + h * oy + 1;
      const u = Math.min(Math.max((a * ox + b * oy + c) / z - 0.5, 0), sw - 1.001);
      const v = Math.min(Math.max((d * ox + e * oy + f) / z - 0.5, 0), sh - 1.001);
      const [x0, y0] = [Math.floor(u), Math.floor(v)];
      const [fx, fy] = [u - x0, v - y0];
      const i00 = (y0 * sw + x0) * 3;
      const i10 = i00 + 3;
      const i01 = i00 + sw * 3;
      const i11 = i01 + 3;
      for (let ch = 0; ch < 3; ch++) {
        const top = src[i00 + ch] * (1 - fx) + src[i10 + ch] * fx;
        const bot = src[i01 + ch] * (1 - fx) + src[i11 + ch] * fx;
        out[(y * w + x) * 3 + ch] = top * (1 - fy) + bot * fy;
      }
    }

  return out;
}

async function card(path: string): Promise<Buffer> {
  const c = await corners(path);
  console.log(path, c.map(([x, y]) => [Math.round(x), Math.round(y)]));

  const [W, H] = CARD_MM.map((mm) => px(mm, WARP_DPI));
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const coeffs = homography([[0, 0], [W, 0], [W, H], [0, H]], c);
  const flat = warp(data, info.width, info.height, coeffs, W, H);

  const [w, h] = CARD_MM.map((mm) => px(mm, OUT_DPI));
  const r = px(CORNER_MM, OUT_DPI);
  const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);
  const rounded = await sharp(flat, { raw: { width: W, height: H, channels: 3 } })
    .resize(w, h, { kernel: 'lanczos3' })
    .linear(1.08, -128 * 0.08) // 略提对比度,更像扫描件
    .ensureAlpha()
    .composite([{ input: svg(`<rect width="${w}" height="${h}" rx="${r}"/>`), blend: 'dest-in' }])
    .png()
    .toBuffer();

  return sharp(rounded)
    .flatten({ background: '#fff' })
    .composite([{ input: svg(`<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${r}" fill="none" stroke="#c8c8c8" stroke-width="2"/>`) }])
    .withMetadata({ density: OUT_DPI })
    .jpeg({ quality: QUALITY })
    .toBuffer();
}

async function main([front, back, out]: string[]) {
  if (!out) {
    console.error('用法: bun scan.ts 正面.jpg 背面.jpg 输出.pdf');
    process.exit(1);
  }

  const pdf = await PDFDocument.create();
  const [pw, ph] = A4_MM.map(pt);
  const [cw, ch] = CARD_MM.map(pt);
  const page = pdf.addPage([pw, ph]);
  const jpgs = await Promise.all([front, back].map(card));
  const images = await Promise.all(jpgs.map((j) => pdf.embedJpg(j)));

  // PDF 原点在左下;正面上沿距页顶 20%,背面 55%
  images.forEach((image, i) =>
    page.drawImage(image, { x: (pw - cw) / 2, y: ph - ph * [0.2, 0.55][i] - ch, width: cw, height: ch }),
  );
  await Bun.write(out, await pdf.save());
  console.log('→', out);
}

if (import.meta.main) await main(Bun.argv.slice(2));
