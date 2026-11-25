import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Hint,
  IconCheck,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconKey,
  IconLoader,
  IconRefresh,
  IconSliders,
  IconSwitch,
  IconWarning,
  IconZap,
  Note,
  PageSection,
  Skeleton,
  StatCard,
  Switch,
  useConfirm,
  useToast,
} from '../../components/ui';
import { zcodeApi } from '../../lib/zcode';
import type { ZCodeProxyStatus, ZCodeUpstreamTestResponse } from '../../lib/zcode';
import { fmtDateTime, fmtNumber } from '../../lib/format';

/**
 * ZCode 反向代理页：把本机 ZCode 登录态的免费套餐额度以 OpenAI 兼容协议暴露给本机其他 agent。
 *
 * 版式对齐 WorkBuddy 管理的「反向代理」页（统计卡 + 总开关卡 + 密钥 + 上游连通 + 接入方法 +
 * 高级设置 + 请求日志）；ZCode 没有账号池勾选、多协议入站，这些块不放。
 * 界面不接触任何凭据明文，调用 Key 也只在点「显示 / 复制」时从本机服务取一次。
 */

/** 复制：优先 Clipboard API，file:// 等不安全上下文回落到 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 回落到下面的 textarea 方案 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({
  text,
  label = '复制',
  /** 复制前的取数钩子：用于"明文需要时才去后端取一次"的场景（如 API Key） */
  beforeCopy,
}: {
  text: string;
  label?: string;
  beforeCopy?: () => Promise<string> | string;
}) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="subtle"
      onClick={async () => {
        let finalText = text;
        if (beforeCopy) {
          // beforeCopy 失败时它自己已经 toast 过具体错误，这里直接中止
          try {
            finalText = await beforeCopy();
          } catch {
            return;
          }
        }
        if (!finalText) return toast('err', '没有可复制的内容');
        const ok = await copyText(finalText);
        if (!ok) return toast('err', '复制失败，请手动选中复制');
        toast('ok', '已复制');
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      title="复制到剪贴板"
    >
      {done ? <IconCheck className="w-3.5 h-3.5" /> : <IconCopy className="w-3.5 h-3.5" />}
      {done ? '已复制' : label}
    </Button>
  );
}

/** 一行可复制的等宽文本（端点地址 / Key / 路径） */
function CodeRow({ value, copyText: override, beforeCopy }: { value: string; copyText?: string; beforeCopy?: () => Promise<string> }) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-700" title={value}>
        {value}
      </code>
      <div className="shrink-0">
        <CopyButton text={override ?? value} beforeCopy={beforeCopy} />
      </div>
    </div>
  );
}

export default function ZCodeProxyPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<ZCodeProxyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ZCodeUpstreamTestResponse | null>(null);
  /** 明文 Key：默认不下发，点「显示 / 复制」时单独取一次 */
  const [plainKey, setPlainKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  /** 当前登录账号名（「正在使用 xxx 的免费额度」） */
  const [accountName, setAccountName] = useState('');
  /** 高级设置的输入草稿（秒 / 毫秒），保存时才校验并提交 */
  const [timeoutSec, setTimeoutSec] = useState('120');
  const [minIntervalMs, setMinIntervalMs] = useState('3000');
  const [savingAdvanced, setSavingAdvanced] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await zcodeApi.proxyStatus();
      setData(s);
      setTimeoutSec(String(Math.round((s.timeoutMs || 120_000) / 1000)));
      setMinIntervalMs(String(s.minIntervalMs ?? 3000));
    } catch (e: any) {
      toast('err', e?.message || '读取 ZCode 反向代理状态失败');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    // 当前登录账号名只用于展示「正在使用谁的免费额度」，读取失败不影响主流程
    zcodeApi
      .state()
      .then((st) => {
        const c = st.current;
        if (c?.exists) setAccountName(c.label || c.name || c.email || c.userId || '');
      })
      .catch(() => {});
  }, [load]);

  const toggleEnabled = async (on: boolean) => {
    if (!data) return;
    // 乐观更新：开关是高频操作，等 PUT 往返会明显"点了没反应"；失败回滚
    setData((p) => (p ? { ...p, enabled: on } : p));
    try {
      await zcodeApi.proxyConfig({ enabled: on });
      toast('ok', on ? 'ZCode 反向代理已开启' : 'ZCode 反向代理已关闭');
      await load();
    } catch (e: any) {
      setData((p) => (p ? { ...p, enabled: !on } : p));
      toast('err', e?.message || '保存失败');
    }
  };

  /** 取明文 Key（已取过就直接复用本地值）；404 等错误抛给调用方 toast */
  const revealKey = async (): Promise<string> => {
    if (plainKey) return plainKey;
    const r = await zcodeApi.revealProxyKey();
    setPlainKey(r.apiKey);
    return r.apiKey;
  };

  const toggleShowKey = async () => {
    if (!showKey) {
      try {
        await revealKey();
      } catch (e: any) {
        // 404：还没生成 Key（先开启反向代理）等服务端原文直接透出
        toast('err', e?.message || '读取 Key 失败');
        return;
      }
    }
    setShowKey((v) => !v);
  };

  const regenerateKey = async () => {
    const ok = await confirm({
      title: '重新生成 Key',
      message: (
        <>
          重新生成后<span className="text-red-600 font-medium">旧 Key 立即失效</span>
          ，已接入的客户端需要同步更新 Key 才能继续调用。确定继续吗？
        </>
      ),
      confirmText: '重新生成',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await zcodeApi.proxyConfig({ regenerateKey: true });
      // 本地缓存的旧明文必须清掉，否则「显示 / 复制」会一直给旧 Key
      setPlainKey('');
      setShowKey(false);
      toast('ok', '已生成新的 Key，请同步更新各客户端的配置');
      await load();
    } catch (e: any) {
      toast('err', e?.message || '生成失败');
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // 服务端上游请求超时 60 秒，zcodeApi.upstreamTest 已给足前端超时（90 秒）
      const r = await zcodeApi.upstreamTest();
      setTestResult(r);
      toast(r.ok ? 'ok' : 'err', r.ok ? '上游连通正常' : `上游连通失败：${r.error || '未知错误'}`);
    } catch (e: any) {
      toast('err', e?.message || '测试失败');
    } finally {
      setTesting(false);
    }
  };

  const saveAdvanced = async () => {
    const sec = Number(timeoutSec);
    const interval = Number(minIntervalMs);
    if (!Number.isFinite(sec) || sec < 10) return toast('err', '超时至少 10 秒');
    if (!Number.isFinite(interval) || interval < 0) return toast('err', '最小请求间隔不能小于 0 毫秒');
    setSavingAdvanced(true);
    try {
      await zcodeApi.proxyConfig({ timeoutMs: Math.round(sec * 1000), minIntervalMs: Math.round(interval) });
      toast('ok', '高级设置已保存');
      await load();
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSavingAdvanced(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }
  if (!data) return <EmptyState icon={<IconSwitch />} title="读取 ZCode 反向代理状态失败" desc="请确认本地服务正在运行" />;

  const models = data.models?.models || [];
  const modelHint = models[0] || '<模型ID>';
  // 示例里绝不放真 Key：统一用 <你的Key> 占位
  const curlSample = `curl ${data.endpoint}/chat/completions \\\n  -H "Authorization: Bearer <你的Key>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${modelHint}","messages":[{"role":"user","content":"hi"}]}'`;

  return (
    <div className="space-y-5">
      {/* 请求统计 */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="累计请求" value={fmtNumber(data.stats.total)} icon={<IconSwitch />} tone="indigo" />
        <StatCard label="成功" value={fmtNumber(data.stats.ok)} accent="text-emerald-600" icon={<IconCheck />} tone="emerald" />
        <StatCard
          label="失败"
          value={fmtNumber(data.stats.failed)}
          accent={data.stats.failed ? 'text-red-600' : undefined}
          icon={<IconWarning />}
          tone="rose"
        />
      </div>

      {/* 总开关 + 端点 */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-[280px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-900">ZCode 反向代理</h2>
              <Badge color={data.enabled ? 'green' : 'gray'} dot>
                {data.enabled ? '已开启' : '未开启'}
              </Badge>
              {accountName && <Badge color="blue">正在使用 {accountName} 的免费额度</Badge>}
            </div>
            <p className="mt-1.5 text-xs leading-5 text-zinc-500">
              开启后，本机其他 agent（Cherry Studio、Cline、Roo Code、Continue 等 OpenAI 兼容客户端）把 base_url 指向下面的端点地址，
              就能用 ZCode 账号的免费套餐额度发请求；请求由控制台进程转发，需保持控制台运行。
            </p>
            <p className="mt-1.5 text-xs leading-5 text-zinc-400">上游说明：{data.upstream}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Switch checked={data.enabled} onChange={(v) => void toggleEnabled(v)} onText="已开启反向代理" offText="开启反向代理" />
            <Button size="sm" variant="subtle" onClick={() => void load()}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
          </div>
        </div>

        {data.credentialChanged && (
          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs leading-relaxed text-emerald-700">
            检测到 ZCode 登录态变化：反代已自动跟随新账号
          </div>
        )}

        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium text-zinc-600">端点地址（OpenAI 兼容 base_url）</div>
          <CodeRow value={data.endpoint} />
        </div>
        <Hint className="mt-3">
          代理只监听 <span className="font-mono">127.0.0.1</span>，局域网内其他机器访问不到；上游请求走本机 ZCode 登录态，界面不保存任何凭据明文。
        </Hint>
      </Card>

      {/* 调用密钥 */}
      <PageSection icon={<IconKey />} title="调用密钥" desc="客户端用这个 Key 访问本机反代；明文只在点「显示 / 复制」时从本机服务取一次">
        <Card className="p-5">
          {data.apiKeySet ? (
            <>
              <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-700" title={showKey && plainKey ? plainKey : undefined}>
                  {showKey && plainKey ? plainKey : 'sk-…••••••••••••'}
                </code>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="subtle" onClick={() => void toggleShowKey()}>
                  {showKey ? <IconEyeOff className="w-3.5 h-3.5" /> : <IconEye className="w-3.5 h-3.5" />}
                  {showKey ? '隐藏' : '显示'}
                </Button>
                <CopyButton text={plainKey} label="复制 Key" beforeCopy={revealKey} />
                <Button size="sm" variant="subtle" loading={busy} onClick={() => void regenerateKey()}>
                  <IconRefresh className="w-3.5 h-3.5" />
                  重新生成 Key
                </Button>
                <Hint className="flex-1">重新生成后旧 Key 立即失效，已配置过的客户端需要同步更新。</Hint>
              </div>
            </>
          ) : (
            <Note tone="amber" title="还没有调用 Key">
              先在上方开启反向代理，系统会自动生成调用 Key；生成后再回到这里查看或复制。
            </Note>
          )}
        </Card>
      </PageSection>

      {/* 上游连通 */}
      <PageSection
        icon={<IconZap />}
        title="上游连通"
        desc="用当前 ZCode 登录态向上游发一条真实请求，验证凭据与网络"
        actions={
          <Button size="sm" variant="subtle" loading={testing} onClick={() => void runTest()}>
            <IconZap className="w-3.5 h-3.5" />
            测试上游连通
          </Button>
        }
      >
        <Card className="p-5">
          {!testResult ? (
            <div className="text-sm text-zinc-400">{testing ? '正在测试，最长可能需要 60 秒…' : '还没测试过；一次测试最长可能需要 60 秒。'}</div>
          ) : testResult.ok ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-3 text-xs leading-relaxed text-emerald-800">
              <div className="font-medium">上游连通正常，回复：{testResult.reply || '（空回复）'}</div>
              {testResult.usage && <div className="mt-1.5 font-mono text-[11px] text-emerald-700">usage：{JSON.stringify(testResult.usage)}</div>}
            </div>
          ) : (
            <div className="rounded-xl border border-red-200 bg-red-50/70 px-3.5 py-3 text-xs leading-relaxed text-red-700">
              <div className="font-medium">上游连通失败（HTTP {testResult.status || '—'}）</div>
              <div className="mt-1 break-all">{testResult.error || '未知错误'}</div>
              {testResult.hint && <div className="mt-1.5 text-amber-700">{testResult.hint}</div>}
            </div>
          )}
        </Card>
      </PageSection>

      {/* 接入方法 */}
      <PageSection icon={<IconSwitch />} title="接入方法" desc="OpenAI 兼容协议：把客户端的 base_url 与 api_key 指到本机反代即可">
        <Card className="p-5 space-y-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <div className="mb-1.5 text-xs font-medium text-zinc-600">base_url</div>
              <CodeRow value={data.endpoint} />
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-zinc-600">api_key（上面「调用密钥」里的 Key）</div>
              <CodeRow value={plainKey || '<你的Key>'} beforeCopy={revealKey} />
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-600">model（可用模型，点旁边按钮复制模型名）</div>
            {models.length ? (
              <div className="flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <span key={m} className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 py-1">
                    <code className="font-mono text-[11px] text-zinc-600">{m}</code>
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await copyText(m);
                        toast(ok ? 'ok' : 'err', ok ? '已复制' : '复制失败，请手动选中复制');
                      }}
                      className="p-0.5 text-zinc-400 hover:text-indigo-600 transition-colors"
                      title={`复制模型名 ${m}`}
                    >
                      <IconCopy className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-sm text-zinc-400">暂未获取到模型列表</div>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-600">
              curl 示例
              <div className="ml-auto">
                <CopyButton text={curlSample} label="复制示例" />
              </div>
            </div>
            <pre className="overflow-x-auto rounded-xl bg-zinc-900 px-4 py-3 font-mono text-[11px] leading-relaxed text-zinc-100">{curlSample}</pre>
            <Hint className="mt-2">
              示例中的 <span className="font-mono">&lt;你的Key&gt;</span> 请替换为上面「调用密钥」里的真实 Key；
              <span className="font-mono">model</span> 必须填上面模型列表中的 ID；流式请求请在 body 里加
              <span className="font-mono"> "stream": true</span>。
            </Hint>
          </div>
        </Card>
      </PageSection>

      {/* 高级设置 */}
      <PageSection icon={<IconSliders />} title="高级设置" desc="超时与节流参数，保存后立即生效">
        <Card className="p-5">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-600">超时（秒，≥10）</label>
              <input
                type="number"
                min={10}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(e.target.value)}
                className="h-9 w-32 px-3 rounded-xl border border-zinc-200 text-sm tabular-nums outline-none focus:border-indigo-400"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-600">最小请求间隔（毫秒，≥0）</label>
              <input
                type="number"
                min={0}
                value={minIntervalMs}
                onChange={(e) => setMinIntervalMs(e.target.value)}
                className="h-9 w-40 px-3 rounded-xl border border-zinc-200 text-sm tabular-nums outline-none focus:border-indigo-400"
              />
            </div>
            <Button variant="primary" loading={savingAdvanced} onClick={() => void saveAdvanced()}>
              保存
            </Button>
          </div>
          <Hint className="mt-3">
            超时是单次上游请求的最长等待时间；最小请求间隔用于串行节流、降低上游风控压力，设为 0 表示不限制。
          </Hint>
        </Card>
      </PageSection>

      {/* 请求日志 */}
      <PageSection
        icon={<IconLoader />}
        title="请求日志"
        count={data.logs.length}
        desc="仅存于内存，不含任何消息正文"
        actions={
          <Button size="sm" variant="subtle" onClick={() => void load()}>
            <IconRefresh className="w-3.5 h-3.5" />
            刷新
          </Button>
        }
      >
        <Card className="overflow-hidden">
          {data.logs.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-400">还没有请求</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs text-zinc-400">
                    <th className="px-4 py-2 font-medium">时间</th>
                    <th className="px-4 py-2 font-medium">模型</th>
                    <th className="px-4 py-2 font-medium">类型</th>
                    <th className="px-4 py-2 font-medium">耗时</th>
                    <th className="px-4 py-2 font-medium">结果</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50">
                  {data.logs.map((l, i) => (
                    <tr key={`${l.at}-${i}`} className="hover:bg-zinc-50/60 transition-colors">
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-zinc-500 tabular-nums">{fmtDateTime(l.at)}</td>
                      <td className="px-4 py-2 font-mono text-xs text-zinc-600">{l.model || '—'}</td>
                      <td className="px-4 py-2 text-xs text-zinc-500">{l.stream ? '流式' : '非流式'}</td>
                      <td className="px-4 py-2 text-xs text-zinc-500 tabular-nums">{l.ms} ms</td>
                      <td className="px-4 py-2">
                        {l.ok ? (
                          <Badge color="green">{l.status}</Badge>
                        ) : (
                          <span className="text-xs text-red-600" title={l.error || l.note}>
                            {l.error || l.note ? String(l.error || l.note).slice(0, 60) : `HTTP ${l.status}`}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageSection>
    </div>
  );
}
