import { expect, test } from 'bun:test';
import { fit, heatmapCorners, homography, step, turned, validQuad } from './core';

test('step 在暗→亮台阶处最大', () => {
  const profile = [...Array(20).fill(100), ...Array(20).fill(200)];
  const d = step(profile);
  expect(d.indexOf(Math.max(...d)) + 4).toBe(20);
});

test('fit 剔除离群点后还原直线', () => {
  const pts = Array.from({ length: 50 }, (_, i): [number, number] => [i, 0.1 * i + 5]);
  pts[10][1] = 999;
  const [k, b] = fit(pts);
  expect(k).toBeCloseTo(0.1, 6);
  expect(b).toBeCloseTo(5, 6);
});

test('homography 把输出矩形四角映射到源四边形', () => {
  const dst: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
  const src: [number, number][] = [[12, 8], [210, 30], [205, 150], [5, 130]];
  const [a, b, c, d, e, f, g, h] = homography(dst, src);
  dst.forEach(([x, y], i) => {
    const z = g * x + h * y + 1;
    expect((a * x + b * y + c) / z).toBeCloseTo(src[i][0], 6);
    expect((d * x + e * y + f) / z).toBeCloseTo(src[i][1], 6);
  });
});

test('heatmapCorners 取每张热力图最大连通块的质心', () => {
  const [w, h] = [8, 8];
  const data = new Float32Array(4 * w * h);
  // 第 0 张:(2,3) 一个 2×2 大块 + (7,7) 一个孤立小点,应取大块质心 (2.5,3.5)
  [[2, 3], [3, 3], [2, 4], [3, 4], [7, 7]].forEach(([x, y]) => (data[y * w + x] = 0.9));
  // 第 1 张全低于阈值,应返回 null
  data[w * h + 10] = 0.2;
  const [p0, p1] = heatmapCorners(data, w, h);
  expect(p0).toEqual([(2.5 + 0.5) / w, (3.5 + 0.5) / h]);
  expect(p1).toBeNull();
});

test('validQuad 拒掉 NaN、自相交、角点重合', () => {
  const ok: [number, number][] = [[10, 10], [90, 12], [88, 60], [12, 58]];
  expect(validQuad(ok, 100, 70)).toBe(true);
  expect(validQuad([[NaN, 10], ok[1], ok[2], ok[3]], 100, 70)).toBe(false);
  expect(validQuad([ok[0], ok[2], ok[1], ok[3]], 100, 70)).toBe(false);
  expect(validQuad([ok[0], ok[0], ok[2], ok[3]], 100, 70)).toBe(false);
});

test('turned 每转一次卡面顺时针 90°:新左上 = 原左下', () => {
  const c: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  expect(turned(c, 1)).toEqual([c[3], c[0], c[1], c[2]]);
  expect(turned(c, 4)).toEqual(c);
});
