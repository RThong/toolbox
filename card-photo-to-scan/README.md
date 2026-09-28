# card-photo-to-scan

证件正反面手机照片 → 实际尺寸的 A4 扫描件 PDF(ID-1 卡片:在留卡 / 身份证 / マイナンバー / 驾照等,85.6 × 54 mm)。
纯网页,照片只在浏览器里处理,不上传;页面也不请求任何第三方(模型和 wasm 同源托管)。
首次打开要下载模型(12.6 MB)和 onnxruntime wasm(13.6 MB,gzip 传输约 3.5 MB),之后走浏览器缓存;加载进度显示在「下载 PDF」按钮旁。

## 用法

1. 把照片拖到(或点击)纸上的正面 / 背面位置,可只放一面
2. 检查右侧四个红点;没对准就拖动(也可 Tab 选中后方向键微调),松手后自动贴到卡边
3. 卡片在照片里竖放或倒放时,点「旋转 90°」
4. 下载 PDF,打印选「实际大小 / 100%」,不要「适合页面」

## 本地运行

在 `toolbox/` 根目录:

```bash
bun install
bun run preview   # 构建到 dist/ 并起本地服务 http://localhost:4173/
```

推送到 `main` 后,GitHub Actions(`.github/workflows/pages.yml`)自动构建并发布到 GitHub Pages。

## 原理

1. **粗定位**四角:DocAligner 模型(`docaligner.ts`,onnxruntime-web)。抗杂乱背景、光照不匀,但角点会偏(实测最多短边 1.5%)
2. **精修**(`core.ts`):在每条粗边附近的窄带里找最强的「暗→亮」台阶,拟合直线求交点,反复几轮直到稳定。
   手拖某个角后只重算与它相邻的两条边,其余三个角不动
3. 透视拉正(600dpi)→ 缩到 300dpi → 圆角外涂白、加浅灰边 → JPEG 质量 85
4. 两张卡按 85.6 × 54 mm 嵌进 A4 页(`pdf.ts`,pdf-lib),整页白纸不存图,一份约 250~310 KB

## 已知局限

- 卡面要比紧贴它的背景亮(浅色卡放深色 / 中间色桌面)。白卡放白桌面会找不准
- 卡内有贴近卡边的深色线(如在留卡背面的表格线)时,手拖偏得较远,可能贴到那条线上;取消勾选「松手后自动贴边」即可手动摆放
- 四边形长宽比偏离 ID-1(1.59)超过 8% 时会提示,那时检查四角

## 第三方

`models/fastvit_t8.onnx` 来自 [DocsaidLab/DocAligner](https://github.com/DocsaidLab/DocAligner)
(热力图模型 `fastvit_t8_h_e_bifpn_256_fp32`),Apache-2.0,许可证原文见 `models/DocAligner-LICENSE`。

## 开发

在 `toolbox/` 根目录跑:`bun test` · `bun run typecheck` · `bun run build`
