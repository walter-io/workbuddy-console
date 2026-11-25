import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconChevronDown,
  IconCopy,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconInfo,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconWarning,
  Modal,
  PlatformNote,
  Segmented,
  Skeleton,
  Spinner,
  useConfirm,
  useToast,
} from '../components/ui';
import { get, post, TIMEOUT } from '../lib/api';
import { onSettingsChanged } from '../lib/appSettings';
import type {
  ExportResponse,
  KeyInfo,
  KeysResponse,
  LoadedInfo,
  LoadResult,
  ModelsResponse,
  ORModel,
  PlatformInfo,
} from '../lib/types';
import { fmtContext, fmtDate, fmtPricePerM, fmtRelative } from '../lib/format';

type SortKey = 'created' | 'context' | 'name' | 'price';

const DEFAULT_PAGE_SIZE = 50;

/** 客户端模型列表缓存：切换平台秒开；超过 TTL 由定时器在后台静默刷新，手动「刷新」才强制回源 */
const CLIENT_TTL = 5 * 60_000;
const modelsCache = new Map<string, { data: ModelsResponse; at: number }>();

function kindBadge(m: ORModel) {
  if (m.outputKind === 'image') return <Badge color="violet">图像生成</Badge>;
  if (m.outputKind === 'video') return <Badge color="amber">视频生成</Badge>;
  return null;
}

/** 平台切换 pills：默认停在 OpenRouter；圆点表示该平台是否已配置 Key。
 * 置灰平台不可浏览（region = 地区受限；platform = 平台限制外部使用），点击提示原因。 */
function PlatformTabs({
  platforms,
  active,
  onChange,
  onDisabledClick,
}: {
  platforms: PlatformInfo[];
  active: string;
  onChange: (id: string) => void;
  onDisabledClick: (p: PlatformInfo) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pb-3.5 mb-3.5 border-b border-zinc-100">
      {platforms.length === 0 &&
        Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-20 rounded-xl" />)}
      {platforms.map((p) => {
        const isActive = active === p.id;
        const disabled = !!p.uiDisabled;
        const title = disabled
          ? `${p.name}（${p.uiDisabled === 'region' ? '地区受限暂无法使用' : '平台限制无法在外部使用'}）`
          : `${p.name}（${p.keyCount ? '已配置 Key' : '未配置 Key'}）${p.restriction ? ` — ⚠ ${p.restriction === 'region' ? '地区受限，可能无法调用' : '平台禁止外部接入，接入后可能被拒'}` : ''}${!p.restriction && p.note ? ` — ${p.note}` : ''}`;
        return (
          <button
            key={p.id}
            onClick={() => (disabled ? onDisabledClick(p) : onChange(p.id))}
            title={title}
            className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-xl text-xs font-medium transition-all duration-150 border ${
              disabled
                ? 'bg-zinc-50 text-zinc-400 border-zinc-200 cursor-not-allowed hover:bg-zinc-100'
                : isActive
                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm shadow-indigo-600/25'
                  : 'bg-white text-zinc-600 border-zinc-200 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/50'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${disabled ? 'bg-zinc-300' : isActive ? 'bg-white/80' : p.keyCount ? 'bg-emerald-500' : 'bg-zinc-300'}`}
            />
            {p.shortName}
          </button>
        );
      })}
    </div>
  );
}

/** 表格骨架：首次加载/切换平台时占位，保持页面结构与工具栏可用 */
function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <Card className="overflow-hidden animate-fade-in">
      <div className="bg-zinc-50/80 border-b border-zinc-100 h-9 flex items-center px-4 gap-4">
        {['w-32', 'w-16', 'w-14', 'w-24', 'w-20', 'w-14', 'w-12'].map((w, i) => (
          <Skeleton key={i} className={`h-3 ${w}`} />
        ))}
      </div>
      <div className="divide-y divide-zinc-50">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3.5">
            <Skeleton className="h-4 w-4 rounded" />
            <div className="flex-1 min-w-0 space-y-1.5">
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="h-2.5 w-64" />
            </div>
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-4 w-14 rounded" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
    </Card>
  );
}

/** 本次应用会话内已提醒过"配置待生效"的 models.json mtime：同一次变更只弹窗一次 */
let lastPromptedMtime = 0;

export default function ModelsPage({ active = true, onGoKeys }: { active?: boolean; onGoKeys?: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();

  const [platform, setPlatform] = useState('openrouter');
  const platformRef = useRef('openrouter');
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 筛选：只看免费模型，除「搜索 + 排序」外不再提供其它筛选
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('created');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  // 载入相关
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [activeKeys, setActiveKeys] = useState<Record<string, string | null>>({});
  const [loadedInfo, setLoadedInfo] = useState<LoadedInfo | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadKey, setLoadKey] = useState('');
  const [loadOpen, setLoadOpen] = useState(false);
  const [loadResult, setLoadResult] = useState<LoadResult | null>(null);
  const [loadLoading, setLoadLoading] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [showLoadedPanel, setShowLoadedPanel] = useState(false);
  const [restartPrompt, setRestartPrompt] = useState(false);
  const [bannerDismissedAt, setBannerDismissedAt] = useState<number | null>(null);

  // 导出配置（拷给其他 agent：只算不写，不改动任何文件）
  const [exportOpen, setExportOpen] = useState(false);
  const [exportData, setExportData] = useState<ExportResponse | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  // 本次导出针对的模型 ID 列表；null 表示导出当前勾选的模型
  const [exportIds, setExportIds] = useState<string[] | null>(null);

  const platformName = platforms.find((p) => p.id === platform)?.name || data?.platformName || platform;
  const platformMeta = platforms.find((p) => p.id === platform);

  /** 拉取指定平台模型列表。force=true 绕过服务端缓存强制回源；有缓存可展示时失败不打扰用户 */
  const fetchModels = useCallback(async (pf: string, force = false) => {
    setRefreshing(true);
    try {
      const r = await get<ModelsResponse>(`/api/models?platform=${encodeURIComponent(pf)}${force ? '&refresh=1' : ''}`, { timeoutMs: TIMEOUT.models });
      if ((r as any).needsKey) throw new Error((r as any).error || '需要配置 API Key');
      modelsCache.set(pf, { data: r, at: Date.now() });
      if (platformRef.current === pf) {
        setData(r);
        setError(null);
      }
    } catch (e: any) {
      if (platformRef.current === pf && !modelsCache.has(pf)) {
        setError(e?.message || '加载失败');
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  /** 展示某平台：有缓存立即渲染，过期则后台补一次刷新；无缓存才整页加载 */
  const showPlatform = useCallback(
    (pf: string) => {
      const cached = modelsCache.get(pf);
      if (cached) {
        setData(cached.data);
        setError(null);
        setLoading(false);
        if (Date.now() - cached.at > CLIENT_TTL) fetchModels(pf, false);
      } else {
        setData(null);
        setLoading(true);
        fetchModels(pf, false).finally(() => setLoading(false));
      }
    },
    [fetchModels]
  );

  const loadSideData = useCallback(async () => {
    get<{ platforms: PlatformInfo[] }>('/api/platforms')
      .then((r) => {
        const list = r.platforms || [];
        setPlatforms(list);
        // 关掉「显示全部平台」后，当前停留的受限平台会重新置灰：退回默认平台，
        // 否则用户会停在一个已不可用的平台上看到空列表
        const cur = list.find((p) => p.id === platformRef.current);
        if (cur?.uiDisabled) showPlatform('openrouter');
      })
      .catch(() => {});
    get<KeysResponse>('/api/keys')
      .then((r) => {
        setKeys(r.keys);
        setActiveKeys(r.activeKeys || {});
      })
      .catch(() => {});
    get<LoadedInfo>('/api/workbuddy/status')
      .then((info) => {
        setLoadedInfo(info);
        // 配置有变更且 WorkBuddy 运行中：同一次变更（按 mtime 识别）只弹窗提醒一次
        if (info.running && info.pendingRestart && info.modelsJsonMtime && info.modelsJsonMtime !== lastPromptedMtime) {
          lastPromptedMtime = info.modelsJsonMtime;
          setRestartPrompt(true);
        }
      })
      .catch(() => {});
  }, [showPlatform]);

  useEffect(() => {
    showPlatform('openrouter');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 页签激活时刷新侧数据：在设置页增删 Key / 载入模型后切回免费模型，平台圆点与状态立即更新
  useEffect(() => {
    if (active) loadSideData();
  }, [active, loadSideData]);

  // 设置里改了「显示全部平台」：就地重取平台列表，不必手动刷新页面
  // （页面是常驻挂载的，外层切页不会触发上面的 active 变化，这正是之前要按 F5 的原因）
  useEffect(
    () =>
      onSettingsChanged((patch) => {
        if (patch.unlockAllPlatforms !== undefined) loadSideData();
      }),
    [loadSideData]
  );

  // 定期刷新：每分钟检查一次，数据超过 5 分钟就在后台静默更新（不挡界面）
  useEffect(() => {
    const t = setInterval(() => {
      const cached = modelsCache.get(platformRef.current);
      if (cached && Date.now() - cached.at > CLIENT_TTL) fetchModels(platformRef.current, false);
    }, 60_000);
    return () => clearInterval(t);
  }, [fetchModels]);

  const switchPlatform = (id: string) => {
    if (id === platformRef.current) return;
    platformRef.current = id;
    setPlatform(id);
    setSelected(new Set());
    setQ('');
    setSort('created');
    setPage(1);
    showPlatform(id);
  };

  /** 点击置灰平台：提示不可用原因 */
  const handleDisabledClick = (p: PlatformInfo) => {
    toast('info', `${p.name}：${p.uiDisabled === 'region' ? '地区受限暂无法使用' : '平台限制无法在外部使用'}`);
  };

  // 载入用 key：当前平台的活跃 key（无则该平台第一个）
  const platformKeys = useMemo(() => keys.filter((k) => k.platform === platform), [keys, platform]);
  useEffect(() => {
    setLoadKey(activeKeys[platform] || platformKeys[0]?.id || '');
  }, [platform, platformKeys, activeKeys]);

  const loadedIds = useMemo(() => new Set((loadedInfo?.loaded || []).map((e) => e.id)), [loadedInfo]);
  const platformNameOf = (id: string) => platforms.find((p) => p.id === id)?.shortName || id;

  const filtered = useMemo(() => {
    let list = data?.models || [];
    const kw = q.trim().toLowerCase();
    if (kw) {
      list = list.filter(
        (m) => m.id.toLowerCase().includes(kw) || m.name.toLowerCase().includes(kw) || m.description.toLowerCase().includes(kw)
      );
    }
    // 只保留免费模型（广场定位如此，不再提供付费/全部切换）
    list = list.filter((m) => m.isFree);

    const sorted = [...list];
    if (sort === 'created') sorted.sort((a, b) => (b.created || 0) - (a.created || 0));
    if (sort === 'context') sorted.sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0));
    if (sort === 'name') sorted.sort((a, b) => a.id.localeCompare(b.id));
    if (sort === 'price')
      sorted.sort((a, b) => (a.pricing?.prompt ?? 0) + (a.pricing?.completion ?? 0) - ((b.pricing?.prompt ?? 0) + (b.pricing?.completion ?? 0)));
    return sorted;
  }, [data, q, sort]);

  useEffect(() => setPage(1), [q, sort, pageSize]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const freeCount = useMemo(() => (data?.models || []).filter((m) => m.isFree).length, [data]);

  const selectable = (m: ORModel) => m.outputKind === 'text' && m.loadable !== false;
  const pageSelectableIds = pageItems.filter(selectable).map((m) => m.id);
  const allPageSelected = pageSelectableIds.length > 0 && pageSelectableIds.every((id) => selected.has(id));

  const anyFilterActive = !!q.trim() || sort !== 'created';

  const resetFilters = () => {
    setQ('');
    setSort('created');
  };

  const toggleSelect = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      on ? next.add(id) : next.delete(id);
      return next;
    });
  };
  const toggleSelectAllPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageSelectableIds.forEach((id) => next.delete(id));
      else pageSelectableIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const selectedFree = useMemo(() => {
    const all = data?.models || [];
    return [...selected].filter((id) => all.find((m) => m.id === id)?.isFree).length;
  }, [selected, data]);

  const doLoad = async () => {
    setLoadLoading(true);
    try {
      const r = await post<LoadResult>('/api/workbuddy/load', { platform, modelIds: [...selected], keyId: loadKey || undefined }, { timeoutMs: TIMEOUT.write });
      setLoadResult(r);
      setLoadOpen(false);
      setSelected(new Set());
      toast('ok', `载入完成：新增 ${r.added} 个，更新 ${r.updated} 个`);
      loadSideData();
    } catch (e: any) {
      toast('err', e?.message || '载入失败');
    } finally {
      setLoadLoading(false);
    }
  };

  /* ---------------- 导出配置给其他 agent（只算不写，不改动任何文件） ---------------- */

  /** reveal=true 时服务端才回 Key 明文；默认只回脱敏尾巴 */
  const fetchExport = async (reveal: boolean, ids?: string[]) => {
    setExportLoading(true);
    try {
      const r = await post<ExportResponse>('/api/export/entries', {
        platform,
        modelIds: ids ?? exportIds ?? [...selected],
        keyId: loadKey || undefined,
        reveal,
      });
      setExportData(r);
    } catch (e: any) {
      toast('err', e?.message || '生成配置失败');
      setExportOpen(false);
      setExportData(null);
    } finally {
      setExportLoading(false);
    }
  };

  /** 传入 modelId 时只导出该模型（行内按钮），否则导出当前勾选的模型 */
  const openExport = (modelId?: string) => {
    const ids = modelId ? [modelId] : null;
    setExportIds(ids);
    setExportData(null);
    setExportOpen(true);
    fetchExport(false, ids ?? undefined);
  };

  const copyText = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast('ok', `已复制${label}`),
      () => toast('err', '复制失败，请手动选中后复制')
    );
  };

  /** 与 WorkBuddy models.json 条目格式一致，可直接粘进其他 agent */
  const exportJson = useMemo(() => {
    if (!exportData) return '';
    return JSON.stringify(exportData.entries.map((e) => ({ ...e, apiKey: exportData.apiKey || e.apiKey })), null, 2);
  }, [exportData]);

  const revealed = !!exportData?.apiKey;

  const doRemove = async (id: string) => {
    const ok = await confirm({
      title: '从 WorkBuddy 移除模型',
      message: (
        <>
          确定移除 <span className="font-mono text-zinc-800">{id}</span> 吗？
          <br />
          移除前会自动备份 <span className="font-mono">models.json</span>，可在备份目录回滚。
        </>
      ),
      confirmText: '移除',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await post<{ removed: number; backup: string | null }>('/api/workbuddy/remove', { modelIds: [id] }, { timeoutMs: TIMEOUT.write });
      toast('ok', `已移除 ${r.removed} 个模型` + (r.backup ? `，备份：${r.backup.split(/[\\/]/).pop()}` : ''));
      loadSideData();
    } catch (e: any) {
      toast('err', e?.message || '移除失败');
    }
  };

  const doRestart = async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      await post('/api/workbuddy/restart', undefined, { timeoutMs: TIMEOUT.write });
      toast('ok', 'WorkBuddy 已重启，模型配置生效');
      loadSideData();
    } catch (e: any) {
      toast('err', e?.message || '重启失败，请手动重启 WorkBuddy');
    } finally {
      setRestarting(false);
    }
  };

  const copyId = (id: string) => {
    navigator.clipboard?.writeText(id).then(
      () => toast('info', `已复制 ${id}`),
      () => {}
    );
  };

  // 首次加载 / 切换平台：保留工具栏与平台页签，仅表格区显示骨架
  const skeleton = (loading && !data) || (!data && !error);

  const toolbar = (
    <Card className="p-4">
      <PlatformTabs
        platforms={platforms}
        active={platform}
        onChange={switchPlatform}
        onDisabledClick={handleDisabledClick}
      />

      {/* 设置里开放了「显示全部平台」时，受限平台也能选——这里常驻风险提示，别让用户以为接不上是工具的问题 */}
      {platformMeta?.restriction && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-700">
          <IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <span className="font-medium">{platformName} 对调用来源有限制（{platformMeta.restriction === 'region' ? '地区受限' : '平台禁止外部接入'}）</span>
            ，你在设置里开启了「显示全部平台」所以这里可以选。接入后可能<b>请求被拒、频繁限流，甚至账号被风控</b>
            ——这是平台侧的限制，不是控制台配置有误。如需关闭，去「设置 → 免费模型平台」取消勾选。
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative">
          <IconSearch className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索模型 ID / 名称 / 描述"
            className="w-64 h-9 pl-9 pr-3 rounded-xl border border-zinc-200 text-sm outline-none transition-shadow focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="h-9 px-2.5 rounded-xl border border-zinc-200 text-sm bg-white outline-none focus:border-indigo-400 ml-auto"
        >
          <option value="created">排序：最新发布</option>
          <option value="context">排序：上下文最大</option>
          <option value="price">排序：价格最低</option>
          <option value="name">排序：名称</option>
        </select>
        <Button variant="subtle" loading={refreshing} onClick={() => fetchModels(platform, true)} title="绕过缓存，强制从平台重新拉取模型列表">
          <IconRefresh className="w-4 h-4" />
          刷新
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-400">
        {data ? (
          <>
            <span>
              该平台共 <b className="text-zinc-600">{data.count ?? 0}</b> 个模型，其中免费{' '}
              <b className="text-emerald-600">{freeCount}</b> 个（本页只展示免费模型）
            </span>
            <span>
              当前筛选 <b className="text-zinc-600">{filtered.length}</b> 个
            </span>
            <span>列表更新于 {fmtRelative(data.fetchedAt)}</span>
          </>
        ) : (
          <Skeleton className="h-3 w-72" />
        )}
        {loadedInfo && (
          <span
            title={
              [loadedInfo.detectError ? `无法确认运行状态：${loadedInfo.detectError}` : null, loadedInfo.detectWarning].filter(Boolean).join('\n') ||
              undefined
            }
          >
            <Badge color={loadedInfo.running ? 'green' : loadedInfo.detectError ? 'amber' : 'gray'} dot>
              WorkBuddy {loadedInfo.running ? '运行中' : loadedInfo.detectError ? '状态未知' : '未运行'}
            </Badge>
          </span>
        )}
        {anyFilterActive && (
          <button className="text-indigo-500 hover:text-indigo-700 hover:underline transition-colors" onClick={resetFilters}>
            清空筛选
          </button>
        )}
      </div>

      {data?.note && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-600 leading-relaxed">
          <IconInfo className="w-3.5 h-3.5 mt-px shrink-0" />
          <PlatformNote note={data.note} tutorialUrl={data.tutorialUrl} />
        </div>
      )}
    </Card>
  );

  return (
    <div className="space-y-5">
      {toolbar}

      {/* 加载失败 */}
      {error && !data && (
        <Card>
          <EmptyState
            icon={<IconRefresh />}
            title={`${platformName} 模型列表加载失败`}
            desc={
              error +
              (platformMeta?.modelsPublic || !platformMeta?.keyUrl
                ? '。已尝试本地缓存但不可用，请检查网络后重试。'
                : '。添加该平台的 API Key 后即可获取模型列表。')
            }
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="primary" onClick={() => showPlatform(platform)}>
                  重试
                </Button>
                {!platformMeta?.modelsPublic && platformMeta?.keyUrl && (
                  <Button variant="subtle" onClick={() => onGoKeys?.()}>
                    前往 API Keys 添加
                  </Button>
                )}
              </div>
            }
          />
        </Card>
      )}

      {/* 配置待生效提醒：models.json 在 WorkBuddy 启动后被修改过 */}
      {loadedInfo?.running && loadedInfo?.pendingRestart && loadedInfo?.modelsJsonMtime !== bannerDismissedAt && (
        <Card className="px-4 py-2.5 flex flex-wrap items-center gap-3 border-amber-200 bg-amber-50/90 animate-fade-in">
          <span className="text-sm text-amber-700">
            模型配置有变更尚未生效（{fmtRelative(loadedInfo.modelsJsonMtime)} 写入 models.json）——WorkBuddy 只在启动时读取配置。
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={doRestart}>
              马上重启 WorkBuddy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setBannerDismissedAt(loadedInfo.modelsJsonMtime ?? null)}>
              稍后
            </Button>
          </div>
        </Card>
      )}

      {/* 已载入面板 */}
      {loadedInfo && loadedInfo.loaded.length > 0 && (
        <Card className="overflow-hidden">
          <button className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-zinc-600 hover:bg-zinc-50 transition-colors" onClick={() => setShowLoadedPanel((v) => !v)}>
            <IconChevronDown className={`w-4 h-4 transition-transform ${showLoadedPanel ? '' : '-rotate-90'}`} />
            已载入 WorkBuddy 的模型
            <Badge color="green">{loadedInfo.loaded.length}</Badge>
            <span className="ml-auto text-xs text-zinc-400 font-normal truncate max-w-sm">{loadedInfo.modelsJsonPath}</span>
          </button>
          {showLoadedPanel && (
            <div className="border-t border-zinc-100 divide-y divide-zinc-50 animate-fade-in">
              {loadedInfo.loaded.map((e) => (
                <div key={e.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm hover:bg-zinc-50/60 transition-colors">
                  <span className="font-mono text-xs text-zinc-700 truncate max-w-[320px]" title={e.id}>
                    {e.id}
                  </span>
                  <Badge color="blue">{platformNameOf(e.platform)}</Badge>
                  {e.keyTail && <Badge color="gray">key…{e.keyTail}</Badge>}
                  {e.supportsToolCall && <Badge color="blue">tools</Badge>}
                  {e.supportsReasoning && <Badge color="violet">reasoning</Badge>}
                  <div className="ml-auto">
                    <Button size="sm" variant="danger" onClick={() => doRemove(e.id)}>
                      <IconTrash className="w-3.5 h-3.5" />
                      移除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* 批量操作条 */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-20 animate-slide-up">
          <Card className="px-4 py-2.5 flex flex-wrap items-center gap-3 border-indigo-200 bg-indigo-50/95 backdrop-blur shadow-lg shadow-indigo-900/5">
            <span className="text-sm text-zinc-700">
              已选 <b className="font-mono">{selected.size}</b> 个模型
              {selectedFree > 0 && <span className="text-emerald-600"> · 免费 {selectedFree} 个</span>}
            </span>
            <Button variant="primary" size="sm" onClick={() => setLoadOpen(true)}>
              <IconDownload className="w-3.5 h-3.5" />
              载入到 WorkBuddy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              取消选择
            </Button>
          </Card>
        </div>
      )}

      {/* 模型表格 */}
      {skeleton ? (
        <TableSkeleton rows={8} />
      ) : (
        !error && (
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-xs">
                  <th className="sticky top-0 z-10 bg-zinc-50/90 shadow-[0_1px_0_0_#e4e4e7] w-9 pl-4 py-2.5 rounded-tl-2xl">
                    <input
                      type="checkbox"
                      checked={allPageSelected}
                      onChange={toggleSelectAllPage}
                      className="accent-indigo-600 rounded align-middle"
                      title="全选本页可载入的模型"
                    />
                  </th>
                  <th className="sticky top-0 z-10 bg-zinc-50/90 shadow-[0_1px_0_0_#e4e4e7] text-left py-2.5 pr-3 font-medium">模型</th>
                  <th className="sticky top-0 z-10 bg-zinc-50/90 shadow-[0_1px_0_0_#e4e4e7] text-left py-2.5 pr-3 font-medium w-28">厂商</th>
                  <th className="sticky top-0 z-10 bg-zinc-50/90 shadow-[0_1px_0_0_#e4e4e7] text-left py-2.5 pr-3 font-medium w-20">上下文</th>
                  <th className="sticky top-0 z-10 bg-zinc-50/90 shadow-[0_1px_0_0_#e4e4e7] text-left py-2.5 pr-3 font-medium w-40">价格 / 1M tokens</th>
                  <th className="sticky top-0 z-10 bg-zinc-50/90 shadow-[0_1px_0_0_#e4e4e7] text-left py-2.5 pr-3 font-medium">能力</th>
                  <th className="sticky top-0 z-10 bg-zinc-50/90 shadow-[0_1px_0_0_#e4e4e7] text-left py-2.5 pr-3 font-medium w-24">发布</th>
                  <th className="sticky top-0 z-10 bg-zinc-50/90 shadow-[0_1px_0_0_#e4e4e7] text-left py-2.5 pr-4 font-medium w-28 rounded-tr-2xl">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {pageItems.map((m) => {
                  const canLoad = selectable(m);
                  const isLoaded = loadedIds.has(m.id);
                  return (
                    <tr
                      key={m.id}
                      className={`group transition-colors hover:bg-zinc-50/70 ${canLoad ? 'cursor-pointer' : ''}`}
                      onClick={
                        canLoad
                          ? (e) => {
                              // 点在按钮/复选框/链接上时不触发行选中
                              if ((e.target as HTMLElement).closest('button,input,a,label')) return;
                              toggleSelect(m.id, !selected.has(m.id));
                            }
                          : undefined
                      }
                    >
                      <td className="pl-4">
                        <input
                          type="checkbox"
                          disabled={!canLoad}
                          checked={selected.has(m.id)}
                          onChange={(e) => toggleSelect(m.id, e.target.checked)}
                          className="accent-indigo-600 rounded disabled:opacity-30 align-middle"
                          title={canLoad ? '选择' : m.loadable === false ? '该模型协议不兼容，不支持载入' : '图像/视频生成模型暂不支持载入'}
                        />
                      </td>
                      <td className="py-2 pr-3 max-w-[340px]">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-zinc-800 truncate" title={m.description?.slice(0, 200)}>
                            {m.name}
                          </span>
                          {kindBadge(m)}
                        </div>
                        <button
                          className="flex items-center gap-1 text-xs text-zinc-400 font-mono hover:text-indigo-500 mt-0.5 transition-colors max-w-full"
                          onClick={() => copyId(m.id)}
                          title="点击复制模型 ID"
                        >
                          <IconCopy className="w-3 h-3 shrink-0" />
                          <span className="truncate">{m.id}</span>
                        </button>
                      </td>
                      <td className="py-2 pr-3 text-zinc-500">{m.vendor}</td>
                      <td className="py-2 pr-3 text-zinc-500 font-mono text-xs">{fmtContext(m.contextLength)}</td>
                      <td className="py-2 pr-3 text-xs">
                        {m.isFree ? (
                          <Badge color="green">免费</Badge>
                        ) : m.pricing ? (
                          <span className="text-zinc-600 font-mono">
                            {fmtPricePerM(m.pricing.prompt)} <span className="text-zinc-300">in</span> · {fmtPricePerM(m.pricing.completion)}{' '}
                            <span className="text-zinc-300">out</span>
                          </span>
                        ) : (
                          <span className="text-zinc-300">按平台计费</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap gap-1">
                          {m.supportsTools && <Badge color="blue">工具调用</Badge>}
                          {m.supportsReasoning && <Badge color="violet">推理</Badge>}
                          {m.supportsImageInput && <Badge color="gray">图片输入</Badge>}
                          {!m.supportsTools && !m.supportsReasoning && !m.supportsImageInput && <span className="text-zinc-300 text-xs">—</span>}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-xs text-zinc-400">{m.created ? fmtDate(m.created * 1000) : '—'}</td>
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-1.5">
                          {isLoaded ? (
                            <Badge color="green" dot>
                              已载入
                            </Badge>
                          ) : canLoad ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                toggleSelect(m.id, true);
                                setLoadOpen(true);
                              }}
                            >
                              载入
                            </Button>
                          ) : (
                            <span className="text-xs text-zinc-300">{m.loadable === false ? '协议不兼容' : '不支持载入'}</span>
                          )}
                          {canLoad && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openExport(m.id)}
                              title="复制该模型的 Base URL / API Key 等配置，粘贴到其他 agent 使用"
                            >
                              <IconCopy className="w-3.5 h-3.5" />
                              载入其他 agent
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {pageItems.length === 0 && (
                  <tr>
                    <td colSpan={8}>
                      <EmptyState
                        icon={<IconSearch />}
                        title="没有符合筛选条件的模型"
                        desc="试试放宽关键词，或清空筛选条件后重新浏览。"
                        action={
                          anyFilterActive ? (
                            <Button variant="subtle" onClick={resetFilters}>
                              清空筛选
                            </Button>
                          ) : undefined
                        }
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-t border-zinc-100 text-xs text-zinc-500">
              <span className="tabular-nums">
                第 <b className="font-mono text-zinc-700">{safePage}</b> / {pageCount} 页 · 共 {filtered.length} 个 · 本页 {pageItems.length} 个
              </span>
              <label className="flex items-center gap-1.5">
                每页
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  className="h-7 px-1.5 rounded-lg border border-zinc-200 bg-white outline-none focus:border-indigo-400"
                >
                  {[20, 50, 100, 200].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                条
              </label>
              <div className="ml-auto flex items-center gap-1.5">
                <Button size="sm" variant="subtle" disabled={safePage <= 1} onClick={() => setPage(1)}>
                  首页
                </Button>
                <Button size="sm" variant="subtle" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
                  上一页
                </Button>
                <Button size="sm" variant="subtle" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>
                  下一页
                </Button>
                <Button size="sm" variant="subtle" disabled={safePage >= pageCount} onClick={() => setPage(pageCount)}>
                  末页
                </Button>
              </div>
            </div>
          </Card>
        )
      )}

      {/* 载入确认弹窗 */}
      <Modal
        open={loadOpen}
        onClose={() => setLoadOpen(false)}
        title={`载入模型到 WorkBuddy（${platformName}）`}
        subtitle={`将写入自定义模型配置（OpenAI 兼容）`}
        footer={
          <>
            <Button onClick={() => setLoadOpen(false)}>取消</Button>
            <Button variant="primary" loading={loadLoading} disabled={platformKeys.length === 0 || selected.size === 0} onClick={doLoad}>
              确认载入 {selected.size} 个
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <div className="text-zinc-600">
            将把 <b className="text-zinc-900">{selected.size}</b> 个模型写入：
            <div className="mt-1 font-mono text-xs bg-zinc-50 rounded-xl px-2.5 py-1.5 text-zinc-500 break-all">
              {loadedInfo?.modelsJsonPath || '~/.workbuddy/models.json'}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-zinc-600">使用的 {platformName} API Key：</div>
            {platformKeys.length === 0 ? (
              <div className="text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                尚未配置 {platformName} Key，请先到「API Keys」页签添加
                {platformMeta?.keyUrl && (
                  <>
                    {' '}
                    （
                    <a href={platformMeta.keyUrl} target="_blank" rel="noreferrer" className="underline">
                      获取 Key ↗
                    </a>
                    ）
                  </>
                )}
              </div>
            ) : (
              <select
                value={loadKey}
                onChange={(e) => setLoadKey(e.target.value)}
                className="w-full h-9 px-2.5 rounded-xl border border-zinc-200 bg-white text-sm outline-none focus:border-indigo-400"
              >
                {platformKeys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                    {k.id === activeKeys[platform] ? '（活跃）' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="text-xs text-zinc-400 leading-relaxed">
            写入前会自动备份 models.json；已存在的模型会更新配置而不会重复添加。图像/视频生成模型与协议不兼容的模型不支持载入。
          </div>
        </div>
      </Modal>

      {/* 载入其他 agent：导出配置（只看不改，不写入任何文件） */}
      <Modal
        open={exportOpen}
        onClose={() => {
          setExportOpen(false);
          setExportData(null);
        }}
        title={`载入其他 agent（${platformName}）`}
        subtitle="只看不改：下面这些配置不会写入任何文件，复制后粘到目标 agent 即可"
        width="max-w-2xl"
        footer={
          <>
            <Button
              onClick={() => {
                setExportOpen(false);
                setExportData(null);
              }}
            >
              关闭
            </Button>
            <Button variant="primary" disabled={!exportData} onClick={() => copyText(exportJson, '全部配置 JSON')}>
              <IconCopy className="w-3.5 h-3.5" />
              复制全部配置（JSON）
            </Button>
          </>
        }
      >
        {!exportData ? (
          <div className="py-12 flex justify-center">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-3.5 text-sm">
            <div className="rounded-xl bg-blue-50/70 border border-blue-100 px-3.5 py-2.5 text-xs text-zinc-600 leading-relaxed">
              这些是 <b className="text-zinc-800">OpenAI 兼容</b>的自定义模型配置。在目标 agent 里找到「自定义模型 / OpenAI 兼容 /
              自定义供应商」之类入口，把下面的 <b className="text-zinc-800">Base URL</b> 与{' '}
              <b className="text-zinc-800">API Key</b> 填进去，模型名填 <b className="text-zinc-800">模型 ID</b> 即可。
            </div>

            {/* 连接信息 */}
            <div className="rounded-xl border border-zinc-200 divide-y divide-zinc-100">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <span className="text-zinc-500 w-20 shrink-0">协议</span>
                <Badge color="blue">OpenAI 兼容</Badge>
                <span className="text-xs text-zinc-400">对话地址 = Base URL + /chat/completions</span>
              </div>

              <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <span className="text-zinc-500 w-20 shrink-0">Base URL</span>
                <code className="font-mono text-xs text-zinc-700 break-all flex-1 min-w-0">
                  {exportData.baseUrl || exportData.entries[0]?.url || '—'}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => copyText(exportData.baseUrl || exportData.entries[0]?.url || '', 'Base URL')}
                >
                  <IconCopy className="w-3.5 h-3.5" />
                  复制
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <span className="text-zinc-500 w-20 shrink-0">API Key</span>
                {revealed ? (
                  <code className="font-mono text-xs text-zinc-800 break-all flex-1 min-w-0">{exportData.apiKey}</code>
                ) : (
                  <code className="font-mono text-xs text-zinc-400 flex-1 min-w-0">
                    {exportData.masked}（点「显示」查看明文）
                  </code>
                )}
                <Button size="sm" variant="ghost" loading={exportLoading} onClick={() => fetchExport(!revealed)}>
                  {revealed ? <IconEyeOff className="w-3.5 h-3.5" /> : <IconEye className="w-3.5 h-3.5" />}
                  {revealed ? '隐藏' : '显示'}
                </Button>
                {revealed && (
                  <Button size="sm" variant="ghost" onClick={() => copyText(exportData.apiKey || '', 'API Key')}>
                    <IconCopy className="w-3.5 h-3.5" />
                    复制
                  </Button>
                )}
              </div>
            </div>

            {/* 模型清单 */}
            <div>
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-zinc-600">已选 {exportData.entries.length} 个模型</span>
                {exportData.skipped.length > 0 && <Badge color="amber">跳过 {exportData.skipped.length} 个</Badge>}
                <span className="text-xs text-zinc-400">模型 ID 就是填到目标 agent 里的「模型名」</span>
              </div>
              <div className="max-h-52 overflow-y-auto rounded-xl border border-zinc-100 divide-y divide-zinc-50">
                {exportData.entries.map((e) => (
                  <div key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="font-mono text-xs text-zinc-800 truncate max-w-[240px]" title={e.id}>
                      {e.id}
                    </span>
                    {e.outputKind === 'image' && <Badge color="violet">图像生成</Badge>}
                    {e.outputKind === 'video' && <Badge color="amber">视频生成</Badge>}
                    {e.supportsToolCall && <Badge color="blue">tools</Badge>}
                    {e.supportsReasoning && <Badge color="violet">reasoning</Badge>}
                    <span className="ml-auto font-mono text-[11px] text-zinc-400 truncate max-w-[220px]" title={e.url}>
                      {e.url}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => copyText(e.id, `模型 ID ${e.id}`)}>
                      <IconCopy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            {/* 完整 JSON */}
            <div>
              <div className="mb-1.5 text-zinc-600">完整配置（与 WorkBuddy models.json 条目同格式，可直接粘过去）</div>
              <textarea
                readOnly
                value={exportJson}
                rows={9}
                className="w-full rounded-xl border border-zinc-200 bg-zinc-50 p-3 font-mono text-[11px] text-zinc-700 leading-relaxed outline-none focus:border-indigo-400 resize-y"
              />
            </div>

            {exportData.entries.some((e) => e.outputKind !== 'text') && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2 leading-relaxed">
                列表里含图像 / 视频生成模型。这类模型走 OpenAI 的 <span className="font-mono">/chat/completions</span>{' '}
                不一定能用，需目标 agent 自己支持对应能力。
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 配置待生效弹窗（进入免费模型时，同一次变更只提醒一次） */}
      <Modal
        open={restartPrompt}
        onClose={() => setRestartPrompt(false)}
        title="模型配置待生效"
        footer={
          <>
            <Button onClick={() => setRestartPrompt(false)}>稍后</Button>
            <Button
              variant="primary"
              onClick={() => {
                setRestartPrompt(false);
                doRestart();
              }}
            >
              马上重启
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <div className="text-zinc-600">
            检测到 <span className="font-mono text-xs">models.json</span> 在 WorkBuddy 运行期间有变更（载入 / 移除模型），WorkBuddy
            需要重启才能加载最新配置。
          </div>
          <div className="text-xs text-zinc-400">重启后，新增的模型才会出现在 WorkBuddy 的自定义模型列表中。</div>
        </div>
      </Modal>

      {/* 载入结果弹窗 */}
      <Modal
        open={!!loadResult}
        onClose={() => setLoadResult(null)}
        title="载入结果"
        footer={
          <Button variant="primary" onClick={() => setLoadResult(null)}>
            完成
          </Button>
        }
      >
        {loadResult && (
          <div className="space-y-4 text-sm">
            <div className="flex gap-2.5">
              <div className="flex-1 bg-emerald-50 border border-emerald-100 rounded-xl px-3.5 py-2.5">
                <div className="text-emerald-700 text-lg font-semibold font-mono tabular-nums tracking-[-0.02em]">{loadResult.added}</div>
                <div className="text-xs text-emerald-600">新增模型</div>
              </div>
              <div className="flex-1 bg-sky-50 border border-sky-100 rounded-xl px-3.5 py-2.5">
                <div className="text-sky-700 text-lg font-semibold font-mono tabular-nums tracking-[-0.02em]">{loadResult.updated}</div>
                <div className="text-xs text-sky-600">更新已有</div>
              </div>
              <div className="flex-1 bg-zinc-50 border border-zinc-100 rounded-xl px-3.5 py-2.5">
                <div className="text-zinc-700 text-lg font-semibold font-mono tabular-nums tracking-[-0.02em]">{loadResult.total}</div>
                <div className="text-xs text-zinc-500">models.json 总数</div>
              </div>
            </div>
            <div className="text-xs text-zinc-500 leading-relaxed">
              使用 Key：<span className="font-mono">{loadResult.keyUsed}</span>
              {loadResult.backup && (
                <>
                  <br />
                  备份文件：<span className="font-mono break-all">{loadResult.backup}</span>
                </>
              )}
            </div>
            {loadResult.skipped.length > 0 && (
              <div className="bg-amber-50 border border-amber-100 rounded-xl px-3.5 py-2.5 text-xs">
                <div className="text-amber-700 font-medium mb-1">跳过 {loadResult.skipped.length} 个：</div>
                <div className="max-h-40 overflow-y-auto space-y-0.5">
                  {loadResult.skipped.map((s) => (
                    <div key={s.id} className="text-amber-600 font-mono break-all">
                      {s.id} — {s.reason}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 bg-zinc-50 rounded-xl px-3.5 py-2.5 text-xs text-zinc-500">
              <span className="flex-1">WorkBuddy 正在运行时需要重启才能读取新模型配置。</span>
              {loadedInfo?.running ? (
                <Button size="sm" variant="primary" onClick={doRestart}>
                  重启 WorkBuddy
                </Button>
              ) : (
                <span className="text-zinc-400">当前未运行，下次启动自动生效</span>
              )}
            </div>
          </div>
        )}
      </Modal>

    </div>
  );
}
