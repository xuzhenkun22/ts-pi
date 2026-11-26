import busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { uploadFilename } from '../workspace/files.js';

const mib = 1024 * 1024;
const maxFiles = 10;
const maxFileBytes = 25 * mib;
const maxRequestBytes = 100 * mib;
export const maxPromptBytes = 60_000;

export class UploadError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function checkUploadLength(req: IncomingMessage) {
  if (Number(req.headers['content-length']) > maxRequestBytes) {
    throw new UploadError(413, '上传请求不能超过 100 MiB');
  }
}

export async function receiveUpload(req: IncomingMessage, inputPath: string): Promise<string> {
  checkUploadLength(req);
  const oversize = new UploadError(413, '上传请求不能超过 100 MiB');
  let parser;
  try {
    parser = busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      preservePath: true,
      limits: {
        files: maxFiles,
        fileSize: maxFileBytes + 1,
        fields: 1,
        fieldSize: maxPromptBytes + 1,
        parts: maxFiles + 2,
      },
    });
  } catch {
    throw new UploadError(400, '无效的 multipart 表单');
  }
  const names = new Set<string>();
  const writes: Promise<void>[] = [];
  let problem: Error | undefined;
  let prompt: string | undefined;
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxRequestBytes) {
        problem = oversize;
        done(oversize);
      } else {
        done(null, chunk);
      }
    },
  });
  const reject = (error: Error) => {
    problem ??= error;
  };
  parser.on('field', (key, value, info) => {
    if (key !== 'prompt') {
      reject(new UploadError(400, '只接受任务描述 prompt 和文件 files'));
    } else if (info.valueTruncated || Buffer.byteLength(value) > maxPromptBytes) {
      reject(new UploadError(413, '任务描述最多 60,000 字节'));
    } else {
      prompt = value.trim();
    }
  });
  parser.on('file', (key, file, info) => {
    file.on('limit', () => reject(new UploadError(413, '单个文件不能超过 25 MiB')));
    // 即使拒绝该字段，也要消费文件流，直到表单结束或达到总大小上限。
    file.on('error', () => {});
    if (problem || key !== 'files') {
      if (key !== 'files') reject(new UploadError(400, '文件字段必须为 files'));
      file.resume();
      return;
    }
    let name: string;
    try {
      name = uploadFilename(info.filename ?? '');
    } catch (error) {
      reject(error as Error);
      file.resume();
      return;
    }
    const canonical = name.toLowerCase();
    if (names.has(canonical)) {
      reject(new UploadError(400, `有重名文件：${name}，请重命名后重新上传`));
      file.resume();
      return;
    }
    names.add(canonical);
    const output = createWriteStream(join(inputPath, name), { flags: 'wx', mode: 0o600 });
    output.on('error', (error) => {
      // 文件写入失败时停止解析；等所有句柄关闭后再由调用方清理目录。
      if (!parser.destroyed) {
        reject(error);
        meter.destroy(error);
      }
    });
    writes.push(pipeline(file, output).catch((error: Error) => reject(error)));
  });
  parser.on('filesLimit', () => reject(new UploadError(413, '一次最多上传 10 个文件')));
  const extraFields = () => reject(new UploadError(400, '表单包含多余字段'));
  parser.on('fieldsLimit', extraFields);
  parser.on('partsLimit', extraFields);

  const onRequestError = (error: Error) => meter.destroy(error);
  const onRequestClose = () => {
    if (!req.complete) meter.destroy(new Error('上传已中断'));
  };
  req.on('error', onRequestError);
  req.on('close', onRequestClose);
  try {
    // 不把 HTTP 请求放入 pipeline：解析失败时仍可向客户端返回明确的错误。
    const parsed = pipeline(meter, parser);
    req.pipe(meter);
    if (req.destroyed && !req.complete) meter.destroy(new Error('上传已中断'));
    await parsed.catch(() => {
      problem ??= new UploadError(400, '上传中断或 multipart 表单不完整');
    });
  } finally {
    req.unpipe(meter);
    req.off('error', onRequestError);
    req.off('close', onRequestClose);
    await Promise.all(writes);
  }
  if (problem) throw problem;
  if (!prompt || !names.size) throw new UploadError(400, '请上传至少一个文件并填写任务描述');
  return prompt;
}
