const $ = (id) => document.getElementById(id);
const labels = {
  queued: '排队中',
  retrying: '整理旧文件',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
};
let selected;
let before;
let preview;
let cursor = '0';
let refreshing = false;
let refreshAgain = false;
let step = 'upload';
let activeTask;
let reviewRequest = 0;
let reviewDraft;
const taskIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function notify(message, error = false) {
  const notice = $('notice');
  notice.textContent = message;
  notice.hidden = !message;
  notice.dataset.error = String(error);
}

async function api(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const error = new Error(
      (await res.json().catch(() => null))?.error || `请求失败 (${res.status})`
    );
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function fileUrl(id, side, name, download = false) {
  return `/api/tasks/${id}/file?${new URLSearchParams({ side, name, download: download ? '1' : '0' })}`;
}

function mayLeaveReview() {
  if (step !== 'review' || !reviewDraft) return true;
  if (reviewDraft.saving) return false;
  return !reviewDraft.dirty || window.confirm('有未保存的修改，确定离开核对页吗？');
}

function showStep(next) {
  if (next !== 'review') {
    reviewRequest++;
    reviewDraft = undefined;
  }
  step = next;
  const panes = { upload: 'upload-pane', run: 'detail', review: 'review-pane' };
  for (const [name, pane] of Object.entries(panes)) {
    $(pane).hidden = name !== next;
    const button = $(`step-${name}`);
    if (name === next) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  $('step-run').disabled = !selected;
  $('step-review').disabled = activeTask?.status !== 'succeeded';
}

function select(id) {
  if (!mayLeaveReview()) return false;
  if (selected !== id) {
    selected = id;
    activeTask = undefined;
    cursor = '0';
    preview = undefined;
    $('preview').hidden = true;
    $('logs').textContent = '';
    $('open-review').hidden = true;
    $('retry').hidden = true;
    $('task-id').textContent = id ? `任务编号：${id}` : '';
    $('status').textContent = '正在加载任务…';
    $('status').dataset.status = '';
    $('prompt').textContent = '';
    $('reply').textContent = '';
    for (const target of ['in', 'process', 'result-files']) $(target).replaceChildren();
  }
  const url = new URL(location.href);
  if (id) url.searchParams.set('task', id);
  else url.searchParams.delete('task');
  history.replaceState(null, '', url);
  showStep(id ? 'run' : 'upload');
  void refresh();
  return true;
}

async function refreshPreview() {
  const item = preview;
  if (!item) {
    return;
  }
  let node;
  if (/\.(png|jpe?g|webp|gif)$/i.test(item.name)) {
    node = document.createElement('img');
    node.alt = item.name;
    node.src = item.url;
  } else if (/\.pdf$/i.test(item.name)) {
    node = document.createElement('iframe');
    node.title = item.name;
    node.src = item.url;
  } else if (/\.(txt|md|json|csv|log)$/i.test(item.name)) {
    node = document.createElement('pre');
    try {
      const res = await fetch(item.url);
      node.textContent = res.ok ? await res.text() : '当前文件无法预览，请下载查看。';
    } catch {
      node.textContent = '读取失败，将自动刷新。';
    }
  } else {
    node = document.createElement('p');
    node.textContent = '该格式请下载查看。';
  }
  if (preview === item) {
    $('contents').replaceChildren(node);
  }
}

function fileList(id, side, files, target, emptyText) {
  const items = files.map((file) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'file-name';
    button.textContent = file.name;
    button.title = file.name;
    button.onclick = () => {
      preview = {
        id,
        side,
        name: file.name,
        version: file.updatedAt,
        url: fileUrl(id, side, file.name),
      };
      $('preview').hidden = false;
      $('filename').textContent = file.name;
      $('contents').textContent = '正在加载…';
      void refreshPreview();
    };
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = formatSize(file.size);
    const download = document.createElement('a');
    download.href = fileUrl(id, side, file.name, true);
    download.textContent = '下载';
    download.setAttribute('aria-label', `下载 ${file.name}`);
    li.append(button, size, download);
    return li;
  });
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty-file';
    li.textContent = emptyText;
    items.push(li);
  }
  $(target).replaceChildren(...items);
  const current =
    preview?.side === side && preview.id === id && files.find((f) => f.name === preview.name);
  if (current && preview.version !== current.updatedAt) {
    preview = { ...preview, version: current.updatedAt };
    void refreshPreview();
  }
}

function formatSize(size) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function outputGroups(files) {
  const process = files.filter((file) => file.name.startsWith('process/'));
  const result = files.filter((file) => !file.name.startsWith('process/'));
  return { process, result };
}

async function retryTask(task, inventory) {
  const names = inventory.files.length
    ? inventory.files.map((file) => `• ${file.name}（${formatSize(file.size)}）`).join('\n')
    : '当前 out 目录为空。';
  const prompt = [
    `任务「${task.cwd}」失败，重新执行前将归档当前 out 目录。`,
    '',
    '以下文件会完整保留在 .previous-runs/ 中，新的运行会使用空 out 目录：',
    names,
    ...(inventory.truncated ? ['', '文件数量较多，清单仅显示部分文件。'] : []),
    '',
    '确认重新执行？',
  ].join('\n');
  if (!window.confirm(prompt)) {
    return;
  }
  const button = $('retry');
  button.disabled = true;
  button.textContent = '正在准备…';
  try {
    const result = await api(`/api/tasks/${task.id}/retry`, { method: 'POST' });
    notify(
      result.archive
        ? `已重新排队，旧文件已归档至 ${result.archive}`
        : '已重新排队，之前没有可归档的输出文件。'
    );
    await refresh();
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '重新执行';
  }
}

async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  const page = before;
  const id = selected;
  try {
    const rows = await api(`/api/tasks${page ? `?before=${page}` : ''}`);
    if (page === before) {
      $('tasks').replaceChildren(
        ...rows.map((row) => {
          const li = document.createElement('li');
          const button = document.createElement('button');
          const end = row.finished_at ? Date.parse(row.finished_at) : Date.now();
          const seconds = row.started_at
            ? ` · ${Math.max(0, Math.floor((end - Date.parse(row.started_at)) / 1000))} 秒`
            : '';
          button.className = 'task-item';
          button.textContent = row.title?.trim() || row.cwd;
          button.title = row.title?.trim() || row.cwd;
          button.onclick = () => {
            notify('');
            select(row.id);
          };
          button.setAttribute('aria-pressed', String(row.id === selected));
          const time = document.createElement('small');
          time.textContent = `${labels[row.status] ?? row.status}${seconds} · ${new Date(row.created_at).toLocaleString()}`;
          li.append(button, time);
          return li;
        })
      );
      $('older').hidden = rows.length < 50;
      $('older').onclick = () => {
        before = rows.at(-1)?.id;
        void refresh();
      };
      $('latest').hidden = !before;
    }
    if (!id || id !== selected || step !== 'run') {
      return;
    }
    const base = `/api/tasks/${id}`;
    const [task, taskLogs, input, output] = await Promise.all([
      api(base),
      api(`${base}/logs?after=${cursor}`),
      api(`${base}/files?side=in`),
      api(`${base}/files?side=out`),
    ]);
    if (id !== selected || step !== 'run') {
      return;
    }
    activeTask = task;
    $('task-id').textContent = `任务编号：${task.id}`;
    const status = `${labels[task.status] ?? task.status} · ${task.model}${task.error ? ` · ${task.error}` : ''}`;
    if ($('status').textContent !== status) $('status').textContent = status;
    $('status').dataset.status = task.status;
    $('open-review').hidden = task.status !== 'succeeded';
    $('step-review').disabled = task.status !== 'succeeded';
    $('prompt').textContent = task.prompt;
    $('reply').textContent = task.reply || '任务完成后显示 Pi 的最终回复。';
    $('retry').hidden = task.status !== 'failed';
    $('retry').onclick = () => void retryTask(task, output);
    if (taskLogs.length) {
      cursor = taskLogs.at(-1).id;
      $('logs').textContent += taskLogs
        .map((log) => `${new Date(log.created_at).toLocaleTimeString()}  ${log.message}\n`)
        .join('');
      $('logs').scrollTop = $('logs').scrollHeight;
    }
    fileList(id, 'in', input.files, 'in', '还没有输入文件');
    const groups = outputGroups(output.files);
    fileList(id, 'out', groups.process, 'process', '还没有过程文件');
    fileList(id, 'out', groups.result, 'result-files', '还没有结果文件');
  } catch (error) {
    if (step === 'run' && id === selected && !activeTask) $('status').textContent = error.message;
    else if ($('notice').hidden && step !== 'upload') notify(error.message, true);
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      void refresh();
    }
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderUploadList() {
  const files = [...$('upload-files').files];
  const list = $('upload-list');
  list.hidden = !files.length;
  list.replaceChildren(
    ...files.map((file) => {
      const li = element('li');
      li.append(element('span', file.name), element('small', formatSize(file.size)));
      return li;
    })
  );
}

function editableValue(draft, label, value, target) {
  const control = element('textarea', undefined, 'review-value');
  control.rows = !value || value.length < 60 ? 1 : 2;
  control.value = value ?? '';
  control.placeholder = '未提取';
  control.setAttribute('aria-label', label);
  draft.fields.push({ control, initial: control.value, target });
  return control;
}

function collectReviewChanges(draft) {
  const contractInfo = Object.create(null);
  const productValues = [];
  for (const { control, initial, target } of draft.fields) {
    if (control.value === initial) continue;
    const value = control.value.trim() || null;
    if (typeof target === 'string') contractInfo[target] = value;
    else productValues.push({ ...target, value });
  }
  return { contractInfo, productValues };
}

async function saveReview(event) {
  event.preventDefault();
  const draft = reviewDraft;
  if (!draft?.dirty || draft.saving) return;
  const changes = collectReviewChanges(draft);
  const button = $('save-review');
  draft.saving = true;
  button.disabled = true;
  for (const { control } of draft.fields) control.readOnly = true;
  $('review-save-status').textContent = '正在保存…';
  try {
    const { revision } = await api(`/api/tasks/${draft.id}/contract-review`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: draft.revision, changes }),
    });
    draft.revision = revision;
    for (const field of draft.fields) {
      if (field.control.value !== field.initial) field.control.value = field.control.value.trim();
      field.initial = field.control.value;
    }
    draft.dirty = false;
    $('review-save-status').textContent = '修改已保存';
  } catch (error) {
    $('review-save-status').textContent = error.message;
  } finally {
    draft.saving = false;
    for (const { control } of draft.fields) control.readOnly = false;
    button.disabled = !draft.dirty;
  }
}

function addNote(parent, label, value) {
  if (value === null) return;
  const note = element('p', undefined, 'review-note');
  note.append(element('strong', `${label}：`), document.createTextNode(value));
  parent.append(note);
}

function renderContractResult(result, draft) {
  const questions = element('section', undefined, 'review-group review-questions');
  const count = result.questions.length;
  const heading = element('h3', '待确认问题');
  heading.append(element('span', `${count} 项`, 'review-count'));
  questions.append(heading);
  if (count) {
    questions.classList.add('review-questions-attention');
    const list = element('ol');
    for (const question of result.questions) list.append(element('li', question));
    questions.append(list);
  } else {
    questions.append(element('p', '未记录待确认问题。', 'review-note'));
  }

  const base = element('details', undefined, 'review-group review-contract');
  const summary = element('summary');
  const entries = Object.entries(result.contractInfo);
  summary.append('合同基础信息', element('span', `${entries.length} 个字段`, 'review-count'));
  base.append(summary);
  if (entries.length) {
    const fields = element('dl', undefined, 'contract-fields');
    for (const [name, value] of entries) {
      const row = element('div');
      const detail = element('dd');
      detail.append(editableValue(draft, `合同基础信息：${name}`, value, name));
      row.append(element('dt', name), detail);
      fields.append(row);
    }
    base.append(fields);
  } else {
    base.append(element('p', '没有可展示的合同基础信息。', 'review-note'));
  }

  const products = result.products.map((product, index) => {
    const group = element('section', undefined, 'review-group');
    group.append(element('h3', `产品 ${index + 1} · ${product.type ?? '未识别类型'}`));
    addNote(group, '产品判定依据', product.basis);
    if (!product.fields.length) {
      group.append(element('p', '没有可展示的规格字段。', 'review-note'));
      return group;
    }
    const fields = element('dl', undefined, 'product-fields');
    for (const [fieldIndex, field] of product.fields.entries()) {
      const row = element('div', undefined, 'product-field');
      const detail = element('dd', undefined, 'product-detail');
      const status = element('span', field.status, 'review-status');
      status.dataset.state = field.status;
      detail.append(
        editableValue(draft, `产品 ${index + 1}：${field.name}`, field.value, {
          productIndex: index,
          fieldIndex,
        })
      );
      const notes = element('div', undefined, 'product-notes');
      addNote(notes, '判定来源', field.source);
      addNote(notes, '原文证据', field.evidence);
      if (notes.childElementCount) detail.append(notes);
      const label = element('dt', field.name, 'product-label');
      label.append(status);
      row.append(label, detail);
      fields.append(row);
    }
    group.append(fields);
    return group;
  });
  $('review-fields').replaceChildren(questions, base, ...products);
}

async function loadReview() {
  const id = selected;
  if (!id || activeTask?.status !== 'succeeded' || step === 'review') return;
  showStep('review');
  const request = ++reviewRequest;
  $('review-title').focus();
  $('review-message').textContent = '正在加载已入库的提取结果…';
  $('review-form').hidden = true;
  const current = () => selected === id && step === 'review' && request === reviewRequest;
  try {
    const { result, revision } = await api(`/api/tasks/${id}/contract-review`);
    if (!current()) return;
    if (result?.schemaVersion !== 1) throw new Error('当前结果格式不支持表单展示。');
    const draft = { id, revision, fields: [], dirty: false, saving: false };
    renderContractResult(result, draft);
    reviewDraft = draft;
    $('review-message').textContent = '';
    $('review-save-status').textContent = revision ? '已加载人工核对值' : '';
    $('save-review').disabled = true;
    $('review-form').hidden = false;
  } catch (error) {
    if (!current()) return;
    $('review-message').textContent =
      error.status === 404
        ? '本任务没有已入库的合同结果，可返回执行详情查看产物。'
        : `无法加载核对表单：${error.message}`;
  }
}

$('submit').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const body = new FormData(form);
  const files = [...$('upload-files').files];
  const prompt = $('task-prompt').value.trim();
  if (!prompt || new TextEncoder().encode(prompt).length > 60_000) {
    return notify('请填写任务描述，最多 60,000 字节。', true);
  }
  if (!files.length || files.length > 10 || files.some((file) => file.size > 25 * 1024 ** 2)) {
    return notify('请选择 1 至 10 个文件，每个不超过 25 MiB。', true);
  }
  if (files.reduce((size, file) => size + file.size, 0) >= 100 * 1024 ** 2) {
    return notify('文件总大小需低于 100 MiB，为表单保留空间。', true);
  }
  body.set('prompt', prompt);
  button.disabled = true;
  $('upload-files').disabled = true;
  $('task-prompt').disabled = true;
  notify('正在上传文件并提交任务…');
  try {
    const task = await api('/api/tasks', { method: 'POST', body });
    form.reset();
    renderUploadList();
    before = undefined;
    notify('文件已保存，任务已进入队列。');
    select(task.taskId);
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
    $('upload-files').disabled = false;
    $('task-prompt').disabled = false;
  }
};
$('latest').onclick = () => {
  before = undefined;
  void refresh();
};
$('close-preview').onclick = () => {
  preview = undefined;
  $('preview').hidden = true;
};
$('new-task').onclick = () => {
  if (!select(undefined)) return;
  notify('');
  $('upload-files').focus();
};
$('step-upload').onclick = () => {
  if (mayLeaveReview()) showStep('upload');
};
$('step-run').onclick = $('back-run').onclick = () => {
  if (!mayLeaveReview()) return;
  showStep('run');
  void refresh();
};
$('review-form').onsubmit = saveReview;
$('review-form').oninput = () => {
  const draft = reviewDraft;
  if (!draft || draft.saving) return;
  draft.dirty = draft.fields.some(({ control, initial }) => control.value !== initial);
  $('save-review').disabled = !draft.dirty;
  $('review-save-status').textContent = draft.dirty ? '有未保存的修改' : '';
};
window.addEventListener('beforeunload', (event) => {
  if (!reviewDraft?.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});
$('step-review').onclick = $('open-review').onclick = () => void loadReview();
$('upload-files').onchange = renderUploadList;
const initialTask = new URL(location.href).searchParams.get('task');
if (taskIdPattern.test(initialTask ?? '')) select(initialTask);
else void refresh();
setInterval(() => {
  if (!refreshing) void refresh();
}, 2000);
