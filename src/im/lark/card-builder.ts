/**
 * 流式卡片构造。
 *
 * 飞书「纯文本消息」不支持 patch 更新，只有 interactive 卡片能反复 patch。
 * 所以流式回贴统一走卡片：把 traex 的屏幕快照塞进一个 markdown 代码块
 * （等宽字体，保留终端对齐），靠 message.patch 原地刷新同一张卡片。
 */
import type { ImCard } from '../types.js';

export type StreamCardStatus = 'working' | 'completed' | 'failed';

export interface TerminalCardOpts {
  /** 当前模型输出（已渲染、去噪）。 */
  body: string;
  status: StreamCardStatus;
  title?: string;
}

const STATUS_META = {
  working: { label: '正在处理', template: 'blue' },
  completed: { label: '已完成', template: 'green' },
  failed: { label: '处理失败', template: 'red' },
} as const;

export function buildTerminalCard(opts: TerminalCardOpts): ImCard {
  const meta = STATUS_META[opts.status];
  const body = opts.body.trim();
  const elements: unknown[] = [];
  if (body) {
    elements.push({ tag: 'markdown', content: body });
  } else {
    elements.push({
      tag: 'markdown',
      content: opts.status === 'working'
        ? "<font color='grey'>traex 正在生成回复…</font>"
        : "<font color='grey'>本轮没有可展示的文本输出。</font>",
    });
  }
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    text_size: 'notation_small_v2',
    content: `<font color='grey'>TraeCode CLI · ${meta.label}</font>`,
  });

  return {
    payload: {
      config: { wide_screen_mode: true },
      header: {
        template: meta.template,
        title: {
          tag: 'plain_text',
          content: `TraeCode · ${opts.title?.trim() || meta.label}`,
        },
      },
      elements,
    },
  };
}
