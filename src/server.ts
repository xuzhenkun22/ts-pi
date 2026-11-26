import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { json, tasks } from './api/tasks.js';
import { port } from './config/env.js';

const host = '127.0.0.1';
const listenPort = port();
const origin = `http://${host}:${listenPort}`;
const publicOrigin = process.env.HTTP_PUBLIC_ORIGIN;
const username = process.env.HTTP_AUTH_USER;
const password = process.env.HTTP_AUTH_PASSWORD;
if (
  (username || password || process.env.NODE_ENV === 'production' || publicOrigin) &&
  (!username || !password)
) {
  throw new Error('请配置 HTTP_AUTH_USER 和 HTTP_AUTH_PASSWORD');
}
const hash = (value: string) => createHash('sha256').update(value).digest();
const credential =
  username && password
    ? hash(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`)
    : null;
const allowedHosts = new Set([
  new URL(origin).host,
  ...(publicOrigin ? [new URL(publicOrigin).host] : []),
]);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
  // 限制 Host/Origin，避免外部页面利用浏览器访问本机任务服务。
  if (
    !allowedHosts.has(req.headers.host ?? '') ||
    (req.headers.origin && ![origin, publicOrigin].includes(req.headers.origin))
  ) {
    return json(res, 403, { error: '禁止跨站访问' });
  }
  if (credential && !timingSafeEqual(credential, hash(req.headers.authorization ?? ''))) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Pi Tasks", charset="UTF-8"');
    return json(res, 401, { error: '需要登录' });
  }
  try {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname.startsWith('/api/')) {
      return await tasks(req, res, url);
    }
    const asset = req.method === 'GET' && assets.get(url.pathname);
    if (!asset) {
      return json(res, 404, { error: '页面不存在' });
    }
    const body = await readFile(new URL(`../web/${asset[0]}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': asset[1] });
    res.end(body);
  } catch {
    if (res.headersSent) {
      res.destroy();
    } else {
      json(res, 500, { error: '服务内部错误' });
    }
  }
}).listen(listenPort, host, () => console.log(`任务面板：${origin}`));
