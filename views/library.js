/**
 * views/library.js — 分镜库面板。
 *
 * 协议（照 TPI 2.0 官方示例实现）：
 *   - 宿主 ← 视图：`parent.postMessage({ tpi: 'view', type: 'resize', height })`
 *   - 宿主 → 视图：`event.data.tpi === 'host'`，`type: 'hello'` 时带 `context`
 *   - 请求-应答：先 post `{tpi:'view', type:'ask', requestId, payload}`，宿主用
 *     `{tpi:'host', type:'answer', requestId, value|error}` 回（本文件里没用到，走的是轮询式 hello + 命令）
 *
 * **图片不一定能显示**：宿主可能把视图跑在带 CSP 的 iframe 里，`file://` 往往被拦。
 * 所以卡片主体是「时间/格数/路径」这类一定有用的信息；`<img>` 只是尽力而为，加载失败就隐藏。
 */

const $ = (id) => document.getElementById(id);
const state = $('state');
const jobsList = $('jobs');
const hint = $('hint');

const resize = () => parent.postMessage(
  { tpi: 'view', type: 'resize', height: document.documentElement.scrollHeight }, '*',
);

function setState(text, kind = 'unknown') {
  state.textContent = text;
  state.dataset.state = kind;
  resize();
}

function showHint(text) {
  hint.textContent = text ?? '';
  hint.hidden = !text;
  resize();
}

/** 一次运行记录 → 一张卡片。字段见 index.js 的 recordFor()。 */
function renderJob(job) {
  const li = document.createElement('li');
  li.className = 'job';

  const head = document.createElement('div');
  head.className = 'job-head';
  const title = document.createElement('span');
  title.className = 'job-title';
  title.textContent = job.label;
  const time = document.createElement('span');
  time.className = 'job-meta';
  time.textContent = new Date(job.at).toLocaleTimeString();
  head.append(title, time);

  const meta = document.createElement('div');
  meta.className = 'job-meta';
  const bits = [job.tool];
  if (job.cells) bits.push(`${job.cells} 格`);
  if (job.images?.length) bits.push(`${job.images.length} 张图`);
  if (job.ms) bits.push(`${(job.ms / 1000).toFixed(1)}s`);
  meta.textContent = bits.join(' · ');

  li.append(head, meta);

  if (job.images?.length) {
    const img = document.createElement('img');
    img.className = 'job-image';
    img.loading = 'lazy';
    // 路径是 Windows 绝对路径，直接塞给 <img src>；被 CSP 拦时触发 error → 隐藏。
    img.src = `file:///${job.images[0].replace(/\\/g, '/')}`;
    img.addEventListener('error', () => { img.hidden = true; });
    li.append(img);
  }

  return li;
}

function render(payload) {
  jobsList.replaceChildren();
  const list = payload?.jobs ?? [];
  if (!list.length) {
    setState('还没有跑过分镜', 'unknown');
    showHint('在对话里调用 video_storyboard 后，这里会出现最近的结果。');
    return;
  }
  setState(`最近 ${list.length} 次运行`, 'ok');
  showHint('');
  for (const job of list) jobsList.append(renderJob(job));
}

const ask = (payload) => new Promise((resolve, reject) => {
  const requestId = Math.random().toString(36).slice(2);
  const timer = setTimeout(() => reject(new Error('timeout')), 4000);
  const onMessage = (event) => {
    const data = event.data;
    if (!data || data.tpi !== 'host' || data.type !== 'answer' || data.requestId !== requestId) return;
    clearTimeout(timer);
    window.removeEventListener('message', onMessage);
    if (data.error) reject(new Error(data.error));
    else resolve(data.value);
  };
  window.addEventListener('message', onMessage);
  parent.postMessage({ tpi: 'view', type: 'ask', requestId, payload }, '*');
});

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.tpi !== 'host') return;
  if (data.type === 'hello') {
    const context = data.context;
    // 作为「工具结果卡片」打开时，结果就在 context 里；否则向插件进程要最近列表。
    if (context?.tool?.startsWith('video_')) { ask({ type: 'last' }).then(render, () => render(null)); return; }
    ask({ type: 'list' }).then(render, () => render(null));
    return;
  }
  if (data.type === 'status') setState(data.text, data.level === 'error' ? 'bad' : 'busy');
  if (data.type === 'job') ask({ type: 'list' }).then(render, () => {});
});

resize();
