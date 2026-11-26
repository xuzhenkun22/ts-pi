import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyContractReview,
  contractJson,
  contractReport,
  parseContractResult,
  readContractResult,
} from './contract-result.js';

const result = {
  schemaVersion: 1,
  contractInfo: { 合同编号: 'DEMO-001' },
  products: [
    {
      type: 'LD',
      basis: '样例第 1 行',
      fields: [
        { name: '吨位', value: '5t', evidence: '第 1 行', source: '合同明示', status: '已确认' },
      ],
    },
    { type: null, basis: '第 2 行型号待确认', fields: [] },
  ],
  questions: ['确认第 2 行型号'],
};

test('核对只更新已有字段值并保留判定信息，空值可以显式保存', () => {
  const review = applyContractReview(parseContractResult(JSON.stringify(result)), {
    contractInfo: { 合同编号: null },
    productValues: [{ productIndex: 0, fieldIndex: 0, value: '6t' }],
  });
  const expected = structuredClone(result);
  expected.products[0].fields[0].value = '6t';
  assert.deepEqual(review, { ...expected, contractInfo: { 合同编号: null } });

  const change = { productIndex: 0, fieldIndex: 0, value: '6t' };
  for (const changes of [
    { contractInfo: { 新字段: '值' }, productValues: [] },
    { contractInfo: {}, productValues: [{ ...change, source: '修改来源' }] },
    { contractInfo: {}, productValues: [{ ...change, fieldIndex: 1 }] },
    { contractInfo: {}, productValues: [change, change] },
  ]) {
    assert.throws(() => applyContractReview(parseContractResult(structuredClone(result)), changes));
  }
});

test('读取合同 Markdown 与 JSON，并保留中间文件和原始 JSON', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-contract-')));
  try {
    const out = join(root, 'out');
    const raw = JSON.stringify(result, null, 2);
    await mkdir(join(out, 'process'), { recursive: true });
    const intermediate = join(out, 'process', 'ocr.txt');
    await writeFile(intermediate, 'demo OCR');
    await writeFile(join(out, contractReport), '# 样例报告');
    await writeFile(join(out, contractJson), raw);
    assert.deepEqual(JSON.parse(await readContractResult(root)), result);
    assert.equal(await readFile(intermediate, 'utf8'), 'demo OCR');
    assert.equal(await readFile(join(out, contractJson), 'utf8'), raw);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('拒绝缺失、空白报告、无效 JSON、无效结构或超限的合同结果', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-invalid-contract-')));
  try {
    const out = join(root, 'out');
    const md = join(out, contractReport);
    const json = join(out, contractJson);
    await mkdir(out);
    await assert.rejects(readContractResult(root), /无法读取.*contract-result\.md/);
    await writeFile(md, '');
    await assert.rejects(readContractResult(root), /contract-result\.md 为空/);
    await writeFile(md, '# 样例报告');
    await assert.rejects(readContractResult(root), /无法读取.*contract-result\.json/);
    for (const [contents, error] of [
      ['```json\n{}\n```', /不是有效的 UTF-8 JSON/],
      [Buffer.from([0xff]), /不是有效的 UTF-8 JSON/],
      [JSON.stringify({ ...result, schemaVersion: 2 }), /不符合合同结果格式/],
      [JSON.stringify({ ...result, products: [] }), /不符合合同结果格式/],
      [' '.repeat(1024 * 1024 + 1), /超过 1 MiB/],
    ] as const) {
      await writeFile(json, contents);
      await assert.rejects(readContractResult(root), error);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
