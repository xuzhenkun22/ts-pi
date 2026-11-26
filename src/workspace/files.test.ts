import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  archiveOutput,
  directoryForTaskId,
  listFiles,
  taskDirectory,
  validateLayout,
  WorkspaceError,
  workspaceSkillFile,
} from './files.js';

test('taskid 只对应工作区根目录的直接子目录，Worker 可创建 out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workspace-'));
  const previous = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  try {
    await mkdir(join(root, '任务-001', 'in'), { recursive: true });
    await mkdir(join(root, 'legacy', 'task', 'in'), { recursive: true });
    const dir = await directoryForTaskId('任务-001');
    assert.equal(dir.cwd, '任务-001');
    await validateLayout(dir.path);
    await validateLayout(dir.path, true);
    assert.ok((await stat(join(dir.path, 'out'))).isDirectory());
    for (const invalid of [
      '',
      ' task',
      '.',
      '..',
      'legacy/task',
      'legacy\\task',
      'C:/task',
      'out',
    ]) {
      await assert.rejects(directoryForTaskId(invalid), WorkspaceError);
    }
    await assert.rejects(directoryForTaskId('missing'), { code: 'ENOENT' });
    assert.equal((await taskDirectory('legacy/task')).cwd, 'legacy/task');
  } finally {
    if (previous === undefined) {
      delete process.env.WORKSPACE_ROOT;
    } else {
      process.env.WORKSPACE_ROOT = previous;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('重执行归档完整保留 out，并建立新的空 out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-retry-'));
  try {
    await mkdir(join(root, 'out', 'process'), { recursive: true });
    await writeFile(join(root, 'out', 'process', 'ocr.txt'), 'intermediate');
    await writeFile(join(root, 'out', 'contract-result.json'), '{"old":true}');
    const archived = await archiveOutput(root);
    const canonicalRoot = await realpath(root);
    assert.equal(archived.files.length, 2);
    assert.deepEqual(await listFiles(canonicalRoot, 'out'), { files: [], truncated: false });
    assert.equal(
      await readFile(join(root, archived.archive!, 'process', 'ocr.txt'), 'utf8'),
      'intermediate'
    );
    assert.equal(
      await readFile(join(root, archived.archive!, 'contract-result.json'), 'utf8'),
      '{"old":true}'
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('共享技能只接受根目录下可访问的真实 SKILL.md', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-skills-'));
  const previous = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  try {
    const skill = join(root, 'skills', '合同提取');
    const file = join(skill, 'SKILL.md');
    await mkdir(skill, { recursive: true });
    await writeFile(file, 'test skill');
    await symlink(skill, join(root, 'linked-skill'), 'junction');
    assert.equal(await workspaceSkillFile('skills/合同提取'), await realpath(file));
    for (const invalid of ['missing', 'skills', '../outside', skill, 'linked-skill']) {
      await assert.rejects(workspaceSkillFile(invalid), {
        message: /^TASK_PI_SKILL_DIR 无效/,
      });
    }
  } finally {
    if (previous === undefined) {
      delete process.env.WORKSPACE_ROOT;
    } else {
      process.env.WORKSPACE_ROOT = previous;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
