import { basename, dirname } from 'node:path';
import { Queue, Worker } from 'bullmq';
import { pollMs, redisConfig, taskTimeout } from '../config/env.js';
import { PiError, runPi } from '../integrations/pi/rpc.js';
import {
  claim,
  db,
  defer,
  due,
  expire,
  finish,
  finishContractTask,
  getTask,
  log,
} from '../repositories/tasks.js';
import {
  ContractResultError,
  contractJson,
  contractReport,
  contractSkillName,
  readContractResult,
} from '../workspace/contract-result.js';
import {
  taskDirectory,
  validateLayout,
  WorkspaceError,
  workspaceSkillFile,
} from '../workspace/files.js';

const name = 'pi-tasks';
const timeout = taskTimeout();
const interval = pollMs();
const skillDirectory = process.env.TASK_PI_SKILL_DIR?.trim();
const queue = new Queue<{ taskId: string }>(name, { connection: redisConfig() });
const worker = new Worker<{ taskId: string }>(
  name,
  async (job) => {
    const id = job.data.taskId;
    // MySQL 的状态是执行依据；重复投递不会再次启动 Pi。
    if (!(await claim(id, timeout))) {
      return;
    }
    let pending = Promise.resolve();
    let logCount = 0;
    function event(message: string) {
      if (++logCount > 501) {
        return;
      }
      if (logCount === 501) {
        message = '已达到日志记录上限（500 条），后续事件不再记录';
      }
      pending = pending
        .then(() => log(id, message))
        .catch(() => {
          console.error('日志写入失败', id);
        });
    }
    event('开始执行');
    try {
      const task = await getTask(id);
      const dir = await taskDirectory(task.cwd);
      if (dir.key !== task.directory_key) {
        throw new PiError('任务目录已变更');
      }
      const skillFile = skillDirectory ? await workspaceSkillFile(skillDirectory) : undefined;
      await validateLayout(dir.path, true);
      if (skillFile) {
        event('已为 Pi 指定工作区共享技能');
      }
      // 仅在部署者启用合同技能时要求双产物；其他技能不受影响。
      const isContract = !!skillFile && basename(dirname(skillFile)) === contractSkillName;
      const instructions = [
        '任务目录约定：业务输入文件只从 ./in/ 读取，不要修改输入；可以读取技能说明及配套资料。最终产物和过程文件写到 ./out/，保留过程文件，不要在任务结束时清理。',
        ...(isContract
          ? [
              `按技能要求生成 out/${contractReport} 和 out/${contractJson}，由 Worker 校验 JSON 并写入 MySQL。Pi 不要直接操作数据库，也不要只在对话中输出结果。`,
            ]
          : []),
        `用户任务：\n${task.prompt}`,
      ].join('\n\n');
      const prompt = isContract ? `/skill:${contractSkillName} ${instructions}` : instructions;
      const reply = await runPi(dir.path, task.model, prompt, timeout, event, skillFile);
      const resultJson = isContract ? await readContractResult(dir.path) : undefined;
      await pending;
      if (resultJson !== undefined) {
        try {
          await finishContractTask(id, reply, resultJson);
        } catch (error) {
          console.error('合同结果提交失败:', (error as NodeJS.ErrnoException)?.code ?? 'unknown');
          throw new ContractResultError('合同 JSON 未能写入 MySQL，磁盘产物已保留');
        }
        event('合同 JSON 已写入 MySQL');
      } else {
        await finish(id, 'succeeded', reply, null);
      }
      event('Pi 执行完成');
      await pending;
    } catch (error) {
      const reason =
        error instanceof PiError ||
        error instanceof WorkspaceError ||
        error instanceof ContractResultError
          ? error.message
          : '任务执行失败，请检查输入目录或服务配置';
      event(reason);
      await pending;
      await finish(id, 'failed', null, reason);
    }
  },
  { connection: redisConfig(true), concurrency: 1 }
);

worker.on('error', (error) => console.error('Worker:', error.name));
worker.on('failed', (job) => console.error('队列任务失败，待 MySQL 恢复检查', job?.id));
queue.on('error', (error) => console.error('Redis:', error.name));

let stopping = false;
let timer: NodeJS.Timeout;
let active: Promise<void>;
// 即使 Redis 丢失任务，定期核对 MySQL 也能重新投递尚未启动的任务。
async function dispatch() {
  await expire();
  for (const id of await due()) {
    if (stopping) {
      break;
    }
    await queue.add(
      'execute',
      { taskId: id },
      { jobId: id, removeOnComplete: true, removeOnFail: true, attempts: 1 }
    );
    await defer(id);
  }
}
function tick() {
  active = dispatch()
    .catch(() => console.error('任务对账或投递失败，将重试'))
    .finally(() => {
      if (!stopping) {
        timer = setTimeout(tick, interval);
      }
    });
}
tick();
async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  clearTimeout(timer);
  await Promise.allSettled([active, worker.close()]);
  await Promise.allSettled([queue.close(), db.end()]);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
console.log('Pi Worker 已启动');
