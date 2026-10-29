import { useEffect, useState } from 'react';
import { Badge, Button, Modal } from './ui';

/**
 * 「账号被封了？申诉指引 + 风控风险点自查」共用弹层。
 *
 * 账号页（限制徽章点击 / 页头按钮）与反代页（风险横幅）共用。
 * 申诉教程走诚实路线：如实说明使用过自动化工具 + 已停止 + 请求复核——
 * 风控数据在官方手里，隐瞒没有意义，如实+整改是最稳妥的申诉策略。
 *
 * 入口均经本机 2026-10-30 验证可达：
 * - 官方支持页 https://www.codebuddy.cn/docs/ide/Support/Contact
 * - 邮箱 codebuddy@tencent.com
 * - 桌面端内反馈：右上角头像 → 帮助与反馈
 */

const SUPPORT_URL = 'https://www.codebuddy.cn/docs/ide/Support/Contact';
const TROUBLE_URL = 'https://www.codebuddy.cn/docs/ide/Support/Troubleshooting';
const SUPPORT_MAIL = 'codebuddy@tencent.com';

/** 申诉邮件模板（uid/时间留空由用户填） */
function appealTemplate(uid = '<填写你的 UID 或手机号>', time = '<填写发现时间，如 2026-10-30 上午>') {
  return [
    `标题：账号异常限制申诉（${uid}）`,
    '',
    '您好，',
    '',
    `我的账号（${uid}）自 ${time} 起出现「11140 request illegal / 账号异常活动」提示，无法正常使用模型服务。`,
    '',
    '我确认该账号由本人使用，未出租出借。此前我曾使用第三方本地管理工具对该账号执行过自动化操作（自动签到、接口调用等），可能因此触发风控限制。目前我已停止全部相关自动化操作，后续仅通过官方客户端正常使用。',
    '',
    '恳请复核并解除限制，谢谢！',
  ].join('\n');
}

export function BanRiskGuide({
  open,
  onClose,
  initialTab = 'appeal',
}: {
  open: boolean;
  onClose: () => void;
  initialTab?: 'appeal' | 'risks';
}) {
  const [tab, setTab] = useState<'appeal' | 'risks'>(initialTab);
  const [copied, setCopied] = useState('');
  // 每次打开按调用方意图定位 tab（open 变化时同步一次，之后用户可自由切换）
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      /* 剪贴板不可用时用户可手动选择文本 */
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title="账号申诉与风控指引"
      subtitle="被封不等于永久——如实申诉 + 停止自动化，是最稳妥的解法"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => window.open(SUPPORT_URL, '_blank')}>
              打开官方支持页 ↗
            </Button>
            <Button size="sm" variant="subtle" onClick={() => window.open(TROUBLE_URL, '_blank')}>
              官方故障排查 ↗
            </Button>
          </div>
          <Button size="sm" variant="subtle" onClick={onClose}>
            关闭
          </Button>
        </div>
      }
    >
      <div className="mb-3 flex gap-1.5">
        {(
          [
            ['appeal', '账号被封了？申诉指引'],
            ['risks', '风控风险点自查'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
              tab === id
                ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                : 'border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'appeal' ? (
        <div className="space-y-3 text-sm leading-6 text-zinc-700">
          <section>
            <h4 className="font-semibold text-zinc-900">第一步：确认症状</h4>
            <p className="mt-1 text-xs text-zinc-600">
              以下任一情况通常是被官方风控限制（而非凭据过期）：
              代理/自检报 <code className="rounded bg-zinc-100 px-1">11140 request illegal</code> 或提示
              「unusual activity / has been restricted」；账号卡片出现红色「官方已限制」徽标；
              官方客户端提示登录异常但密码正确。
            </p>
          </section>
          <section>
            <h4 className="font-semibold text-zinc-900">第二步：先止损（重要）</h4>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-zinc-600">
              <li>立即停止对该账号的一切自动化：移出代理池、不要点签到/刷新/切号——被限制期间继续自动化会加重处罚</li>
              <li>同一台电脑上的其他账号也会被连坐排查，全部保持静默，不要再用新账号高频操作</li>
            </ul>
          </section>
          <section>
            <h4 className="font-semibold text-zinc-900">第三步：发申诉邮件（模板可直接复制）</h4>
            <div className="mt-1 flex items-center gap-2">
              <Button size="sm" variant="subtle" onClick={() => void copy(appealTemplate(), 'tpl')}>
                {copied === 'tpl' ? '✓ 已复制模板' : '复制申诉模板'}
              </Button>
              <Button size="sm" variant="subtle" onClick={() => void copy(SUPPORT_MAIL, 'mail')}>
                {copied === 'mail' ? '✓ 已复制邮箱' : `复制邮箱 ${SUPPORT_MAIL}`}
              </Button>
              <a
                className="text-xs text-indigo-600 hover:underline"
                href={`mailto:${SUPPORT_MAIL}?subject=${encodeURIComponent('账号异常限制申诉')}`}
              >
                或直接打开邮件编辑 ↗
              </a>
            </div>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-600">
{appealTemplate()}
            </pre>
            <p className="mt-1 text-xs text-zinc-500">
              把 UID 和发现时间填上再发。模板采取「如实说明 + 已停止 + 恳请复核」的策略——风控数据在官方手里，
              如实陈述是最快路径；一次说清即可，不要短时间重复投递。
            </p>
          </section>
          <section>
            <h4 className="font-semibold text-zinc-900">第四步：等待期间</h4>
            <p className="mt-1 text-xs text-zinc-600">
              申诉后一般 1~3 个工作日回复（官方支持页另有说明）。期间不要换号继续自动化——
              设备已被标记，只会扩大封禁范围。也可以在官方客户端内「头像 → 帮助与反馈」同步提交。
            </p>
          </section>
        </div>
      ) : (
        <div className="space-y-3 text-sm leading-6 text-zinc-700">
          <p className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800">
            原则：官方风控识别的是<b>自动化与伪造行为</b>。本工具已把已知触发点做成了默认防御（你不需要配置任何东西），
            但<b>防御不能保证完全不封</b>——下表同时告诉你「我们做了什么」和「你自己要注意什么」。
          </p>
          {(
            [
              {
                level: 'danger' as const,
                name: '跨账号复制会话 / 搬家 / 去重',
                status: '已停用',
                we: '官方能识别跨账号会话重放，且封号是「一组」而不是一个。2026-10-29 起全入口停用，恢复需设环境变量并自担风险',
                you: '不要试图绕过；历史复制过的账号组保持静默',
              },
              {
                level: 'warn' as const,
                name: '反向代理（agent 接入）',
                status: '已内置防御',
                we: '同一账号串行 + 请求间隔 ≥3 秒 + 全局并发 ≤2 + 单账号每日 500 次上限 + 设备指纹与官方客户端对齐；请求节奏与官方客户端仍有差异',
                you: '控制用量、避免长时间高并发跑批；重要账号不要接入代理池',
              },
              {
                level: 'warn' as const,
                name: '自动签到 / 成长中心',
                status: '已内置防御',
                we: '账号间错峰 3 分钟、夜间（23–06）静默、巡检时刻随机抖动、补对话间隔 20–45 秒随机',
                you: '账号很多时风险叠加，别在同一台机器上养超过日常所需的账号数',
              },
              {
                level: 'warn' as const,
                name: '切换账号',
                status: '已内置防御',
                we: '3 分钟冷却（高频切号本身是异常信号）、杀进程后验证完全退出',
                you: '按需切换即可，不要把切号当「刷新」用',
              },
              {
                level: 'info' as const,
                name: '扫码添加 / 凭据刷新',
                status: '低风险',
                we: '仅登录时与临期时（6 小时巡检一次）出站',
                you: '无需额外注意',
              },
            ] as const
          ).map((r) => (
            <div key={r.name} className="rounded-xl border border-zinc-200 bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-zinc-900">{r.name}</span>
                <Badge color={r.level === 'danger' ? 'red' : r.level === 'warn' ? 'amber' : 'green'}>
                  {r.status}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-zinc-600">
                <b>工具已做：</b>
                {r.we}
              </p>
              <p className="mt-0.5 text-xs text-zinc-600">
                <b>你要注意：</b>
                {r.you}
              </p>
            </div>
          ))}
          <p className="text-xs text-zinc-500">
            共用/买卖账号是官方明令禁止的行为，本工具的任何防御都不适用于这类场景。
          </p>
        </div>
      )}
    </Modal>
  );
}
