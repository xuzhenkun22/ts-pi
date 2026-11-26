import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { model } from '../config/env.js';
import {
  beginRetry,
  completeRetry,
  createTask,
  failRetry,
  getContractResult,
  getContractReview,
  getTask,
  listTasks,
  logs,
  saveContractReview,
} from '../repositories/tasks.js';
import {
  applyContractReview,
  ContractResultError,
  parseContractResult,
} from '../workspace/contract-result.js';
import {
  WorkspaceError,
  archiveOutput,
  createUploadWorkspace,
  directoryForTaskId,
  listFiles,
  openFile,
  taskDirectory,
  validateLayout,
} from '../workspace/files.js';
import { checkUploadLength, maxPromptBytes, receiveUpload, UploadError } from './upload.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const mime = new Map(
  Object.entries({
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.csv': 'text/plain; charset=utf-8',
    '.json': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
  })
);

export function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new ContractResultError('请求体过大');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ContractResultError('JSON 格式错误');
  }
}

async function submitUpload(req: IncomingMessage, res: ServerResponse) {
  checkUploadLength(req);
  const taskModel = model();
  const { id, inputPath, dir, discard } = await createUploadWorkspace();
  let prompt: string;
  try {
    prompt = await receiveUpload(req, inputPath);
    if (res.destroyed) {
      await discard();
      return;
    }
  } catch (error) {
    await discard();
    throw error;
  }
  // 文件全部落盘才写入队列。写库时若连接断开，提交结果可能不明，不能删掉可能已排队的输入。
  await createTask(id, dir.cwd, dir.key, prompt, taskModel);
  return json(res, 202, { taskId: id, taskid: dir.cwd, status: 'queued' });
}

async function submit(req: IncomingMessage, res: ServerResponse) {
  const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType === 'multipart/form-data') {
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return json(res, 403, { error: '禁止跨站上传' });
    }
    return submitUpload(req, res);
  }
  if (contentType !== 'application/json') {
    return json(res, 415, { error: '请发送 multipart/form-data 或 application/json' });
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      res.setHeader('Connection', 'close');
      return json(res, 413, { error: '请求过大' });
    }
    chunks.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return json(res, 400, { error: 'JSON 格式错误' });
  }
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).length !== 2 ||
    typeof input.taskid !== 'string' ||
    typeof input.prompt !== 'string' ||
    !input.prompt.trim() ||
    Buffer.byteLength(input.prompt) > maxPromptBytes
  ) {
    return json(res, 400, { error: '只接受字符串 taskid 和非空 prompt，prompt 最多 60,000 字节' });
  }
  const dir = await directoryForTaskId(input.taskid);
  await validateLayout(dir.path);
  const id = randomUUID();
  // HTTP 只写 MySQL，后台负责投递，Redis 暂时断开不影响接收任务。
  await createTask(id, dir.cwd, dir.key, input.prompt, model());
  return json(res, 202, { taskId: id, taskid: input.taskid, status: 'queued' });
}

export async function tasks(req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    if (url.pathname === '/api/tasks') {
      if (req.method === 'POST') {
        return await submit(req, res);
      }
      if (req.method === 'GET') {
        const before = url.searchParams.get('before');
        if (before !== null && !uuid.test(before)) {
          return json(res, 400, { error: '无效的分页游标' });
        }
        return json(res, 200, await listTasks(before ?? undefined));
      }
    }
    const review = /^\/api\/tasks\/([^/]+)\/contract-review$/.exec(url.pathname);
    if (review && uuid.test(review[1]) && (req.method === 'GET' || req.method === 'PUT')) {
      res.setHeader('Cache-Control', 'no-store');
      const task = await getTask(review[1]);
      if (!task) return json(res, 404, { error: '任务不存在' });
      if (task.status !== 'succeeded') {
        return json(res, 409, { error: '只有已完成任务可以核对', status: task.status });
      }
      if (req.method === 'GET') {
        const row = await getContractReview(task.id);
        if (!row) return json(res, 404, { error: '任务没有已入库的合同结果' });
        return json(res, 200, {
          taskId: task.id,
          result: parseContractResult(row.result_json),
          revision: row.revision,
        });
      }
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json(res, 415, { error: '请发送 application/json' });
      }
      const input = await readJson(req, 2 * 1024 * 1024);
      if (!input || typeof input !== 'object' || !('revision' in input) || !('changes' in input)) {
        return json(res, 400, { error: '需要提供 revision 和 changes' });
      }
      const { revision, changes } = input;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        return json(res, 400, { error: '无效的核对版本' });
      }
      const saved = await saveContractReview(task.id, revision, (current) => {
        const result = applyContractReview(parseContractResult(current), changes);
        if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) {
          throw new ContractResultError('核对结果超过 2 MiB');
        }
        return result;
      });
      if (saved.status === 'missing') {
        return json(res, 404, { error: '任务没有已入库的合同结果' });
      }
      if (saved.status === 'conflict') {
        return json(res, 409, { error: '核对结果已更新，请复制当前修改后重新打开核对页' });
      }
      return json(res, 200, { taskId: task.id, result: saved.result, revision: saved.revision });
    }
    const retry = /^\/api\/tasks\/([^/]+)\/retry$/.exec(url.pathname);
    if (retry && req.method === 'POST' && uuid.test(retry[1])) {
      const task = await getTask(retry[1]);
      if (!task) {
        return json(res, 404, { error: '任务不存在' });
      }
      if (task.status !== 'failed') {
        return json(res, 409, { error: '只有失败任务可以重新执行', status: task.status });
      }
      const dir = await taskDirectory(task.cwd);
      if (dir.key !== task.directory_key) {
        throw new WorkspaceError('任务目录已变更');
      }
      if (!(await beginRetry(task.id))) {
        return json(res, 409, { error: '任务状态已变化，请刷新后重试' });
      }
      try {
        const archived = await archiveOutput(dir.path);
        if (!(await completeRetry(task.id))) {
          throw new Error('任务重执行状态已变化');
        }
        return json(res, 202, {
          taskId: task.id,
          status: 'queued',
          archive: archived.archive,
          archivedFiles: archived.files,
        });
      } catch (error) {
        await failRetry(task.id, '重执行准备失败，旧文件已保留，请刷新后重试');
        throw error;
      }
    }
    if (req.method === 'GET') {
      const match = /^\/api\/tasks\/([^/]+)(?:\/(logs|files|file|contract-result))?$/.exec(
        url.pathname
      );
      if (match && uuid.test(match[1])) {
        const task = await getTask(match[1]);
        if (!task) {
          return json(res, 404, { error: '任务不存在' });
        }
        if (!match[2]) {
          const { directory_key: _internal, ...detail } = task;
          return json(res, 200, detail);
        }
        if (match[2] === 'contract-result') {
          if (task.status === 'queued' || task.status === 'running' || task.status === 'retrying') {
            return json(res, 409, { error: '任务尚未结束', status: task.status });
          }
          const result = task.status === 'succeeded' ? await getContractResult(task.id) : undefined;
          if (result === undefined) {
            return json(res, 404, { error: '任务没有已入库的合同结果' });
          }
          res.setHeader('Cache-Control', 'no-store');
          return json(res, 200, { taskId: task.id, taskid: task.cwd, result });
        }
        if (match[2] === 'logs') {
          const after = url.searchParams.get('after') ?? '0';
          if (!/^\d{1,20}$/.test(after) || BigInt(after) > 18446744073709551615n) {
            return json(res, 400, { error: '无效的日志游标' });
          }
          return json(res, 200, await logs(task.id, after));
        }
        const side = url.searchParams.get('side');
        if (side !== 'in' && side !== 'out') {
          return json(res, 400, { error: 'side 必须是 in 或 out' });
        }
        const dir = await taskDirectory(task.cwd);
        if (dir.key !== task.directory_key) {
          throw new WorkspaceError('任务目录已变更');
        }
        if (match[2] === 'files') {
          const result = await listFiles(dir.path, side);
          return json(res, 200, {
            ...result,
            category: side === 'in' ? 'input' : 'output',
          });
        }
        const name = url.searchParams.get('name') ?? '';
        const { handle, info } = await openFile(dir.path, side, name);
        const type = mime.get(extname(name).toLowerCase());
        const download = !type || url.searchParams.get('download') === '1';
        if (!download && info.size > 20 * 1024 * 1024) {
          await handle.close();
          return json(res, 413, { error: '文件超过 20 MiB，请下载查看' });
        }
        const filename = encodeURIComponent(name.split('/').at(-1)!).replace(
          /['()*]/g,
          (c) => `%${c.charCodeAt(0).toString(16)}`
        );
        // 未列入白名单的格式只能下载；文件响应不允许执行脚本。
        res.writeHead(200, {
          'Content-Type': download ? 'application/octet-stream' : type,
          'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${filename}`,
          'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'self'",
        });
        if (info.size === 0) {
          await handle.close();
          return res.end();
        }
        await pipeline(handle.createReadStream({ end: info.size - 1 }), res);
        return;
      }
    }
    return json(res, 404, { error: '接口不存在' });
  } catch (error) {
    if (res.headersSent || res.destroyed) {
      return;
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (error instanceof UploadError) {
      res.setHeader('Connection', 'close');
      return json(res, error.status, { error: error.message });
    }
    if (error instanceof ContractResultError) {
      if (error.message === '请求体过大') res.setHeader('Connection', 'close');
      return json(res, error.message === '请求体过大' ? 413 : 400, { error: error.message });
    }
    if (error instanceof WorkspaceError) {
      return json(res, 400, { error: error.message });
    }
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return json(res, 404, { error: '目录或文件不存在；请先准备任务目录和 in/' });
    }
    if (code === 'ER_DUP_ENTRY') {
      return json(res, 409, { error: '该目录已有任务，请使用新目录' });
    }
    console.error('任务接口失败:', code ?? 'unknown');
    return json(res, 503, { error: '服务暂不可用，请检查 MySQL 和工作区配置' });
  }
}
