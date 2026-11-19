/**
 * views/settings.js — 填 ASR key 的设置页。
 *
 * 协议按 TPI 2.0 文档「页面与插件进程通信」：
 *   - 页面就绪：`{tpi:'view', type:'ready'}`
 *   - 页面发消息：`{tpi:'view', type:'post', id, message}`，插件进程用 `{tpi:'host', type:'reply', id, ok, value|error}` 回
 *   - 宿主推消息：`{tpi:'host', type:'hello', context}` / `type:'push'`
 *
 * key 本身不落这个页面：`host.secrets` 只在插件进程里能碰，页面只负责传值。
 */

const KEY = 'asrKey';
const $ = (id) => document.getElementById(id);

const stateEl = $('state');
const input = $('key');
const messageEl = $('message');

let nextId = 1;
const pending = new Map();

function resize() {
  parent.postMessage({ tpi: 'view', type: 'resize', height: document.documentElement.scrollHeight }, '*');
}

function setState(text, kind = 'unknown') {
  stateEl.textContent = text;
  stateEl.dataset.state = kind;
  resize();
}

function showMessage(text) {
  messageEl.textContent = text ?? '';
  messageEl.hidden = !text;
  resize();
}

/** 发给插件进程，等 id 匹配的 reply。 */
function post(message) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error('机制未应答（页面与插件进程没连上）'));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ tpi: 'view', type: 'post', id, message }, '*');
  });
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.tpi !== 'host') return;
  if (data.type === 'hello') { void refresh(); return; }
  if (data.type === 'reply') {
    const waiter = pending.get(data.id);
    if (!waiter) return;
    pending.delete(data.id);
    clearTimeout(waiter.timer);
    if (data.ok) waiter.resolve(data.value);
    else waiter.reject(new Error(data.error ?? '未知错误'));
  }
});

async function refresh() {
  try {
    const value = await post({ type: 'secret-status', key: KEY });
    setState(value?.configured ? '已配置 key' : '未配置 key —— 需要台词的工具有限降级', value?.configured ? 'ok' : 'unknown');
  } catch (error) {
    setState(`读不到配置：${error.message}`, 'bad');
  }
}

$('save').addEventListener('click', async () => {
  const value = input.value.trim();
  if (!value) { showMessage('请输入 key，或点「清除」。'); return; }
  try {
    await post({ type: 'secret-set', key: KEY, value });
    input.value = '';
    showMessage('已保存。下一次调用 video_storyboard 就会带上它。');
    await refresh();
  } catch (error) {
    showMessage(`保存失败：${error.message}`);
  }
});

$('clear').addEventListener('click', async () => {
  try {
    await post({ type: 'secret-delete', key: KEY });
    input.value = '';
    showMessage('已清除。');
    await refresh();
  } catch (error) {
    showMessage(`清除失败：${error.message}`);
  }
});

parent.postMessage({ tpi: 'view', type: 'ready' }, '*');
resize();
