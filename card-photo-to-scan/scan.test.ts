import { expect, test } from 'bun:test';
import { fit, homography, step } from './scan';

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
