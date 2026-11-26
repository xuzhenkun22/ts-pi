import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolLogger } from './tool-logs.js';

test('并行工具调用按序号关联，日志不保存文件正文', () => {
  const lines: string[] = [];
  const tools = createToolLogger((line) => lines.push(line));
  tools.start({ toolName: 'read', toolCallId: 'a', args: { path: 'in/data.txt' } });
  tools.start({
    toolName: 'write',
    toolCallId: 'b',
    args: { path: 'out/report.md', content: 'PRIVATE_CONTENT' },
  });
  tools.end({ toolName: 'write', toolCallId: 'b', isError: true, durationMs: 12 });
  tools.end({ toolName: 'read', toolCallId: 'a', isError: false, durationMs: 3 });
  assert.deepEqual(lines, [
    '#1 [read] 开始 · path=in/data.txt',
    '#2 [write] 开始 · path=out/report.md',
    '#2 [write] 失败 · 12 ms',
    '#1 [read] 完成 · 3 ms',
  ]);
});

test('遮蔽常见凭据并限制日志长度，扩展只展示参数名', () => {
  const lines: string[] = [];
  const tools = createToolLogger((line) => lines.push(line));
  tools.start({
    toolName: 'bash',
    args: { command: `API_KEY=demo-value echo 'Bearer example-value'\n${'字'.repeat(400)}` },
  });
  tools.start({ toolName: 'custom', args: { destination: 'PRIVATE_VALUE' } });
  assert.match(lines[0], /command=API_KEY=\[已隐藏\]/);
  assert.doesNotMatch(lines[0], /demo-value|example-value|\n/);
  assert.ok(Array.from(lines[0]).length <= 255);
  assert.equal(lines[1], '#2 [custom] 开始 · 参数名：destination');
});
