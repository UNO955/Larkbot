/**
 * 流式卡片构造。
 *
 * 飞书「纯文本消息」不支持 patch 更新，只有 interactive 卡片能反复 patch。
 * 所以流式回贴统一走卡片：把 traex 的屏幕快照塞进一个 markdown 代码块
 * （等宽字体，保留终端对齐），靠 message.patch 原地刷新同一张卡片。
 */
import type { ImCard } from '../types.js';

export interface TerminalCardOpts {
  /** 卡片标题，如 "traex · 运行中" / "traex · 已完成"。 */
  title: string;
  /** 终端快照文本（已渲染、去噪）。 */
  body: string;
  /** 标题栏主题色。 */
  template?: 'blue' | 'green' | 'grey' | 'red';
}

/** 飞书 markdown 里的代码块用三反引号；转义 body 里可能出现的连续反引号。 */
function fence(body: string): string {
  const safe = body.replace(/```/g, '` ` `');
  return '```\n' + safe + '\n```';
}

export function buildTerminalCard(opts: TerminalCardOpts): ImCard {
  const { title, body, template = 'blue' } = opts;
  return {
    payload: {
      config: { wide_screen_mode: true },
      header: {
        template,
        title: { tag: 'plain_text', content: title },
      },
      elements: [
        { tag: 'markdown', content: body.trim() ? fence(body) : '_（暂无输出）_' },
      ],
    },
  };
}
