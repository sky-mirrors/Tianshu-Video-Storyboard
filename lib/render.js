/**
 * lib/render.js — 工具回执的整形：文本在前，图片路径按页给。
 *
 * 抽到这里是为了能被单测盯住（`test/render.test.mjs`）：分页边界（恰好等于阈值、
 * 差一张、多一张、没有图）是这里唯一的判断，留在 index.js 里就只能靠人工试。
 */

/** 一次回执里最多列几张图的路径；其余只报数量（两小时的片子能出十几张）。 */
export const IMAGE_PAGE = 4;

/**
 * @param {{ text?: string, images?: string[] }} result worker 的结果 JSON
 * @returns {string} 工具回执文本
 */
export function renderResult(result) {
  const parts = [result.text];
  const images = result.images ?? [];
  if (images.length > 0) {
    const shown = images.slice(0, IMAGE_PAGE);
    parts.push('', `分镜图（用 read_file 打开查看；共 ${images.length} 张，先列 ${shown.length} 张）：`);
    for (const p of shown) parts.push(`- ${p}`);
    if (images.length > shown.length) {
      parts.push('', `其余 ${images.length - shown.length} 张与上面同一目录、文件名按序号递增；需要时再取。`);
    }
  }
  return parts.join('\n');
}

/** 从结果文本里抠出格子数，喂给面板卡片；抠不到就返回空对象，不猜。 */
export function summarize(text) {
  const cells = /grid="([0-9]+) frames/.exec(String(text ?? ''))?.[1];
  return cells ? { cells: Number(cells) } : {};
}
