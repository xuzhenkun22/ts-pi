import { spawn } from 'node:child_process';
import { resolve as absolutePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolLogger } from './tool-logs.js';

const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
export class PiError extends Error {}

export function runPi(
  cwd: string,
  model: string,
  prompt: string,
  timeout: number,
  log: (message: string) => void,
  skillFile?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    // 不继承数据库、队列、HTTP 凭据或外层 Pi 会话的上下文。
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(MYSQL_|REDIS_|HTTP_AUTH_|NODE_OPTIONS$|PI_(SESSION_|MODEL$|PROVIDER$|REASONING_LEVEL$))/i.test(
            key
          )
      )
    );
    if (process.env.PI_CODING_AGENT_DIR) {
      env.PI_CODING_AGENT_DIR = absolutePath(process.env.PI_CODING_AGENT_DIR);
    }
    const args = [entry, '--no-session', '--model', model];
    // 技能路径单独传给 Pi，不改变任务的工作目录。
    if (skillFile) {
      args.push('--skill', skillFile);
    }
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      windowsHide: true,
    });
    const tools = createToolLogger(log);
    let result: { reply: string } | { error: PiError } | undefined;
    let response = false;
    let settled = false;
    let lastStop: string | undefined;
    let reply = '';
    let line = '';
    let force: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => stop({ error: new PiError('Pi 执行超时') }), timeout);
    function stop(value: NonNullable<typeof result>) {
      if (result) {
        return;
      }
      result = value;
      child.stdin.end();
      if ('error' in value) {
        child.kill();
      }
      force = setTimeout(() => child.kill('SIGKILL'), 1500);
    }
    const fail = (message: string) => stop({ error: new PiError(message) });
    const done = () => {
      if (!response || !settled) {
        return;
      }
      if (!lastStop || lastStop !== 'stop') {
        return fail('Pi 未正常完成模型调用');
      }
      stop({ reply });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (result) {
        return;
      }
      line += chunk;
      let end: number;
      while (!result && (end = line.indexOf('\n')) !== -1) {
        const record = line.slice(0, end);
        line = line.slice(end + 1);
        if (record.length > 8_000_000) {
          return fail('Pi RPC 消息过大');
        }
        let event;
        try {
          event = JSON.parse(record);
        } catch {
          continue;
        }
        if (!event || typeof event !== 'object') {
          continue;
        }
        if (event.type === 'response' && event.id === 'task') {
          if (!event.success || event.data?.disposition !== 'started') {
            return fail('Pi 未启动任务，请检查模型及扩展配置');
          }
          response = true;
          done();
        } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
          lastStop = event.message.stopReason;
          reply = Array.isArray(event.message.content)
            ? event.message.content
                .filter((p: { type: string; text?: string }) => p.type === 'text')
                .map((p: { text: string }) => p.text)
                .join('')
                .slice(0, 250_000)
            : '';
        } else if (event.type === 'agent_settled') {
          if (event.aborted) {
            return fail('Pi 已中止任务');
          }
          settled = true;
          done();
        } else if (
          event.type === 'extension_ui_request' &&
          ['select', 'confirm', 'input', 'editor'].includes(event.method)
        ) {
          return fail('Pi 需要交互确认；请预先审核并配置项目或扩展');
        } else if (event.type === 'tool_execution_start') {
          tools.start(event);
        } else if (event.type === 'tool_execution_end') {
          tools.end(event);
        } else if (event.type === 'auto_retry_start') {
          log('Pi 正在重试模型请求');
        }
      }
      if (line.length > 8_000_000) {
        fail('Pi RPC 消息过大');
      }
    });
    child.stderr.resume(); // 不持久化原始 stderr 和模型报错，避免意外泄露敏感信息。
    child.on('error', () => fail('无法启动 Pi CLI'));
    child.stdin.on('error', () => fail('Pi RPC 输入已关闭'));
    child.on('close', () => {
      clearTimeout(timer);
      clearTimeout(force);
      if (result && 'reply' in result) {
        resolve(result.reply);
      } else {
        reject(result?.error ?? new PiError('Pi 提前退出，请检查模型、凭据或项目配置'));
      }
    });
    child.stdin.write(JSON.stringify({ id: 'task', type: 'prompt', message: prompt }) + '\n');
  });
}
