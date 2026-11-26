import { readFile } from 'node:fs/promises';
import { createConnection } from 'mysql2/promise';
import { mysqlConfig } from '../config/env.js';

// 按顺序执行仓库内的幂等建表脚本；API 和 Worker 不开启多语句模式。
const migrations = [
  '001_tasks.sql',
  '002_contract_results.sql',
  '003_retrying_status.sql',
  '004_contract_reviews.sql',
];
try {
  const connection = await createConnection({ ...mysqlConfig(), multipleStatements: true });
  try {
    for (const file of migrations) {
      const sql = await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
      await connection.query(sql);
    }
    console.log('MySQL 建表完成');
  } finally {
    await connection.end();
  }
} catch (error) {
  console.error('MySQL 初始化失败:', (error as NodeJS.ErrnoException).code ?? 'unknown');
  process.exitCode = 1;
}
