/* ============================================================
   WorkBuddy Console UI 特效层 · 行为脚本 r2
   r2 变更（WB round-005 审查意见）：
   - R005-1 展开层 close 幂等守卫 + 三条关闭路径统一注销 Esc
   - R005-2 流光卡持久标记（beamSet），不随重渲染累积
   - R005-3 拖拽纯视觉（ghost 跟随 + 落点高亮），不再移动 React 管理的 DOM
   - R005-4 定位多选择器 fallback + 找不到目标静默跳过
   - R005-5 骨架屏引用计数
   - R005-6 observer 回调去抖 + 统一观察 scanMain 命中的容器
   - R005-9 拖拽排除集补 .cursor-pointer
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
  const spotSet = new WeakSet();
  const beamSet = new WeakSet();
  let beamAssigned = false; // R005-2：全局只标一张，持久标记后不再换卡
  function scanMain() {
    const main = findMain();
    if (!main) return;
    const cards = scanCards(main);
    cards.forEach((card) => {
      if (card.closest('#fx-expand-layer')) return; // R015-5：CoverFlow/dock 已移除
      // ② 聚光
      if (!card.querySelector('input, textarea, select') && !spotSet.has(card)) {
        card.classList.add('fx-spot');
        spotSet.add(card);
        card.addEventListener('pointermove', (e) => {
          const r = card.getBoundingClientRect();
          const x = e.clientX - r.left, y = e.clientY - r.top;
          card.style.setProperty('--fx-mx', x + 'px');
          card.style.setProperty('--fx-my', y + 'px');
          const rx = ((y / r.height) - .5) * -2 * 3.2;
          const ry = ((x / r.width) - .5) * 2 * 3.2;
          card.style.transform = 'perspective(900px) rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
        });
        card.addEventListener('pointerleave', () => {
          card.style.transition = 'transform .5s ' + OUT;
          card.style.transform = 'none';
          setTimeout(() => { card.style.transition = ''; }, 520);
        });
      }
      // ③ 边缘流光：只标当前第一张，持久（R005-2）
      if (!beamAssigned && !beamSet.has(card)) {
        card.classList.add('fx-beam');
        beamSet.add(card);
        beamAssigned = true;
      }
      // ④ 点击展开
      if (!card.dataset.fxExpand) {
        card.dataset.fxExpand = '1';
        card.addEventListener('click', (e) => {
          if (e.target.closest('button, a, input, select, textarea, [role=tab], .cursor-pointer')) return;
          // R021：无实质内容的卡片（纯按钮/开关卡）不展开——反代卡等只有操作按钮没有数据体
          // R024：textLen 改 innerText（textContent 会把 display:none 的子节点也算进去，导致空壳卡虚高）；
          //       hasDataBody 去掉裸 svg（lucide 图标也渲染成 svg，会让任何带图标的卡被误判为有数据体），
          //       改为只认"图表型 svg"（有 viewBox 且尺寸够大）与 table/tabular/图片/骨架行。
          const textLen = (card.innerText || card.textContent || '').replace(/\s+/g, '').length;
          const chartSvg = $$('svg', card).some((s) => {
            const vb = s.getAttribute('viewBox');
            if (!vb) return false;
            const m = vb.match(/0\s+0\s+([\d.]+)\s+([\d.]+)/);
            return m ? (parseFloat(m[1]) >= 100 || parseFloat(m[2]) >= 100) : false;
          });
          const hasDataBody = card.querySelector('table, [class*="tabular"], .fx-sk-lines, img') || chartSvg;
          const btnRatio = card.querySelectorAll('button').length;
          if (!hasDataBody && (textLen < 120 || btnRatio >= 4)) return;
          if (e.target !== card && !e.target.classList.contains('card-title')) return;
          expandCard(card);
        });
      }
      // ⑦ 拖拽（纯视觉）
      if (!card.dataset.fxDrag) {
        card.dataset.fxDrag = '1';
        attachDrag(card, main);
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

  /* ============ ④ 点击原位展开（R005-1：三条关闭路径统一清理） ============ */
  let expandLayer = null;
    function expandCard(card) {
    if (expandLayer) return;
    const r = card.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.id = 'fx-expand-layer';
    const detail = document.createElement("div");
    detail.id = 'fx-expand-detail';
    let escHandler = null;
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (escHandler) document.removeEventListener("keydown", escHandler);
      const cr = card.getBoundingClientRect();
      detail.style.transition = 'all .38s ' + OUT;
      detail.style.left = cr.left + 'px';
      detail.style.top = cr.top + 'px';
      detail.style.width = cr.width + 'px';
      detail.style.height = cr.height + 'px';
      layer.classList.add('fx-hiding');
      setTimeout(() => { detail.remove(); layer.remove(); if (expandLayer === layer) expandLayer = null; }, 400);
    }
    // R8-1 终版：所有节点先组装完毕再挂载，挂载后立即绑关闭事件——无任何可抛错的中间态
    const clone = card.cloneNode(true);
    clone.style.margin = '0'; clone.style.boxShadow = 'none';
    // 克隆卡里的按钮一律禁用（详情为只读快照；真实操作在原卡进行）——关闭方式：点「收起」/空白处/Esc
    $$("button, a, [role=tab], input, select, textarea", clone).forEach((el) => {
      el.setAttribute('disabled', 'disabled');
      el.style.pointerEvents = 'none';
      el.style.opacity = '.55';
      if (el.tagName === 'A') el.removeAttribute('href'); // R009-2：只读快照不产生导航
    });
    const hint = document.createElement("div");
    hint.className = 'text-xs text-zinc-400 mt-2';
    hint.textContent = '详情为只读快照 · 点击「收起」或空白处返回，操作请回到原卡片进行';
    const closeBtn = document.createElement("button");
    closeBtn.textContent = '收起';
    closeBtn.className = 'mt-3';
    closeBtn.style.cssText = 'padding:8px 18px;border:none;border-radius:10px;background:#6366f1;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit';
        detail.appendChild(clone);
    detail.appendChild(hint);
    detail.appendChild(closeBtn);
    layer.appendChild(detail);
    document.body.appendChild(layer);
    expandLayer = layer;
    layer.addEventListener('click', (e) => { if (e.target === layer) close(); });
    closeBtn.addEventListener('click', close);
    escHandler = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", escHandler);
    // 原位放大动画
    detail.style.left = r.left + 'px';
    detail.style.top = r.top + 'px';
    detail.style.width = r.width + 'px';
    detail.style.height = r.height + 'px';
    detail.offsetHeight;
    detail.style.transition = 'all .45s ' + SPRING;
    detail.style.left = (innerWidth - Math.min(720, innerWidth - 80)) / 2 + 'px';
    detail.style.top = Math.max(20, (innerHeight - Math.min(detail.scrollHeight + 40, innerHeight - 60)) / 2) + 'px';
    detail.style.width = Math.min(720, innerWidth - 80) + 'px';
    detail.style.minHeight = Math.min(detail.scrollHeight + 40, innerHeight - 60) + 'px';
  }

  /* ============ ⑦ 拖拽（R005-3：纯视觉 ghost + 落点高亮，不移动业务 DOM） ============ */
  function attachDrag(card, main) {
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // R005-9：排除集与展开点击一致（补 .cursor-pointer）
      if (e.target.closest('button, a, input, select, textarea, [role=tab], .cursor-pointer')) return;
      if (e.clientY - card.getBoundingClientRect().top > 34 && e.target === card) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const or = card.getBoundingClientRect();
      const others = scanCards(main).filter(c => c !== card).map(c => ({ el: c }));
      let ghost = null, lastHint = null;
      function move(ev) {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!ghost && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
          ghost = card.cloneNode(true);
          ghost.style.cssText = 'position:fixed;margin:0;pointer-events:none;opacity:.92;z-index:calc(var(--fx-z-dock) + 2);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.3),0 0 0 1.5px rgba(99,102,241,.5)';
          document.body.appendChild(ghost);
          card.classList.add('fx-drag-ghost-src');
          document.body.classList.add('fx-drag-on');
        }
        if (!ghost) return;
        ghost.style.left = (or.left + dx) + 'px';
        ghost.style.top = (or.top + dy) + 'px';
        ghost.style.width = or.width + 'px';
        // 落点高亮（让位提示，纯视觉）
        const hover = others.find(o => {
          const rr = o.el.getBoundingClientRect();
          return ev.clientX >= rr.left && ev.clientX <= rr.right && ev.clientY >= rr.top && ev.clientY <= rr.bottom;
        });
        if (hover && hover.el !== lastHint) {
          if (lastHint) lastHint.classList.remove('fx-yield-hint');
          hover.el.classList.add('fx-yield-hint');
          lastHint = hover.el;
        }
        if (!hover && lastHint) { lastHint.classList.remove('fx-yield-hint'); lastHint = null; }
      }
      function up() {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        window.removeEventListener('blur', up);
        document.body.classList.remove('fx-drag-on');
        card.classList.remove('fx-drag-ghost-src');
        card.classList.add('fx-drop-pulse');
        setTimeout(() => card.classList.remove('fx-drop-pulse'), 450);
        if (ghost) ghost.remove();
        if (lastHint) lastHint.classList.remove('fx-yield-hint');
        ghost = null; lastHint = null;
      }
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up); // R010-2：系统中断/指针取消也清理
      window.addEventListener('blur', up); // R010-2：窗口失焦清理
    });
  }

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
