// 卡面单独嵌图、白纸不栅格化:同样清晰度下比整页存成一张图小约 120KB
import { PDFDocument } from 'pdf-lib';
import { A4_MM, CARD_MM, SLOTS_TOP } from './core';

const pt = (mm: number) => (mm / 25.4) * 72;

// jpgs[0] 正面、jpgs[1] 背面;缺哪面(null)就空着那个位置
export async function buildPdf(jpgs: (Uint8Array | null)[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const [pw, ph] = A4_MM.map(pt);
  const [cw, ch] = CARD_MM.map(pt);
  const page = pdf.addPage([pw, ph]);
  const images = await Promise.all(jpgs.map((j) => j && pdf.embedJpg(j)));

  // PDF 原点在左下
  images.forEach((image, i) => {
    if (image) page.drawImage(image, { x: (pw - cw) / 2, y: ph - ph * SLOTS_TOP[i] - ch, width: cw, height: ch });
  });

  return pdf.save();
}
