type ToolEvent = {
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  isError?: unknown;
  durationMs?: unknown;
};

const sensitive = String.raw`[\w.-]*(?:token|password|passwd|secret|api[-_]?key|authorization|credential)[\w.-]*`;
const assignment = new RegExp(
  String.raw`\b(${sensitive})(["']?\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|,]+)`,
  'gi'
);

function clean(value: string) {
  // 先遮蔽常见凭据，再折叠控制字符和换行，避免伪造独立日志行。
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s'";,]+/gi, '$1 [已隐藏]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[\w-]+/g, '[已隐藏]')
    .replace(/(\b[a-z][\w+.-]*:\/\/)[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(assignment, '$1$2[已隐藏]')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
}

function limit(text: string, length: number) {
  const chars = Array.from(text);
  return chars.length <= length ? text : chars.slice(0, length - 1).join('') + '…';
}

export function createToolLogger(log: (message: string) => void) {
  const active = new Map<string, { number: number; time: number }>();
  let sequence = 0;
  function name(event: ToolEvent) {
    return typeof event.toolName === 'string' ? limit(clean(event.toolName), 48) : '未知工具';
  }
  return {
    start(event: ToolEvent) {
      // 用任务内的序号关联开始和结束，避免并行调用同名工具时混淆。
      const number = ++sequence;
      if (typeof event.toolCallId === 'string') {
        active.set(event.toolCallId, { number, time: performance.now() });
      }
      const tool = name(event);
      const args =
        event.args && typeof event.args === 'object' ? (event.args as Record<string, unknown>) : {};
      const fields =
        tool === 'bash'
          ? ['command', 'timeout']
          : ['read', 'write', 'edit', 'ls', 'find', 'grep'].includes(tool)
            ? [
                'path',
                'offset',
                'limit',
                'glob',
                ...(['find', 'grep'].includes(tool) ? ['pattern'] : []),
              ]
            : [];
      // 只记录内置工具的白名单参数；扩展工具记录参数名，不保存未知参数值。
      const details = fields.length
        ? fields
            .flatMap((key) => {
              const value = args[key];
              return typeof value === 'string' || typeof value === 'number'
                ? [`${key}=${limit(clean(String(value)), key === 'command' ? 220 : 130)}`]
                : [];
            })
            .join(' · ')
        : Object.keys(args)
            .slice(0, 12)
            .map((key) => limit(clean(key), 32))
            .join(', ');
      log(
        limit(
          `#${number} [${tool}] 开始${details ? ` · ${fields.length ? '' : '参数名：'}${details}` : ''}`,
          255
        )
      );
    },
    end(event: ToolEvent) {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
      const call = id === undefined ? undefined : active.get(id);
      if (id !== undefined) {
        active.delete(id);
      }
      const duration =
        typeof event.durationMs === 'number' &&
        Number.isFinite(event.durationMs) &&
        event.durationMs >= 0
          ? event.durationMs
          : call
            ? performance.now() - call.time
            : undefined;
      const status =
        event.isError === true ? '失败' : event.isError === false ? '完成' : '结束（结果未知）';
      // 不入库工具结果正文，避免把文件正文、命令输出或图片写入日志。
      log(
        `${call ? `#${call.number} ` : ''}[${name(event)}] ${status}${duration === undefined ? '' : ` · ${Math.round(duration)} ms`}`
      );
    },
  };
}
