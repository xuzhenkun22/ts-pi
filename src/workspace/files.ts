import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { workspaceRoot } from '../config/env.js';

export class WorkspaceError extends Error {}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const segments = (path: string) => {
  const parts = path.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[\\<>:"|?*\p{Cc}]|[. ]$/u.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
  ) {
    throw new WorkspaceError('无效的相对路径');
  }
  return parts;
};

// 逐段检查目录，拒绝符号链接，再用真实路径确认没有越出工作区。
async function checked(root: string, parts: string[]) {
  let path = root;
  let info = await lstat(path);
  for (const part of parts) {
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new WorkspaceError('禁止访问符号链接或非目录路径');
    }
    path = join(path, part);
    info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new WorkspaceError('禁止访问符号链接');
    }
  }
  const actual = await realpath(path);
  const rel = relative(root, actual);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new WorkspaceError('路径超出工作区');
  }
  return { path: actual, info };
}

export async function taskDirectory(cwd: string) {
  if (cwd.length > 1024) {
    throw new WorkspaceError('路径过长');
  }
  const parts = segments(cwd);
  if (parts.some((part) => /^(in|out|\.pi)$/i.test(part))) {
    throw new WorkspaceError('任务目录不能位于 in、out 或 .pi 内');
  }
  const root = await realpath(workspaceRoot());
  const dir = await checked(root, parts);
  if (!dir.info.isDirectory()) {
    throw new WorkspaceError('任务路径不是目录');
  }
  const canonical = relative(root, dir.path).split(sep).join('/');
  const key = createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex');
  return { ...dir, cwd: canonical, key };
}

// 外部任务编号只能指向根目录的直接子目录；历史记录仍沿用原有 cwd 解析。
export async function directoryForTaskId(taskid: string) {
  if (
    !taskid ||
    taskid !== taskid.trim() ||
    /[\/\\]/.test(taskid) ||
    Buffer.byteLength(taskid) > 255
  ) {
    throw new WorkspaceError('taskid 必须是单个目录名，最多 255 字节');
  }
  const dir = await taskDirectory(taskid);
  if (!dir.cwd || dir.cwd.includes('/')) {
    throw new WorkspaceError('任务目录必须是根目录的直接子目录');
  }
  return dir;
}

// 文件名按 Windows/Linux 的共同规则校验，不接受目录或设备路径。
export function uploadFilename(value: string) {
  const name = value.normalize('NFC');
  if (
    segments(name).length !== 1 ||
    Buffer.byteLength(name) > 240 ||
    /^\s|[\u202a-\u202e\u2066-\u2069]|^(?:conin\$|conout\$|com[¹²³]|lpt[¹²³])(?:\.|$)/iu.test(name)
  ) {
    throw new WorkspaceError('文件名无效，请修改后重新上传');
  }
  return name;
}

export async function createUploadWorkspace() {
  const id = randomUUID();
  const root = await realpath(workspaceRoot());
  const path = join(root, id);
  const inputPath = join(path, 'in');
  await mkdir(path, { mode: 0o700 });
  const discard = () => rm(path, { recursive: true, force: true, maxRetries: 3 });
  try {
    await mkdir(inputPath, { mode: 0o700 });
    return { id, inputPath, dir: await directoryForTaskId(id), discard };
  } catch (error) {
    await discard();
    throw error;
  }
}

// 共享技能由部署者配置，始终相对于工作区根目录解析，不接收来自任务的路径。
export async function workspaceSkillFile(directory: string) {
  try {
    const root = await realpath(workspaceRoot());
    const skill = await checked(root, [...segments(directory), 'SKILL.md']);
    if (skill.info.isFile()) {
      return skill.path;
    }
  } catch (error) {
    if (!(error instanceof WorkspaceError) && !missing(error)) {
      throw error;
    }
  }
  throw new WorkspaceError(
    'TASK_PI_SKILL_DIR 无效：请指定根目录下含 SKILL.md 的技能目录，不允许符号链接'
  );
}

export async function validateLayout(root: string, createOutput = false) {
  const input = await checked(root, ['in']);
  if (!input.info.isDirectory()) {
    throw new WorkspaceError('in 必须是目录');
  }
  try {
    const output = await checked(root, ['out']);
    if (!output.info.isDirectory()) {
      throw new WorkspaceError('out 必须是目录');
    }
    if ((await readdir(output.path)).length) {
      throw new WorkspaceError('out 必须为空，请使用新的任务目录');
    }
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
    if (createOutput) {
      await mkdir(join(root, 'out'));
    }
  }
}

// 每次重跑都原子归档旧 out，并建立空 out；过程文件和旧结果完整保留。
export async function archiveOutput(root: string) {
  root = await realpath(root);
  const inventory = await listFiles(root, 'out');
  const outputPath = join(root, 'out');
  try {
    const output = await checked(root, ['out']);
    if (!output.info.isDirectory()) {
      throw new WorkspaceError('out 必须是目录');
    }
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
    await mkdir(outputPath);
    return { ...inventory, archive: null };
  }

  const archiveName = `.previous-runs/${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const archiveParts = segments(archiveName);
  try {
    await mkdir(join(root, archiveParts[0]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const archives = await checked(root, [archiveParts[0]]);
  if (!archives.info.isDirectory()) {
    throw new WorkspaceError('历史归档路径不是目录');
  }
  const archivePath = join(root, ...archiveParts);
  await rename(outputPath, archivePath);
  try {
    await mkdir(outputPath);
  } catch (error) {
    await rename(archivePath, outputPath);
    throw error;
  }
  return { ...inventory, archive: archiveName };
}

export type Side = 'in' | 'out';
export async function listFiles(root: string, side: Side) {
  const files: { name: string; size: number; updatedAt: string }[] = [];
  let scanned = 0;
  let truncated = false;
  async function walk(parts: string[]) {
    const dir = await checked(root, [side, ...parts]);
    if (!dir.info.isDirectory()) {
      return;
    }
    for (const entry of await readdir(dir.path, { withFileTypes: true })) {
      if (++scanned > 2000 || files.length >= 500) {
        truncated = true;
        return;
      }
      const next = [...parts, entry.name];
      try {
        segments(entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          if (next.length < 12) {
            await walk(next);
          } else {
            truncated = true;
          }
        } else if (entry.isFile()) {
          const item = await checked(root, [side, ...next]);
          if (item.info.isFile() && item.info.nlink === 1) {
            files.push({
              name: next.join('/'),
              size: item.info.size,
              updatedAt: item.info.mtime.toISOString(),
            });
          }
        }
      } catch (error) {
        if (!missing(error) && !(error instanceof WorkspaceError)) {
          throw error;
        }
      }
    }
  }
  try {
    await walk([]);
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
  }
  return { files: files.sort((a, b) => a.name.localeCompare(b.name)), truncated };
}

export async function openFile(root: string, side: Side, name: string) {
  const item = await checked(root, [side, ...segments(name)]);
  if (!item.info.isFile() || item.info.nlink !== 1) {
    throw new WorkspaceError('不是可访问的普通文件');
  }
  const handle = await open(item.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.ino !== item.info.ino ||
      info.dev !== item.info.dev
    ) {
      throw new WorkspaceError('文件已变化，请重试');
    }
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
