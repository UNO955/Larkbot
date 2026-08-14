/**
 * 流式卡片构造。
 *
 * 飞书「纯文本消息」不支持 patch 更新，只有 interactive 卡片能反复 patch。
 * 所以流式回贴统一走卡片：把 traex 的屏幕快照塞进一个 markdown 代码块
 * （等宽字体，保留终端对齐），靠 message.patch 原地刷新同一张卡片。
 */
import type { ImCard } from '../types.js';

export type StreamCardStatus = 'working' | 'completed' | 'failed' | 'stopped';

export interface TerminalCardOpts {
  /** 当前模型输出（已渲染、去噪）。 */
  body: string;
  status: StreamCardStatus;
  title?: string;
  replySignature?: string;
  replyToId?: string;
}

export interface ThinkingCardOpts {
  url: string;
  interruptSessionId: string;
  status: StreamCardStatus;
  footer?: string;
}

const STATUS_META = {
  working: { icon: '⏳', label: '正在处理', template: 'blue' },
  completed: { icon: '✅', label: '已完成', template: 'green' },
  failed: { icon: '⚠️', label: '处理失败', template: 'red' },
  stopped: { icon: '⏹️', label: '已停止', template: 'grey' },
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
  if (opts.status === 'completed') {
    const signature = completedFooter(opts.replySignature, opts.replyToId);
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      text_size: 'notation_small_v2',
      content: `<font color='grey'>${signature}</font>`,
    });
  }
  const payload: Record<string, unknown> = {
    config: { wide_screen_mode: true },
    elements,
  };
  if (opts.status !== 'completed') {
    payload.header = {
      template: meta.template,
      title: {
        tag: 'plain_text',
        content: `${meta.icon} ${opts.title?.trim() || meta.label}`,
      },
    };
  }
  return { payload };
}

function escapeMarkdownText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function completedFooter(replySignature?: string, replyToId?: string): string {
  const signature = escapeMarkdownText(replySignature?.trim() || 'larkbot');
  const at = replyToId?.trim() ? ` 发送给: <at id="${escapeMarkdownText(replyToId.trim())}"></at>` : '';
  return `${signature}${at}`;
}

export function buildThinkingCard(opts: ThinkingCardOpts): ImCard {
  const meta = STATUS_META[opts.status];
  const stopped = opts.status === 'stopped';
  const buttonDisabled = opts.status !== 'working';
  const buttonText = opts.status === 'completed'
    ? '思考已完成'
    : stopped
    ? '思考已停止'
    : '停止思考';
  const interruptValue = { action: 'interrupt_thinking', sessionId: opts.interruptSessionId };
  const elements: unknown[] = [
    {
      tag: 'markdown',
      content: stopped
        ? "<font color='grey'>本轮思考已停止，会话仍可继续使用。</font>"
        : opts.status === 'working'
        ? "<font color='grey'>正在思考和调用工具，可打开只读终端查看实时过程。</font>"
        : "<font color='grey'>思考过程可在只读终端中查看。</font>",
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '打开思考过程' },
          type: 'default',
          multi_url: {
            url: opts.url,
            pc_url: opts.url,
            android_url: opts.url,
            ios_url: opts.url,
          },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: buttonText },
          type: buttonDisabled ? 'default' : 'danger',
          disabled: buttonDisabled,
          value: interruptValue,
          behaviors: [{ type: 'callback', value: interruptValue }],
        },
      ],
    },
  ];
  if (opts.footer?.trim()) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      text_size: 'notation_small_v2',
      content: `<font color='grey'>${opts.footer.trim()}</font>`,
    });
  }
  return {
    payload: {
      config: { wide_screen_mode: true },
      header: {
        template: meta.template,
        title: {
          tag: 'plain_text',
          content: `${opts.status === 'completed' ? '✅ 思考完成' : opts.status === 'stopped' ? '⏹️ 已停止思考' : opts.status === 'failed' ? '⚠️ 思考失败' : '🧠 思考中'}`,
        },
      },
      elements,
    },
  };
}
