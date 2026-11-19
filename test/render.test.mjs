import test from 'node:test';
import assert from 'node:assert/strict';

import { IMAGE_PAGE, renderResult, summarize } from '../lib/render.js';

const imgs = (n) => Array.from({ length: n }, (_, i) => `D:/out/sheet-${i + 1}.png`);

test('renderResult: 没有图时不出现「分镜图」段', () => {
  const out = renderResult({ text: 'index line', images: [] });
  assert.equal(out, 'index line');
});

test('renderResult: images 缺失（undefined）与空数组等价', () => {
  assert.equal(renderResult({ text: 'index line' }), 'index line');
});

test('renderResult: 空文本 + 无图 → 空串', () => {
  assert.equal(renderResult({ text: '', images: [] }), '');
});

test(`renderResult: 恰好 ${IMAGE_PAGE} 张 = 阈值，全部列出且不出现「其余」`, () => {
  const out = renderResult({ text: 'index', images: imgs(IMAGE_PAGE) });
  assert.match(out, new RegExp(`共 ${IMAGE_PAGE} 张，先列 ${IMAGE_PAGE} 张`));
  for (let i = 1; i <= IMAGE_PAGE; i += 1) assert.match(out, new RegExp(`sheet-${i}\\.png`));
  assert.doesNotMatch(out, /其余/);
});

test('renderResult: 阈值 -1（3 张）全部列出、无「其余」', () => {
  const out = renderResult({ text: 'index', images: imgs(IMAGE_PAGE - 1) });
  assert.doesNotMatch(out, /其余/);
  assert.match(out, /sheet-3\.png/);
});

test('renderResult: 阈值 +1（5 张）只列前 4 张，其余报数量', () => {
  const out = renderResult({ text: 'index', images: imgs(IMAGE_PAGE + 1) });
  assert.match(out, new RegExp(`共 ${IMAGE_PAGE + 1} 张，先列 ${IMAGE_PAGE} 张`));
  assert.match(out, /sheet-4\.png/);
  assert.doesNotMatch(out, /sheet-5\.png/, '第 5 张不应出现在路径列表里');
  assert.match(out, new RegExp(`其余 ${1} 张`));
});

test('renderResult: 单张图（下界）也走图片段', () => {
  const out = renderResult({ text: 'index', images: imgs(1) });
  assert.match(out, /共 1 张，先列 1 张/);
  assert.doesNotMatch(out, /其余/);
});

test('summarize: 从 grid 里取格子数', () => {
  assert.deepEqual(summarize('<storyboard ... grid="4 frames on 1 image(s)" ...>'), { cells: 4 });
});

test('summarize: 没有 grid / 空输入 → 空对象（不猜）', () => {
  assert.deepEqual(summarize('<storyboard ...>'), {});
  assert.deepEqual(summarize(''), {});
  assert.deepEqual(summarize(undefined), {});
});
