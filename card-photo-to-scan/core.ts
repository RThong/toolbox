// 不碰 DOM / Canvas:纯函数才能在 bun test 里直接测

export type Pt = [number, number];
export type Gray = { data: Float32Array; w: number; h: number };
export type Pixels = { data: Uint8Array | Uint8ClampedArray; w: number; h: number; ch: 3 | 4 };

export const CARD_MM: Pt = [85.6, 54];
export const A4_MM: Pt = [210, 297];
export const CORNER_MM = 3.18; // ID-1 标准圆角半径
export const WARP_DPI = 600; // 先按 600dpi 拉正,再缩到输出 DPI,比直接出小图清楚
export const OUT_DPI = 300; // 扫描仪默认档,实测最小字(约 1.5mm 高)仍清晰;600dpi 体积约 ×3
export const QUALITY = 0.85; // JPEG 质量;300dpi 下 75→85 只多 ~80KB,取 85 给字边留余量
export const CONTRAST = 1.08; // 略提对比度,更像扫描件
export const SLOTS_TOP = [0.2, 0.55];

const F = 2; // 精修时降采样倍数
const K = 4; // 台阶两侧各取 K 像素求均值,平掉背景纹理
const BAND = 0.06; // 精修搜索半宽(占画面短边比例);实测 DocAligner 粗定位最大偏差为短边 1.5%,留足余量
const SIGMA = 2;

export const px = (mm: number, dpi: number) => Math.round((mm / 25.4) * dpi);

export function grayHalf({ data, w, h, ch }: Pixels): Gray {
  const W = Math.floor(w / F);
  const H = Math.floor(h / F);
  const g = new Float32Array(W * H);
  const lum = (x: number, y: number) => {
    const i = (y * w + x) * ch;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      g[y * W + x] = (lum(2 * x, 2 * y) + lum(2 * x + 1, 2 * y) + lum(2 * x, 2 * y + 1) + lum(2 * x + 1, 2 * y + 1)) / 4;

  return blur({ data: g, w: W, h: H });
}

function blur({ data, w, h }: Gray): Gray {
  const r = Math.ceil(3 * SIGMA);
  const raw = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * SIGMA * SIGMA)));
  const sum = raw.reduce((a, b) => a + b, 0);
  const kernel = raw.map((v) => v / sum);
  const pass = (src: Float32Array, dx: number, dy: number) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) {
          const xx = Math.min(Math.max(x + k * dx, 0), w - 1);
          const yy = Math.min(Math.max(y + k * dy, 0), h - 1);
          acc += src[yy * w + xx] * kernel[k + r];
        }
        out[y * w + x] = acc;
      }
    return out;
  };

  return { data: pass(pass(data, 1, 0), 0, 1), w, h };
}

// step[i] = 后 K 像素均值 − 前 K 像素均值,对应位置 i+K
export function step(a: number[]): number[] {
  const c = a.reduce((acc, v) => (acc.push(acc[acc.length - 1] + v), acc), [0]);
  const win = c.slice(K).map((v, i) => (v - c[i]) / K);

  return win.slice(K).map((v, i) => v - win[i]);
}

// 沿法线由外向内取一段亮度,最强的「暗→亮」台阶就是卡边。
// 手拖后吸附也用最强:实测 128 次拖动(偏 8/20px、四个方向)失败 4 次,改取「离放下处最近的明显台阶」反而失败 24 次(背景纹理被当成边)
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

const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);

// 四边形长宽比与 ID-1(1.59)的相对偏差;超过 8% 多半是没找准边
export function ratioOff(c: Pt[]): number {
  const ratio = (dist(c[0], c[1]) + dist(c[3], c[2])) / (dist(c[0], c[3]) + dist(c[1], c[2]));
  return Math.abs(ratio / (CARD_MM[0] / CARD_MM[1]) - 1);
}

// 边 e(0 上 / 1 右 / 2 下 / 3 左):两端角下标、由外向内的法线、拟合时哪一维当自变量(横边 y=f(x),竖边 x=f(y))
const EDGES: [number, number, Pt, 0 | 1][] = [
  [0, 1, [0, 1], 0],
  [1, 2, [-1, 0], 1],
  [3, 2, [0, -1], 0],
  [0, 3, [1, 0], 1],
];
// 角 k 是哪两条边的交点:[竖边, 横边]
const CORNER_EDGES = [
  [3, 0],
  [1, 0],
  [1, 2],
  [3, 2],
];

// small:降采样坐标下的四角
function edgeLine(img: Gray, small: Pt[], e: number): Pt {
  const band = Math.floor(Math.min(img.w, img.h) * BAND);
  const [i, j, n, v] = EDGES[e];
  const [a, b] = [small[i], small[j]];

  return fit(
    Array.from({ length: 150 }, (_, t) => 0.15 + (0.7 * t) / 149)
      .map((t) => hit(img, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], n, band))
      .map((q): Pt => [q[v], q[1 - v]]),
  );
}

const toSmall = (c: Pt[]) => c.map(([x, y]): Pt => [x / F, y / F]);

function cornerAt(lines: Pt[], k: number): Pt {
  const [v, h] = CORNER_EDGES[k];
  const [x, y] = meet(lines[v], lines[h]);
  return [x * F, y * F];
}

// 四角顺序按照片里的位置(左上/右上/右下/左下,原图像素),与卡面朝向无关
export function refine(img: Gray, rough: Pt[]): Pt[] {
  const small = toSmall(rough);
  const lines = EDGES.map((_, e) => edgeLine(img, small, e));

  return rough.map((_, k) => cornerAt(lines, k));
}

// 只重算角 k 相邻的两条边:用户已摆好的其余三个角不能被连带改动
export function snapCorner(img: Gray, corners: Pt[], k: number): Pt[] {
  const small = toSmall(corners);
  const lines: Pt[] = [];
  CORNER_EDGES[k].forEach((e) => (lines[e] = edgeLine(img, small, e)));

  return corners.map((p, i) => (i === k ? cornerAt(lines, k) : p));
}

// DocAligner 热力图(1×4×H×W)→ 四角(0~1 归一化):每张图取 ≥0.3 的最大连通块质心,同官方 postprocess
export function heatmapCorners(data: Float32Array, w: number, h: number): (Pt | null)[] {
  return Array.from({ length: 4 }, (_, k) => {
    const hm = data.subarray(k * w * h, (k + 1) * w * h);
    const seen = new Uint8Array(w * h);
    let best = { n: 0, sx: 0, sy: 0 };
    for (let i = 0; i < w * h; i++) {
      if (seen[i] || hm[i] < 0.3) continue;
      const blob = { n: 0, sx: 0, sy: 0 };
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop()!;
        const [x, y] = [j % w, Math.floor(j / w)];
        blob.n++;
        blob.sx += x;
        blob.sy += y;
        const next = [x > 0 && j - 1, x < w - 1 && j + 1, y > 0 && j - w, y < h - 1 && j + w];
        next.forEach((n) => {
          if (n !== false && !seen[n] && hm[n] >= 0.3) {
            seen[n] = 1;
            stack.push(n);
          }
        });
      }
      if (blob.n > best.n) best = blob;
    }
    return best.n ? [(best.sx / best.n + 0.5) / w, (best.sy / best.n + 0.5) / h] : null;
  });
}

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

export function warp(src: Pixels, corners: Pt[], w: number, h: number): Pixels {
  const [a, b, c, d, e, f, g, hh] = homography([[0, 0], [w, 0], [w, h], [0, h]], corners);
  const { data, w: sw, h: sh, ch } = src;
  const out = new Uint8ClampedArray(w * h * ch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [ox, oy] = [x + 0.5, y + 0.5];
      const z = g * ox + hh * oy + 1;
      const u = Math.min(Math.max((a * ox + b * oy + c) / z - 0.5, 0), sw - 1.001);
      const v = Math.min(Math.max((d * ox + e * oy + f) / z - 0.5, 0), sh - 1.001);
      const [x0, y0] = [Math.floor(u), Math.floor(v)];
      const [fx, fy] = [u - x0, v - y0];
      const i00 = (y0 * sw + x0) * ch;
      const i10 = i00 + ch;
      const i01 = i00 + sw * ch;
      const i11 = i01 + ch;
      for (let k = 0; k < ch; k++) {
        const top = data[i00 + k] * (1 - fx) + data[i10 + k] * fx;
        const bot = data[i01 + k] * (1 - fx) + data[i11 + k] * fx;
        out[(y * w + x) * ch + k] = top * (1 - fy) + bot * fy;
      }
    }

  return { data: out, w, h, ch };
}

// 反复精修直到四角稳定:粗框偏得超出搜索窗时(如手拖偏 100px+),单轮只能拉回一部分,
// 下一轮以上一轮结果为起点就能进窗。最多 5 轮,四角都移动不足 1px 即停
function untilStable(once: (c: Pt[]) => Pt[], start: Pt[]): Pt[] {
  let cur = start;
  for (let i = 0; i < 5; i++) {
    const next = once(cur);
    const moved = Math.max(...next.map((p, k) => dist(p, cur[k])));
    cur = next;
    if (!(moved >= 1)) break;
  }
  return cur;
}

export const refineStable = (img: Gray, rough: Pt[]) => untilStable((c) => refine(img, c), rough);
export const snapCornerStable = (img: Gray, corners: Pt[], k: number) => untilStable((c) => snapCorner(img, c, k), corners);

// 精修结果能不能用:角点重合、拖成细条时直线拟合会退化成 NaN 或自相交,那时应保留用户原来的角点
export function validQuad(c: Pt[], w: number, h: number): boolean {
  const inRange = c.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x > -0.05 * w && x < 1.05 * w && y > -0.05 * h && y < 1.05 * h);
  const cross = c.map((p, i) => {
    const [q, r] = [c[(i + 1) % 4], c[(i + 2) % 4]];
    return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
  });
  const convex = cross.every((v) => v > 0) || cross.every((v) => v < 0);
  const minSide = Math.min(...c.map((p, i) => dist(p, c[(i + 1) % 4])));

  return inRange && convex && minSide > 0.02 * Math.min(w, h);
}

// 卡片在照片里竖放或倒放时,把照片位置顺序的四角转成卡面顺序:每转一次,卡面顺时针转 90°
export const turned = (c: Pt[], t: number): Pt[] => c.map((_, i) => c[(i - (t % 4) + 4) % 4]);
