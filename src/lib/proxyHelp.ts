/**
 * 反代上游报错的"人话翻译"：小白看到 11140/11102/429 这类天书第一反应是"坏了"，
 * 第二反应是来问。这里把已知错误码翻成「这是什么 + 现在该怎么办」，直接展示在
 * 请求日志和体检结果里，省掉来回猜的环节。映射只覆盖已实证的码；未知的返回 null，
 * 界面照旧显示原始错误。
 */

export interface ErrorAdvice {
  /** 一句话：这是什么 */
  what: string;
  /** 该怎么办（可操作） */
  todo: string;
  /** 严重级别：info 能自愈 / warn 需要动手 / danger 账号级问题 */
  level: 'info' | 'warn' | 'danger';
}

const RULES: Array<{ re: RegExp; advice: ErrorAdvice }> = [
  {
    re: /今日上游请求已达上限|DailyCapError/i,
    advice: {
      what: '本工具的每日保护上限触发了（单账号每日请求过多）',
      todo: '这是保护不是故障：该账号今日暂停出站，明日自动恢复。若非你主动为之，说明某个 agent 在失控重试，请检查其配置',
      level: 'warn',
    },
  },
  {
    re: /11140|unusual activity|has been restricted/i,
    advice: {
      what: '账号已被官方限制（风控判定异常活动）',
      todo: '停止对该账号的一切自动化（签到/代理/切号），把它移出代理池；账号需走官方渠道申诉，代码无法解除',
      level: 'danger',
    },
  },
  {
    re: /11128|Illegal API invocation/i,
    advice: {
      what: '系统提示词命中官方风控（判定非官方客户端）',
      todo: '服务端已自动净化常见指纹并留样；若仍复现，把触发场景反馈给开发者（样例已存 proxy-11128-samples.jsonl）',
      level: 'warn',
    },
  },
  {
    re: /11102|模型不可用|model.*not.*available/i,
    advice: {
      what: '请求的模型上游不提供（多见于客户端默认模型名）',
      todo: '服务端已自动回落到可用模型；若仍出现，说明清单里没有可用模型，点「刷新模型列表」',
      level: 'info',
    },
  },
  {
    re: /14003|Model busy/i,
    advice: {
      what: '上游模型忙（临时性）',
      todo: '服务端会按 retry_after 自动重试并给该账号记 10 分钟冷却；频繁出现就换个时段',
      level: 'info',
    },
  },
  {
    re: /(^|[^0-9])429([^0-9]|$)|积分不足|余额不足|额度(不足|用尽)/i,
    advice: {
      what: '该账号积分/额度已用尽或触发限频',
      todo: '自动换号已处理；若所有账号都如此，等积分刷新或减少用量',
      level: 'warn',
    },
  },
  {
    re: /401|invalid_grant|refresh[_ ]?token.*invalid|凭据失效/i,
    advice: {
      what: '凭据失效（token 过期或被轮换作废）',
      todo: '先点该账号的「刷新凭据」；提示 refresh_token 已失效则需要重新扫码登录',
      level: 'warn',
    },
  },
  {
    re: /11101|Non-stream/i,
    advice: {
      what: '该接口只接受流式请求',
      todo: '服务端出站恒为流式，见到此错说明请求绕过了本代理，请检查客户端 Base URL 指向',
      level: 'info',
    },
  },
];

/** 从任意错误文本里抽出人话解释；匹配不到返回 null */
export function explainUpstreamError(text: unknown): ErrorAdvice | null {
  const s = String(text ?? '');
  if (!s) return null;
  for (const r of RULES) if (r.re.test(s)) return r.advice;
  return null;
}
