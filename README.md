<p align="center">
  <img src="assets/cover.png" alt="workbuddy控制台 — 账号 · 模型 · 用量" width="100%" />
</p>

# workbuddy控制台

> 把 **WorkBuddy 账号管理**、**多平台免费模型**、**Token 用量统计**、**积分统计**、**全网签到** 收进同一个本地工具。

---

## 使用说明（普通用户看这里）

### 一、下载安装（推荐，无需安装 Node.js）

1. 打开 [GitHub Releases 下载页](https://github.com/walter-io/workbuddy-console/releases/latest)；
2. 按系统下载安装包：

| 系统 | 文件 | 说明 |
| --- | --- | --- |
| Windows 10/11（64 位） | `WorkBuddy-Console-<版本>-win-x64.exe` | NSIS 安装向导，可选安装目录，自动创建桌面快捷方式 |
| macOS Apple Silicon | `WorkBuddy-Console-<版本>-mac-arm64.dmg` | 拖入 Applications 即完成安装 |
| macOS Intel | `WorkBuddy-Console-<版本>-mac-x64.dmg` | 同上 |

3. **macOS 首次打开**：安装包未做 Apple 公证，需「右键 → 打开」，或在「系统设置 → 隐私与安全性」里放行一次；
4. 启动后窗口可以关闭——**只是缩到系统托盘**，每日签到巡检继续在后台跑；右键托盘图标可恢复窗口或真正退出。

### 二、首次使用三步走

1. **添加账号**：进「WorkBuddy 管理 → 账号切换」→ 点「扫码添加」，用 WorkBuddy 客户端扫码登录（二维码在本机渲染，不经过任何第三方）；也可「导入本机登录态」直接复用已登录的 WorkBuddy；
2. **切换账号**：在目标账号卡片上点「切换」——工具会自动退出 WorkBuddy → 备份并切换登录态 → 自动重启 WorkBuddy，你直接拿到已登录新账号的客户端；切换时可勾选「同时复制会话」把当前对话带给新账号；
3. **开启自动化（可选）**：进「WorkBuddy 管理 → WorkBuddy 设置」，保持自动巡检开启，每天自动签到并领取旅行礼物 / 任务 / 补签 / 兑换 / 盲盒等全部奖励；其他平台的每日福利在「全网签到」页代领。

### 三、常见操作速查

| 想做什么 | 去哪里 |
| --- | --- |
| 添加 / 切换 / 刷新凭据 / 删除账号 | 「WorkBuddy 管理 → 账号切换」 |
| 让 Claude Code、Codex、Gemini CLI 等用 WorkBuddy 的额度 | 「反向代理」→ 开启 → 复制 Base URL 与 API Key，接入示例可直接复制 |
| 查看 Token 用量与缓存命中率 | 「Token 统计」 |
| 查看积分余额与逐请求明细 | 「积分统计」 |
| 手动签到 / 一键领取成长中心奖励 | 「设置 → 每日签到与成长中心」 |
| 给免费模型平台配置 Key、写入 models.json | 「免费模型广场」三个子页签 |
| 检查更新 / 关掉自动更新检查 | 左下角版本号，或「设置 → 关于」 |

### 四、从源码运行（开发者）

```bash
npm install          # 安装依赖
npm run build        # 构建前端（改了 src/ 后必须执行，界面才会更新）
npm start            # 启动服务（默认 http://127.0.0.1:57891）
npm run app          # 以桌面窗口运行（Electron）
npm run app:win      # 本地打包 Windows 安装包（release/*.exe）
npm run test:proxy   # 其余测试脚本见下文各节
```

> 桌面版与 `npm start` 走的是同一套本地服务；日常使用装 Release 安装包即可，源码运行只在本机开发时需要。

## 功能

| 页面 | 说明 |
| --- | --- |
| **WorkBuddy 管理** | 扫码添加（OAuth 设备码，二维码本地渲染、服务端常驻采集）、导入本机登录态、**切换账号**（**自动结束 WorkBuddy 后台进程** → 备份 + 原子写入 + 失败回滚 → **自动重新打开**）、**刷新凭据**（用 refresh_token 换新的 access_token）、**会话复制**（把当前账号的对话按新会话 id 复制给目标账号，切换时可勾选一并执行）、备注、删除；顶部标明当前登录态与 WorkBuddy 运行状态 |
| **免费模型广场** | 三个子页签合并在一个入口：**免费模型**（只看各平台免费模型，搜索 + 排序，一键写入 `models.json` 或导出给其他 agent）、**平台额度**（各平台 Key 的免费额度与余额）、**API Keys**（多 Key 轮换、测试、设为活跃）+ 模型列表缓存管理 |
| **反向代理**（WorkBuddy 管理内） | 把 WorkBuddy 的官方对话能力**按四种主流协议**暴露给本机 agent：OpenAI Chat Completions（`/v1/chat/completions`）、Anthropic Messages（`/v1/messages`）、OpenAI Responses（`/v1/responses`）、Google Gemini 原生（`/v1beta/models/{model}:generateContent`）；账号池轮询、401 自动刷新 token 并换号、流式/非流式都支持（上游只收流式，非流式由代理聚合）；按协议族分组的接入示例（Claude Code / Codex CLI / Gemini CLI / Cherry Studio / Cline / Cursor / TRAE / 小米 MiMo / 豆包 等）、请求日志与连通性自检；默认关闭，需在页面显式开启 |
| **Token 统计**（WorkBuddy 管理内） | 扫描本机会话日志（JSONL），统计请求数、输入/输出/缓存读写/思考 Token、缓存命中率、模型与项目排行、会话明细；**按档位（国内版 / 国际版）分别归档**，可选「全部档位」合并查看 |
| **积分统计**（WorkBuddy 管理内） | 调用官方用量接口：可用剩余积分（按客户端的**套餐基础积分 / 平台奖励积分 / 购买积分**三类分列）、按账号与档位汇总、逐请求明细（分页）、趋势与模型分布；账号卡片上的**积分明细**可展开到每一条发放记录（到期时间、已使用 x/y、有效期内 / 已过期），接口不可达时回退本地离线预估 |
| **全网签到** | 一键代领**其他 AI 平台**的每日福利：网页版（智谱清言 / MiniMax Code / 扣子 / 即梦 / 哩布哩布 / 吐司 / 百度 Comate / Vidu / PixVerse / 通义万相）由内置无头浏览器代为操作，桌面版（豆包 / Trae / Qoder）通过调试通道临时接管客户端；每平台可单独启停、登录、一键代领；每天定时自动代领（控制台常驻，每小时检查补跑），带连续天数统计 |
| **设置** | 通用配置：**网络代理**（访问 OpenRouter 等海外平台，留空自动探测）、**全网签到自动领取**（时间与开关）、**通知历史**、**界面错误日志**、**关于**（版本号常驻左下角，有新版本时出现升级按钮；「检查更新」可手动触发，自动检查可关）。WorkBuddy 专属的设置——**运行状态与重启**、**每日签到与成长中心**（旅行礼物 / 派 Buddy / 任务 / 断登补签 / 连登兑换 / 开盲盒 / Buddy 盲盒）、**账号凭据维护**（凭据自动刷新 + 检查并刷新）、**数据/安装目录**、**登录态与目录权限自检**、**登录态备份与恢复**——在「WorkBuddy 管理 → WorkBuddy 设置」 |

## Token 统计口径

- `total = input + output + cacheWrite`，其中 `input` **已包含** cacheRead，因此不再重复累加 `cacheRead`。
- 真实日志中 cacheRead 只落在 `inputTokensDetails[].cached_tokens`，扁平别名（如 `cache_read_input_tokens`）恒为 0，已同时兼容两种结构。
- 档位数据根：国内版 `~/.workbuddy`（可在设置里覆盖），国际版 `~/.workbuddy-ai`。

## 会话复制（切号时把对话带给目标账号）

WorkBuddy 的对话记录**按账号隔离**：`workbuddy.db` 的 `sessions` 表带 `user_id`，侧栏只显示当前账号的会话。所以换账号登录后就看不到旧账号的对话——本工具提供「复制会话」把这个缺口补上。

在账号卡片上点 **同步会话**，或在切换账号时勾选「同时复制会话」，即可把**当前登录账号**的会话复制给目标账号。

**会话数据是「三件套」，缺一不可**（依据客户端对会话库的实际读写行为验证）：

| 位置 | 作用 | 复制时怎么处理 |
| --- | --- | --- |
| `<数据根>/projects/<工作区>/<会话id>.jsonl` | 正文（每行一条 JSON，行内有 `sessionId`） | 用**新 UUID** 另存一份，并把正文里所有旧 id 替换成新 id |
| `<数据根>/workbuddy.db` 的 `sessions` 表 | 元数据（`user_id` 决定归属） | 复制源行，`user_id` 改成目标账号，时间戳刷新，`deleted_at` 置空 |
| `<数据根>/edge-sync-mapping-v*.db` | 云端归属映射 | **故意不写** |

- **为什么不写第三项**：预写映射会让客户端的 edge-sync 判定「已迁移」而跳过上传，结果是云端根本没有这条会话，客户端之后对它的改名 / 活跃度上报会全部 404。客户端下次启动会自己登记。
- **源账号一个字不动**：副本是独立的新会话（新 UUID + 新库行），与源会话不共享任何 id；源账号的侧栏与云端数据都不受影响。
- **复制时清空云端同步痕迹**（`agent_dirty` / `agent_dirty_at` / `agent_last_synced` / `verified_at`）并把 `unread` 归零，让客户端把副本当成尚未上传的新会话；源会话若正处于 `working`，副本会写成 `completed`，避免客户端尝试续跑副本。
- **不用手动退 WorkBuddy，工具自己关**：运行中的实例看不到我们的写入，继续对话会让副本与源会话分叉；而 WorkBuddy 关窗只是缩到系统托盘，经常"看着关了其实还活着"。所以切换 / 复制前本工具会**自动结束全部 WorkBuddy / CodeBuddy 进程**（Electron 应用，本机实测有 9 个：主进程 + 渲染 / GPU / 工具子进程），并在结束后**把 WorkBuddy 重新打开**，让你直接拿到一个已登录新账号的客户端。不想要这个行为，就取消勾选「先退出 WorkBuddy」——那时若检测到它正在运行，写入会被直接拒绝（不会偷偷改库）。
- **退出流程是"确认过才继续"**：每轮都重新枚举进程再关（先关子进程会被主进程立刻拉起来，反复枚举才能把名单收敛干净）→ 先发正常关闭信号（保住正在落盘的数据）→ 关不掉再强杀进程树 → **等进程表真的空了 + 700ms 让 SQLite 放开 `-wal`/`-shm` 句柄**，才动数据库。探测判据是：**只要有一种方式成功执行完并且报告"没有该进程"，就认定它确实没在运行**；只有**所有**方式都没能执行（例如系统安全策略同时禁掉了 PowerShell 与 tasklist）才叫"无法判定"，这时才保守拒绝写入。
- **写入安全**：备份 `workbuddy.db`（含 `-wal` / `-shm`）到 `~/.wb-switch/backups/session-copy-*/` → 写正文（临时文件 + fsync + 改名）→ 回读校验（旧 id 不得残留、行内 `sessionId` 必须全指向副本、行数一致）→ 插入会话行 → 回读校验归属；任一步失败只回滚该会话（删掉刚写的正文与刚插入的行），不影响其他会话。
- **记账去重**：复制过的会话记在 `~/.wb-switch/session_copies.json`（`副本id → 来源id` 反查表由整张账本现算），列表里标「已复制」，避免目标账号里堆出重复会话。
- **原位同步，不堆重复会话**：目标账号里已经有同一份会话时，**不再新建**，而是把新增内容与改名同步到那份上——两个方向都成立：
  - **往返**（本账号这份是目标账号某会话的副本）：在目标账号里继续聊出来的消息 + 改名，在切回来时并进原会话；
  - **正向**（目标账号里有之前复制过去的旧副本）：本账号又聊了新内容时，勾选再复制一次会把增量传给那份旧副本。所以「已复制」的会话在列表里**依然可以勾选**——再选一次不是重复复制，而是补增量。
  判定靠**血缘链**：沿祖先链往上找**第一个「目标账号里确实存在」**的那份作为落点（限深 32 且防环），所以 A→B→C→A 这类跨账号接力也能正确归位；只反查一层账本会让它漏判、把会话又复制一份出来。内容合并按**逐行差集**（来源里有、目标里没有的行才补），天然幂等，两侧都各自聊过也不会把同一段内容追加两遍。
- **往返复制会带上改名**：这一步是必要的：实测客户端会给导入的副本重新生成自动标题、覆盖复制来的名字，而原会话一旦带上固定名（`custom_title`）就不再被自动命名改写。改名同步只动 `title` / `custom_title` 两列（复制报告会标出「改名同步」数量）。
- **同步会先备份落点正文**：与只新增文件的复制路径不同，原位同步是**改已有正文**，所以先把落点正文备份到本次操作的备份目录，备份失败就中止——宁可不同步，也不无备份地改用户的会话数据。
- **体积与副作用**：正文是整份另存，复制会等量占用磁盘；WorkBuddy 下次启动会把副本**上传到云端**。本机实测当前账号有 3300+ 个会话、约 3.9 GB，所以界面默认是**勾选复制**而不是全量复制。
- **不参与复制的会话**：Claw 工作区（绑定当前账号的 IM 渠道）、已删除、没有正文文件的会话。
- **不复制的东西**：`session_usage` 本地用量缓存（客户端会自行重建）。

自动化测试（隔离临时数据根与临时账号库，不联网、不碰真实会话数据）：

```bash
node scripts/test-session-copy.mjs    # 会话复制 / 门禁 / 回滚 / 账本 / 原地合并（125 项断言）
node scripts/test-roundtrip-flow.mjs  # 往返全流程：不预置账本、按真实操作链跑端到端（49 项断言）
node scripts/test-stop-process.mjs    # 自动退出 WorkBuddy 的进程链路（23 项断言，仅 Windows）
node scripts/test-token-refresh.mjs   # 凭据刷新判据与版本自检（46 项断言，官方接口用桩替换）
node scripts/test-growth.mjs          # 成长中心模块、补登候选与对话任务补全（74 项断言，官方接口用桩替换）
node scripts/test-netcheckin.mjs     # 全网签到回归：注册表完整性、配置合并、每日随机延迟、补跑过滤
```

`test-session-copy.mjs` 里有一部分用例是**手工预置账本**再验证合并的——它只能证明「账本里已经有那一条时能合并」。`test-roundtrip-flow.mjs` 补上这个缺口：**从零开始**跑「登录 A → 复制给 B → 切登录到 B → 在 B 继续聊 + 改名 → 切回 A → 复制回 A」（含跨账号接力 A→B→C→A、一个会话分发到两个账号、两边都继续聊），每一步都断言**目标账号里没有多出无法解释的会话**。跨账号接力的重复会话就是这套用例抓出来的。

`test-stop-process.mjs` 会把 `node.exe` 复制成同名替身 `WorkBuddyFake.exe` 后台拉起，再走完整的「枚举 → 优雅退出 → 强杀 → 确认消失」流程，并断言**真实 WorkBuddy 的进程一个都没被误杀**。它还守着一条容易写反的判据：进程确实不存在时探测结果必须"干净地"报没有（`error` 为空），否则在 PowerShell 被安全策略禁掉的机器上，切换账号会在最后一道门把自己拦住。

## 每日签到与成长中心（国内版）

签到只给一部分积分；**成长中心**里还有六个每天刷新的奖励入口，工具会一并代领（`server/workbuddy/growth.mjs`）：

| # | 模块 | 接口 | 备注 |
| --- | --- | --- | --- |
| 1 | **Buddy 旅行** | `buddy/travel/status` → `claim` → `config` → `depart` | 到站先领礼物再派出；服务端已说"今日名额用完"就不再派出，省掉两个必然失败的请求 |
| 2 | **任务** | `tasks` → `tasks/accept` → `tasks/{code}/claim` | 接单 body 是**复数** `task_codes` 数组（单数 `task_code` 官方一律 400）；只有 `completed` 才发奖 |
| 2.5 | **对话任务补全** | `/v2/chat/completions`（带 `extra_vars.growthEvent` 上报） | `chat_*` 类任务（如「和 AI 聊天 5 次」）只有真实发起模型对话才计进度（`server/workbuddy/usageTasks.mjs`）。模型选择：**免费模型优先**（hy3 / step-5-preview / wb-lite，实测 0 积分/次），全部不可用才退到**低倍率付费模型**（按实测倍率升序）并在报告里点名提醒；单任务每轮最多补 10 次 |
| 3 | **断登补签** | `streak` + `heatmap` → `makeup-cards/use` | 只补**当月、今天之前、`score==0`、未补登过**的日期；**每轮最多用 1 张卡** |
| 4 | **连登兑换** | `redeem/summary` → `redeem` | 入门 7 天 / 进阶 14 天 / 巅峰 28 天；`tier` 只认档位标识 `7d`/`14d`/`28d` |
| 5 | **开盲盒** | `lottery/chances` → `lottery/draw` | 写路径不可逆，**每轮只开一次**；中实物奖会提醒去填收件信息 |
| 6 | **Buddy 盲盒** | `buddy/quota` → `buddy/open` | 能量攒够 `cost_per_open` 才开，数量取 `min(affordable, max_open_count)` |

几个刻意的设计：

- **模块顺序有讲究**：「任务/兑换」排在「开盲盒」之前——兑换和任务送的抽奖机会/能量，**同一轮就能用上**（实测：连登兑换「入门」给的 1 次抽奖机会，在同一轮里被盲盒用掉，开出 10 积分）。
- **补登先于兑换**：补登会改变连登天数，先补再兑才能拿到最新解锁状态。
- **每轮限量**：补登卡 1 张、盲盒 1 次。写操作**一律不重试**（服务端处理完成后才超时时，重试会重复提交）。
- **常态不算失败**：旅行名额用完、"没有抽奖机会"（`400 insufficient lottery chance balance`）、连登兑换 `403 天数不足`、日期已无需补登，都是每天的正常状态，只进报告、不计失败，也不会让整轮中止。
- **一处中止**：`401/403`（非上述业务常态）判定为登录态被拒，中止本轮并提示刷新凭据或重新扫码；第一个请求就网络不可达时立刻收手，不把后面六个接口全撞一遍。
- **两道巡检门禁**：签到 + 成长中心**各自**判定"今天做完没有"。签到早满了不影响成长中心的旅行/任务/补登/兑换/盲盒——两者是独立的每日额度。
- **补登必须"有据可依"**：补登候选完全来自服务端活跃日历，结构异常（缺服务端日期、分数非法、格式不对）直接抛错跳过，**绝不靠猜测消耗补登卡**。
- **汇报优先用服务端实发值**：任务列表里的 `reward_credit` 只是活动配置；兑换实发字段带 `_granted` 后缀（`credit_granted` / `energy_granted` / `cards_granted` / `chances_granted`），直接读 `credit` 恒为空、会把兑换所得漏计。

手动入口在「设置 → 每日签到与成长中心」：**一键领取**（签到 + 成长中心全部可领）和单账号「领取」。最近记录里每条都带成长中心的一行式汇报（含进账积分），例如：

```
[16:12:08] 时光悠悠 今日已签到              成长中心 +0
  今日旅行名额已用完；领取任务「关注官方公众号」（进度开始计）；连登兑换「入门」（+2 能量 +1 次抽奖）；开盲盒获得：10 积分（能量 4，连签 13 天）
```


## 全网签到（其他平台的每日福利）

WorkBuddy 账号自己的签到在上一节；这一节是**其他平台**的（`server/netcheckin/`）。平台的签到形态天生两类，工具也按两类处理：

| 类型 | 平台 | 怎么自动 |
| --- | --- | --- |
| 网页版 | 智谱清言 | **纯接口代领**：签到是页面加载时前端自动调用的接口，签名（X-Sign = md5(ts-nonce-secret)）可本地计算，不碰 DOM，最稳；先打开一次首页让前端自动续期 token |
| 网页版 | MiniMax Code | 无头浏览器复用登录态：签到面板只在未签时出现，没有就进账户菜单 → 每日签到 |
| 网页版 | 通义万相 | 接口存活但产品已并入千问，默认关闭，确认能领再开 |
| 网页版 | 扣子 | 每天登录自动发 1500 积分（当日有效）——打开工作台即到账；状态偶显「入口未命中」也无需理会 |
| 网页版 | 即梦 | 每日登录送积分，数额随活动浮动（20~80）；免费积分一般当日有效 |
| 网页版 | PixVerse | 每日 30 积分（注册另送 60），用于视频生成；到账方式需登录后确认 |
| 网页版 | 哩布哩布 | 免费用户每日登录领 300 点算力；领取入口在个人中心或活动页，位置随活动调整 |
| 网页版 | 吐司 | 每天登录送 50~100 算力 + 20 次免费生图，打开页面即到账；历史记录免费版保留 14 天 |
| 网页版 | 百度 Comate | 个人版每日签到得积分（用于代码补全/生成）；入口也可能只在 IDE 插件里 |
| 网页版 | Vidu | 每天登录自动送 80 积分（月上限约 800），打开页面即到账，用于文生视频 |
| 桌面版 | 豆包 | 带调试端口接管桌面客户端，直接打开「免费用豆包」活动页（agent-explore）点「立即签到」；每天 200 额度、周一翻倍，额度在「订阅与额度管理 → 活动赠送额度」里累计；**领完后按钮直接消失**（不是变灰），引擎按「页面还在活动页但入口不在」判定已完成 |
| 桌面版 | Trae 国内版 / Qoder 国内版 | 通过调试端口（CDP）接管桌面客户端：客户端没开就带端口拉起、签完自动退出；**客户端开着但没开端口时自动重启一次**，绝不强杀用户正在用的窗口 |
| 自定义 | 任意网页平台 | `~/.free-token/checkin/config.json` 的 `custom` 数组加一条（id/name/url/keywords）即生效，不用改代码 |

设计要点（与「设置 → 每日签到」的分工、为什么这样做）：

- **WorkBuddy 不在本页**：账号级签到走官方接口 + 成长中心（上一节，能力更全），这里再做一份只会重复请求。
- **防风控是刻意的**：平台之间**串行 + 3~9 秒随机间隔**；每天自动代领时间带随机延迟窗口；同一时刻只允许一个浏览器实例（自动代领和「去登录」窗口互斥）。
- **幂等**：今天已领的平台自动跳过；错过或失败后每小时检查一次，发现没领的就自动补跑（启动时也检查），23 点后不再自动跑。
- **登录态自持**：网页类平台共用一个持久化浏览器 profile（`~/.free-token/checkin/profile`，等价账号凭据，别外传）；登录态失效时卡片显示「需登录」，点「登录」弹窗扫码，成功后自动关窗保存。
- **状态一眼可读**：卡片徽章直接给出「已到账 / 今日已领 / 需登录 / 未安装 / 没找到入口」，该做什么一目了然；平台改版后把新文案补进 keywords 即可。
- **风险自担**：多数平台的服务条款不允许自动化，每天至多一次、只在本机自己的账号上用。

## 账号不会"放着放着就失效"（凭据自动刷新）

账号库里的 `access_token` / `refresh_token` 都有有效期。原先**唯一**会刷新它们的地方是反向代理处理请求时，而且只在"到期前 60 秒"那个极窄窗口触发——于是**既没被切换过、也没走过反向代理**的账号会一路静默过期，等到想用时只能重新扫码。

服务端因此加了一条巡检（默认开启，可在「设置 → 账号凭据维护」关闭或手动触发）：

| 情况 | 动作 |
| --- | --- |
| `access_token` 剩余 < **24 小时** | 刷 |
| `refresh_token` 剩余 < **72 小时** | 刷（兜底：refresh 一过期就再也救不回来） |
| 两个有效期字段都缺失 | **不动**（判断不了就别猜） |
| `refresh_token` 已过期 / 账号根本没有 refresh_token 且 access 已临期 | 不刷，界面标红提示**需重新扫码登录** |

- **巡检间隔 6 小时**，但**只在临期时才动手**。为什么不每次巡检都刷：刷新有可能轮换 `refresh_token`，而 WorkBuddy 自己的登录态文件里还存着它那一份；频次越高，两方互相踩到的概率越大。临期才刷，等于只在"反正也要死了"的时刻出手。
- **两个入口，粒度不同**：设置页的「检查并刷新」是批量动作，**不带 force**，只动临期账号；账号卡片上的「刷新凭据」是用户明确点在某个账号上，**带 force**，无条件刷新。
- **失败不静默**：接口 4xx/5xx、网络不通都逐账号记录原因；巡检平时完全静默（没有临期账号时不写日志）。
- **只记结果不记凭据**：日志在 `~/.wb-switch/token_refresh_logs.json`（本工具私有），只有时间、账号名、动作与剩余有效期。

## 版本自检（左下角的升级按钮）

左下角版本号取自 `package.json`（前端不再硬编码），版本服务是 GitHub Release（本仓库 Actions 在推 tag 时构建 Windows / macOS 安装包）。

- **只有远端版本严格新于本机时才出现升级按钮**。本机开发版常常领先于已发布的 tag（本地 `0.2.0`、最新 Release 还是 `0.1.2`），若按"版本号不相等即有更新"判断，按钮会把用户引向一次**降级**安装——这条已写成回归断言。
- 点击按钮打开与当前平台/架构匹配的安装包下载地址（匹配不到就回落到 Release 页面）。产物命名随版本变过（早期 `Free-Token-0.1.2-win-x64.exe`，现在 `WorkBuddy-Console-0.2.0-win-x64.exe`），所以只按"后缀 + 架构关键词"匹配，不锚定前缀。
- 结果缓存 6 小时（GitHub 未认证请求限每小时 60 次）；**失败不覆盖上一次的成功结果**，只在请求成功时写缓存。网络不通就"不显示按钮"，不弹报错——没有新版本来就是常态。
- 出站走统一的 `proxyFetch`，自动遵循「设置 → 网络代理」/ 环境变量 / Windows 系统代理。
- 这是本工具**唯一一处访问非官方服务**的出站请求（只读 Release 元数据）；「设置 → 关于」里可关掉自动检查，手动「检查更新」仍可用。

## 桌面版（Windows / macOS）

控制台可以打包成免装 Node 的桌面应用：Electron 主进程里直接跑 Express 服务，窗口加载本地回环地址；**关闭窗口只是缩到系统托盘**，每日签到的自动巡检继续在后台运行，右键托盘图标可恢复窗口或真正退出。

```bash
npm run icons   # 生成 build/ 下的多平台图标（png / ico / icns / 托盘图）
npm run app:win # 打包 Windows 安装包（NSIS，release/*.exe）
npm run app:mac # 打包 macOS（release/*.dmg + *.zip；需在 macOS 上执行）
npm run app:dir # 只出免安装目录（release/<平台>-unpacked），本地验证用
```

- 打 tag（如 `v0.2.1`）推送到 GitHub 后，Actions 会同时构建 Windows 与 macOS 安装包并挂到 Release。
- **macOS 首次打开**：安装包未做 Apple 公证（identity 走 ad-hoc），首次需「右键 → 打开」或在「系统设置 → 隐私与安全性」里放行一次。
- 应用数据全部写在家目录（见下表），卸载程序不会动这些数据。

## 反向代理（给市面上的主流 agent 用 WorkBuddy 的额度）

开启后，控制台会在**自身端口**上提供四种主流协议的接口（不额外开端口）：

| 端点 | 协议 | 典型客户端 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | OpenAI SDK、Cherry Studio、Cline、Roo Code、Cursor、Continue、Aider、TRAE、小米 MiMo Code、豆包 MarsCode 等 |
| `POST /v1/messages` | Anthropic Messages | Claude Code、ZCode（Anthropic 模式）及其它 Anthropic 兼容客户端 |
| `POST /v1/responses` | OpenAI Responses | Codex CLI |
| `POST /v1beta/models/{model}:generateContent`<br>`POST /v1beta/models/{model}:streamGenerateContent` | Google Gemini 原生 | Gemini CLI、Gemini 原生 SDK |
| `GET /v1/models`、`GET /v1beta/models` | 模型清单（按客户端形状返回） | 全部 |

- **协议转换**：官方上游只认 OpenAI 协议、且**只接受流式**；四种入站协议都在 `server/proxy/` 里做双向翻译，非流式请求由代理本地聚合后回填。
- **风控净化**：上游会拦「system 文本里带别家 agent 系统提示词」的请求（`code 11128`）；代理出站前会把竞品指纹词中性化，用户消息不受影响。详见下文。
- **鉴权**：`Authorization: Bearer <Key>`、`x-api-key: <Key>`、`x-goog-api-key: <Key>`（或 `?key=`）三种都认 —— 分别对应 OpenAI 类 / Anthropic 类 / Gemini 类客户端各自的默认行为。Key 首次开启自动生成，可随时重新生成。
- **账号池与出站顺序**：默认用全部「能出站」的账号（有明文凭据的算能出站；`access_token` 过期、甚至只存了加密信封，只要还有 `refresh_token` 也算，出站前会先换一份明文回来），并按**「积分最早过期优先」**排序——优先消耗快要过期的积分，避免浪费；余额数据每 10 分钟后台刷新，不阻塞请求。**某账号对某模型撞限额**（429 / 积分不足类错误）时，同一请求内自动换下一个账号，并给该「账号×模型」记 **10 分钟冷却**，期间后续请求直接跳过它（冷却只按模型隔离：DeepSeek 限额不影响同账号的其它模型）。401/403 会先刷新 token 再重试一次，仍失败换下一个账号。**桌面端当前登录的账号会被自动排除**（显式勾选也不参与）：上游渠道风控对账号有连坐效应——同一账号既跑官方客户端又被代理带着竞品 system 文本出站，官方客户端也会开始被拦（11128）。若仅有的账号正是当前登录账号，池子为空，界面会提示先切换客户端账号或再导入一个。
- **档位隔离**：国内版走 `copilot.tencent.com`，国际版走 `www.workbuddy.ai`，绝不混档。
- **安全**：只监听 `127.0.0.1`，局域网不可见；`refresh_token` 只出现在官方 refresh 端点；请求日志只存内存、不含消息正文。
- **依赖**：代理由控制台进程提供，需保持控制台运行（桌面版关闭窗口后驻留托盘，不会中断）。

各客户端的配置片段在控制台「反向代理 → 接入示例」里**按协议族分组**列出、可直接复制。几个关键点：

```bash
# Claude Code（Anthropic 协议）
export ANTHROPIC_BASE_URL=http://127.0.0.1:57891/v1
export ANTHROPIC_AUTH_TOKEN=<页面上点「显示」复制的 Key>
```

```bash
# Gemini CLI：只填域名根，**不要带 /v1beta**（CLI 自己拼 /v1beta/models/{model}:...）
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:57891
export GEMINI_API_KEY=<Key>
export GEMINI_MODEL=<模型 ID>
# 并在 ~/.gemini/settings.json 里显式指定 API Key 认证，否则会走 Google 账号登录：
# { "security": { "auth": { "selectedType": "gemini-api-key" } } }
```

> Gemini CLI 要求 HTTPS，但 `127.0.0.1` / localhost 例外，因此本机回环可直接用 http。

### 上游渠道风控（`code 11128`）与 system 文本净化

上游 `/v2/chat/completions` 有一道**渠道风控**：只放行 WorkBuddy 自家客户端的请求。
一旦在 system 级文本里认出别家 agent 的系统提示词，就回

```
400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

这跟客户端指纹头无关（同一组头走普通请求是通的），判的是**内容**。实测结论：

| 实验 | 结果 |
| --- | --- |
| 52,000 字中性文本 | 通过 → **与长度无关** |
| Codex `base_instructions` 前 184 字 | 通过 |
| 同上前 **185 字**（多一个句号） | **被拦** |
| 删掉三句里任意一句 / 打乱句序 / 句间插一个换行 | 通过 |
| 只把 `Codex CLI` 或只把 `OpenAI` 换成中性词 | 通过 |
| 整段转小写 | 仍被拦（大小写不敏感） |

⇒ 判据是**一段连续逐字文本**命中已知竞品系统提示词，不是关键词表、也不是长度门。

且指纹库里**不只有品牌词，还有竞品系统提示词里的固定模板句**。
回放 ZCode 的真实请求体（system 共 3 段）实测：

| 实验 | 结果 |
| --- | --- |
| 只留第 1 / 第 2 段 | 通过 |
| 只留第 3 段（5,735 字，**全文没有任何品牌词**） | **被拦** |
| 第 3 段里删掉 ` (you will usually use this for PRs)` | 通过（整段 5,735 字） |
| 单独把 `Main branch (you will usually use this for PRs)`（47 字）当 system 发 | **被拦**（连测 3 次一致） |

⇒ 最小触发片段是 Claude Code 注入 git 状态时写的**分支标签**
（`Main branch (you will usually use this for PRs): <分支>`，当前分支是主干时才出现）。

因此 `server/proxy/sanitize.mjs` 在出站前做三件事：

1. 剔除客户端注入的内部元数据行（Claude Code 的 `x-anthropic-billing-header:` 等）；
2. 把竞品指纹**词**换成中性词（`Codex CLI` → `assistant CLI`、`OpenAI` → `the vendor`），
   按句首补大写，语义不变；
3. 把竞品系统提示词里的**固定模板句**还原成普通写法
   （`Main branch (you will usually use this for PRs)` → `Main branch`，分支信息不丢）。

**只动 system 级文本**（Responses 的 `instructions`、Anthropic 的 `system`、
OpenAI 的 `role:"system"`、Gemini 的 `systemInstruction`），**用户消息一律原样透传** ——
用户正常问一句「OpenAI 是什么」不该被改写。

> 规则分两张表、都只收**已实证触发**的项：品牌词只有 `Codex` / `OpenAI` / `ChatGPT` 家族，
> 模板句只有上面那条 git 状态标签。新增规则前请先做「移除该片段 → 上游是否放行」的二分验证，
> 别凭猜加词——改写 system 文本本身有语义代价。用户反馈仍然 11128 时，请把该客户端的
> 系统提示词特征一并带来。

### 客户端连不上 / 报错时怎么查

界面的**请求日志**是唯一权威线索——包括**被拒绝的请求**（Key 不对、代理没开、body 缺字段），
每条都带**客户端 UA**、**Key 携带方式**、**请求路径**和**人话版失败原因**。日志只存内存、
不含任何消息正文（最后一条失败还会单独置顶提示）。按顺序核对：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 日志里**一条记录都没有** | 请求根本没到控制台：控制台没开（代理由控制台提供，**不需要 WorkBuddy 在运行**）、端口写错（桌面版端口可能顺延到 57892）、或客户端把 `localhost` 解析成 `::1` | 核对页面顶部显示的 Base URL |
| `Key 方式：未携带` / `不匹配` | 客户端没带 Key，或带了别的 Key | 页面点「显示」复制；注意 `Authorization` 要 `Bearer <Key>`（裸 Key 也认） |
| `上游 11128：上游渠道风控拦截` | 客户端的系统提示词被判定为非官方客户端（见上一节） | 已内置净化；若仍出现，把该客户端的系统提示词特征反馈来加词表 |
| 官方客户端自己也报 11128 | 当前登录账号曾被代理拿去出站，被上游风控连坐标记 | 切换客户端登录账号（或等标记过期）；新版已把当前登录账号自动排除出账号池，不会再发生 |
| `上游 11102：模型不可用` | 模型名不在清单里（如 `gpt-4o`） | 用 `GET /v1/models` 或页面「模型清单」里的 ID |
| `所有账号都请求失败` + 401/403 | 账号凭据失效 | 页面「检查并刷新」，或重新扫码导入 |

> 只监听**环回**（IPv4 `127.0.0.1` 与 IPv6 `::1` 同时监听），不对外暴露；`NO_IPV6=1` 可关掉 IPv6 那一路。

协议级自动化测试（不联网、不碰真实账号，覆盖四种协议的转换、流式终止事件、路由鉴权
与风控净化）：

```bash
node scripts/test-proxy-protocols.mjs   # 84 项断言
node scripts/test-proxy-pool.mjs        # 32 项断言：账号池准入、凭据刷新判据与当前登录账号排除
```

> `test-proxy-pool.mjs` 守的是一条真实踩过的坑：账号池曾经用「明文凭据且未过期」当准入判据，
> 于是「控制台离线几天、`access_token` 正好过期」的账号会被**静默踢出池子** ——
> 明明 `refresh_token` 还有效、一次刷新就能救回来，界面却只回一句「没有可用账号」，
> 把人往「重新扫码」上引。

## 隐私红线

- 绝不读取 / 返回 `providerData.reasoning`（思考内容）、`message.content`（消息正文）。
- 绝不读取 / 返回用量接口响应中的 `input` / `inputTrunc`（原文内容），只取 token 数与时间戳。
- 扫码登录的二维码由本机渲染（`qrcode` 库），验证链接含 state，不外传任何第三方。
- 账号 Token 在页面上只显示掩码；界面与本地服务仅监听 `127.0.0.1`。

## 数据位置

| 内容 | 路径 |
| --- | --- |
| 账号库 | `~/.wb-switch/accounts.json` |
| 登录态备份 | `~/.wb-switch/backups/` |
| 会话复制账本（本工具私有） | `~/.wb-switch/session_copies.json` |
| 会话复制前的会话库备份 | `~/.wb-switch/backups/session-copy-*/workbuddy.db`（含 `-wal` / `-shm`） |
| WorkBuddy 登录态（国内版 / 国际版） | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` / `workbuddy-desktop-ai.info` |
| 积分快照 | `~/.wb-switch/credit_usage_snapshots.json` |
| 积分用量缓存（本工具私有） | `~/.wb-switch/credit_stats_cache.json` |
| 签到与成长中心日志（本工具私有） | `~/.wb-switch/checkin_logs.json` |
| 凭据刷新日志（本工具私有，不含 token） | `~/.wb-switch/token_refresh_logs.json` |
| 工具配置（平台 Key / 代理 / 自动签到 / 凭据自动刷新） | `~/.free-token/config.json` |
| 全网签到数据（配置 / 结果流水 / 截图 / 浏览器登录态） | `~/.free-token/checkin/`（`config.json` / `results.jsonl` / `shots/` / `profile/`） |
| 版本自检缓存（6 小时） | `~/.free-token/cache/update-check.json` |
| 写入 WorkBuddy 的模型配置 | `~/.workbuddy/models.json`（国内版）/ `~/.workbuddy-ai/models.json`（国际版） |

> 账号库、备份与积分快照放在 `~/.wb-switch/` 下；缓存与日志各写各的文件，避免结构不同导致读取错乱。

## 技术栈

- **前端**：React 18 + TypeScript + Vite + Tailwind CSS + Recharts
- **后端**：Node.js（ESM）+ Express，仅监听回环地址，不暴露到局域网
- **桌面**：Electron + electron-builder（托盘常驻、单实例、开机自启动可选）

```
workbuddy-free-token-manage/
├── server/
│   ├── index.mjs            # Express 入口 + 路由 + 定时巡检（签到 / 凭据刷新）
│   ├── proxy.mjs            # 出站代理（免费模型平台请求）
│   ├── update.mjs           # 版本自检（GitHub Release + 6 小时缓存 + semver 比较）
│   ├── proxy/               # 反向代理（多协议：OpenAI / Anthropic / Responses / Gemini）
│   │   ├── index.mjs        # 路由 + 账号池轮询 + 鉴权 + 管理 API
│   │   ├── wb.mjs           # WorkBuddy 官方上游客户端（风控头 / 刷新 token / SSE 聚合）
│   │   ├── anthropic.mjs    # Anthropic Messages ↔ OpenAI
│   │   ├── responses.mjs    # OpenAI Responses ↔ OpenAI
│   │   ├── gemini.mjs       # Google Gemini 原生 ↔ OpenAI
│   │   └── sanitize.mjs     # 出站 system 文本净化（上游渠道风控 code 11128）
│   ├── providers/           # 各平台适配（OpenRouter / 硅基流动 / 魔搭 / Agnes / Groq ...）
│   ├── stats/               # Token 日志扫描（worker 线程，支持多档位数据根）
│   ├── targets/workbuddy.mjs# 数据目录检测、models.json 读写、进程枚举与退出/重启
│   └── workbuddy/
│       ├── variant.mjs      # 国内版 / 国际版路径与常量
│       ├── accounts.mjs     # 账号存储（读写 / 备份 / 掩码）
│       ├── auth.mjs         # 登录态切换（原子写入 + 回读校验 + 回滚）
│       ├── sessions.mjs     # 会话读取与复制（workbuddy.db + projects/ 正文 + 复制账本）
│       ├── oauth.mjs        # 扫码登录（服务端常驻轮询）
│       ├── credits.mjs      # 积分统计（官方接口 + 离线预估）
│       ├── checkin.mjs      # 每日签到（顺带领取成长中心）
│       ├── growth.mjs       # 成长中心：旅行 / 任务 / 补登 / 兑换 / 盲盒 / Buddy
│       ├── tokenRefresh.mjs # 凭据自动刷新（临期判定 + 日志）
│       ├── backups.mjs      # 登录态备份管理
│       └── diagnostics.mjs  # 目录权限自检
├── src/
│   ├── App.tsx              # 侧栏导航与页面挂载
│   ├── components/ui.tsx    # 设计系统（Card / PageSection / Toolbar / StatCard ...）
│   └── pages/
│       ├── AccountsPage.tsx     # 账号管理（含扫码弹窗）
│       ├── PlatformPage.tsx     # 免费模型广场（三子页签）
│       ├── ProxyPage.tsx       # 反向代理（OpenAI 兼容）
│       ├── ModelsPage.tsx       # 模型广场
│       ├── QuotaPage.tsx        # 平台额度
│       ├── PlatformKeysPanel.tsx# API Keys
│       ├── StatsPage.tsx        # Token 统计
│       ├── CreditStatsPage.tsx  # 积分统计
│       └── SettingsPage.tsx     # 设置
├── scripts/
│   ├── test-proxy-protocols.mjs # 四协议转换回归（离线）
│   ├── test-proxy-pool.mjs      # 反向代理账号池准入回归（隔离账号库）
│   ├── test-session-copy.mjs    # 会话复制回归（隔离临时数据根）
│   ├── test-roundtrip-flow.mjs  # 往返全流程端到端回归（从零构造，不预置账本）
│   ├── test-stop-process.mjs    # 退出 WorkBuddy 的进程链路回归（同名替身进程）
│   ├── test-token-refresh.mjs   # 凭据刷新判据 + 版本自检回归（官方接口用桩替换）
│   └── test-growth.mjs          # 成长中心六模块 + 补登候选回归（官方接口用桩替换）
└── electron/main.mjs        # 桌面壳（内嵌 Express + 窗口）
```

## 许可证

本项目基于 [MIT License](LICENSE) 开源，可自由使用、修改与分发。

