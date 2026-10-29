/**
 * Electron 主进程（CJS）：
 * 把现有 Express 服务（server/index.mjs）直接跑在主进程里，无需系统安装 Node，
 * 窗口加载 http://127.0.0.1:<port>。关闭窗口只是缩到托盘，「每日签到」自动巡检继续在
 * 后台运行；从托盘菜单可恢复窗口或真正退出。
 *
 * 为什么用 .cjs 而不是 .mjs：Electron 44 下 ESM 入口拿不到 electron API——
 * 具名导入抛 "does not provide an export named"，动态 import 返回空命名空间，
 * createRequire 又解析到 npm 包本体；CJS 的 require('electron') 始终可靠。
 */
const { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const buildRes = (name) => path.join(__dirname, '..', 'build', name);

// 单实例锁：二次启动唤起已有窗口。
// ⚠️ app.quit() 是异步的——锁失败后若不把生命周期代码隔离开，whenReady 的启动流程
// 仍会继续跑：新进程会抢下一个空闲端口起第二个服务、创建窗口，随后被退出流程打断，
// loadURL 以 ERR_FAILED (-2) 告终并弹出「启动失败」错误框（用户看起来就是"打开报错"）。
// 因此所有初始化必须收在拿到锁的分支里。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {

// 控制台是纯 UI + 本地服务，不需要 GPU：远程桌面 / 虚拟机里 GPU 进程可能不可用，
// 禁用硬件加速避免窗口渲染崩溃（软件渲染对这种界面毫无压力）
app.disableHardwareAcceleration();

// Windows 通知/任务栏分组需要与 appId 一致
if (process.platform === 'win32') {
  app.setAppUserModelId('com.workbuddy.console');
}

// 阻止 Express 服务自动打开系统浏览器（由窗口代替）；并告知后端运行在桌面壳里
process.env.NO_OPEN = '1';
process.env.WB_DESKTOP = '1';

let mainWindow = null;
let tray = null;
let quitting = false;

/** 从 start 开始找到第一个可绑定的端口 */
function getFreePort(start) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(port + 1));
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '127.0.0.1');
    };
    tryPort(start);
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* 未就绪，继续等待 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('本地服务启动超时');
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  // macOS 菜单栏要求模板图（仅 alpha，颜色由系统定）；Windows 用彩色小图
  const iconPath = process.platform === 'darwin' ? buildRes('trayTemplate.png') : buildRes('tray.png');
  // 打包后图标在 asar 内：createFromPath 读 asar 不可靠（会拿到空图），先读 buffer 再建图
  let icon = nativeImage.createEmpty();
  try {
    icon = nativeImage.createFromBuffer(fs.readFileSync(iconPath));
    if (process.platform === 'darwin') icon.setTemplateImage(true);
  } catch {
    /* 图标读不到就在下面直接返回，不建托盘 */
  }
  if (icon.isEmpty()) return; // 图标缺失时不建托盘，窗口关闭将直接退出（见 close 处理）

  tray = new Tray(icon);
  tray.setToolTip('workbuddy控制台');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 workbuddy控制台', click: showWindow },
      { type: 'separator' },
      {
        label: '开机自动启动',
        type: 'checkbox',
        // 开发模式下该项不可靠，打包后才生效
        checked: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
        enabled: app.isPackaged,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', showWindow); // macOS 单击托盘即打开窗口
}

async function createWindow() {
  // 与 server/index.mjs 的默认端口保持一致，避免用户同时跑开发服务时总被挤到 57891 起的空档
  const port = await getFreePort(57911);
  process.env.PORT = String(port);
  await import('../server/index.mjs');
  await waitForServer(`http://127.0.0.1:${port}/api/platforms`);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'workbuddy控制台',
    icon: buildRes('icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f4f4f5',
    // 等首帧渲染完成再显示，避免启动白屏闪烁
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => win.show());

  // 平台官网等外链用系统浏览器打开；mailto: 等协议交给系统默认处理
  // （此前只放行 https?:，mailto: 走 deny 分支被静默吞掉——申诉指引里的
  // 「直接打开邮件编辑」点了没反应，2026-10-30 用户实测）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith('http://127.0.0.1')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    if (/^mailto:/i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 兜底：SPA 窗口内本不该发生外部导航；万一发生（如 mailto: 被当成导航）同样外放，
  // 并阻止它替换掉控制台页面
  win.webContents.on('will-navigate', (e, url) => {
    if (/^mailto:/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url);
      return;
    }
    if (/^https?:/i.test(url) && !url.startsWith('http://127.0.0.1')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // 点关闭按钮 → 缩到托盘（自动签到需要进程常驻）；真正退出走托盘菜单
  win.on('close', (e) => {
    if (quitting) return;
    // 没有托盘就没有任何入口能把窗口找回来：此时若仍 hide，进程会变成看不见也关不掉的僵尸。
    // 所以托盘缺失时按普通关闭处理，交给 window-all-closed 退出。
    if (!tray) {
      quitting = true;
      return;
    }
    e.preventDefault();
    win.hide();
    // Windows 用户习惯「点 X 就是关」，首次隐藏时用气泡提示一次
    if (process.platform === 'win32' && tray) {
      tray.displayBalloon({
        title: 'workbuddy控制台仍在后台运行',
        content: '每日签到自动巡检继续工作中。右键托盘图标可打开窗口或退出。',
        iconType: 'info',
      });
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);
  return win;
}

app.whenReady()
  .then(() => {
    createTray();
    return createWindow();
  })
  .catch((err) => {
    // 服务启动失败时弹出系统对话框而不是白屏
    dialog.showErrorBox('workbuddy控制台启动失败', String(err?.message || err));
    app.quit();
  });

app.on('before-quit', () => {
  quitting = true;
});

app.on('second-instance', showWindow);

// macOS：点 Dock 图标且无窗口时重建
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  // 不主动退出：托盘常驻负责自动签到；退出统一走托盘菜单 / Cmd+Q
  if (process.platform !== 'darwin' && !tray) app.quit();
});
} // 单实例锁 else 分支结束：没拿到锁的进程只 quit，不做任何初始化
