import { createPool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { mysqlConfig } from '../config/env.js';

export const db = createPool({ ...mysqlConfig(), connectionLimit: 8 });
export interface Task extends RowDataPacket {
  id: string;
  cwd: string;
  directory_key: string;
  prompt: string;
  model: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'retrying';
  reply: string | null;
  error: string | null;
}

export async function createTask(
  id: string,
  cwd: string,
  key: string,
  prompt: string,
  model: string
) {
  // 同一行的 next_dispatch_at 就是持久化投递标记，任务和投递意图原子写入。
  await db.execute(
    'INSERT INTO tasks (id,cwd,directory_key,prompt,model,created_at,next_dispatch_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',
    [id, cwd, key, prompt, model]
  );
}
export async function getTask(id: string) {
  const [rows] = await db.execute<Task[]>(
    'SELECT id,cwd,directory_key,prompt,model,status,reply,error,created_at,started_at,finished_at FROM tasks WHERE id=?',
    [id]
  );
  return rows[0];
}
export async function listTasks(before?: string) {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT id,cwd,LEFT(prompt, 80) AS title,model,status,created_at,started_at,finished_at FROM tasks ${before ? 'WHERE (created_at,id) < (SELECT created_at,id FROM tasks WHERE id=?)' : ''} ORDER BY created_at DESC,id DESC LIMIT 50`,
    before ? [before] : []
  );
  return rows;
}
export async function logs(id: string, after: string) {
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT CAST(id AS CHAR) AS id,message,created_at FROM task_logs WHERE task_id=? AND task_logs.id>CAST(? AS UNSIGNED) ORDER BY task_logs.id LIMIT 100',
    [id, after]
  );
  return rows;
}
export async function due() {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id FROM tasks WHERE status='queued' AND next_dispatch_at<=UTC_TIMESTAMP(3) ORDER BY next_dispatch_at LIMIT 50"
  );
  return rows.map((row) => String(row.id));
}
export async function defer(id: string) {
  await db.execute(
    "UPDATE tasks SET next_dispatch_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 SECOND) WHERE id=? AND status='queued'",
    [id]
  );
}
export async function claim(id: string, timeoutMs: number) {
  const [result] = await db.execute<ResultSetHeader>(
    "UPDATE tasks SET status='running',started_at=UTC_TIMESTAMP(3),deadline_at=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)) WHERE id=? AND status='queued'",
    [Math.ceil(timeoutMs / 1000) + 30, id]
  );
  return result.affectedRows === 1;
}
export async function expire() {
  await db.execute(
    "UPDATE tasks SET status='failed',error='Worker 中断或未能写回结果',finished_at=UTC_TIMESTAMP(3) WHERE status='running' AND deadline_at < UTC_TIMESTAMP(3)"
  );
  // API 在归档期间崩溃时，避免任务永久停留在准备状态。
  await db.execute(
    "UPDATE tasks SET status='failed',error='重执行准备阶段中断，请再次重试',finished_at=UTC_TIMESTAMP(3) WHERE status='retrying' AND started_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE)"
  );
}
export async function log(id: string, message: string) {
  await db.execute(
    'INSERT INTO task_logs (task_id,message,created_at) VALUES (?,?,UTC_TIMESTAMP(3))',
    [id, message]
  );
}
// 结果入库与任务成功状态在同一个事务内提交；超时或状态已变化的任务不可写入结果。
export async function finishContractTask(id: string, reply: string, resultJson: string) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [updated] = await connection.execute<ResultSetHeader>(
      "UPDATE tasks SET status='succeeded',reply=?,error=NULL,finished_at=UTC_TIMESTAMP(3) WHERE id=? AND status='running' AND deadline_at >= UTC_TIMESTAMP(3)",
      [reply, id]
    );
    if (updated.affectedRows !== 1) {
      throw new Error('合同任务已无法提交结果');
    }
    await connection.execute('INSERT INTO contract_results (task_id,result_json) VALUES (?,?)', [
      id,
      resultJson,
    ]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function beginRetry(id: string) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.execute<ResultSetHeader>(
      "UPDATE tasks SET status='retrying',started_at=UTC_TIMESTAMP(3),finished_at=NULL WHERE id=? AND status='failed'",
      [id]
    );
    if (result.affectedRows !== 1) {
      await connection.rollback();
      return false;
    }
    // 重跑开始后，旧合同结果不再代表当前执行；旧文件仍保留在归档目录中。
    await connection.execute('DELETE FROM contract_results WHERE task_id=?', [id]);
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function completeRetry(id: string) {
  const [result] = await db.execute<ResultSetHeader>(
    "UPDATE tasks SET status='queued',reply=NULL,error=NULL,started_at=NULL,deadline_at=NULL,finished_at=NULL,next_dispatch_at=UTC_TIMESTAMP(3) WHERE id=? AND status='retrying'",
    [id]
  );
  return result.affectedRows === 1;
}

export async function failRetry(id: string, error: string) {
  await db.execute(
    "UPDATE tasks SET status='failed',error=?,finished_at=UTC_TIMESTAMP(3) WHERE id=? AND status='retrying'",
    [error, id]
  );
}

export async function getContractResult(id: string) {
  const [rows] = await db.execute<(RowDataPacket & { result_json: unknown })[]>(
    'SELECT result_json FROM contract_results WHERE task_id=?',
    [id]
  );
  return rows[0]?.result_json;
}

type ContractReviewRow = RowDataPacket & { result_json: unknown; revision: number };

export async function getContractReview(id: string) {
  const [rows] = await db.execute<ContractReviewRow[]>(
    `SELECT COALESCE(r.result_json,c.result_json) AS result_json,COALESCE(r.revision,0) AS revision
     FROM contract_results c LEFT JOIN contract_reviews r ON r.task_id=c.task_id WHERE c.task_id=?`,
    [id]
  );
  return rows[0];
}

export async function saveContractReview<T>(
  id: string,
  expectedRevision: number,
  apply: (current: unknown) => T
) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    // 锁定原始结果行，同一个任务的首次保存和后续编辑串行执行。
    const [originals] = await connection.execute<(RowDataPacket & { result_json: unknown })[]>(
      'SELECT result_json FROM contract_results WHERE task_id=? FOR UPDATE',
      [id]
    );
    if (!originals[0]) {
      await connection.rollback();
      return { status: 'missing' } as const;
    }
    const [rows] = await connection.execute<ContractReviewRow[]>(
      'SELECT result_json,revision FROM contract_reviews WHERE task_id=?',
      [id]
    );
    const currentRevision = rows[0]?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      await connection.rollback();
      return { status: 'conflict' } as const;
    }
    const result = apply((rows[0] ?? originals[0]).result_json);
    const resultJson = JSON.stringify(result);
    const revision = expectedRevision + 1;
    if (rows[0]) {
      await connection.execute(
        'UPDATE contract_reviews SET result_json=?,revision=?,updated_at=UTC_TIMESTAMP(3) WHERE task_id=?',
        [resultJson, revision, id]
      );
    } else {
      await connection.execute(
        'INSERT INTO contract_reviews (task_id,result_json,revision,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(3))',
        [id, resultJson, revision]
      );
    }
    await connection.commit();
    return { status: 'saved', result, revision } as const;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function finish(
  id: string,
  status: 'succeeded' | 'failed',
  reply: string | null,
  error: string | null
) {
  await db.execute(
    "UPDATE tasks SET status=?,reply=?,error=?,finished_at=UTC_TIMESTAMP(3) WHERE id=? AND status='running'",
    [status, reply, error, id]
  );
}
