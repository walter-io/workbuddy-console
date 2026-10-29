import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Hint,
  IconCheck,
  IconCopy,
  IconDatabase,
  IconEye,
  IconEyeOff,
  IconKey,
  IconLoader,
  IconRefresh,
  IconSwitch,
  IconWarning,
  IconZap,
  Note,
  PageSection,
  Segmented,
  StatCard,
  Toolbar,
  useToast,
} from '../components/ui';
import { get, post, put, TIMEOUT } from '../lib/api';
import { fmtDateTime, fmtNumber, fmtRelative } from '../lib/format';
import { explainUpstreamError } from '../lib/proxyHelp';
import { BanRiskGuide } from '../components/BanRiskGuide';
import type { ProxyStatus, ProxyTestResult } from '../lib/types';

/**
 * 反向代理页：把 WorkBuddy 的官方对话能力以多种协议暴露给本机其他 agent。
 *
 * 支持四种协议：OpenAI Chat Completions / Anthropic Messages / OpenAI Responses /
 * Google Gemini 原生。页面只做三件事：开关与凭据、账号池、可观测性（模型 + 请求日志）；
 * 真正的转发与协议转换在服务端 server/proxy/ —— 界面不接触任何 token 明文。
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
        // 有 beforeCopy 就用它返回的最新值，避免复制到占位符/脱敏串
        const finalText = beforeCopy ? await beforeCopy() : text;
        if (!finalText) return toast('err', '没有可复制的内容');
        const ok = await copyText(finalText);
        if (!ok) return toast('err', '复制失败，请手动选中复制');
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

/** 一行可复制的等宽文本（地址 / Key / 命令） */
function CodeRow({
  value,
  masked,
  hasPlain,
  onReveal,
}: {
  value: string;
  masked?: boolean;
  /** 明文是否已在本地（没有则需要先 onReveal 取一次） */
  hasPlain?: boolean;
  /** 点「显示」/「复制」时的取数回调，返回明文（明文不常驻页面，需要时再取一次） */
  onReveal?: () => Promise<string>;
}) {
  const [revealed, setRevealed] = useState(false);
  const hidden = masked && !revealed;
  const shown = hidden ? '•'.repeat(Math.max(12, Math.min(40, value.length))) : value;
  return (
    <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-700" title={hidden ? undefined : value}>
        {shown}
      </code>
      {masked && (
        <button
          onClick={() => {
            if (!revealed && onReveal) void onReveal();
            setRevealed((v) => !v);
          }}
          className="shrink-0 p-1 text-zinc-400 hover:text-zinc-700 transition-colors"
          title={revealed ? '隐藏' : '显示'}
        >
          {revealed ? <IconEyeOff className="w-3.5 h-3.5" /> : <IconEye className="w-3.5 h-3.5" />}
        </button>
      )}
      <div className="shrink-0">
        {/* 明文没取到时，复制前先触发一次取数，避免把脱敏串复制到 agent 配置里 */}
        <CopyButton text={value} beforeCopy={masked && !hasPlain && onReveal ? onReveal : undefined} />
      </div>
    </div>
  );
}

/** 协议族：不同 agent 说不同的"方言"，服务端对每种都有一层适配 */
const PROTOCOLS = [
  { id: 'openai', label: 'OpenAI 兼容' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'responses', label: 'Responses' },
  { id: 'gemini', label: 'Gemini 原生' },
] as const;

type ProtocolId = (typeof PROTOCOLS)[number]['id'];

interface ClientSample {
  id: string;
  protocol: ProtocolId;
  label: string;
  /** 该客户端的注意事项（拼接方式 / 认证方式） */
  hint: string;
  /** base 结尾带 /v1；root 是去掉 /v1 的域名根（Gemini CLI、部分客户端只填域名） */
  body: (base: string, root: string, key: string, model: string) => string;
}

/**
 * 接入示例：覆盖市面上的主流 agent，按协议族分组。
 * 每个片段的 Base URL / Key / 模型 ID 都会按当前控制台实际值渲染，可直接复制。
 */
const CLIENT_SAMPLES: ClientSample[] = [
  /* ---- OpenAI 兼容（复用 /v1/chat/completions，覆盖面最广） ---- */
  {
    id: 'openai-sdk',
    protocol: 'openai',
    label: 'OpenAI SDK',
    hint: '任意语言的 OpenAI SDK 同理：换 base_url 与 api_key',
    body: (base, _root, key, model) =>
      `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}", api_key="${key}")\nresp = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "你好"}],\n)\nprint(resp.choices[0].message.content)`,
  },
  {
    id: 'cherry-studio',
    protocol: 'openai',
    label: 'Cherry Studio',
    hint: '添加 OpenAI 类型提供商，接口地址填到 /v1',
    body: (base, _root, key, model) =>
      `设置 → 模型服务 → 添加提供商\n  提供商类型：OpenAI\n  API 地址    ：${base}\n  API 密钥    ：${key}\n  模型 ID     ：${model}\n\n# 保存后点「检测」，通过即可在对话里选用`,
  },
  {
    id: 'cline-roo',
    protocol: 'openai',
    label: 'Cline / Roo Code',
    hint: 'VS Code 插件里选 OpenAI Compatible',
    body: (base, _root, key, model) =>
      `API Provider : OpenAI Compatible\nBase URL     : ${base}\nAPI Key      : ${key}\nModel ID     : ${model}`,
  },
  {
    id: 'cursor',
    protocol: 'openai',
    label: 'Cursor',
    hint: 'Settings → Models 里填写（需自定义模型覆盖）',
    body: (base, _root, key, model) =>
      `Settings → Models → OpenAI API Key\n  Override OpenAI Base URL：${base}\n  API Key                 ：${key}\n  新增模型                 ：${model}`,
  },
  {
    id: 'continue',
    protocol: 'openai',
    label: 'Continue',
    hint: '写入 ~/.continue/config.json 的 models 数组',
    body: (base, _root, key, model) =>
      `{\n  "models": [\n    {\n      "title": "WorkBuddy",\n      "provider": "openai",\n      "model": "${model}",\n      "apiBase": "${base}",\n      "apiKey": "${key}"\n    }\n  ]\n}`,
  },
  {
    id: 'aider',
    protocol: 'openai',
    label: 'Aider',
    hint: '设好环境变量后按 openai/<模型> 指定',
    body: (base, _root, key, model) =>
      `export OPENAI_API_BASE="${base}"\nexport OPENAI_API_KEY="${key}"\n\naider --model openai/${model}`,
  },
  {
    id: 'trae',
    protocol: 'openai',
    label: 'TRAE CLI',
    hint: 'traecli config edit → trae_cli.yaml；TRAE 同时支持 Claude 协议',
    body: (base, root, key, model) =>
      `# traecli config edit  →  trae_cli.yaml\nmodels:\n  - name: "WorkBuddy"\n    open_ai:\n      base_url: ${base}\n      api_key: "${key}"\n      model: "${model}"\n\n# 也可走 Claude 协议（二选一）：\n#   claude:\n#     base_url: ${root}\n#     api_key: "${key}"\n#     model: "${model}"\n# 若报 404，把 base_url 末尾的 /v1 去掉（或反过来）再试一次`,
  },
  {
    id: 'mimo',
    protocol: 'openai',
    label: '小米 MiMo Code',
    hint: '写入 ~/.config/mimocode/mimocode.jsonc',
    body: (base, _root, key, model) =>
      `{\n  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",\n  "model": "custom/${model}",\n  "provider": {\n    "custom": {\n      "name": "WorkBuddy",\n      "npm": "@ai-sdk/openai-compatible",\n      "only_configured_models": true,\n      "models": { "${model}": { "name": "${model}" } },\n      "options": { "baseURL": "${base}", "apiKey": "${key}" }\n    }\n  }\n}`,
  },
  {
    id: 'doubao',
    protocol: 'openai',
    label: '豆包 / MarsCode',
    hint: '读 OpenAI 环境变量，指向本机代理即可',
    body: (base, _root, key, model) =>
      `export OPENAI_BASE_URL="${base}"\nexport OPENAI_API_KEY="${key}"\nexport OPENAI_MODEL="${model}"\n\n# Windows PowerShell：\n# $env:OPENAI_BASE_URL="${base}"\n# $env:OPENAI_API_KEY="${key}"`,
  },
  {
    id: 'curl',
    protocol: 'openai',
    label: 'curl 直连',
    hint: '排查连通性用；流式请加 "stream": true',
    body: (base, _root, key, model) =>
      `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"hi"}]}'`,
  },

  /* ---- Anthropic Messages（/v1/messages） ---- */
  {
    id: 'claude',
    protocol: 'anthropic',
    label: 'Claude Code',
    hint: '设置环境变量后重新启动 Claude Code 即可',
    body: (base, _root, key, _model) =>
      `export ANTHROPIC_BASE_URL=${base}\nexport ANTHROPIC_AUTH_TOKEN=${key}\n# Windows PowerShell：\n# $env:ANTHROPIC_BASE_URL="${base}"\n# $env:ANTHROPIC_AUTH_TOKEN="${key}"`,
  },
  {
    id: 'anthropic-generic',
    protocol: 'anthropic',
    label: 'Anthropic 兼容客户端',
    hint: 'ZCode 等 Anthropic 模式：协议选 Anthropic，密钥即为 API Key',
    body: (base, _root, key, model) =>
      `协议 / Provider : Anthropic\nBase URL        : ${base}\nAPI Key         : ${key}\nModel           : ${model}\n\n# 走 POST ${base}/messages（Anthropic Messages 协议）`,
  },

  /* ---- OpenAI Responses（/v1/responses） ---- */
  {
    id: 'codex',
    protocol: 'responses',
    label: 'Codex CLI',
    hint: '~/.codex/config.toml，wire_api 用 responses',
    body: (base, _root, key, model) =>
      `# ~/.codex/config.toml\nmodel_provider = "workbuddy"\nmodel = "${model}"\n\n[model_providers.workbuddy]\nname = "WorkBuddy"\nbase_url = "${base}"\nwire_api = "responses"\nenv_key = "WORKBUDDY_API_KEY"\n\n# 然后设置密钥环境变量：\n# export WORKBUDDY_API_KEY=${key}\n# $env:WORKBUDDY_API_KEY="${key}"   # PowerShell`,
  },

  /* ---- Gemini 原生（/v1beta/models/{model}:generateContent） ---- */
  {
    id: 'gemini',
    protocol: 'gemini',
    label: 'Gemini CLI',
    hint: '只填域名根，不要带 /v1beta（CLI 会自己拼）',
    body: (_base, root, key, model) =>
      `export GOOGLE_GEMINI_BASE_URL=${root}\nexport GEMINI_API_KEY=${key}\nexport GEMINI_MODEL=${model}\n\n# Windows PowerShell：\n# $env:GOOGLE_GEMINI_BASE_URL="${root}"\n# $env:GEMINI_API_KEY="${key}"\n\n# ~/.gemini/settings.json（关掉 Google 账号登录，走 API Key）：\n# { "security": { "auth": { "selectedType": "gemini-api-key" } } }\n\n# 验证：\n# gemini -p "Reply with OK only."`,
  },
];

/** Key 携带方式 → 中文（日志里「没带」和「带错」要能分清，两者都是 401 但修法不同） */
const AUTH_LABEL: Record<string, string> = {
  bearer: 'Bearer',
  raw: 'Authorization 裸 Key',
  'x-api-key': 'x-api-key',
  'x-goog-api-key': 'x-goog-api-key',
  query: '?key=',
  none: '未设置 Key',
  absent: '未携带 Key',
  mismatch: 'Key 不匹配',
};

/** UA → 一眼能认出的短名（日志列窄，只取关键词），用来判断「到底是哪个客户端在用」 */
function shortUa(ua?: string | null): string {
  if (!ua) return '—';
  const m = ua.match(
    /(CherryStudio|Claude[- ]Code|claude-cli|codex|Cursor|Cline|Roo|Continue|Aider|Trae|ZCode|GeminiCLI|gemini-cli|openai-python|python-requests|axios|curl|okhttp|Go-http|node)/i
  );
  if (m) return m[1];
  return ua.split(/[\s/]/)[0].slice(0, 24) || '—';
}

export default function ProxyPage() {
  const toast = useToast();
  const [data, setData] = useState<ProxyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [protocol, setProtocol] = useState<ProtocolId>(PROTOCOLS[0].id);
  const [client, setClient] = useState(CLIENT_SAMPLES[0].id);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);
  /** 明文 Key：默认不下发，点「显示」时单独取一次（与模型页 Key 的显示口径一致） */
  const [plainKey, setPlainKey] = useState('');
  /** 一键体检（小白向）：全链路自检结果 */
  const [doctoring, setDoctoring] = useState(false);
  /** 申诉与风险指引弹层（风险横幅入口） */
  const [riskGuideOpen, setRiskGuideOpen] = useState(false);
  interface DoctorCheck { id: string; ok: boolean; label: string; detail: string; fix: string }
  interface DoctorResult { ok: boolean; summary: string; checks: DoctorCheck[] }
  const [doctor, setDoctor] = useState<DoctorResult | null>(null);

  const runDoctor = async () => {
    setDoctoring(true);
    setDoctor(null);
    try {
      const r = await get<DoctorResult>('/api/proxy/doctor', { timeoutMs: TIMEOUT.write });
      setDoctor(r);
      if (r.ok) toast('ok', r.summary);
    } catch (e: any) {
      toast('err', e?.message || '体检失败');
    } finally {
      setDoctoring(false);
    }
  };

  const load = useCallback(async () => {
    try {
      setData(await get<ProxyStatus>('/api/proxy/status'));
    } catch (e: any) {
      toast('err', e?.message || '读取反向代理状态失败');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // 开启后每 8 秒轻刷一次状态（统计与日志才会动起来）；关闭时不需要轮询。
  // 串行 setTimeout：请求超时（25s）大于轮询间隔（8s），setInterval 在服务慢时
  // 会叠加并发请求，抢光浏览器同源连接
  useEffect(() => {
    if (!data?.enabled) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = () => {
      get<ProxyStatus>('/api/proxy/status')
        .then((d) => {
          if (!stopped) setData(d);
        })
        .catch(() => {})
        .finally(() => {
          if (!stopped) timer = window.setTimeout(tick, 8000);
        });
    };
    timer = window.setTimeout(tick, 8000);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [data?.enabled]);

  const toggleEnabled = async (on: boolean) => {
    if (!data) return;
    // 乐观更新：开关是高频操作，等 PUT 往返会明显"点了没反应"
    setData({ ...data, enabled: on });
    try {
      setData(await put<ProxyStatus>('/api/proxy/config', { enabled: on }, { timeoutMs: TIMEOUT.write }));
      toast('ok', on ? '反向代理已开启' : '反向代理已关闭');
    } catch (e: any) {
      setData({ ...data, enabled: !on });
      toast('err', e?.message || '保存失败');
    }
  };

  const toggleAccount = async (id: string, on: boolean) => {
    if (!data) return;
    // 空数组代表"全部账号"：先把当前全量固化成显式列表再增删，避免语义歧义
    const base = data.accountIds.length ? data.accountIds : data.accounts.map((a) => a.id);
    const next = on ? [...new Set([...base, id])] : base.filter((x) => x !== id);
    setData({ ...data, accountIds: next, accounts: data.accounts.map((a) => (a.id === id ? { ...a, selected: on } : a)) });
    try {
      setData(await put<ProxyStatus>('/api/proxy/config', { accountIds: next }, { timeoutMs: TIMEOUT.write }));
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
      void load();
    }
  };

  const rotateKey = async () => {
    setBusy(true);
    try {
      // 服务端要落盘 config.json，写盘重试最坏 36 秒 → 必须给足超时，否则「其实已生成」会被报成超时
      const next = await post<ProxyStatus>('/api/proxy/key/rotate', undefined, { timeoutMs: TIMEOUT.write });
      setData(next);
      // 关键：plainKey 里可能残留旧 key（用户之前点过「显示」），不覆盖就会一直
      // 显示旧值，看起来像「重新生成没生效」。服务端现在会带回新明文。
      setPlainKey(next.apiKey || '');
      toast('ok', '已生成新的 API Key，请同步更新各 agent 的配置');
    } catch (e: any) {
      toast('err', e?.message || '生成失败');
    } finally {
      setBusy(false);
    }
  };

  const refreshModels = async () => {
    setBusy(true);
    try {
      await post('/api/proxy/models/refresh', undefined, { timeoutMs: TIMEOUT.models });
      await load();
      toast('ok', '模型列表已刷新');
    } catch (e: any) {
      toast('err', e?.message || '刷新失败');
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // 不传 model：服务端自会挑（跳过 auto/default 伪模型、优先免费 hy3）。
      // 旧版传 ids[0]="auto" 会被上游路由到不可控的模型，忙时挂 60 秒或 429，还烧积分。
      const r = await post<ProxyTestResult>('/api/proxy/test', {}, { timeoutMs: TIMEOUT.quota });
      setTestResult(r);
      toast(r.ok ? 'ok' : 'err', r.ok ? '连通性自检通过' : `自检失败：${r.error || '未知错误'}`);
      await load();
    } catch (e: any) {
      toast('err', e?.message || '自检失败');
    } finally {
      setTesting(false);
    }
  };

  const usableCount = useMemo(() => (data?.accounts || []).filter((a) => a.usable).length, [data]);
  // 可参与出站的账号 = 可用 且 不是桌面端当前登录账号（后者被服务端强制排除）
  const eligibleCount = useMemo(
    () => (data?.accounts || []).filter((a) => a.usable && !a.isCurrentLogin).length,
    [data]
  );
  // base 结尾带 /v1；root 去掉 /v1（Gemini CLI 等只填域名根）；model 取实拉到的第一个模型
  const rootUrl = (data?.baseUrl || '').replace(/\/v1$/, '');
  // 示例模型提示：清单首位常是伪模型 "auto"（会被上游路由到不可控的付费模型），
  // 小白照抄配置就会烧积分。这里挑真实模型、优先免费（与服务端 pickTestModel 同口径）
  const modelHint = useMemo(() => {
    const ids = (data?.models.ids || []).map((m) => String(m || '').trim()).filter(Boolean);
    const real = ids.filter((m) => !['auto', 'default'].includes(m.toLowerCase()));
    return real.find((m) => /^hy3$/i.test(m)) || real.find((m) => /free|lite|flash/i.test(m)) || real[0] || '<模型 ID>';
  }, [data?.models.ids]);
  const keyHint = plainKey || data?.keyPreview || '<开启后生成>';
  const protocolClients = useMemo(() => CLIENT_SAMPLES.filter((c) => c.protocol === protocol), [protocol]);
  const sample = protocolClients.find((c) => c.id === client) || protocolClients[0];
  const pickProtocol = (p: ProtocolId) => {
    setProtocol(p);
    const first = CLIENT_SAMPLES.find((c) => c.protocol === p);
    if (first) setClient(first.id);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-24 rounded-2xl border border-zinc-200 bg-white" />
        <div className="h-40 rounded-2xl border border-zinc-200 bg-white" />
      </div>
    );
  }
  if (!data) return <EmptyState icon={<IconSwitch />} title="读取反向代理状态失败" desc="请确认本地服务正在运行" />;

  return (
    <div className="space-y-5">
      {/* 概览：累计请求等核心指标放最上方 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="累计请求" value={fmtNumber(data.stats.total)} icon={<IconSwitch />} tone="indigo" />
        <StatCard label="成功" value={fmtNumber(data.stats.ok)} accent="text-emerald-600" icon={<IconCheck />} tone="emerald" />
        <StatCard label="失败" value={fmtNumber(data.stats.failed)} accent={data.stats.failed ? 'text-red-600' : undefined} icon={<IconWarning />} tone="rose" />
        <StatCard
          label="可用模型"
          value={fmtNumber(data.models.ids.length)}
          sub={data.models.fetchedAt ? `${fmtRelative(data.models.fetchedAt)}更新` : '未拉取'}
          icon={<IconDatabase />}
          tone="violet"
        />
      </div>

      {/* 账号池：参与轮换的账号放最上方 */}
      <PageSection
        icon={<IconKey />}
        title="参与轮换的账号"
        count={`${data.poolCount}/${usableCount}`}
        desc="只有扫码登录导入的账号（含明文凭据）能用于出站请求；桌面端当前登录的账号会被自动排除，避免同一账号被上游风控连坐"
        actions={
          <Button size="sm" variant="subtle" onClick={() => void load()}>
            <IconRefresh className="w-3.5 h-3.5" />
            刷新
          </Button>
        }
      >
        {data.accounts.length === 0 ? (
          <EmptyState icon={<IconKey />} title="账号库里还没有账号" desc="请先到「账号管理」扫码添加或导入本机登录态" />
        ) : (
          <Card className="divide-y divide-zinc-100">
            {data.accounts.map((a) => (
              <label
                key={a.id}
                className={`flex flex-wrap items-center gap-3 px-4 py-3 ${a.usable && !a.isCurrentLogin ? 'cursor-pointer' : 'opacity-60'}`}
              >
                <input
                  type="checkbox"
                  checked={a.selected && a.usable && !a.isCurrentLogin}
                  disabled={!a.usable || a.isCurrentLogin}
                  onChange={(e) => void toggleAccount(a.id, e.target.checked)}
                  className="accent-indigo-600 rounded"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-800">{a.name}</span>
                <Badge color="gray">{a.variantLabel}</Badge>
                {a.restriction && (
                  <Badge color="red" dot>
                    官方已限制（{a.restriction.code}）
                  </Badge>
                )}
                {a.isCurrentLogin && (
                  <Badge color="blue" dot>
                    桌面端登录中 · 不参与出站
                  </Badge>
                )}
                {a.usable ? (
                  <Badge color={a.expired ? 'amber' : 'green'} dot>
                    {a.expired ? '凭据已过期（将自动刷新）' : '可用'}
                  </Badge>
                ) : (
                  <Badge color="gray">无明文凭据，不可用</Badge>
                )}
                {a.expiresAt && <span className="text-[11px] text-zinc-400 tabular-nums">{fmtDateTime(a.expiresAt)} 过期</span>}
              </label>
            ))}
          </Card>
        )}
      </PageSection>

      {/* 总开关 + 凭据 */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-[280px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-900">反向代理（多协议）</h2>
              <Badge color={data.enabled ? 'green' : 'gray'} dot>
                {data.enabled ? '已开启' : '已关闭'}
              </Badge>
              {data.enabled && <Badge color="blue">{data.poolCount} 个账号在池中</Badge>}
            </div>
            <p className="mt-1.5 text-xs leading-5 text-zinc-500">
              开启后，本机其他 agent（Claude Code、Codex CLI、Gemini CLI、Cherry Studio、Cline、TRAE、小米 MiMo、豆包等）
              把地址指向下面的 Base URL，就能用 WorkBuddy 账号的积分与模型额度发请求。出站按「积分最早过期优先」
              排序，先用快过期的积分；某账号对某模型撞限额时自动换号并冷却 10 分钟；401 时自动刷新 token 再重试。
              桌面端当前登录的账号会自动排除在池外，
              避免同一账号被上游风控连坐（11128）导致官方客户端不可用。
            </p>
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-800">
              <b>封号风险提示（2026-10 用户实测）</b>：反代流量的请求节奏与官方客户端存在差异，高频 / 大批量使用
              仍可能被上游风控判定并封禁关联账号（同机账号会被连坐）。本工具已内置防御：同一账号的请求串行且
              间隔至少 3 秒、全局并发上限 2、单账号每日 500 次上限、设备指纹与官方客户端对齐——但<b>无法保证完全规避</b>。
              请控制用量、避免长时间高并发跑批，重要账号不要接入代理池。
              {(() => {
                // 横幅内的申诉指引入口：直接打开共用弹层
                return (
                  <>
                    {' '}账号已被限制？<button type="button" onClick={() => setRiskGuideOpen(true)} className="font-semibold underline hover:text-amber-900">看申诉教程与官方入口 →</button>
                  </>
                );
              })()}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-zinc-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={data.enabled}
                onChange={(e) => void toggleEnabled(e.target.checked)}
                className="accent-indigo-600 rounded"
              />
              {data.enabled ? '已开启反向代理' : '开启反向代理'}
            </label>
            <Button size="sm" variant="subtle" loading={testing} onClick={() => void runTest()} disabled={!data.enabled || !data.poolCount}>
              <IconZap className="w-3.5 h-3.5" />
              连通性自检
            </Button>
            <Button size="sm" variant="subtle" loading={doctoring} onClick={() => void runDoctor()}>
              一键体检
            </Button>
          </div>
        </div>

        {doctor && (
          <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
            <div className={`text-xs font-semibold ${doctor.ok ? 'text-emerald-700' : 'text-amber-700'}`}>
              {doctor.ok ? '✅ ' : '⚠️ '}
              {doctor.summary}
            </div>
            <div className="mt-2 space-y-1.5">
              {doctor.checks.map((c) => {
                const adv = !c.ok ? explainUpstreamError(c.detail) : null;
                return (
                  <div key={c.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <span className={c.ok ? 'text-emerald-600' : 'text-red-600'}>{c.ok ? '✓' : '✗'}</span>
                    <span className="font-medium text-zinc-700">{c.label}</span>
                    <span className="text-zinc-500">{c.detail}</span>
                    {adv && (
                      <span className={adv.level === 'danger' ? 'text-red-700' : 'text-zinc-600'}>
                        （{adv.what}：{adv.todo}）
                      </span>
                    )}
                    {c.fix && <span className="text-amber-700">→ {c.fix}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-600">Base URL（填到 agent 的 base_url）</div>
            <CodeRow value={data.baseUrl} />
          </div>
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-600">
              API Key
              {data.hasKey ? (
                <span className="font-mono text-[11px] font-normal text-zinc-400">{data.keyPreview}</span>
              ) : (
                <span className="text-[11px] font-normal text-zinc-400">开启后自动生成</span>
              )}
            </div>
            {data.hasKey ? (
              <CodeRow
                value={plainKey || data.keyPreview}
                masked={!plainKey}
                hasPlain={!!plainKey}
                onReveal={async () => {
                  if (plainKey) return plainKey;
                  try {
                    const s = await get<ProxyStatus>('/api/proxy/status?reveal=1');
                    setPlainKey(s.apiKey || '');
                    return s.apiKey || '';
                  } catch (e: any) {
                    toast('err', e?.message || '读取 Key 失败');
                    return '';
                  }
                }}
              />
            ) : (
              <div className="rounded-xl bg-zinc-50 px-3 py-2 text-xs text-zinc-400">开启反向代理后自动生成</div>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Hint className="flex-1">
            代理只监听 <span className="font-mono">127.0.0.1</span>，局域网内其他机器访问不到；重新生成 Key 后，已配置过的 agent 需要同步更新。
            代理由控制台进程提供，需保持控制台运行（桌面版关闭窗口后会驻留系统托盘，不会中断）。
          </Hint>
          <Button size="sm" variant="subtle" loading={busy} onClick={() => void rotateKey()} disabled={!data.hasKey}>
            <IconRefresh className="w-3.5 h-3.5" />
            重新生成 Key
          </Button>
        </div>

        {testResult && (
          <div className="mt-3">
            <Note tone={testResult.ok ? 'zinc' : 'amber'} title={testResult.ok ? `自检通过：${testResult.account} · ${testResult.model}` : '自检失败'}>
              {testResult.ok ? testResult.preview || '上游已返回内容' : testResult.error || '未知错误'}
            </Note>
          </div>
        )}

        {data.enabled && data.poolCount === 0 && (
          <div className="mt-3">
            <Note tone="amber" title="当前账号池是空的">
              {eligibleCount > 0
                ? '请在上方「参与轮换的账号」里至少勾选一个账号。'
                : usableCount > 0
                  ? '可用的账号只有桌面端当前登录的那个——该账号不参与代理出站（避免同一账号被上游风控连坐官方客户端）。请先切换客户端登录账号，或再导入一个账号。'
                  : '账号库里没有可用于出站请求的账号（需要扫码登录导入的明文凭据），请先到「账号管理」添加。'}
            </Note>
          </div>
        )}
      </Card>

      {/* 模型 */}
      <PageSection
        icon={<IconDatabase />}
        title="可用模型"
        count={data.models.ids.length}
        desc="从上游实时拉取；这些模型 ID 就是 agent 里填的 model"
        actions={
          <Button size="sm" variant="subtle" loading={busy} onClick={() => void refreshModels()} disabled={!data.poolCount}>
            <IconRefresh className="w-3.5 h-3.5" />
            刷新模型列表
          </Button>
        }
      >
        <Card className="p-4">
          {data.models.error ? (
            <div className="text-sm text-amber-700">拉取失败：{data.models.error}</div>
          ) : data.models.ids.length ? (
            <div className="flex flex-wrap gap-1.5">
              {data.models.ids.map((id) => (
                <button
                  key={id}
                  onClick={async () => {
                    const ok = await copyText(id);
                    toast(ok ? 'ok' : 'err', ok ? `已复制模型 ID：${id}` : '复制失败');
                  }}
                  className="rounded-lg border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
                  title="点击复制模型 ID"
                >
                  {id}
                </button>
              ))}
            </div>
          ) : (
            <div className="text-sm text-zinc-400">尚未拉取模型列表，点右上角「刷新模型列表」</div>
          )}
        </Card>
      </PageSection>

      {/* 接入示例 */}
      <PageSection
        icon={<IconZap />}
        title="接入示例"
        desc="选协议族 → 选客户端 → 复制配置；模型 ID 请用上面列表里的"
      >
        <Card className="p-4">
          <Toolbar className="mb-3">
            <Segmented
              value={protocol}
              onChange={(v) => pickProtocol(v as ProtocolId)}
              options={PROTOCOLS.map((p) => ({ value: p.id, label: p.label }))}
              size="sm"
            />
            <span className="text-xs text-zinc-400">{sample.hint}</span>
            <div className="ml-auto">
              <CopyButton
                text={sample.body(data.baseUrl, rootUrl, plainKey || '<点上方 Key 的「显示」后复制>', modelHint)}
                label="复制配置"
              />
            </div>
          </Toolbar>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {protocolClients.map((c) => (
              <button
                key={c.id}
                onClick={() => setClient(c.id)}
                className={`rounded-lg border px-2 py-1 text-[11px] transition-colors ${
                  c.id === sample.id
                    ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                    : 'border-zinc-200 bg-white text-zinc-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <pre className="overflow-x-auto rounded-xl bg-zinc-900 px-4 py-3 font-mono text-[11px] leading-relaxed text-zinc-100">
            {sample.body(data.baseUrl, rootUrl, keyHint, modelHint)}
          </pre>
          <Hint className="mt-2">
            示例里的 Key 是脱敏预览，真实 Key 请点上方「显示」后复制；<span className="font-mono">model</span> 必须填上面模型列表中的 ID。
            Claude Code / Codex / Gemini CLI 走各自的原生协议（<span className="font-mono">/v1/messages</span>、
            <span className="font-mono">/v1/responses</span>、<span className="font-mono">/v1beta/models/…</span>），
            其余客户端都走 OpenAI 兼容的 <span className="font-mono">/v1/chat/completions</span>。
          </Hint>
        </Card>
      </PageSection>

      {/* 请求日志 */}
      <PageSection
        icon={<IconLoader />}
        title="请求日志"
        count={data.logs.length}
        desc="仅存于内存（最多 50 条展示），不含任何消息正文"
        actions={
          <Button size="sm" variant="subtle" onClick={() => void load()}>
            <IconRefresh className="w-3.5 h-3.5" />
            刷新
          </Button>
        }
      >
        {data.logs[0] && !data.logs[0].ok && (
          <Note tone="amber" title="最近一次请求失败">
            {data.logs[0].error || '未知错误'}
            {data.logs[0].path ? ` · 路径 ${data.logs[0].path}` : ''}
            {data.logs[0].auth ? ` · Key 方式 ${AUTH_LABEL[data.logs[0].auth] || data.logs[0].auth}` : ''}
            {data.logs[0].ua ? ` · 来自 ${shortUa(data.logs[0].ua)}` : ''}
          </Note>
        )}
        <Card className="overflow-hidden">
          {data.logs.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-400">还没有请求记录</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs text-zinc-400">
                  <th className="px-4 py-2 font-medium">时间</th>
                  <th className="px-4 py-2 font-medium">客户端</th>
                  <th className="px-4 py-2 font-medium">账号</th>
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
                    <td className="px-4 py-2 text-xs text-zinc-600" title={l.ua || ''}>
                      {shortUa(l.ua)}
                    </td>
                    <td className="px-4 py-2 text-zinc-700">{l.account || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-zinc-600">{l.model || '—'}</td>
                    <td className="px-4 py-2 text-xs text-zinc-500">{l.stream ? '流式' : '非流式'}</td>
                    <td className="px-4 py-2 text-xs text-zinc-500 tabular-nums">{l.ms} ms</td>
                    <td className="px-4 py-2">
                      {l.ok ? (
                        <Badge color="green">{l.status}</Badge>
                      ) : (
                        <span className="text-xs text-red-600" title={l.errorRaw || l.error}>
                          {l.error ? l.error.slice(0, 60) : l.status}
                          {(() => {
                            const adv = explainUpstreamError(l.errorRaw || l.error);
                            return adv ? (
                              <span className="mt-0.5 block text-[11px] font-normal text-zinc-500">
                                {adv.level === 'danger' ? '⛔' : adv.level === 'warn' ? '⚠️' : 'ℹ️'} {adv.what}：{adv.todo}
                              </span>
                            ) : null;
                          })()}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </PageSection>
      <BanRiskGuide open={riskGuideOpen} onClose={() => setRiskGuideOpen(false)} />
    </div>
  );
}
