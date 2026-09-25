/**
 * serve.mjs — 零依赖本地静态服务器
 * ---------------------------------------------------------------
 * 用途：ES Modules 在 file:// 协议下会被浏览器同源策略拦截，
 *       因此需要以 http 方式打开站点。本脚本仅供本地预览与自检。
 *
 * 用法：node tools/serve.mjs [端口]     （默认 5173）
 * 说明：仅监听 127.0.0.1，不对外暴露；生产部署请交由任意静态托管。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.argv[2]) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** 把 URL 路径解析为 ROOT 内的安全绝对路径；越界返回 null */
function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(clean).replace(/^([/\\])+/, '');
  const abs = join(ROOT, rel || 'index.html');
  if (abs !== ROOT && !abs.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return null;
  return abs;
}

const server = createServer(async (req, res) => {
  let abs = resolveSafe(req.url || '/');
  if (!abs) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 路径越界');
  }

  try {
    let info = await stat(abs);
    if (info.isDirectory()) {
      abs = join(abs, 'index.html');
      info = await stat(abs);
    }
    const body = await readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<meta charset="utf-8"><h1>404</h1><p>未找到该资源。请从站点根目录访问。</p>');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  孙氏族谱 · 本地预览\n  → http://127.0.0.1:${PORT}/\n  根目录：${ROOT}\n  Ctrl+C 结束\n`);
});
