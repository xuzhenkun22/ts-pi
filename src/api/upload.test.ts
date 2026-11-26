import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { receiveUpload, UploadError } from './upload.js';
import { WorkspaceError } from '../workspace/files.js';

async function withUpload(run: (url: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-upload-'));
  const server = createServer(async (req, res) => {
    try {
      res.end(await receiveUpload(req, directory));
    } catch (error) {
      res.statusCode =
        error instanceof UploadError ? error.status : error instanceof WorkspaceError ? 400 : 500;
      res.setHeader('Connection', 'close');
      res.end((error as Error).message);
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    await run(`http://127.0.0.1:${address.port}`, directory);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('multipart 流式保存多个文件，保留中文文件名及二进制内容', async () => {
  await withUpload(async (url, directory) => {
    const form = new FormData();
    const bytes = Uint8Array.of(0, 1, 255);
    form.append('files', new Blob([bytes]), '合 同.bin');
    form.append('files', new Blob(['second']), 'notes.txt');
    form.append('prompt', ' 提取合同信息 ');
    const response = await fetch(url, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '提取合同信息');
    assert.deepEqual(await readFile(join(directory, '合 同.bin')), Buffer.from(bytes));
    assert.equal(await readFile(join(directory, 'notes.txt'), 'utf8'), 'second');
  });
});

test('multipart 拒绝路径文件名、重名、缺文件和未结束的表单', async () => {
  await withUpload(async (url, directory) => {
    const multipart = (body: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=example' },
        body,
      });
    const prompt = '--example\r\nContent-Disposition: form-data; name="prompt"\r\n\r\ncheck\r\n';
    const entry = (name: string) =>
      `--example\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\n\r\ndata\r\n`;
    const end = '--example--\r\n';
    for (const body of [
      prompt + end,
      prompt + entry('../escape.txt') + end,
      prompt + entry('cut.txt'),
    ]) {
      const response = await multipart(body);
      assert.equal(response.status, 400, await response.text());
    }
    assert(!(await readdir(directory)).includes('escape.txt'));
    const duplicate = await multipart(prompt + entry('Repeat.txt') + entry('repeat.TXT') + end);
    assert.equal(duplicate.status, 400);
    assert.match(await duplicate.text(), /有重名文件/);
  });
});

test('multipart 拒绝超过文字和文件数量限制的上传', async () => {
  await withUpload(async (url) => {
    const form = new FormData();
    form.append('prompt', '一'.repeat(20_001));
    form.append('files', new Blob(['test']), 'notes.txt');
    const response = await fetch(url, { method: 'POST', body: form });
    assert.equal(response.status, 413);
    assert.match(await response.text(), /60,000/);
    const files = new FormData();
    files.append('prompt', 'test');
    for (let i = 0; i < 11; i++) files.append('files', new Blob(['x']), `${i}.txt`);
    const result = await fetch(url, { method: 'POST', body: files });
    assert.equal(result.status, 413);
    assert.match(await result.text(), /最多上传 10/);
  });
});
