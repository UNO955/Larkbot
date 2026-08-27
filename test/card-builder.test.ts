import { describe, expect, it } from 'vitest';
import { buildDailyReportCard, buildFeedbackOwnerCard, buildTerminalCard, buildThinkingCard } from '../src/im/lark/card-builder.js';

describe('buildTerminalCard', () => {
  it('运行态使用蓝色状态头和原生 Markdown 正文', () => {
    const card: any = buildTerminalCard({
      body: '**正在检查**',
      status: 'working',
    }).payload;
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('正在处理');
    expect(card.elements[0].content).toBe('**正在检查**');
    expect(card.elements[0].content).not.toContain('```');
  });

  it('完成态保留正文并显示回复对象落款', () => {
    const card: any = buildTerminalCard({
      body: '处理完成',
      status: 'completed',
      replySignature: '只读排查助手',
      replyToId: 'ou_123',
    }).payload;
    expect(card.header).toBeUndefined();
    expect(card.elements).toHaveLength(3);
    expect(card.elements[0].content).toBe('处理完成');
    expect(card.elements.at(-1).content).toContain('只读排查助手');
    expect(card.elements.at(-1).content).toContain('发送给:');
    expect(card.elements.at(-1).content).toContain('<at id="ou_123"></at>');
  });

  it('完成态最终回答卡展示知识库参考资料', () => {
    const card: any = buildTerminalCard({
      body: '结论：按钮未下发。',
      status: 'completed',
      knowledge: {
        references: [{ path: '知识库《猜答行业推全改造》', source: 'structured' }],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }).payload;
    expect(card.elements[0].content).toBe('结论：按钮未下发。');
    expect(card.elements[1].content).toContain('本轮参考资料');
    expect(card.elements[1].content).toContain('知识库《猜答行业推全改造》');
  });

  it('完成态识别 logid 后在底栏右侧展示 Argos 跳转', () => {
    const card: any = buildTerminalCard({
      body: '结论：服务端发送成功。\n\n证据：msg_id=7674844825229837873 已反查到 result_logid=021786939060271fdbddc0c00010106000000000000003625b880',
      status: 'completed',
      replySignature: 'larkbot',
      replyToId: 'ou_123',
      argosUrlTemplate: 'https://argos.example/trace?log_id={logid}',
    }).payload;
    const footer = card.elements.at(-1);
    expect(footer.tag).toBe('column_set');
    expect(footer.columns[0].elements[0].content).toContain('larkbot');
    expect(footer.columns[1].elements[0].text.content).toBe('一键跳转 Argos ↗');
    expect(footer.columns[1].elements[0].multi_url.url).toBe('https://argos.example/trace?log_id=021786939060271fdbddc0c00010106000000000000003625b880');
  });

  it('完成态识别显式标注的纯数字 logid 后展示 Argos 跳转', () => {
    const card: any = buildTerminalCard({
      body: '结论：服务端发送成功。\n\n证据：logid=12345678901234567890',
      status: 'completed',
      replySignature: 'larkbot',
      replyToId: 'ou_123',
      argosUrlTemplate: 'https://argos.example/trace?log_id={logid}',
    }).payload;
    expect(card.elements.at(-1).columns[1].elements[0].multi_url.url).toBe('https://argos.example/trace?log_id=12345678901234567890');
  });

  it('完成态识别 logid 和 psm 后生成 Argos streamlog 链接', () => {
    const card: any = buildTerminalCard({
      body: '结论：服务端发送成功。\n\n证据：logid=20260818103108CAFC9A59F03E1975EEA3，PSM=ad.tetris.scs_robot',
      status: 'completed',
      replySignature: 'larkbot',
      replyToId: 'ou_123',
      argosUrlTemplate: 'https://cloud.bytedance.net/argos/streamlog/info_overview/log_id_search?data_source_uid=&logId={logid}&log_search=false&psm={psm}&psmList=&region=China-North&x-bc-region-id=bytedance&x-resource-account=public',
    }).payload;
    expect(card.elements.at(-1).columns[1].elements[0].multi_url.url).toBe('https://cloud.bytedance.net/argos/streamlog/info_overview/log_id_search?data_source_uid=&logId=20260818103108CAFC9A59F03E1975EEA3&log_search=false&psm=ad.tetris.scs_robot&psmList=&region=China-North&x-bc-region-id=bytedance&x-resource-account=public');
  });

  it('完成态优先使用 bytedcli 输出里的 Argos 短链接', () => {
    const card: any = buildTerminalCard({
      body: '结论：服务端发送成功。',
      status: 'completed',
      replySignature: 'larkbot',
      replyToId: 'ou_123',
      argosUrlTemplate: 'https://cloud.bytedance.net/argos/streamlog/info_overview/log_id_search?logId={logid}&psm={psm}',
      argosSource: '{"status":"success","data":{"link":"http://aiops-argos.byted.org/agent_center/s/VMnnBG6P"}}',
    }).payload;
    expect(card.elements.at(-1).columns[1].elements[0].multi_url.url).toBe('http://aiops-argos.byted.org/agent_center/s/VMnnBG6P');
  });

  it('只有 msg_id 没有业务 logid 时不展示 Argos 跳转', () => {
    const card: any = buildTerminalCard({
      body: '结论：收到输入。\n\n证据：msg_id=7674844825229837873',
      status: 'completed',
      replySignature: 'larkbot',
      replyToId: 'ou_123',
      argosUrlTemplate: 'https://argos.example/trace?log_id={logid}',
    }).payload;
    expect(card.elements.at(-1).tag).toBe('markdown');
    expect(card.elements.at(-1).content).toContain('larkbot');
  });

  it('分析完成后停止按钮不可点击且不展示参考资料', () => {
    const card: any = buildThinkingCard({
      url: 'http://console/terminal/lm-1',
      interruptSessionId: 'lm-1',
      status: 'completed',
      knowledge: {
        references: [{ path: 'docs/qa-log-troubleshooting-prompt.md', source: 'trace' }],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      footer: '🪙 累计 Token ↑15K ↓3.5K',
    }).payload;
    expect(card.header.template).toBe('green');
    expect(card.elements[1].actions[0].text.content).toBe('打开分析过程');
    expect(card.elements[1].actions[0].multi_url.url).toBe('http://console/terminal/lm-1');
    expect(card.elements[1].actions[1].text.content).toBe('👍 有帮助');
    expect(card.elements[1].actions[1].value).toEqual({
      action: 'rate_thinking',
      sessionId: 'lm-1',
      rating: 'positive',
      footer: '🪙 累计 Token ↑15K ↓3.5K',
    });
    expect(card.elements[1].actions[1].behaviors).toEqual([
      {
        type: 'callback',
        value: {
          action: 'rate_thinking',
          sessionId: 'lm-1',
          rating: 'positive',
          footer: '🪙 累计 Token ↑15K ↓3.5K',
        },
      },
    ]);
    expect(card.elements[1].actions[2].text.content).toBe('👎 拉完了');
    expect(card.elements[1].actions[2].value).toMatchObject({ action: 'rate_thinking', sessionId: 'lm-1', rating: 'negative' });
    expect(JSON.stringify(card.elements)).not.toContain('本轮参考资料');
    expect(card.elements.at(-1).content).toContain('累计 Token ↑15K ↓3.5K');
  });

  it('好评后的思考卡展示参考资料', () => {
    const card: any = buildThinkingCard({
      url: 'http://console/terminal/lm-1',
      interruptSessionId: 'lm-1',
      status: 'completed',
      feedback: 'positive',
      knowledge: {
        references: [{ path: 'docs/qa-log-troubleshooting-prompt.md', source: 'trace' }],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }).payload;
    expect(JSON.stringify(card.elements)).toContain('本轮参考资料');
    expect(JSON.stringify(card.elements)).toContain('docs/qa-log-troubleshooting-prompt.md');
    expect(JSON.stringify(card.elements)).toContain('感谢认可');
  });

  it('点击差评后隐藏反馈按钮并展示原因快捷按钮', () => {
    const card: any = buildThinkingCard({
      url: 'http://console/terminal/lm-1',
      interruptSessionId: 'lm-1',
      status: 'completed',
      feedback: 'negative_pending',
      knowledge: {
        references: [{ path: 'docs/qa-log-troubleshooting-prompt.md', source: 'trace' }],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      footer: '⏱️ 总耗时：01:02',
    }).payload;
    expect(card.elements[1].actions).toHaveLength(1);
    expect(card.elements[1].actions[0].text.content).toBe('打开分析过程');
    expect(JSON.stringify(card.elements)).toContain('本轮参考资料');
    expect(JSON.stringify(card.elements)).toContain('docs/qa-log-troubleshooting-prompt.md');
    const feedbackNotice = card.elements.find((element: any) => element.content?.includes('已记录差评并通知 Owner'));
    expect(feedbackNotice.content).toContain('已记录差评并通知 Owner');
    const reasonActions = card.elements.filter((element: any) => element.tag === 'action').slice(1);
    expect(reasonActions[0].actions).toHaveLength(3);
    expect(reasonActions[0].actions[0].text.content).toBe('结论不准确');
    expect(reasonActions[0].actions[0].value).toMatchObject({
      action: 'submit_negative_feedback',
      sessionId: 'lm-1',
      rating: 'negative',
      reason: '结论不准确',
    });
    expect(reasonActions[1].actions[1].text.content).toBe('表达不清楚');
    expect(card.elements.at(-1).content).toContain('总耗时');
  });

  it('提交差评原因后隐藏表单并展示确认文案', () => {
    const card: any = buildThinkingCard({
      url: 'http://console/terminal/lm-1',
      interruptSessionId: 'lm-1',
      status: 'completed',
      feedback: 'negative',
      feedbackReason: '证据不足',
      footer: '⏱️ 总耗时：01:02',
    }).payload;
    expect(card.elements[1].actions).toHaveLength(1);
    expect(card.elements[1].actions[0].text.content).toBe('打开分析过程');
    expect(card.elements[2].content).toContain('已收到反馈');
    expect(card.elements[2].content).toContain('证据不足');
    expect(card.elements.at(-1).content).toContain('总耗时');
  });

  it('构造 Owner 反馈通知卡，包含问题、会话、点击人和完整过程入口，不展示过程摘录', () => {
    const card: any = buildFeedbackOwnerCard({
      rating: 'negative',
      sessionTitle: '猜答手机号按钮排查',
      sessionId: 'lm-1',
      chatName: '项目群',
      operatorName: 'QA',
      operatorId: 'ou_qa',
      terminalUrl: 'http://console/terminal/lm-1',
      traceExcerpt: '读取知识库\n检查代码',
      question: '为什么猜答手机号按钮未下发？',
      answer: '结论：猜答手机号按钮未下发。',
      knowledge: {
        references: [{
          path: '41-WORK-PROJECT-PUBLIC/2026-08-10-猜答行业推全改造/one-page.md',
          source: 'trace',
        }],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      reason: '证据不足',
      note: '没有解释为什么',
      supplemental: true,
    }).payload;
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toContain('差评原因补充');
    expect(card.elements[0].content).toContain('猜答手机号按钮排查');
    expect(card.elements[0].content).toContain('项目群');
    expect(card.elements[0].content).toContain('QA');
    expect(card.elements[0].content).toContain('证据不足');
    expect(card.elements[0].content).toContain('没有解释为什么');
    expect(card.elements[0].content).toContain('为什么猜答手机号按钮未下发');
    expect(card.elements[0].content).toContain('41-WORK-PROJECT-PUBLIC');
    expect(card.elements[0].content).not.toContain('分析过程摘录');
    expect(card.elements[0].content).not.toContain('读取知识库');
    expect(card.elements[1].actions[0].multi_url.url).toBe('http://console/terminal/lm-1');
  });

  it('分析中可停止，停止后按钮不可点击', () => {
    const working: any = buildThinkingCard({
      url: 'http://console/terminal/lm-1',
      interruptSessionId: 'lm-1',
      status: 'working',
    }).payload;
    expect(working.elements[1].actions[1].text.content).toBe('停止分析');
    expect(working.elements[1].actions[1].type).toBe('danger');
    expect(working.elements[1].actions[1].disabled).toBe(false);
    expect(working.elements[1].actions[1].value).toEqual({ action: 'interrupt_thinking', sessionId: 'lm-1' });
    expect(working.elements[1].actions[1].behaviors).toEqual([
      { type: 'callback', value: { action: 'interrupt_thinking', sessionId: 'lm-1' } },
    ]);
    expect(working.elements[1].actions[1].multi_url).toBeUndefined();

    const stopped: any = buildThinkingCard({
      url: 'http://console/terminal/lm-1',
      interruptSessionId: 'lm-1',
      status: 'stopped',
    }).payload;
    expect(stopped.header.title.content).toBe('⏹️ 已停止分析');
    expect(stopped.elements[1].actions[1].text.content).toBe('分析已停止');
    expect(stopped.elements[1].actions[1].disabled).toBe(true);
  });
});

describe('buildDailyReportCard', () => {
  it('展示每日统计和改动最多的一轮', () => {
    const card: any = buildDailyReportCard({
      dateLabel: '2026/8/27',
      totalTurns: 5,
      completed: 3,
      failed: 1,
      stopped: 1,
      totalDuration: '2 小时 10 分钟',
      busiestChat: { label: '工程群', count: 4 },
      longestTurn: {
        title: '修复构建',
        chat: '工程群',
        duration: '45 分钟',
        status: '完成',
      },
      mostChangedTurn: {
        title: '重构控制台',
        chat: '工程群',
        changedFileCount: 6,
        files: ['src/a.ts', 'src/b.ts'],
      },
      remark: '今天有刹车也有报错，值得明早扫一眼复盘。',
      dashboardUrl: 'http://console',
    }).payload;

    expect(card.header.title.content).toBe('larkbot 今日战报');
    expect(card.header.template).toBe('orange');
    expect(card.elements[0].content).toContain('处理轮次：5 轮');
    expect(card.elements[0].content).toContain('工程群（4 轮）');
    expect(card.elements[0].content).toContain('重构控制台');
    expect(card.elements[1].content).toContain('src/a.ts');
    expect(card.elements[2].actions[0].multi_url.url).toBe('http://console');
  });
});
