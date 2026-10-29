/**
 * 「成长中心」回归测试（离线，不联网、不碰真实账号库）。
 *
 * 守几条容易写错、写错了就会**每天静默丢奖励或误消耗补登卡**的判据：
 *
 * 1. **补登候选**：只认当月、今天之前、score==0、不在已补登历史里的日期；
 *    用 heatmap.today 的服务端日期（本机时区会把月初/午夜算错）；结构异常必须抛错，
 *    不能靠猜测消耗补登卡。
 * 2. **连登兑换**：tier 只认档位标识（"7d"），unknown tier 才退回天数重试；
 *    403「天数不足」是常态而不是失败，更不能中止整轮；claimed/locked/字段缺失都跳过。
 * 3. **盲盒**：draw 必须带 client_token；无次数（insufficient chance）是常态不计失败。
 * 4. **任务**：接单 body 是复数 task_codes（单数 task_code 官方一律 400）；
 *    领奖走 /tasks/{code}/claim，只有 completed 才发奖。
 * 5. **中止语义**：401/403（非业务常态）中止本轮并标记 unauthorized；
 *    第一个请求就网络不可达时立刻收手，不把后续接口全撞一遍。
 *
 * 隔离：`WB_SWITCH_HOME` + `FREE_TOKEN_CONFIG_DIR` 在 **import 之前**设好；
 * 官方接口用桩替换 `globalThis.fetch`（proxyFetch 底层就是它）。
 *
 * 运行：node scripts/test-growth.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-growth-'));
process.env.WB_SWITCH_HOME = path.join(tmp, 'wb-switch');
process.env.FREE_TOKEN_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.WB_SWITCH_HOME, { recursive: true });
fs.mkdirSync(process.env.FREE_TOKEN_CONFIG_DIR, { recursive: true });

const { makeupCandidates, runGrowthForAccount, dig, MAKEUP_MAX_PER_RUN } = await import('../server/workbuddy/growth.mjs');
const { chatTaskBacklog, completeChatTasks, FREE_MODELS, MODEL_CANDIDATES, GROWTH_EVENT_CODE, MAX_CHATS_PER_TASK, __resetDailyChatCount } = await import('../server/workbuddy/usageTasks.mjs');

/**
 * 出站必须走 fetch 桩：先清掉代理环境变量，再传 systemProxy:false 跳过 Windows 系统代理探测。
 * 否则 proxyFetch 会选用 undici + ProxyAgent 真发请求，桩形同虚设（本机有代理时必踩）。
 */
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
/** 隔离模式下的成长中心调用（systemProxy:false 是 proxy.mjs 预留的测试开关） */
const run = (acc) => runGrowthForAccount(acc, { systemProxy: false });

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    const detail = extra === undefined ? '' : ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
    failures.push(label + detail);
    console.log(`  ✗ ${label}${detail}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

/** 造一个国内版明文凭据账号（无 expiresAt → hasPlainToken 保守视为有效） */
const account = {
  id: 'acc-growth',
  uid: 'uid-growth',
  name: '测试账号',
  variant: 'cn',
  access_token: 'access-growth',
};

/**
 * fetch 桩：路由表 (METHOD path) → {status, body} 或函数。
 * 记录每一次调用，供断言「带了 client_token」「body 是复数 task_codes」。
 */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = (opts.method || 'GET').toUpperCase();
    const key = `${method} ${u.pathname}`;
    const body = opts.body ? JSON.parse(String(opts.body)) : undefined;
    calls.push({ key, body, headers: opts.headers || {} });
    const hit = routes[key];
    if (!hit) {
      return { status: 404, text: async () => JSON.stringify({ code: 404, msg: `no stub for ${key}` }) };
    }
    const r = typeof hit === 'function' ? hit({ body, headers: opts.headers || {} }) : hit;
    return { status: r.status ?? 200, text: async () => JSON.stringify(r.body ?? null) };
  };
  return calls;
}

/** 常用「全部无可领」桩：旅行在路上、任务空、没卡、兑换全 locked、没抽奖、没能量 */
function quietRoutes() {
  return {
    'GET /v2/activity/growth/buddy/travel/status': { body: { state: 'traveling', location: { name: '上海' }, arrive_at: 2000, server_now: 1000 } },
    'GET /v2/activity/growth/tasks': { body: { tasks: [] } },
    'GET /v2/activity/growth/streak': { body: { streak: { days: 3, makeup_dates: [] }, makeup_cards: { balance: 0 }, launch_date: '2026-06-17' } },
    'GET /v2/activity/growth/redeem/summary': { body: { starter_status: 'locked', advanced_status: 'locked', legendary_status: 'locked' } },
    'GET /v2/activity/growth/lottery/chances': { body: { balance: 0 } },
    'GET /v2/activity/growth/buddy/quota': { body: { affordable: 0 } },
    'GET /v2/activity/growth/energy': { body: { balance: 7 } },
  };
}

// ---------------------------------------------------------------- 1. 补登候选纯函数
section('1. makeupCandidates：只选当月、今天之前、score==0、未补登过的断登日');
{
  const streak = {
    streak: { days: 1, makeup_dates: ['2026-10-03'] },
    makeup_cards: { balance: 2 },
    launch_date: '2026-06-17',
  };
  const heatmap = {
    today: { date: '2026-10-13' },
    cells: [
      { date: '2026-10-12', score: 5 }, // 活跃，不选
      { date: '2026-10-11', score: 0 }, // 断登 ✓（最近优先 → 排第一）
      { date: '2026-10-03', score: 0 }, // 已补登过，不选
      { date: '2026-10-01', score: 0 }, // 断登 ✓
      { date: '2026-09-30', score: 0 }, // 上月，不选（官方口径：仅当月）
      { date: '2026-10-13', score: 0 }, // 今天还没过完，不选
    ],
  };
  const got = makeupCandidates(streak, heatmap);
  check('选中且仅选中当月断登日', JSON.stringify(got) === JSON.stringify(['2026-10-11', '2026-10-01']), got);
  check('最近的断点排最前（尽早恢复当前连登）', got[0] === '2026-10-11');

  // launch_date 晚于月初时，从上线日起算
  const got2 = makeupCandidates(
    { streak: { makeup_dates: [] }, launch_date: '2026-10-05' },
    { today: { date: '2026-10-13' }, cells: [{ date: '2026-10-04', score: 0 }, { date: '2026-10-06', score: 0 }] }
  );
  check('活动上线日之前的断登不选', JSON.stringify(got2) === JSON.stringify(['2026-10-06']), got2);

  // launch_date 缺失 → 用内置下限 2026-06-17，不抛错
  const got3 = makeupCandidates(
    { streak: { makeup_dates: [] } },
    { today: { date: '2026-10-13' }, cells: [{ date: '2026-10-02', score: 0 }] }
  );
  check('launch_date 缺失时用内置下限', JSON.stringify(got3) === JSON.stringify(['2026-10-02']), got3);

  // 结构异常必须抛错——不能靠猜测消耗补登卡
  const bad = [
    ['缺 today', { streak: { makeup_dates: [] } }, { cells: [] }],
    ['cells 非数组', { streak: { makeup_dates: [] } }, { today: { date: '2026-10-13' }, cells: {} }],
    ['score 非法', { streak: { makeup_dates: [] } }, { today: { date: '2026-10-13' }, cells: [{ date: '2026-10-01', score: '0' }] }],
    ['日期格式错', { streak: { makeup_dates: [] } }, { today: { date: '2026/10/13' }, cells: [] }],
    ['streak 缺失', {}, { today: { date: '2026-10-13' }, cells: [] }],
    ['makeup_dates 非数组', { streak: { makeup_dates: '2026-10-03' } }, { today: { date: '2026-10-13' }, cells: [] }],
  ];
  for (const [label, s, h] of bad) {
    let threw = false;
    try {
      makeupCandidates(s, h);
    } catch {
      threw = true;
    }
    check(`结构异常抛错：${label}`, threw);
  }

  // 信封结构（data 包裹）也能挖到字段
  const got4 = makeupCandidates(
    { data: { streak: { makeup_dates: [] }, launch_date: '2026-06-17' } },
    { data: { today: { date: '2026-10-13' }, cells: [{ date: '2026-10-02', score: 0 }] } }
  );
  check('信封（data 包裹）结构可解析', JSON.stringify(got4) === JSON.stringify(['2026-10-02']), got4);
}

// ---------------------------------------------------------------- 2. dig 信封
section('2. dig：在 data/result 信封里挖字段');
{
  check('直取', dig({ a: 1 }, 'a') === 1);
  check('data 包裹', dig({ data: { a: 2 } }, 'a') === 2);
  check('嵌套 result', dig({ result: { data: { a: 3 } } }, 'a') === 3);
  check('缺失返回 null', dig({ b: 1 }, 'a') === null);
  check('null 值视为缺失继续往里挖', dig({ a: null, data: { a: 4 } }, 'a') === 4);
}

// ---------------------------------------------------------------- 3. 全流程：每个模块都领到
section('3. runGrowthForAccount：六模块全领一轮');
{
  const calls = stubFetch({
    'GET /v2/activity/growth/buddy/travel/status': { body: { state: 'arrived', record_id: 'rec-1' } },
    'POST /v2/activity/growth/buddy/travel/claim': { body: { reward_credit: 50 } },
    'GET /v2/activity/growth/buddy/travel/config': { body: { locations: [{ id: 'loc-1', name: '成都' }] } },
    'POST /v2/activity/growth/buddy/travel/depart': { body: { location: { name: '成都' }, duration_hours: 8 } },
    'GET /v2/activity/growth/tasks': {
      body: {
        tasks: [
          { task_code: 't1', title: '每日登录', accept_status: 'not_accepted', locked: false },
          { task_code: 't2', title: '完成对话', accept_status: 'completed', locked: false, reward_credit: 20, reward_energy: 2 },
          { task_code: 't3', title: '已领奖', accept_status: 'claimed', locked: false },
          { task_code: 't4', title: '锁定任务', accept_status: 'completed', locked: true },
        ],
      },
    },
    'POST /v2/activity/growth/tasks/accept': { body: { results: [{ task_code: 't1', status: 'ok' }] } },
    'POST /v2/activity/growth/tasks/t2/claim': { body: { credit: 20, energy: 2 } },
    'GET /v2/activity/growth/streak': {
      body: { streak: { days: 9, makeup_dates: [] }, makeup_cards: { balance: 2 }, launch_date: '2026-06-17' },
    },
    'GET /v2/activity/growth/heatmap': {
      body: { today: { date: '2026-10-13' }, cells: [{ date: '2026-10-11', score: 0 }, { date: '2026-10-09', score: 0 }] },
    },
    'POST /v2/activity/growth/makeup-cards/use': { body: { code: 0, makeup_cards: { balance: 1 } } },
    'GET /v2/activity/growth/redeem/summary': {
      body: { starter_status: 'available', advanced_status: 'locked', legendary_status: 'claimed' },
    },
    'POST /v2/activity/growth/redeem': { body: { credit_granted: 0, energy_granted: 2, cards_granted: 1, chances_granted: 1 } },
    'GET /v2/activity/growth/lottery/chances': { body: { balance: 1 } },
    'POST /v2/activity/growth/lottery/draw': { body: { prize_name: '冰箱贴', need_address: true } },
    'GET /v2/activity/growth/buddy/quota': { body: { affordable: 2, max_open_count: 1 } },
    'POST /v2/activity/growth/buddy/open': { body: { buddy: 'Buddy·橙' } },
    'GET /v2/activity/growth/energy': { body: { balance: 9 } },
  });

  const r = await run(account);
  const joined = (r.parts || []).join('\n');
  check('整轮成功', r.ok === true, r.report);
  check('领旅行礼物进账计入汇总', r.creditsGained === 70, `creditsGained=${r.creditsGained}`);
  check('旅行 claim 带 record_id', calls.some((c) => c.key === 'POST /v2/activity/growth/buddy/travel/claim' && c.body?.record_id === 'rec-1'));
  check('领完礼物后派 Buddy 去首个目的地', calls.some((c) => c.key === 'POST /v2/activity/growth/buddy/travel/depart' && c.body?.location_id === 'loc-1'));
  check('接单 body 是复数 task_codes（单数会被官方 400）',
    calls.some((c) => c.key === 'POST /v2/activity/growth/tasks/accept' && Array.isArray(c.body?.task_codes) && c.body.task_codes.includes('t1')));
  check('completed 任务走 /tasks/{code}/claim', calls.some((c) => c.key === 'POST /v2/activity/growth/tasks/t2/claim'));
  check('claimed/locked 任务不领奖', !calls.some((c) => /tasks\/t[34]\/claim/.test(c.key)));
  check('补登带 target_date，每轮最多 1 张',
    calls.filter((c) => c.key === 'POST /v2/activity/growth/makeup-cards/use').length === MAKEUP_MAX_PER_RUN &&
    calls.some((c) => c.key === 'POST /v2/activity/growth/makeup-cards/use' && c.body?.target_date === '2026-10-11'));
  check('兑换 tier 传档位标识 "7d"（不是天数也不是档位名）',
    calls.some((c) => c.key === 'POST /v2/activity/growth/redeem' && c.body?.tier === '7d'));
  check('兑换带 client_token', calls.some((c) => c.key === 'POST /v2/activity/growth/redeem' && /^u-/.test(String(c.body?.client_token || ''))));
  check('locked/claimed 档不兑换', calls.filter((c) => c.key === 'POST /v2/activity/growth/redeem').length === 1);
  check('盲盒 draw 带 client_token', calls.some((c) => c.key === 'POST /v2/activity/growth/lottery/draw' && /^u-/.test(String(c.body?.client_token || ''))));
  check('实物奖提醒填收件信息', joined.includes('需到成长中心填写收件信息'), joined);
  check('Buddy open 数量受 max_open_count 限制', calls.some((c) => c.key === 'POST /v2/activity/growth/buddy/open' && c.body?.count === 1));
  check('报告含能量与连签天数', r.report.includes('能量 9') && r.report.includes('连签 9 天'), r.report);
  check('无硬失败', r.hardFailures === 0);
}

// ---------------------------------------------------------------- 4. 连登兑换的边角
section('4. 连登兑换：unknown tier 退回天数、403 天数不足是中止常态');
{
  // unknown tier → 退回天数再试一次
  let redeemBodies = [];
  stubFetch({
    ...quietRoutes(),
    'GET /v2/activity/growth/redeem/summary': { body: { starter_status: 'available', advanced_status: 'locked', legendary_status: 'locked' } },
    'POST /v2/activity/growth/redeem': ({ body }) => {
      redeemBodies.push(body);
      if (body.tier === '7d') return { status: 400, body: { code: 400, msg: 'unknown tier' } };
      return { body: { credit_granted: 50, energy_granted: 3 } };
    },
  });
  const r1 = await run(account);
  check('unknown tier 时退回天数重试', redeemBodies.length === 2 && redeemBodies[1].tier === 7, redeemBodies);
  check('重试成功后计入进账', r1.creditsGained === 50, r1.report);

  // 403 天数不足 → 常态继续，不算失败
  stubFetch({
    ...quietRoutes(),
    'GET /v2/activity/growth/redeem/summary': { body: { starter_status: 'available', advanced_status: 'locked', legendary_status: 'locked' } },
    'POST /v2/activity/growth/redeem': { status: 403, body: { code: 403, msg: '连续登录天数不足' } },
  });
  const r2 = await run(account);
  check('403 天数不足不当中止', r2.ok === true && !r2.unauthorized, r2.report);
  check('403 天数不足不计失败', r2.failures === 0 && r2.report.includes('未解锁'), r2.report);

  // 状态字段缺失 → 跳过（接口改版时不无脑 POST）
  const calls3 = stubFetch({
    ...quietRoutes(),
    'GET /v2/activity/growth/redeem/summary': { body: {} },
  });
  const r3 = await run(account);
  check('summary 字段缺失时不发起兑换', !calls3.some((c) => c.key === 'POST /v2/activity/growth/redeem'));
  check('字段缺失不算失败', r3.failures === 0, r3.report);
}

// ---------------------------------------------------------------- 5. 盲盒无次数是常态
section('5. 盲盒：无抽奖机会（400 insufficient chance）不计失败');
{
  stubFetch({
    ...quietRoutes(),
    'GET /v2/activity/growth/lottery/chances': { body: { balance: 1 } },
    'POST /v2/activity/growth/lottery/draw': { status: 400, body: { code: 400, msg: 'insufficient lottery chance balance' } },
  });
  const r = await run(account);
  check('无次数不算失败', r.failures === 0 && r.ok === true, r.report);
  check('报告如实说明', r.report.includes('开盲盒'), r.report);
}

// ---------------------------------------------------------------- 6. 中止语义
section('6. 中止：401/403 中止本轮；网络不可达立刻收手');
{
  // 旅行查询 401 → 整轮中止，后续接口一个都不打
  const calls1 = stubFetch({
    'GET /v2/activity/growth/buddy/travel/status': { status: 401, body: { code: 401, msg: 'unauthorized' } },
  });
  const r1 = await run(account);
  check('401 → 中止并标记 unauthorized', r1.ok === false && r1.unauthorized === true, r1.report);
  check('401 后不再打其它接口', calls1.length === 1, calls1.map((c) => c.key));

  // 第一个请求网络不可达 → 立刻收手
  globalThis.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  const r2 = await run(account);
  check('网络不可达立刻收手', r2.ok === false && r2.hardFailures === 1 && r2.report.includes('网络不可达'), r2.report);

  // 国际版 → unsupported，不发任何请求
  let aiCalls = 0;
  globalThis.fetch = async () => {
    aiCalls++;
    return { status: 200, text: async () => 'null' };
  };
  const r3 = await run({ ...account, variant: 'ai' });
  check('国际版标记 unsupported 且零请求', r3.unsupported === true && aiCalls === 0, r3.report);
}

// ---------------------------------------------------------------- 7. 旅行分支
section('7. 旅行：名额用完不派出、旅行中报 ETA、查询 5xx 计硬失败');
{
  // idle + daily_limit_reached → 不碰 config/depart
  const calls1 = stubFetch({
    ...quietRoutes(),
    'GET /v2/activity/growth/buddy/travel/status': { body: { state: 'idle', daily_limit_reached: true } },
  });
  const r1 = await run(account);
  check('名额用完不再派出', !calls1.some((c) => c.key.includes('depart') || c.key.includes('config')), calls1.map((c) => c.key));
  check('名额用完如实汇报', r1.report.includes('今日旅行名额已用完'), r1.report);

  // traveling → 报 ETA，不领不派
  stubFetch(quietRoutes()); // quietRoutes 里就是 traveling：arrive_at 2000 - server_now 1000 = 约 17 分钟
  const r2 = await run(account);
  check('旅行中报 ETA', r2.report.includes('旅行中') && r2.report.includes('分钟后回'), r2.report);
  check('纯空跑标记 idle', r2.idle === true, r2.report);

  // 查询 5xx → 硬失败
  stubFetch({
    ...quietRoutes(),
    'GET /v2/activity/growth/buddy/travel/status': { status: 502, body: { msg: 'bad gateway' } },
  });
  const r3 = await run(account);
  check('查询 5xx 计硬失败', r3.hardFailures >= 1 && r3.ok === false, r3.report);
}

// ---------------------------------------------------------------- 8. 对话任务补全
section('8. 对话任务补全：免费模型优先、growthEvent 上报、补完领奖');
{
  // chatTaskBacklog 纯函数口径
  const backlog = chatTaskBacklog([
    { task_code: 'chat_5', title: '和 AI 聊天 5 次', accept_status: 'in_progress', progress: { current: 2, target: 5 } },
    { task_code: 'chat_5', title: '已领', accept_status: 'claimed', progress: { current: 5, target: 5 } },
    { task_code: 'chat_5', title: '没接单', accept_status: 'not_accepted', progress: null },
    { task_code: 'chat_5', title: '已达标', accept_status: 'in_progress', progress: { current: 5, target: 5 } },
    { task_code: 'chat_5', title: '锁定', accept_status: 'in_progress', locked: true, progress: { current: 0, target: 5 } },
    { task_code: 'create_canvas', title: '画布', accept_status: 'in_progress', progress: { current: 0, target: 1 } },
    { task_code: 'chat_20', title: '超额封顶', accept_status: 'in_progress', progress: { current: 0, target: 20 } },
  ]);
  check('只挑未完成的 chat_* 任务', backlog.length === 2 && backlog[0].code === 'chat_5' && backlog[1].code === 'chat_20', backlog);
  check('need = target - current', backlog[0].need === 3, backlog[0]);
  check('单任务上限 MAX_CHATS_PER_TASK', backlog[1].need === MAX_CHATS_PER_TASK, backlog[1]);
  check('非数组输入返回空', chatTaskBacklog(null).length === 0);

  // 免费模型直发 → 进度满 → 补领奖
  const progress = { current: 2, target: 5 };
  let claimedChat5 = false;
  const chats = [];
  stubFetch({
    ...quietRoutes(),
    'GET /v2/activity/growth/tasks': () => ({
      body: {
        tasks: [
          {
            task_code: 'chat_5',
            title: '和 AI 聊天 5 次',
            accept_status: claimedChat5 ? 'claimed' : progress.current >= progress.target ? 'completed' : 'in_progress',
            progress: { ...progress },
            reward_credit: 100,
            reward_energy: 5,
          },
        ],
      },
    }),
    'POST /v2/chat/completions': ({ body }) => {
      chats.push(body);
      progress.current += 1;
      return { status: 200, body: { id: 'chatcmpl-x' } };
    },
    'POST /v2/activity/growth/tasks/chat_5/claim': () => {
      claimedChat5 = true;
      return { body: { credit: 100, energy: 5 } };
    },
  });
  const r1 = await run(account);
  check('缺口 3 次 → 恰好发 3 次对话', chats.length === 3, chats.length);
  check('免费模型 hy3 优先', chats.every((b) => b?.model === FREE_MODELS[0]), chats.map((b) => b?.model));
  check('对话必须流式（非流式官方 400）', chats.every((b) => b?.stream === true), chats.map((b) => b?.stream));
  const events = chats.map((b) => {
    try {
      return JSON.parse(b?.extra_vars?.growthEvent || '[]')[0];
    } catch {
      return null;
    }
  });
  check('对话带 chat_request_send 上报（否则不计进度）',
    events.every((e) => e?.eventCode === GROWTH_EVENT_CODE && e?.id && e?.extra?.requestModelId === FREE_MODELS[0]),
    events[0]);
  check('每次对话 id 唯一', new Set(events.map((e) => e.id)).size === events.length);
  check('补满后复查并领奖', claimedChat5, r1.report);
  check('报告点名免费模型', (r1.parts || []).join('\n').includes(`免费模型 ${FREE_MODELS[0]}`), r1.parts);
  check('补全进账计入积分', r1.creditsGained === 100, r1.creditsGained);
  check('无硬失败', r1.hardFailures === 0, r1.report);
}

// ---------------------------------------------------------------- 9. 免费模型全灭 → 低倍率兜底
section('9. 模型回退：免费模型 5xx/429 换下一个，全灭才用低倍率付费模型');
{
  const usedModels = [];
  stubFetch({
    ...quietRoutes(),
    'GET /v2/activity/growth/tasks': {
      body: { tasks: [{ task_code: 'chat_5', title: '和 AI 聊天 5 次', accept_status: 'in_progress', progress: { current: 4, target: 5 } }] },
    },
    'POST /v2/chat/completions': ({ body }) => {
      usedModels.push(body?.model);
      // 前两个免费模型挂掉，第三个免费模型可用 → 不应碰付费模型
      return usedModels.length <= 2
        ? { status: usedModels.length === 1 ? 500 : 429, body: { msg: 'upstream error' } }
        : { status: 200, body: { id: 'x' } };
    },
  });
  const r = await run(account);
  const joined = (r.parts || []).join('\n');
  check('免费模型 500/429 后换下一个免费模型', usedModels.join(',') === `${FREE_MODELS[0]},${FREE_MODELS[1]},${FREE_MODELS[2]}`, usedModels);
  check('免费模型有可用时不碰付费模型', !usedModels.some((m) => !FREE_MODELS.includes(m)), usedModels);
  check('5xx 计硬失败、429 只换模型不中止', r.hardFailures === 1 && r.unauthorized !== true, r.report);
  check('模型不可用如实汇报', joined.includes(`模型 ${FREE_MODELS[0]} 不可用`) && joined.includes(`模型 ${FREE_MODELS[1]} 不可用`), joined);
  check('补全成功写入报告', joined.includes(`免费模型 ${FREE_MODELS[2]}`), joined);

  // 所有免费模型都挂 → 低倍率付费模型兜底，报告必须点名
  const paid = MODEL_CANDIDATES.find((m) => !FREE_MODELS.includes(m));
  const used2 = [];
  stubFetch({
    ...quietRoutes(),
    'GET /v2/activity/growth/tasks': {
      body: { tasks: [{ task_code: 'chat_5', title: '和 AI 聊天 5 次', accept_status: 'in_progress', progress: { current: 0, target: 2 } }] },
    },
    'POST /v2/chat/completions': ({ body }) => {
      used2.push(body?.model);
      return FREE_MODELS.includes(body?.model)
        ? { status: 503, body: { msg: 'unavailable' } }
        : { status: 200, body: { id: 'x' } };
    },
  });
  const r2 = await run(account);
  check('免费全灭退到低倍率付费模型', used2[used2.length - 1] === paid, used2);
  check('付费模型点名提醒（积分消耗）', (r2.parts || []).join('\n').includes(`付费模型 ${paid}`), r2.parts);
}

// ---------------------------------------------------------------- 10. 对话补全的失控保险
section('10. 失控保险：目标虚高时单任务封顶；模型全灭计失败不抛错');
{
  // 每日合成聊天上限（20 次/账号）是进程内累计的：前面场景已消耗部分配额，清零后再测
  __resetDailyChatCount();
  let n = 0;
  stubFetch({
    ...quietRoutes(),
    'GET /v2/activity/growth/tasks': {
      body: { tasks: [{ task_code: 'chat_99', title: '夸张目标', accept_status: 'in_progress', progress: { current: 0, target: 99 } }] },
    },
    'POST /v2/chat/completions': () => {
      n += 1;
      return { status: 200, body: { id: 'x' } };
    },
  });
  const r = await run(account);
  check('进度永远不满也不超过单任务上限', n === MAX_CHATS_PER_TASK, n);
  check('不把进度未满当失败刷屏', r.failures === 0, r.report);

  // 所有候选模型都不可用 → 计失败、报告说明，绝不抛异常污染整轮
  stubFetch({
    ...quietRoutes(),
    'GET /v2/activity/growth/tasks': {
      body: { tasks: [{ task_code: 'chat_5', title: '和 AI 聊天 5 次', accept_status: 'in_progress', progress: { current: 0, target: 1 } }] },
    },
    'POST /v2/chat/completions': { status: 404, body: { msg: 'not found' } },
  });
  const r2 = await run(account);
  check('全部候选不可用计失败', r2.failures >= 1 && r2.ok === true, r2.report);
  check('报告说明还差几次', (r2.parts || []).join('\n').includes('还差 1 次'), r2.parts);
  check('4xx 不算硬失败', r2.hardFailures === 0, r2.report);
}

// ---------------------------------------------------------------- 汇总
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
