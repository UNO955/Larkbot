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
  feedback?: FeedbackState;
  feedbackReason?: string;
  feedbackNote?: string;
  feedbackId?: string;
}

export interface MaintenanceCardOpts {
  title?: string;
  status: string;
  version: string;
  unfinishedSessions: number;
  dashboardUrl: string;
  cleanupPolicy?: string;
  details?: string[];
}

export type FeedbackRating = 'positive' | 'negative';
export type FeedbackState = FeedbackRating | 'negative_pending';

export interface FeedbackOwnerCardOpts {
  rating: FeedbackRating;
  sessionTitle: string;
  sessionId: string;
  chatName?: string;
  chatId?: string;
  operatorName?: string;
  operatorId: string;
  terminalUrl: string;
  traceExcerpt?: string;
  reason?: string;
  note?: string;
  supplemental?: boolean;
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
    ? '分析已完成'
    : stopped
    ? '分析已停止'
    : '停止分析';
  const interruptValue = { action: 'interrupt_thinking', sessionId: opts.interruptSessionId };
  const elements: unknown[] = [
    {
      tag: 'markdown',
      content: stopped
        ? "<font color='grey'>本轮分析已停止，会话仍可继续使用。</font>"
        : opts.status === 'working'
        ? "<font color='grey'>正在全力分析中，可打开只读终端查看实时过程。</font>"
        : "<font color='grey'>分析过程可在只读终端中查看。</font>",
    },
    {
      tag: 'action',
      actions: opts.status === 'completed'
        ? completedThinkingActions(opts)
        : [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '打开分析过程' },
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
  if (opts.status === 'completed' && opts.feedback) {
    if (opts.feedback === 'negative_pending') {
      elements.push(...buildNegativeFeedbackForm(opts));
    } else {
      elements.push({
        tag: 'markdown',
        text_size: 'notation_small_v2',
        content: opts.feedback === 'positive'
          ? "<font color='green'>👍 感谢认可，我会继续保持这种排查质量。</font>"
          : `<font color='orange'>👎 已收到反馈${opts.feedbackReason ? `：${escapeMarkdownText(opts.feedbackReason)}` : ''}，Owner 已收到通知。</font>`,
      });
    }
  }
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
          content: `${opts.status === 'completed' ? '✅ 分析完成' : opts.status === 'stopped' ? '⏹️ 已停止分析' : opts.status === 'failed' ? '⚠️ 分析失败' : '🔎 正在全力分析中'}`,
        },
      },
      elements,
    },
  };
}

function completedThinkingActions(opts: ThinkingCardOpts): unknown[] {
  const openButton = {
    tag: 'button',
    text: { tag: 'plain_text', content: '打开分析过程' },
    type: 'default',
    multi_url: {
      url: opts.url,
      pc_url: opts.url,
      android_url: opts.url,
      ios_url: opts.url,
    },
  };
  if (opts.feedback) return [openButton];
  const positive = { action: 'rate_thinking', sessionId: opts.interruptSessionId, rating: 'positive', footer: opts.footer };
  const negative = { action: 'rate_thinking', sessionId: opts.interruptSessionId, rating: 'negative', footer: opts.footer };
  return [
    openButton,
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '👍 有帮助' },
      type: 'primary',
      value: positive,
      behaviors: [{ type: 'callback', value: positive }],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '👎 拉完了' },
      type: 'default',
      value: negative,
      behaviors: [{ type: 'callback', value: negative }],
    },
  ];
}

function buildNegativeFeedbackForm(opts: ThinkingCardOpts): unknown[] {
  const submit = { action: 'submit_negative_feedback', sessionId: opts.interruptSessionId, feedbackId: opts.feedbackId, rating: 'negative', footer: opts.footer };
  return [
    {
      tag: 'markdown',
      text_size: 'notation_small_v2',
      content: "<font color='orange'>👎 已记录差评并通知 Owner。可以继续补充原因，帮助后续复盘。</font>",
    },
    {
      tag: 'select_static',
      name: 'feedback_reason',
      placeholder: { tag: 'plain_text', content: '选择主要原因' },
      options: [
        { text: { tag: 'plain_text', content: '结论不准确' }, value: '结论不准确' },
        { text: { tag: 'plain_text', content: '证据不足' }, value: '证据不足' },
        { text: { tag: 'plain_text', content: '没看知识库/代码' }, value: '没看知识库/代码' },
        { text: { tag: 'plain_text', content: '没有解决问题' }, value: '没有解决问题' },
        { text: { tag: 'plain_text', content: '表达不清楚' }, value: '表达不清楚' },
      ],
    },
    {
      tag: 'input',
      name: 'feedback_note',
      placeholder: { tag: 'plain_text', content: '补充说明，可不填' },
      max_length: 500,
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '提交原因' },
          type: 'primary',
          value: submit,
          behaviors: [{ type: 'callback', value: submit }],
        },
      ],
    },
  ];
}

export function buildFeedbackOwnerCard(opts: FeedbackOwnerCardOpts): ImCard {
  const liked = opts.rating === 'positive';
  const title = liked ? '👍 收到一次好评' : opts.supplemental ? '👎 收到差评原因补充' : '👎 收到一次差评';
  const trace = opts.traceExcerpt?.trim()
    ? escapeMarkdownText(trimTail(opts.traceExcerpt.trim(), 2600))
    : '暂无可读取的分析过程摘录，可打开完整分析过程查看。';
  const content = [
    `**评价：${liked ? '有帮助' : '拉完了'}**`,
    opts.supplemental ? undefined : '已写入控制台反馈中心，可在控制台标记状态或删除。',
    opts.reason ? `原因：${escapeMarkdownText(opts.reason)}` : undefined,
    opts.note ? `补充：${escapeMarkdownText(opts.note)}` : undefined,
    `问题：${escapeMarkdownText(opts.sessionTitle || opts.sessionId)}`,
    `群聊：${escapeMarkdownText(opts.chatName || opts.chatId || '未知群聊')}`,
    `会话：${escapeMarkdownText(opts.sessionId)}`,
    `点击人：${escapeMarkdownText(opts.operatorName || opts.operatorId)}`,
    '',
    '**分析过程摘录**',
    trace,
  ].filter((line): line is string => line !== undefined).join('\n');
  return {
    payload: {
      config: { wide_screen_mode: true },
      header: {
        template: liked ? 'green' : 'red',
        title: { tag: 'plain_text', content: title },
      },
      elements: [
        { tag: 'markdown', content },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '打开完整分析过程' },
              type: 'primary',
              multi_url: {
                url: opts.terminalUrl,
                pc_url: opts.terminalUrl,
                android_url: opts.terminalUrl,
                ios_url: opts.terminalUrl,
              },
            },
          ],
        },
      ],
    },
  };
}

function trimTail(value: string, max: number): string {
  if (value.length <= max) return value;
  return `...（仅展示尾部 ${max} 字符）\n${value.slice(-max)}`;
}

export function buildMaintenanceCard(opts: MaintenanceCardOpts): ImCard {
  const dashboardUrl = opts.dashboardUrl.trim();
  const content = [
    `**${escapeMarkdownText(opts.status)}**`,
    `版本：${escapeMarkdownText(opts.version)}`,
    `未结束会话：${opts.unfinishedSessions} 个`,
    opts.cleanupPolicy ? `会话清理：${escapeMarkdownText(opts.cleanupPolicy)}` : undefined,
    dashboardUrl ? `Dashboard：[${escapeMarkdownText(dashboardUrl)}](${dashboardUrl})` : undefined,
  ].filter((line): line is string => !!line).join('\n');
  const elements: unknown[] = [{ tag: 'markdown', content }];
  if (dashboardUrl) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '打开 Dashboard' },
          type: 'primary',
          multi_url: {
            url: dashboardUrl,
            pc_url: dashboardUrl,
            android_url: dashboardUrl,
            ios_url: dashboardUrl,
          },
        },
      ],
    });
  }
  const details = opts.details?.map((line) => line.trim()).filter(Boolean) ?? [];
  if (details.length) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      text_size: 'notation_small_v2',
      content: `<font color='grey'>${details.map(escapeMarkdownText).join('\n')}</font>`,
    });
  }
  return {
    payload: {
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: {
          tag: 'plain_text',
          content: opts.title?.trim() || 'larkbot 维护通知',
        },
      },
      elements,
    },
  };
}
