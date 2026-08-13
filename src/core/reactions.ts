/**
 * 表情进度指示的 emoji_type 常量（仅在 bot 配置 disableStreamingCard 时使用）。
 *
 * 只保留两个飞书内置表情：
 *   - Get  ：收到活儿 / 进行中
 *   - DONE ：一轮完成
 *
 * 刻意精简为两态：收到 / 完成，不引入更多中间状态。
 * 拼写大小写需与飞书 emoji_type 枚举完全一致。
 */
export const RECEIVED_REACTION = 'Get';
export const DONE_REACTION = 'DONE';
