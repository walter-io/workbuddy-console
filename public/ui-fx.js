/* ============================================================
   WorkBuddy Console UI 特效层 · 行为脚本 r3
   r3 变更（2026-11-26 用户反馈）：
   - 整体移除 ② 悬停 3D 聚光倾斜（拖动选文字时卡片跟着转，选不了字）
   - 整体移除 ④ 点击卡片展开成只读弹窗（鸡肋）
   - 整体移除 ⑦ 卡片拖拽视觉反馈（含 pointerdown 监听，文字选择彻底放行）
   - 保留：① 侧栏胶囊、③ 边缘流光、数字滚动、⑧ 骨架屏（均不拦截任何交互）
   r2 变更（WB round-005 审查意见）：
   - R005-1 展开层 close 幂等守卫 + 三条关闭路径统一注销 Esc
   - R005-2 流光卡持久标记（beamSet），不随重渲染累积
   - R005-4 定位多选择器 fallback + 找不到目标静默跳过
   - R005-5 骨架屏引用计数
   - R005-6 observer 回调去抖 + 统一观察 scanMain 命中的容器
   纯装饰层：只加东西、不删不改业务 DOM；React 重渲染后由 observer 自愈。
   ============================================================ */
(() => {
  if (window.__uiFxLoaded) return;
  window.__uiFxLoaded = true;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const SPRING = 'cubic-bezier(.34,1.56,.64,1)';
  const OUT = 'cubic-bezier(.22,.61,.36,1)';

  /* ============ ①+⑩ 侧栏：液态玻璃胶囊 + 粘性融合 ============ */
  let fxPill = null, fxGoo = null, pillPrev = null;
  function activeSideBtn() {
    // R005-4：多选择器 fallback，找不到就静默跳过
    return $$('aside nav > button').find(b =>
      b.className.includes('bg-indigo-50') || b.classList.contains('fx-side-active')
    ) || null;
  }
  function rectOf(el, nav) {
    const r = el.getBoundingClientRect(), n = nav.getBoundingClientRect();
    return { top: r.top - n.top, height: r.height };
  }
  function sidePillTick(animate = true) {
    const nav = $('aside nav');
    if (!nav) return;
    const act = activeSideBtn();
    if (!act) {
      // R006-3：无激活项时隐藏胶囊，避免残留误导
      if (fxPill) { fxPill.style.opacity = '0'; }
      pillPrev = null;
      return;
    }
    if (fxPill) { fxPill.style.opacity = '1'; }
    if (!fxPill) {
      fxPill = document.createElement('div');
      fxPill.className = 'fx-pill';
      nav.appendChild(fxPill);
    }
    const r = rectOf(act, nav);
    if (pillPrev && animate) {
      const p = pillPrev;
      fxPill.style.transition = 'none';
      fxPill.style.top = p.top + 'px';
      fxPill.style.height = p.height + 'px';
      fxPill.style.transform = 'none';
      fxPill.offsetHeight;
      const dy = r.top - p.top;
      const stretch = Math.min(Math.abs(dy) * 0.12, 14);
      const dur = Math.min(140 + Math.abs(dy) * 1.1, 420);
      fxPill.style.transition = 'transform ' + dur + 'ms ' + SPRING + ', top ' + dur + 'ms ' + SPRING + ', height ' + dur + 'ms ' + SPRING;
      fxPill.style.transformOrigin = dy > 0 ? 'top center' : 'bottom center';
      fxPill.style.top = r.top + 'px';
      fxPill.style.height = r.height + 'px';
      fxPill.style.transform = 'scaleY(' + ((r.height + stretch) / r.height).toFixed(3) + ')';
      setTimeout(() => {
        if (!fxPill) return;
        fxPill.style.transition = 'transform 240ms ' + SPRING;
        fxPill.style.transform = 'none';
      }, dur);
      gooBridge(p, r, nav);
    } else {
      fxPill.style.transition = 'none';
      fxPill.style.top = r.top + 'px';
      fxPill.style.height = r.height + 'px';
      fxPill.style.transform = 'none';
    }
    pillPrev = r;
  }
  function gooBridge(from, to, nav) {
    if (!fxGoo) {
      fxGoo = document.createElement('div');
      fxGoo.className = 'fx-goo-bridge';
      nav.appendChild(fxGoo);
    }
    // R006-1：分别算两元素中心坐标，桥长 = 中心点实际距离
    const fromCenter = from.top + from.height / 2;
    const toCenter = to.top + to.height / 2;
    const top = Math.min(fromCenter, toCenter);
    const bottom = Math.max(fromCenter, toCenter);
    const h = bottom - top;
    if (h < 4) return;
    const g = fxGoo;
    g.style.transition = 'none';
    g.style.top = top + 'px';
    g.style.height = h + 'px';
    g.style.opacity = '1';
    g.offsetHeight;
    const dur = 300;
    g.style.transition = 'top ' + dur + 'ms ' + OUT + ', height ' + dur + 'ms ' + OUT + ', opacity 200ms ' + dur + 'ms';
    g.style.top = (to.top + to.height / 2 - 8) + 'px';
    g.style.height = '16px';
    g.style.opacity = '0';
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('aside nav > button');
    if (btn) setTimeout(() => sidePillTick(true), 30);
  }, true);

  /* ============ 扫描主内容区（②③④⑥⑦ 挂载） ============ */
  function findMain() {
    // R005-4/R005-6：统一容器查找，observer 与 scanMain 用同一个
    return document.querySelector('main') || null;
  }
  const CARD_SEL = [
    'main .rounded-2xl.border.bg-white',
    'main .rounded-2xl.border',
    'main [class*="rounded-2xl"][class*="border"]',
  ];
  function scanCards(main) {
    for (const sel of CARD_SEL) {
      const found = $$(sel, main);
      if (found.length) return found;
    }
    return [];
  }
  const beamSet = new WeakSet();
  let beamAssigned = false; // R005-2：全局只标一张，持久标记后不再换卡
  function scanMain() {
    const main = findMain();
    if (!main) return;
    const cards = scanCards(main);
    cards.forEach((card) => {
      if (card.closest('#fx-expand-layer')) return; // R015-5：CoverFlow/dock 已移除
      // ③ 边缘流光：只标当前第一张，持久（R005-2）
      if (!beamAssigned && !beamSet.has(card)) {
        card.classList.add('fx-beam');
        beamSet.add(card);
        beamAssigned = true;
      }
    });
    wakeNumbers(main);
  }
  const numbersWoken = new WeakSet();
  function wakeNumbers(main) {
    $$('main .tabular-nums', main).forEach(el => {
      if (numbersWoken.has(el)) return;
      const text = el.textContent.trim();
      const m = text.match(/^([\d,]+(\.\d+)?)$/);
      if (!m) return;
      const num = parseFloat(m[1].replace(/,/g, ''));
      if (!isFinite(num) || num <= 0) return; // R009-5：0/负数先跳过再标记，语义严谨
      numbersWoken.add(el);
      const decimals = (m[1].split('.')[1] || '').length;
      const t0 = performance.now(), dur = 900;
      const ease = t => 1 - Math.pow(1 - t, 3);
      function frame(t) {
        const p = Math.min(1, (t - t0) / dur);
        const v = num * ease(p);
        el.textContent = v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        if (p < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }

  /* ============ ④ 点击展开 与 ⑦ 拖拽：已于 2026-11-26 整体移除（用户反馈鸡肋，
     且拖拽/悬停倾斜妨碍卡片内文字选择；点击卡片不再弹只读快照层） ============ */

  /* ⑤ dock 与 ⑨ Cover Flow：已移除 */

  /* ============ ⑧ 骨架屏（R005-5：引用计数） ============ */
  let skEl = null;
  const pendingSkeletons = new Set();
  // 反馈④：白框反复弹 = 骨架屏对高频/短请求反复触发。
  // 白名单收紧到「首次进入页面的重路由」，剔除 zcode 轮询与状态类接口；250ms 延迟显示，快请求永不闪框。
  const SKELETON_ROUTES = /\/api\/(accounts$|accounts\?|stats\?|credits\?)/;
  const SKELETON_MIN_MS = 250;
  function showSkeleton(tag) {
    if (skFading) return; // R012-1：淡出动画期间禁止新建，防双骨架叠影
    if (!skEl) {
      skEl = document.createElement('div');
      skEl.id = 'fx-skeleton';
      const rows = [];
      for (let i = 0; i < 3; i++) {
        rows.push('<div class="fx-sk-card"><div class="fx-sk-avatar"></div><div class="fx-sk-lines"><div class="fx-sk-bar b' + (i === 0 ? '1' : '2') + '"></div><div class="fx-sk-bar b' + (i === 1 ? '1' : '2') + '"></div></div><div class="fx-sk-block"></div></div>');
      }
      skEl.innerHTML = rows.join('');
      document.body.appendChild(skEl);
    }
    pendingSkeletons.add(tag);
  }
  let skFading = false; // R010-3：淡出动画期间禁止新建，防双骨架
  function hideSkeleton(tag) {
    pendingSkeletons.delete(tag);
    if (pendingSkeletons.size === 0 && skEl && !skFading) {
      skFading = true;
      skEl.classList.add('fx-fade');
      const el = skEl;
      setTimeout(() => { el.remove(); skFading = false; }, 380);
      skEl = null;
    }
  }
  let skSeq = 0;
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const isSkeleton = SKELETON_ROUTES.test(url) && !url.includes('netcheckin/run') && !url.includes('/switch');
    const tag = 'fxsk-' + (++skSeq);
    let showTimer = null;
    if (isSkeleton) showTimer = setTimeout(() => { showSkeleton(tag); }, SKELETON_MIN_MS);
    try {
      return await origFetch(...args);
    } finally {
      if (isSkeleton) {
        clearTimeout(showTimer);
        hideSkeleton(tag);
      }
    }
  };

  /* ============ 启动（R005-6：observer 去抖 + 统一容器） ============ */
  function boot() {
    const main = findMain();
    if (!main) { setTimeout(boot, 400); return; }
    scanMain();
    let mainPending = false;
    let navPending = false;
    const mainObs = new MutationObserver(() => {
      // R006-2：两个 observer 独立防抖，互不阻塞
      if (mainPending) return;
      mainPending = true;
      requestAnimationFrame(() => { mainPending = false; scanMain(); });
    });
    mainObs.observe(main, { childList: true, subtree: true });
    // 侧栏胶囊初始化（aside 可能晚于 main 出现）
    const navObs = new MutationObserver(() => {
      if (navPending) return;
      navPending = true;
      requestAnimationFrame(() => { navPending = false; sidePillTick(false); });
    });
    const aside = $('aside');
    if (aside) {
      navObs.observe(aside, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      sidePillTick(false); // 初始挂载：aside 已渲染好时 observer 不会触发，直调一次
    } else {
      const asideWait = new MutationObserver(() => {
        const a = $('aside');
        if (a) { asideWait.disconnect(); navObs.observe(a, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); sidePillTick(false); }
      });
      asideWait.observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
