import { resolve, sep } from 'node:path';

const port = Number(process.env.PORT ?? 4173);
const root = resolve('dist');

// 只听本机:预览时页面里是证件照,不该让局域网访问
Bun.serve({
  hostname: 'localhost',
  port,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    // resolve 后必须仍在 dist 里:防 ..%2F 这类路径穿越读到仓库外的文件
    const target = resolve(root, `.${path.endsWith('/') ? `${path}index.html` : path}`);
    const file = Bun.file(target);
    if (!target.startsWith(root + sep) || !(await file.exists())) return new Response('Not found', { status: 404 });
    return new Response(file);
  },
});
console.log(`http://localhost:${port}/`);
