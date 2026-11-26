import { resolve } from 'node:path';

function number(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function mysqlConfig() {
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: number('MYSQL_PORT', 3306, 1, 65535),
    user: process.env.MYSQL_USER || 'pi_tasks',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE || 'pi_tasks',
    timezone: 'Z',
    charset: 'utf8mb4',
  };
}

export const workspaceRoot = () => resolve(process.env.WORKSPACE_ROOT || 'workspaces');
export const port = () => number('PORT', 3000, 1, 65535);
export const taskTimeout = () => number('PI_TIMEOUT_MS', 300_000, 1000, 86_400_000);
// 使用业务专用变量，避免继承启动本服务的 Pi 会话模型。
export const model = () => process.env.TASK_PI_MODEL || 'relay/gpt-6.2-sol';
export const pollMs = () => number('QUEUE_POLL_MS', 2000, 200, 60_000);

export function redisConfig(worker = false) {
  const url = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  const db = Number(url.pathname.slice(1) || 0);
  if (
    !['redis:', 'rediss:'].includes(url.protocol) ||
    !Number.isInteger(db) ||
    db < 0 ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid REDIS_URL');
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 6379),
    db,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: worker ? null : 1,
    enableOfflineQueue: worker,
    connectTimeout: 5000,
    commandTimeout: worker ? undefined : 5000,
  };
}
