import { CARD_MM, CONTRAST, CORNER_MM, type Gray, grayHalf, OUT_DPI, type Pt, px, QUALITY, ratioOff, refineStable, snapCornerStable, turned, validQuad, WARP_DPI, warp } from './core';
import { detect, loadModel } from './docaligner';
import { buildPdf } from './pdf';

type Side = {
  src: ImageData;
  gray: Gray;
  corners: Pt[]; // 按照片里的位置排:左上/右上/右下/左下
  turn: number; // 卡面顺时针转了几个 90°
  url: string;
};

const NAMES = ['正面', '背面'];
const CORNER_NAMES = ['左上角', '右上角', '右下角', '左下角'];
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
const slots = [...document.querySelectorAll<HTMLButtonElement>('.slot')];
const fileInput = $<HTMLInputElement>('#file');
const statusEl = $<HTMLParagraphElement>('#status');
const downloadBtn = $<HTMLButtonElement>('#download');
const editor = $<HTMLDivElement>('#editor');
const photo = $<HTMLImageElement>('#photo');
const overlay = $<SVGSVGElement>('#overlay');
const quad = $<SVGPolygonElement>('#quad');
const warnEl = $<HTMLParagraphElement>('#warn');
const snap = $<HTMLInputElement>('#snap');

const sides: (Side | undefined)[] = [undefined, undefined];
let active = 0;
let pickingFor = 0;
let modelOk = true;

const say = (text: string) => (statusEl.textContent = text);

// 页面一打开就开始下载模型,用户放照片时多半已就绪
say('正在加载识别模型…（只有第一次打开需要下载）');
loadModel((ratio) => say(`正在加载识别模型… ${Math.round(ratio * 100)}%（只有第一次打开需要下载）`)).then(
  () => say('识别模型已就绪。'),
  () => {
    modelOk = false;
    say('识别模型加载失败：可以继续用，四角需要手动拖到卡片上。');
  },
);

// iOS Safari 单个 canvas 上限约 16.7M 像素,24MP 的手机原图得先缩;12M 像素给 300dpi 卡面仍绰绰有余
const MAX_PIXELS = 12e6;

async function decode(file: File): Promise<ImageBitmap> {
  const full = await createImageBitmap(file);
  const k = Math.sqrt(MAX_PIXELS / (full.width * full.height));
  if (k >= 1) return full;
  const small = await createImageBitmap(full, {
    resizeWidth: Math.round(full.width * k),
    resizeHeight: Math.round(full.height * k),
    resizeQuality: 'high',
  });
  full.close();
  return small;
}

// 模型认不出时也要给用户一个能拖的起点,不能卡住
function fallbackQuad(w: number, h: number): Pt[] {
  const cw = Math.min(w * 0.8, h * 0.8 * (CARD_MM[0] / CARD_MM[1]));
  const ch = cw * (CARD_MM[1] / CARD_MM[0]);
  const [x0, y0] = [(w - cw) / 2, (h - ch) / 2];
  return [[x0, y0], [x0 + cw, y0], [x0 + cw, y0 + ch], [x0, y0 + ch]];
}

async function load(i: number, file: File) {
  if (!file.type.startsWith('image/')) {
    say(`「${file.name}」不是图片，请换一张照片。`);
    return;
  }
  say(`正在识别${NAMES[i]}照片…`);
  slots[i].classList.add('busy');

  try {
    // createImageBitmap 默认按 EXIF 转正,与 <img> 的显示方向一致
    const bitmap = await decode(file);
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const src = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const gray = grayHalf({ data: src.data, w: src.width, h: src.height, ch: 4 });

    // 识别失败只是少了自动框,不算读图失败
    const rough = (modelOk && (await detect(bitmap).catch(() => null))) || null;
    const refined = rough && refineStable(gray, rough);
    const found = !!refined && validQuad(refined, src.width, src.height);
    const corners = found ? refined : fallbackQuad(src.width, src.height);

    const old = sides[i];
    if (old) URL.revokeObjectURL(old.url);
    sides[i] = { src, gray, corners, turn: 0, url: URL.createObjectURL(file) };

    renderCard(i);
    select(i);
    say(found ? `${NAMES[i]}已放好。` : `没认出${NAMES[i]}照片里的卡片，请把四个红点拖到卡片的角上。`);
  } catch {
    say(`读不了「${file.name}」：浏览器不支持这种图片格式（如 HEIC）、文件已损坏或图片太大，请换成 JPEG 或 PNG。`);
  } finally {
    slots[i].classList.remove('busy');
  }
}

function cardCanvas(s: Side, out: HTMLCanvasElement) {
  const [W, H] = CARD_MM.map((mm) => px(mm, WARP_DPI));
  const flat = warp({ data: s.src.data, w: s.src.width, h: s.src.height, ch: 4 }, turned(s.corners, s.turn), W, H);
  const big = new OffscreenCanvas(W, H);
  big.getContext('2d')!.putImageData(new ImageData(flat.data as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0);

  const [w, h] = CARD_MM.map((mm) => px(mm, OUT_DPI));
  const r = px(CORNER_MM, OUT_DPI);
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
  ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, w, h);
  ctx.restore();

  // 略提对比度,更像扫描件(纸白提完仍是白)
  const img = ctx.getImageData(0, 0, w, h);
  const off = -128 * (CONTRAST - 1);
  img.data.forEach((v, k) => {
    if (k % 4 !== 3) img.data[k] = v * CONTRAST + off;
  });
  ctx.putImageData(img, 0, 0);

  ctx.strokeStyle = '#c8c8c8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(1, 1, w - 2, h - 2, r);
  ctx.stroke();
}

function renderCard(i: number) {
  const s = sides[i];
  const canvas = slots[i].querySelector('canvas')!;
  if (!s) return;
  cardCanvas(s, canvas);
  canvas.hidden = false;
  slots[i].classList.add('filled');
  slots[i].setAttribute('aria-label', `${NAMES[i]}：点击调整四角`);
  downloadBtn.disabled = false;
}

const handles = CORNER_NAMES.map((name) => {
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('class', 'handle');
  c.setAttribute('tabindex', '0');
  c.setAttribute('role', 'button');
  c.setAttribute('aria-label', `${name}，方向键移动`);
  overlay.append(c);
  return c;
});

function select(i: number) {
  active = i;
  slots.forEach((s, k) => s.classList.toggle('active', k === i));
  const s = sides[i];
  $<HTMLParagraphElement>('#editor-empty').hidden = !!s;
  editor.hidden = !s;
  if (!s) return;

  $<HTMLHeadingElement>('#editor-title').textContent = NAMES[i];
  photo.src = s.url;
  photo.alt = `${NAMES[i]}原图`;
  overlay.setAttribute('viewBox', `0 0 ${s.src.width} ${s.src.height}`);
  drawQuad();
  updateWarn();
}

// 红点按屏幕尺寸定大小(半径 11px,手指也按得准),而不是按原图:原图缩进手机屏后会只剩几个像素
function sizeHandles() {
  const s = sides[active];
  if (!s || !photo.clientWidth || !photo.clientHeight) return;
  const scale = Math.max(s.src.width / photo.clientWidth, s.src.height / photo.clientHeight);
  handles.forEach((h) => h.setAttribute('r', String(11 * scale)));
}

photo.addEventListener('load', sizeHandles);
new ResizeObserver(sizeHandles).observe(photo);

function drawQuad() {
  const s = sides[active];
  if (!s) return;
  quad.setAttribute('points', s.corners.map((p) => p.join(',')).join(' '));
  handles.forEach((h, k) => {
    h.setAttribute('cx', String(s.corners[k][0]));
    h.setAttribute('cy', String(s.corners[k][1]));
  });
}

// 只在松手 / 抬键时更新:拖动中每帧改写 role=alert 会让读屏软件连续播报
function updateWarn() {
  const s = sides[active];
  if (!s) return;
  const off = ratioOff(turned(s.corners, s.turn));
  warnEl.hidden = off <= 0.08;
  warnEl.textContent = `四角可能没对准：框出的长宽比和标准卡片差了 ${Math.round(off * 100)}%。把红点拖到卡片的角上；卡片竖着放时点「旋转 90°」。`;
}

function commit(k: number) {
  const s = sides[active];
  if (!s) return;
  const snapped = snap.checked && snapCornerStable(s.gray, s.corners, k);
  if (snapped && validQuad(snapped, s.src.width, s.src.height)) s.corners = snapped;
  drawQuad();
  updateWarn();
  renderCard(active);
}

const toSvg = (e: PointerEvent): Pt => {
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(overlay.getScreenCTM()!.inverse());
  return [p.x, p.y];
};

const MOVES: Record<string, Pt> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

// 角点移出图片后,透视采样会把边缘像素拉成大片条纹
const inside = (s: Side, [x, y]: Pt): Pt => [Math.min(Math.max(x, 0), s.src.width), Math.min(Math.max(y, 0), s.src.height)];

handles.forEach((h, k) => {
  h.addEventListener('pointerdown', (e) => {
    h.setPointerCapture(e.pointerId);
    h.classList.add('dragging');
  });
  h.addEventListener('pointermove', (e) => {
    const s = sides[active];
    if (!s || !h.hasPointerCapture(e.pointerId)) return;
    s.corners[k] = inside(s, toSvg(e));
    drawQuad();
  });
  h.addEventListener('pointerup', () => {
    h.classList.remove('dragging');
    commit(k);
  });

  // 键盘微调不吸附:每步很小,一吸附就会被拉回原处
  h.addEventListener('keydown', (e) => {
    const s = sides[active];
    const d = MOVES[e.key];
    if (!s || !d) return;
    e.preventDefault();
    const unit = Math.min(s.src.width, s.src.height) * 0.002 * (e.shiftKey ? 10 : 1);
    s.corners[k] = inside(s, [s.corners[k][0] + d[0] * unit, s.corners[k][1] + d[1] * unit]);
    drawQuad();
  });
  h.addEventListener('keyup', (e) => {
    if (!MOVES[e.key]) return;
    updateWarn();
    renderCard(active);
  });
});

slots.forEach((slot, i) => {
  slot.addEventListener('click', () => {
    if (sides[i]) return select(i);
    pickingFor = i;
    fileInput.click();
  });
  slot.addEventListener('dragover', (e) => {
    e.preventDefault();
    slot.classList.add('over');
  });
  slot.addEventListener('dragleave', () => slot.classList.remove('over'));
  slot.addEventListener('drop', (e) => {
    e.preventDefault();
    slot.classList.remove('over');
    const file = e.dataTransfer?.files[0];
    if (file) load(i, file);
  });
});

$<HTMLButtonElement>('#rotate').addEventListener('click', () => {
  const s = sides[active];
  if (!s) return;
  s.turn = (s.turn + 1) % 4;
  updateWarn();
  renderCard(active);
});

$<HTMLButtonElement>('#replace').addEventListener('click', () => {
  pickingFor = active;
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (file) load(pickingFor, file);
});

const toJpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array>((resolve, reject) =>
    canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error('JPEG 编码失败'))), 'image/jpeg', QUALITY),
  );

downloadBtn.addEventListener('click', async () => {
  const bytes = await Promise.all(slots.map((slot, i) => (sides[i] ? toJpeg(slot.querySelector('canvas')!) : null)))
    .then(buildPdf)
    .catch(() => null);
  if (!bytes) {
    say('生成 PDF 失败，请刷新页面后重试。');
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
  a.download = '扫描件.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  say(`已下载 扫描件.pdf（${Math.round(bytes.length / 1024)} KB）。`);
});
