import * as lark from '@larksuiteoapi/node-sdk';
import 'dotenv/config';
const appId = process.env.LARK_APP_ID, appSecret = process.env.LARK_APP_SECRET;
if (!appId || !appSecret) { console.error('❌ .env 缺凭证'); process.exit(1); }
const dispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const openId = data?.sender?.sender_id?.open_id ?? '(未取到)';
    const text = (() => { try { return JSON.parse(data?.message?.content ?? '{}').text ?? ''; } catch { return ''; } })();
    console.log('\n==================================================');
    console.log('  ✅ 收到消息！你的 open_id：');
    console.log('  ' + openId);
    console.log('  （内容：' + text.trim() + '）');
    console.log('==================================================\n');
  },
});
const ws = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.info });
ws.start({ eventDispatcher: dispatcher });
console.log('🔌 长连接已启动，去飞书 @ 你的机器人发一句话……');
