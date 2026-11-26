import { openFile } from './files.js';

export const contractSkillName = 'contract-info-extraction';
export const contractReport = 'contract-result.md';
export const contractJson = 'contract-result.json';
const maxBytes = 1024 * 1024;
const statuses = new Set([
  '已确认',
  '规则映射',
  '规则默认',
  '未提及',
  '不适用',
  '冲突待确认',
  '无法识别',
]);

export class ContractResultError extends Error {}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
type ContractValue = string | null;
type ContractField = {
  name: string;
  value: ContractValue;
  evidence: ContractValue;
  source: ContractValue;
  status: string;
};
type ContractProduct = { type: ContractValue; basis: string; fields: ContractField[] };
type ContractResult = {
  schemaVersion: 1;
  contractInfo: Record<string, ContractValue>;
  products: ContractProduct[];
  questions: string[];
};

const nullableText = (value: unknown): value is ContractValue => value === null || text(value);
const field = (value: unknown): value is ContractField =>
  object(value) &&
  text(value.name) &&
  nullableText(value.value) &&
  nullableText(value.evidence) &&
  nullableText(value.source) &&
  typeof value.status === 'string' &&
  statuses.has(value.status);
const product = (value: unknown): value is ContractProduct =>
  object(value) &&
  (value.type === null || text(value.type)) &&
  text(value.basis) &&
  Array.isArray(value.fields) &&
  (value.type === null ? value.fields.length === 0 : value.fields.length > 0) &&
  value.fields.every(field) &&
  new Set(value.fields.map((entry) => entry.name)).size === value.fields.length;

function valid(value: unknown): value is ContractResult {
  return (
    object(value) &&
    value.schemaVersion === 1 &&
    object(value.contractInfo) &&
    Object.values(value.contractInfo).every(nullableText) &&
    Array.isArray(value.products) &&
    value.products.length > 0 &&
    value.products.every(product) &&
    Array.isArray(value.questions) &&
    value.questions.every(text)
  );
}

export function parseContractResult(value: unknown): ContractResult {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!valid(parsed)) throw new Error('已入库结果不符合合同结果格式 v1');
  return parsed;
}

export function applyContractReview(result: ContractResult, changes: unknown): ContractResult {
  if (
    !object(changes) ||
    !object(changes.contractInfo) ||
    !Array.isArray(changes.productValues) ||
    Object.keys(changes).length !== 2
  ) {
    throw new ContractResultError('请提供 contractInfo 和 productValues');
  }
  for (const [name, value] of Object.entries(changes.contractInfo)) {
    if (!Object.hasOwn(result.contractInfo, name) || !nullableText(value)) {
      throw new ContractResultError('合同基础信息只允许修改已有字段值');
    }
    result.contractInfo[name] = value;
  }
  const changedFields = new Set<string>();
  for (const change of changes.productValues as unknown[]) {
    if (
      !object(change) ||
      Object.keys(change).length !== 3 ||
      typeof change.productIndex !== 'number' ||
      !Number.isSafeInteger(change.productIndex) ||
      typeof change.fieldIndex !== 'number' ||
      !Number.isSafeInteger(change.fieldIndex) ||
      !nullableText(change.value)
    ) {
      throw new ContractResultError('产品字段只接受产品索引、字段索引和提取值');
    }
    const field = result.products[change.productIndex]?.fields[change.fieldIndex];
    const key = `${change.productIndex}:${change.fieldIndex}`;
    if (!field || changedFields.has(key)) {
      throw new ContractResultError('产品字段不存在或重复');
    }
    changedFields.add(key);
    field.value = change.value;
  }
  if (!Object.keys(changes.contractInfo).length && !changedFields.size) {
    throw new ContractResultError('没有可保存的字段修改');
  }
  return result;
}

async function openResult(root: string, name: string) {
  try {
    return await openFile(root, 'out', name);
  } catch {
    throw new ContractResultError(`无法读取 out/${name}，请检查文件是否已生成且为普通文件`);
  }
}

export async function readContractResult(root: string): Promise<string> {
  // 保留产物原样，只读取固定文件；不扫描或删除过程文件。
  const report = await openResult(root, contractReport);
  await report.handle.close();
  if (!report.info.size) {
    throw new ContractResultError(`out/${contractReport} 为空`);
  }

  const { handle, info } = await openResult(root, contractJson);
  try {
    if (info.size > maxBytes) {
      throw new ContractResultError(`out/${contractJson} 超过 1 MiB`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of handle.createReadStream({ end: maxBytes, autoClose: false })) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length > maxBytes) {
      throw new ContractResultError(`out/${contractJson} 超过 1 MiB`);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    } catch {
      throw new ContractResultError(`out/${contractJson} 不是有效的 UTF-8 JSON`);
    }
    if (!valid(value)) {
      throw new ContractResultError(`out/${contractJson} 不符合合同结果格式 v1，请检查字段及状态`);
    }
    return JSON.stringify(value);
  } finally {
    await handle.close();
  }
}
