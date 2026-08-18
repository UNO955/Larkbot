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
  argosUrlTemplate?: string;
  argosSource?: string;
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
    const argosUrl = buildArgosUrl(opts.argosSource ?? opts.body, opts.argosUrlTemplate);
    elements.push({ tag: 'hr' });
    elements.push(buildCompletedFooter(signature, argosUrl));
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

function buildCompletedFooter(signature: string, argosUrl?: string): unknown {
  const signatureElement = {
    tag: 'markdown',
    text_size: 'notation_small_v2',
    content: `<font color='grey'>${signature}</font>`,
  };
  if (!argosUrl) return signatureElement;
  return {
    tag: 'column_set',
    flex_mode: 'none',
    background_style: 'default',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [signatureElement],
      },
      {
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '一键跳转 Argos ↗' },
            type: 'default',
            multi_url: {
              url: argosUrl,
              pc_url: argosUrl,
              android_url: argosUrl,
              ios_url: argosUrl,
            },
          },
        ],
      },
    ],
  };
}

const LABELLED_LOGID_RE = /`?(?:业务\s*)?(?:result_)?(?:logid|log_id|LogID|LogId)`?\s*[=:：为是]?\s*`?([A-Za-z0-9][A-Za-z0-9_-]{15,127})`?/;
const TRACE_LOGID_RE = /\b(0[0-9A-Za-z][0-9A-Za-z_-]{24,127})\b/;
const PSM_RE = /`?(?:PSM|psm)`?\s*[=:：为是]?\s*`?([a-z][a-z0-9_.-]{2,127})`?/;
const BYTEDCLI_ARGOS_LINK_RE = /https?:\/\/aiops-argos\.byted\.org\/agent_center\/s\/[A-Za-z0-9_-]+/;

function buildArgosUrl(body: string, template?: string): string | undefined {
  const bytedcliLink = body.match(BYTEDCLI_ARGOS_LINK_RE)?.[0];
  if (bytedcliLink) return bytedcliLink;
  const trimmedTemplate = template?.trim();
  if (!trimmedTemplate) return undefined;
  const logId = extractTraceLogId(body);
  if (!logId) return undefined;
  const encoded = encodeURIComponent(logId);
  const psm = extractPsm(body);
  if (trimmedTemplate.includes('{logid}') || trimmedTemplate.includes('{psm}')) {
    return trimmedTemplate
      .replaceAll('{logid}', encoded)
      .replaceAll('{psm}', encodeURIComponent(psm ?? ''));
  }
  const separator = trimmedTemplate.includes('?') ? '&' : '?';
  return `${trimmedTemplate}${separator}log_id=${encoded}`;
}

function extractTraceLogId(body: string): string | undefined {
  return body.match(LABELLED_LOGID_RE)?.[1] ?? body.match(TRACE_LOGID_RE)?.[1];
}

function extractPsm(body: string): string | undefined {
  return body.match(PSM_RE)?.[1];
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
