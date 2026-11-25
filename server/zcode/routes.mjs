/**
 * ZCode管理 全部路由注册（对齐 WorkBuddy管理 的四个子功能）：
 * - GET  /api/zcode/state         账号库 + 当前登录态 + ZCode 进程状态
 * - POST /api/zcode/switch        切换账号（内部先停 ZCode 进程）
 * - POST /api/zcode/import        导入当前登录态为账号
 * - POST /api/zcode/accounts/delete | /api/zcode/accounts/rename
 * - GET  /api/zcode/stats         token 统计（range/model 参数对齐 /api/stats）
 * - GET  /api/zcode/balance | /api/zcode/balance/cache  免费套餐额度与落盘缓存
 * - POST /api/zcode/launch       启动 ZCode 客户端（已在运行就不重复拉起）
 * - POST /api/zcode/proxy/reveal-key  显示反代 Key 明文（仅本机页面用）
 * - GET/PUT /api/zcode/proxy/*    反代状态与配置
 * - GET  /api/zcode/settings      ZCode 设置汇总
 * - GET  /api/zcode/upstream-test 用当前登录态发一次上游真实请求（打通验证）
 *
 * 路由只做参数校验与编排，业务在 ./accounts.mjs / ./stats.mjs / ./proxyCore.mjs。
 */
import { loadAccounts, importCurrentAccount, detectCurrentAccount, switchToAccount, deleteAccount, updateAccountLabel, publicAccount, ACCOUNTS_FILE } from './accounts.mjs';
import { getZcodeStats } from './stats.mjs';
import { readZcodeSettings, writeZcodeClientSetting } from './settings.mjs';
import { registerZcodeProxyRoutes } from './proxyCore.mjs';
import { detectZcodeProcess, stopZcode, findZcodeExe } from './targets.mjs';
import { anthropicMessages, listUpstreamModels, zcodeClientVersion, startZcodeCredentialWatcher, getCredentialState } from './upstream.mjs';
import { notifyZcodeCredentialChange } from './proxyCore.mjs';
import { readCredentialsDecrypted } from './credentialStore.mjs';
import { loadConfig } from '../store/config.mjs';
import { spawn } from 'node:child_process';
import { getZcodeBalance, readBalanceCache } from './balanceCache.mjs';

/** 切换冷却：3 分钟一次（对齐 WorkBuddy 账号切换的风控冷却） */
let lastSwitchAt = 0;
const SWITCH_COOLDOWN_MS = 180_000;

export function registerZcodeRoutes(app, { port, wrap }) {
  // 凭据文件变化（扫码登录 / 客户端换号）时：通知反代刷新，并把当前登录态幂等写入账号库。
  // 之前监视器只做通知，导致「扫码登录成功后账号库仍然为空」，必须手动点导入。
  const onZcodeCredentialChange = (state) => {
    try { notifyZcodeCredentialChange(state); } catch { /* 通知失败不影响入库 */ }
    void importCurrentAccount('').catch(() => { /* 登录态暂不可解时等下次变化再试 */ });
  };
  startZcodeCredentialWatcher(onZcodeCredentialChange);

  // 总状态：账号库 + 当前登录态 + 进程 + 上游版本
  app.get('/api/zcode/state', wrap(async (req, res) => {
    const [proc, current] = await Promise.all([detectZcodeProcess(), detectCurrentAccount()]);
    let credentialOk = false;
    try {
      await readCredentialsDecrypted();
      credentialOk = true;
    } catch {
      credentialOk = false;
    }
    res.json({
      accounts: loadAccounts().map(publicAccount),
      current,
      process: proc,
      credentialOk,
      exe: findZcodeExe(),
      clientVersion: zcodeClientVersion(),
      accountsFile: ACCOUNTS_FILE,
      switchCooldown: { ms: SWITCH_COOLDOWN_MS, lastAt: lastSwitchAt || null },
    });
  }));

  // 扫码/浏览器登录：返回 ZCode 官方登录页 URL 并打开系统默认浏览器。
  // 登录完成后 ZCode 客户端会写入 ~/.zcode/v2/credentials.json，凭据监视器自动发现并刷新账号库。
  app.post('/api/zcode/login-url', wrap(async (req, res) => {
    const { execFile } = await import('node:child_process');
    const url = 'https://zcode.z.ai/login';
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else if (process.platform === 'darwin') execFile('open', [url], () => {});
    else execFile('xdg-open', [url], () => {});
    res.json({ ok: true, url, note: '已在浏览器打开 ZCode 官方登录页；登录完成后 ZCode 客户端会自动记录登录态，控制台检测到后自动加入账号库' });
  }));

  // 结束全部 ZCode 进程（对齐 WB「退出 WorkBuddy」按钮）
  app.post('/api/zcode/stop', wrap(async (req, res) => {
    const r = await stopZcode();
    res.json(r);
  }));

  // 导入当前登录态
  app.post('/api/zcode/import', wrap(async (req, res) => {
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    const out = await importCurrentAccount(label);
    res.json({ ok: true, ...out });
  }));

  // 切换账号
  app.post('/api/zcode/switch', wrap(async (req, res) => {
    const id = String(req.body?.id || '');
    if (!id) return res.status(400).json({ error: '缺少账号 id' });

    if (!req.body?.force && lastSwitchAt && Date.now() - lastSwitchAt < SWITCH_COOLDOWN_MS) {
      const waitSec = Math.ceil((SWITCH_COOLDOWN_MS - (Date.now() - lastSwitchAt)) / 1000);
      throw Object.assign(
        new Error('距上次切换账号还不足 3 分钟（还需等 ' + waitSec + ' 秒）。高频切号是风控高危行为，请稍后再试'),
        { status: 429 }
      );
    }

    // R010-1：切换前无条件检测并停止 ZCode（运行中会把内存登录态写回磁盘覆盖新快照），
    // 不再依赖客户端 stopApp 参数；停止失败或进程未退出则拒绝切换。
    let stopped = null;
    {
      const before = await detectZcodeProcess();
      if (before.running) {
        stopped = await stopZcode();
        if (!stopped.ok) {
          throw Object.assign(
            new Error('无法结束 ZCode 进程（' + String(stopped.error || '未知原因') + '）。请手动退出 ZCode 后重试切换'),
            { status: 500 }
          );
        }
        const after = await detectZcodeProcess();
        if (after.running) {
          throw Object.assign(new Error('ZCode 进程未完全退出（余 ' + after.pids.length + ' 个）。请手动退出后重试'), { status: 500 });
        }
      }
    }
    try {
      const result = await switchToAccount(id);
      lastSwitchAt = Date.now(); // R012-2：冷却在切换成功后写入
      res.json({ ok: true, stopped, result, note: '已写入 ZCode 登录态；重新打开 ZCode 客户端即为切换后的账号' });
    } catch (e) {
      throw Object.assign(new Error('切换失败：' + String((e && e.message) || e)), { status: 500 });
    }
  }));

  // 删除/重命名账号
  app.post('/api/zcode/accounts/delete', wrap(async (req, res) => {
    const id = String(req.body?.id || '');
    if (!id) return res.status(400).json({ error: '缺少账号 id' });
    res.json(await deleteAccount(id));
  }));

  app.post('/api/zcode/accounts/rename', wrap(async (req, res) => {
    const id = String(req.body?.id || '');
    if (!id) return res.status(400).json({ error: '缺少账号 id' });
    const label = String(req.body?.label || '');
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return res.status(400).json({ error: '缺少新名称' });
    res.json({ ok: true, account: await updateAccountLabel(id, trimmedLabel) });
  }));

  // token 统计
  app.get('/api/zcode/stats', wrap(async (req, res) => {
    const range = ['today', '7d', '30d', 'all'].includes(String(req.query.range)) ? String(req.query.range) : '30d';
    res.json(await getZcodeStats({ range, model: String(req.query.model || '') }));
  }));

  // ZCode 免费套餐额度：refresh=1 强制走官方接口，否则 30 秒内复用上次结果
  app.get('/api/zcode/balance', wrap(async (req, res) => {
    res.json(await getZcodeBalance({ force: req.query.refresh === '1' }));
  }));

  // 上次读到的额度缓存（key 是 userId，供账号卡片回显）
  app.get('/api/zcode/balance/cache', wrap(async (req, res) => {
    res.json({ cache: readBalanceCache() });
  }));

  // 启动 ZCode 客户端（已在运行就不重复拉起）
  // 注意：spawn 成功返回 ≠ 客户端真的起来了（GUI 程序可能因会话/权限直接退出）。
  // 这里实际轮询进程，失败时用 Explorer 走系统 Shell 再兜底一次，并把真实结果返回给前端。
  app.post('/api/zcode/launch', wrap(async (req, res) => {
    const exe = findZcodeExe();
    if (!exe) {
      return res.status(404).json({ error: '没找到 ZCode 安装位置：请先安装 ZCode，或设置环境变量 ZCODE_INSTALL_DIR 指向安装目录' });
    }
    const proc = await detectZcodeProcess();
    if (proc.running) return res.json({ ok: true, already: true, pids: proc.pids });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitRunning = async (rounds) => {
      for (let i = 0; i < rounds; i++) {
        await sleep(500);
        const p = await detectZcodeProcess();
        if (p.running) return p;
      }
      return null;
    };

    let spawnError = null;
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (e) => { spawnError = String(e?.message || e); });
      child.unref();
    } catch (e) {
      spawnError = String(e?.message || e);
    }
    let running = await waitRunning(6); // 最多 3 秒
    if (!running && process.platform === 'win32') {
      // GUI 程序从服务进程直接拉起可能立刻退出；交给 Explorer 用系统 Shell 打开一次。
      try {
        spawn('explorer.exe', [exe], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch { /* 兜底失败时仍返回下面的明确错误 */ }
      running = await waitRunning(6);
    }
    if (!running) {
      throw Object.assign(new Error(
        'ZCode 进程没有起来（' + (spawnError || '启动后立即退出') + '）。请手动双击 ' + exe + ' 启动后再试'
      ), { status: 500 });
    }
    res.json({ ok: true, exe, pids: running.pids });
  }));

  // 显示反代 Key 明文（仅给本机页面用；服务只监听 127.0.0.1，且已有 Host 头本机校验）
  app.post('/api/zcode/proxy/reveal-key', wrap(async (req, res) => {
    const apiKey = loadConfig().zcodeProxy?.apiKey;
    if (!apiKey) return res.status(404).json({ error: '还没生成 Key：先开启反向代理' });
    res.json({ apiKey });
  }));

  // ZCode 设置
  app.put('/api/zcode/client-setting', wrap(async (req, res) => {
    const key = String(req.body?.key || '');
    const value = !!req.body?.value;
    res.json(await writeZcodeClientSetting(key, value));
  }));

  app.get('/api/zcode/settings', wrap(async (req, res) => {
    // watcher 在路由注册时已启动（含自动入库），这里再调一次仅作幂等兜底
    startZcodeCredentialWatcher(onZcodeCredentialChange);
    const base = readZcodeSettings();
    const proc = await detectZcodeProcess();
    const cv = zcodeClientVersion();
    res.json({ ...base, process: proc, clientVersion: cv, credentialState: getCredentialState() });
  }));

  // 上游连通性真实验证（用登录态发一条最小请求；对齐 WorkBuddy 反代的「上游连通」体检）
  app.get('/api/zcode/upstream-test', wrap(async (req, res) => {
    const out = await anthropicMessages({
      model: 'GLM-5.3-Flash',
      max_tokens: 16,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    }, { timeoutMs: 60_000 });
    // access_token 过期（exp 短）时上游 401；桌面端会自动刷新，提示用户打开 ZCode 即可
    let hint = null;
    if (!out.ok && out.status === 401) hint = 'ZCode 登录凭据需要刷新：打开 ZCode 客户端让它跑一次（任意对话即可），再回来重试';
    res.json({
      ok: out.ok,
      status: out.status,
      error: out.error,
      hint,
      usage: out.data?.usage || null,
      reply: out.ok ? String(out.data?.content?.[0]?.text || '').slice(0, 80) : null,
    });
  }));

  // 模型清单
  app.get('/api/zcode/models', (req, res) => {
    res.json(listUpstreamModels());
  });

  // 反代（/v1z/* 数据面 + 状态/配置接口）
  registerZcodeProxyRoutes(app, { port });
}
