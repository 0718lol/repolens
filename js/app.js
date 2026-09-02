// RepoLens · 应用入口:hash 路由 + 视图渲染
import { fetchRepoBundle, searchRepos, getToken, setToken, onRate, rate, getApiBase, setApiBase, RateLimitError, NotFoundError } from './github.js';
import { analyze, verdict, DIMENSIONS, hasCustomWeights } from './score.js';
import { drawRadar, drawHeatmap, drawBars, bundleToDaily, PALETTE } from './charts.js';
import { exportScorecard } from './card.js';
import { getHistory, pushHistory, clearHistory, getFavs, isFav, toggleFav, getWeights, setWeights, encodeWeights, decodeWeights } from './store.js';

const view = document.getElementById('view');
const $ = (sel, el = view) => el.querySelector(sel);
const $$ = (sel, el = view) => [...el.querySelectorAll(sel)];

const fmt = n => n == null ? '—' : n >= 1000 ? (n >= 10000 ? (n / 1000).toFixed(0) : (n / 1000).toFixed(1)) + 'k' : String(n);
const ago = iso => {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso)) / 864e5);
  return d < 1 ? '今天' : d < 30 ? `${d} 天前` : d < 365 ? `${Math.floor(d / 30)} 个月前` : `${(d / 365).toFixed(1)} 年前`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const scoresCache = new Map(); // full -> bundle+scores,供对比页复用

// ---------------- 路由 ----------------
const routes = [
  { re: /^#\/$/, fn: renderHome },
  { re: /^#\/compare\/(.+)$/, fn: (m) => renderCompare(parseCompareSpec(m[1])) },
  { re: /^#\/compare\/?$/, fn: () => renderCompare() },
  { re: /^#\/repo\/([^/]+)\/(.+)$/, fn: (m) => renderRepo(`${m[1]}/${m[2]}`) },
  { re: /^#\/about\/?$/, fn: renderAbout },
];

// 深链规格:"a...b...c" → ['a','b','c'](最多 4 个)
function parseCompareSpec(spec) {
  return (spec || '').split('...').map(s => decodeURIComponent(s).trim()).filter(Boolean).slice(0, 4);
}

function navigate() {
  const h = location.hash || '#/';
  for (const r of routes) {
    const m = h.match(r.re);
    if (m) { r.fn(m); syncNav(h); window.scrollTo(0, 0); return; }
  }
  location.hash = '#/';
}
function syncNav(h) {
  $$('.topnav a').forEach(a => {
    const key = a.dataset.nav;
    a.classList.toggle('on', key === 'home' ? h === '#/' || h.startsWith('#/repo') : h.startsWith('#/' + key));
  });
}
window.addEventListener('hashchange', navigate);

// ---------------- 通用 UI ----------------
function toast(msg, bad = false) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.classList.add('show');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove('show'), 3200);
}

function showLoading(text = '加载中…') {
  const el = document.getElementById('global-loading');
  if (!el) return;
  el.classList.remove('hidden');
  document.getElementById('loading-text').textContent = text;
}
function hideLoading() { document.getElementById('global-loading')?.classList.add('hidden'); }
function page(html) { view.innerHTML = `<div class="page">${html}</div>`; return view.firstElementChild; }

function progress(pct, label) {
  const el = document.getElementById('loading-text');
  if (el) el.innerHTML = `${esc(label)} <span class="pct">${pct}%</span>`;
}

// 顶部搜索与示例 chips(全局绑定一次)
function bindGlobalSearch() {
  const form = document.getElementById('search-form');
  const input = document.getElementById('search-input');
  form.addEventListener('submit', e => { e.preventDefault(); goAnalyze(input.value); });
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-eg]');
    if (chip) goAnalyze(chip.dataset.eg);
  });
}
function goAnalyze(qRaw) {
  const q = (qRaw || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
  if (!q) return;
  if (/^[\w.-]+\/[\w.-]+$/.test(q)) location.hash = `#/repo/${q}`;
  else {
    // 先回到首页(hashchange 渲染),再在其后渲染搜索结果,避免被导航覆盖
    if (location.hash !== '#/' && location.hash !== '') location.hash = '#/';
    setTimeout(() => searchFlow(q), 0);
  }
}

// ---------------- 首页 ----------------
function renderHome() {
  view.innerHTML = '';
  view.appendChild(document.getElementById('tpl-home').content.cloneNode(true));
  const form = $('.hero-search');
  form.addEventListener('submit', e => { e.preventDefault(); goAnalyze(form.querySelector('input').value); });
  renderHomeHistory();
}

// 首页:收藏 + 最近分析
function renderHomeHistory() {
  const box = document.getElementById('home-history');
  if (!box) return;
  const favs = getFavs();
  const history = getHistory();
  if (!favs.length && !history.length) { box.innerHTML = ''; return; }

  const card = (full, total, ts) => {
    const d = Math.floor((Date.now() - ts) / 864e5);
    const when = d < 1 ? '今天' : d < 30 ? `${d} 天前` : `${Math.floor(d / 30)} 个月前`;
    return `<a class="h-card" href="#/repo/${esc(full)}">
      <b>${esc(full)}</b>
      ${total != null ? `<em style="background:${toneOf(total)}">${total}</em>` : '<em class="na">—</em>'}
      <span>${when}</span>
    </a>`;
  };

  box.innerHTML = `
    ${favs.length ? `<div class="h-section"><h2>⭐ 收藏</h2><div class="h-grid">${favs.map(f => card(f, null, Date.now())).join('')}</div></div>` : ''}
    ${history.length ? `<div class="h-section"><h2>🕘 最近分析 <button class="link-btn" id="btn-clear-history">清空</button></h2><div class="h-grid">${history.map(x => card(x.full, x.total, x.ts)).join('')}</div></div>` : ''}`;
  const btn = document.getElementById('btn-clear-history');
  if (btn) btn.onclick = () => { clearHistory(); renderHomeHistory(); toast('已清空历史'); };
}

function renderAbout() {
  view.innerHTML = '';
  view.appendChild(document.getElementById('tpl-about').content.cloneNode(true));
}

// ---------------- 搜索结果 ----------------
async function searchFlow(q) {
  showLoading(`搜索 “${q}”…`);
  try {
    const items = await searchRepos(q);
    hideLoading();
    if (!items.length) { toast('没有匹配的仓库', true); return; }
    const el = page(`
      <h2 class="section-title">“${esc(q)}” 的搜索结果 <small>点击进入洞察</small></h2>
      <div class="search-grid">
        ${items.map(r => `
          <a class="repo-card" href="#/repo/${r.full_name}">
            <div class="rc-head"><img src="${r.owner.avatar_url}" alt=""> <b>${esc(r.full_name)}</b></div>
            <p>${esc(r.description || '(无描述)')}</p>
            <div class="rc-meta"><span>★ ${fmt(r.stargazers_count)}</span><span>${esc(r.language || '—')}</span><span>更新 ${ago(r.pushed_at)}</span></div>
          </a>`).join('')}
      </div>`);
    return el;
  } catch (e) { hideLoading(); toast(e.message, true); }
}

// ---------------- 仓库洞察页 ----------------
async function renderRepo(full) {
  showLoading('仓库元信息…');
  try {
    const b = await fetchRepoBundle(full, progress);
    hideLoading();
    const customW = getWeights();
    const archived = !!b.repo.archived;
    const { scores, evidence, total: rawTotal } = analyze(b, customW);
    const total = archived ? null : rawTotal; // 归档仓库不给综合分
    scoresCache.set(full, { b, scores, total: rawTotal });

    const v = verdict(b, scores, rawTotal);
    const repo = b.repo;
    const langs = Object.entries(b.languages || {}).sort((a, c) => c[1] - a[1]);
    const langSum = langs.reduce((s, [, n]) => s + n, 0) || 1;
    const yearTotal = (b.commitActivity || []).reduce((s, w) => s + (w.total || 0), 0);

    page(`
      <div class="repo-hero">
        <img class="avatar" src="${repo.owner.avatar_url}" alt="">
        <div class="rh-main">
          <h1><a href="${repo.html_url}" target="_blank" rel="noopener">${esc(repo.full_name)} ↗</a>
            ${archived ? '<span class="pill pill-info">已归档</span>' : ''}</h1>
          <p class="rh-desc">${esc(repo.description || '(无描述)')}</p>
          <div class="rh-meta">
            <span>★ ${fmt(repo.stargazers_count)}</span>
            <span>⑂ ${fmt(repo.forks_count)}</span>
            <span>👁 ${fmt(repo.subscribers_count)}</span>
            ${repo.language ? `<span><i class="lang-dot" style="background:${langColor(repo.language)}"></i>${esc(repo.language)}</span>` : ''}
            <span>最近推送 ${ago(repo.pushed_at)}</span>
            ${repo.license ? `<span>${esc(repo.license.spdx_id || repo.license.name)}</span>` : ''}
          </div>
        </div>
        <div class="rh-actions">
          <button class="btn btn-primary" id="btn-card">🃏 导出记分卡</button>
          <button class="btn" id="btn-fav">${isFav(full) ? '⭐ 已收藏' : '☆ 收藏'}</button>
          <button class="btn" id="btn-compare">⚔️ 加入对比</button>
          <button class="btn" id="btn-share">🔗 复制链接</button>
        </div>
      </div>

      <div class="verdict verdict-${v.tone}">
        <div class="v-icon">${{ good: '✅', warn: '⚠️', bad: '⛔', info: '📦' }[v.tone]}</div>
        <div><b>${v.title}</b><p>${v.text}</p></div>
      </div>

      <div class="grid-2">
        <section class="card score-card">
          <h2>综合健康分</h2>
          <div class="score-flex">
            <div class="ring-wrap">
              <canvas id="ring" width="10"></canvas>
              <div class="ring-num"><b>${total ?? '—'}</b><span>${total == null ? '已归档' : '/100'}</span></div>
            </div>
            <canvas id="radar"></canvas>
          </div>
        </section>
        <section class="card">
          <h2>维度明细 <small>每项均给出得分依据</small>
            <button class="link-btn" id="btn-weights">${hasCustomWeights(customW) ? '⚖️ 自定义权重生效中' : '⚖️ 自定义权重'}</button>
          </h2>
          <div id="weights-panel" class="weights-panel hidden">
            <p class="hint">拖动滑杆调整五维权重(按比例归一化),总分实时重算;权重写入链接,可分享你的口径。</p>
            ${DIMENSIONS.map(d => `
              <div class="w-row">
                <span>${d.label}</span>
                <input type="range" min="0" max="40" step="1" data-k="${d.key}" value="${customW?.[d.key] ?? Math.round(d.weight * 100)}">
                <b data-wv="${d.key}">—</b>
              </div>`).join('')}
            <div class="w-foot">
              <span class="hint" id="w-note"></span>
              <button class="link-btn" id="w-reset">恢复默认</button>
            </div>
          </div>
          <div class="dims">
            ${DIMENSIONS.map(d => `
              <div class="dim" data-k="${d.key}" title="${esc(d.desc)}">
                <div class="dim-head"><span>${d.label}<small>权重 ${(d.weight * 100).toFixed(0)}%</small></span><b>${scores[d.key]}</b></div>
                <div class="dim-bar"><i style="width:${scores[d.key]}%;background:${toneOf(scores[d.key])}" data-c="${toneOf(scores[d.key])}"></i></div>
                <div class="dim-evidence">${evidence[d.key].map(esc).join(' · ')}</div>
              </div>`).join('')}
          </div>
          <p class="hint">评分与依据均为算法估算:提交/Release 为 GitHub 官方统计,Issue 关闭时长来自近期样本。</p>
        </section>
      </div>

      <div class="grid-2">
        <section class="card">
          <h2>提交热力图 <small>近 12 个月</small></h2>
          <div id="heatmap"></div>
          <h2 style="margin-top:20px">月度提交趋势</h2>
          <div id="bars"></div>
        </section>
        <section class="card">
          <h2>关键指标</h2>
          <div class="stats">
            ${[
              ['贡献者', fmt(b.contributorTotal)],
              ['近一年提交', yearTotal ? fmt(yearTotal) : `${b._fallbackCommits?.length || 0}(采样)`],
              ['最新 Release', b.latestRelease ? esc(b.latestRelease.tag_name) : '无'],
              ['最近发布', b.latestRelease ? ago(b.latestRelease.published_at) : '—'],
              ['开放 Issue', fmt(repo.open_issues_count)],
              ['仓库大小', repo.size >= 1024 * 1024 ? (repo.size / 1048576).toFixed(1) + ' GB' : repo.size >= 1024 ? (repo.size / 1024).toFixed(1) + ' MB' : repo.size + ' KB'],
              ['创建于', new Date(repo.created_at).toLocaleDateString('zh-CN')],
              ['Issue 响应', responseSummary(b)],
            ].map(([k, val]) => `<div class="stat"><span>${k}</span><b>${val}</b></div>`).join('')}
          </div>
          ${langs.length ? `
            <h2 style="margin-top:20px">语言构成</h2>
            <div class="langbar">${langs.map(([l, n]) => `<i style="flex:${n / langSum};background:${langColor(l)}" title="${esc(l)}"></i>`).join('')}</div>
            <div class="langlegend">${langs.slice(0, 6).map(([l]) => `<span><i style="background:${langColor(l)}"></i>${esc(l)}</span>`).join('')}</div>` : ''}
          <h2 style="margin-top:20px">近期 Release</h2>
          ${b.releases.length ? `<ul class="rel-list">${b.releases.slice(0, 4).map(r => `
            <li><a href="${r.html_url}" target="_blank" rel="noopener">${esc(r.tag_name || r.name)}</a><span>${ago(r.published_at)}</span></li>`).join('')}</ul>`
            : '<p class="hint">该仓库没有发布过 Release。</p>'}
        </section>
      </div>`);

    // 画图
    drawRing($('#ring'), total, archived);
    drawRadar($('#radar'), [{ label: repo.full_name, scores, color: PALETTE[0] }], { width: 300, height: 280 });
    drawHeatmap($('#heatmap'), bundleToDaily(b));
    drawBars($('#bars'), bundleToDaily(b));

    // ---- 自定义权重:实时重算 ----
    const updateWeightLabels = () => {
      const inputs = $$('#weights-panel input[type=range]');
      const sum = inputs.reduce((s, r) => s + Number(r.value), 0) || 1;
      inputs.forEach(r => {
        $(`#weights-panel [data-wv="${r.dataset.k}"]`).textContent = Math.round(Number(r.value) / sum * 100) + '%';
      });
    };
    const applyWeights = () => {
      const w = getWeights();
      const re = analyze(b, w);
      scoresCache.set(full, { b, scores: re.scores, total: re.total });
      drawRing($('#ring'), archived ? null : re.total, archived);
      drawRadar($('#radar'), [{ label: repo.full_name, scores: re.scores, color: PALETTE[0] }], { width: 300, height: 280 });
      $('.ring-num b').textContent = archived ? '—' : re.total;
      DIMENSIONS.forEach(d => {
        const row = $(`.dim[data-k="${d.key}"]`);
        const bar = row.querySelector('.dim-bar i');
        bar.style.width = re.scores[d.key] + '%';
        bar.style.background = toneOf(re.scores[d.key]);
        row.querySelector('.dim-head b').textContent = re.scores[d.key];
      });
      const nv = verdict(b, re.scores, re.total);
      const vb = $('.verdict');
      vb.className = `verdict verdict-${nv.tone}`;
      vb.innerHTML = `<div class="v-icon">${{ good: '✅', warn: '⚠️', bad: '⛔', info: '📦' }[nv.tone]}</div><div><b>${nv.title}</b><p>${esc(nv.text)}</p></div>`;
      $('#btn-weights').textContent = hasCustomWeights(w) ? '⚖️ 自定义权重生效中' : '⚖️ 自定义权重';
      $('#w-note').textContent = hasCustomWeights(w) ? '当前为自定义口径,记分卡与对比页同样生效' : '默认口径';
      history.replaceState(null, '', (w ? `?w=${encodeWeights(w)}` : location.pathname) + location.hash);
    };
    $('#btn-weights').onclick = () => $('#weights-panel').classList.toggle('hidden');
    $('#weights-panel').addEventListener('input', e => {
      if (e.target.type !== 'range') return;
      const w = {};
      $$('#weights-panel input[type=range]').forEach(r => { w[r.dataset.k] = Number(r.value); });
      if (Object.values(w).every(v => v === 0)) return; // 全零权重无意义,忽略
      setWeights(w);
      scoresCache.clear(); // 权重变化使对比缓存失效
      updateWeightLabels();
      applyWeights();
    });
    $('#w-reset').onclick = () => {
      setWeights(null);
      scoresCache.clear();
      $$('#weights-panel input[type=range]').forEach(r => {
        r.value = Math.round(DIMENSIONS.find(d => d.key === r.dataset.k).weight * 100);
      });
      updateWeightLabels();
      applyWeights();
    };
    updateWeightLabels();

    // 动作
    pushHistory(full, rawTotal); // 记入历史
    $('#btn-card').onclick = () => {
      const cur = analyze(b, getWeights());
      exportScorecard(b, cur.scores, cur.total, verdict(b, cur.scores, cur.total), hasCustomWeights(getWeights()));
    };
    $('#btn-fav').onclick = () => {
      const on = toggleFav(full);
      $('#btn-fav').textContent = on ? '⭐ 已收藏' : '☆ 收藏';
      toast(on ? '已加入收藏' : '已取消收藏');
    };
    $('#btn-share').onclick = async () => {
      try { await navigator.clipboard.writeText(location.href); toast('链接已复制'); }
      catch { toast('复制失败,请手动复制地址栏', true); }
    };
    $('#btn-compare').onclick = () => {
      location.hash = `#/compare/${encodeURIComponent(full)}...`;
    };
  } catch (e) {
    hideLoading();
    renderError(e, full);
  }
}

function renderError(e, full) {
  page(`
    <div class="card err-card">
      <h2>${e instanceof NotFoundError ? '🔍 仓库不存在' : '😵 分析失败'}</h2>
      <p>${esc(e.message)}</p>
      <div class="row-gap">
        <a class="btn btn-primary" href="#/">返回首页</a>
        ${e instanceof RateLimitError ? '<button class="btn" id="btn-open-settings">设置 Token</button>' : ''}
        ${!(e instanceof NotFoundError) ? `<button class="btn" onclick="location.reload()">重试</button>` : ''}
      </div>
    </div>`);
  const btn = $('#btn-open-settings');
  if (btn) btn.onclick = () => openSettings();
}

function toneOf(v) { return v >= 70 ? '#00b894' : v >= 45 ? '#fdcb6e' : '#e17055'; }

function responseSummary(b) {
  if (b.issueCounts && b.issueCounts.open != null && (b.issueCounts.open + b.issueCounts.closed) > 0) {
    const { open, closed } = b.issueCounts;
    const med = medianCloseFromSample(b);
    const medLabel = med == null ? '' : med < 1 ? ' · 中位关闭 <1 天' : med < 30 ? ` · 中位关闭 ${med.toFixed(0)} 天` : ` · 中位关闭 ${(med / 30).toFixed(1)} 月`;
    return `${(open / (open + closed) * 100).toFixed(0)}% 开放${medLabel}`;
  }
  const closed = b.issues.filter(i => i.state === 'closed');
  if (!closed.length) return '样本不足';
  const durs = closed.map(i => (new Date(i.closed_at) - new Date(i.created_at)) / 864e5).filter(d => d >= 0).sort((a, c) => a - c);
  const med = durs[Math.floor(durs.length / 2)] ?? 0;
  return med < 1 ? '<1 天(中位)' : med < 30 ? `${med.toFixed(0)} 天(中位)` : `${(med / 30).toFixed(1)} 月(中位)`;
}

function medianCloseFromSample(b) {
  const durs = b.issues.filter(i => i.state === 'closed' && i.closed_at)
    .map(i => (new Date(i.closed_at) - new Date(i.created_at)) / 864e5)
    .filter(d => d >= 0).sort((a, c) => a - c);
  return durs.length ? durs[Math.floor(durs.length / 2)] : null;
}

// 总分圆环(归档仓库置灰)
function drawRing(canvas, total, archived = false) {
  const size = 170, ctx = canvas.getContext('2d');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = size * dpr; canvas.height = size * dpr;
  canvas.style.width = canvas.style.height = size + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = size / 2, cy = size / 2, R = 70;
  ctx.lineWidth = 13; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(120,130,170,.15)';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  if (total == null) return;
  const col = archived ? '#6b7394' : toneOf(total);
  const g = ctx.createLinearGradient(cx - R, cy, cx + R, cy);
  g.addColorStop(0, '#6c5ce7'); g.addColorStop(1, col);
  ctx.strokeStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * total / 100); ctx.stroke();
}

// ---------------- 对比页 ----------------
// 深链格式:#/compare/<owner/repo>...<owner/repo>...(2–4 个),可直接分享
async function renderCompare(pres = []) {
  const filled = pres.filter(s => /^[\w.-]+\/[\w.-]+$/.test(s)).slice(0, 4);
  page(`
    <h2 class="section-title">⚔️ 多仓库对比 <small>2–4 个 owner/repo,雷达叠加 + 指标对决;对比链接可直接分享</small></h2>
    <div class="card compare-inputs">
      <div id="ci-rows"></div>
      <div class="ci-actions">
        <button class="btn" id="ci-add">＋ 添加仓库</button>
        <button class="btn btn-primary" id="cmp-go">开始对比</button>
      </div>
    </div>
    <div id="cmp-body">${filled.length >= 2 ? '<div class="spinner"></div><p class="hint">正在拉取仓库数据…</p>' : '<p class="hint">填写 2–4 个仓库后点击「开始对比」;也可以在任意洞察页点「加入对比」带入。</p>'}</div>`);

  const rows = $('#ci-rows');
  const addRow = (value = '') => {
    if (rows.children.length >= 4) return;
    const div = document.createElement('div');
    div.className = 'ci-row';
    div.innerHTML = `<i class="ci-dot"></i>
      <input placeholder="owner/repo,如 vuejs/core" spellcheck="false">
      <button class="ci-rm" title="移除">✕</button>`;
    div.querySelector('input').value = value;
    rows.appendChild(div);
    refreshRows();
  };
  const refreshRows = () => {
    [...rows.children].forEach((r, i) => {
      r.querySelector('.ci-dot').style.background = PALETTE[i % PALETTE.length];
      r.querySelector('.ci-rm').style.visibility = rows.children.length > 2 ? 'visible' : 'hidden';
    });
    $('#ci-add').disabled = rows.children.length >= 4;
  };
  rows.addEventListener('click', e => {
    if (!e.target.classList.contains('ci-rm')) return;
    e.target.closest('.ci-row').remove();
    refreshRows();
  });
  $('#ci-add').onclick = () => addRow();
  filled.forEach(f => addRow(f));
  while (rows.children.length < 2) addRow();
  refreshRows();

  async function runCompare() {
    const inputs = [...rows.querySelectorAll('input')].map(i => i.value.trim().replace(/^https?:\/\/github\.com\//i, ''));
    const valid = inputs.filter(v => /^[\w.-]+\/[\w.-]+$/.test(v));
    if (valid.length < 2) { toast('请至少填写 2 个有效的 owner/repo', true); return; }
    const repos = [...new Set(valid)];
    if (repos.length !== valid.length) toast('已忽略重复仓库');
    const deep = '#/compare/' + repos.map(r => encodeURIComponent(r)).join('...');
    if (location.hash !== deep) history.replaceState(null, '', deep);

    const body = $('#cmp-body');
    body.innerHTML = '<div class="spinner"></div><p class="hint">正在拉取仓库数据…</p>';
    const settled = await Promise.allSettled(repos.map(getScored));
    const ok = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
    if (ok.length < 2) {
      const reason = settled.find(s => s.status === 'rejected')?.reason?.message || '未知错误';
      body.innerHTML = `<div class="card err-card"><h2>😵 对比失败</h2><p>${esc(reason)}</p></div>`;
      return;
    }
    if (ok.length < settled.length) toast('部分仓库拉取失败,已跳过', true);
    renderCompareResult(body, ok);
  }
  $('#cmp-go').onclick = runCompare;
  rows.addEventListener('keydown', e => { if (e.key === 'Enter') runCompare(); });

  if (filled.length >= 2) runCompare(); // 深链进入时自动执行
}

async function getScored(full) {
  if (scoresCache.has(full)) return scoresCache.get(full);
  const b = await fetchRepoBundle(full, () => {});
  const { scores, total } = analyze(b, getWeights()); // 对比同样尊重自定义权重
  const r = { b, scores, total };
  scoresCache.set(full, r);
  return r;
}

function renderCompareResult(el, results) {
  const maxTotal = Math.max(...results.map(r => r.total));
  const tie = results.filter(r => r.total === maxTotal).length > 1;
  const yearOf = b => (b.commitActivity || []).reduce((s, w) => s + (w.total || 0), 0);

  // 指标定义:val 用于比较,disp 用于展示;mode 决定谁"最优"
  const defs = [
    { label: '综合健康分', val: r => r.total, disp: r => String(r.total), mode: 'max' },
    { label: 'Stars', val: r => r.b.repo.stargazers_count, disp: r => fmt(r.b.repo.stargazers_count), mode: 'max' },
    { label: 'Forks', val: r => r.b.repo.forks_count, disp: r => fmt(r.b.repo.forks_count), mode: 'max' },
    { label: '贡献者', val: r => r.b.contributorTotal, disp: r => fmt(r.b.contributorTotal), mode: 'max' },
    { label: '近一年提交', val: r => yearOf(r.b), disp: r => fmt(yearOf(r.b)), mode: 'max' },
    { label: '最近推送', val: r => new Date(r.b.repo.pushed_at).getTime(), disp: r => ago(r.b.repo.pushed_at), mode: 'max' },
    { label: '最新 Release', val: r => r.b.latestRelease ? +new Date(r.b.latestRelease.published_at) : -Infinity, disp: r => r.b.latestRelease ? ago(r.b.latestRelease.published_at) : '—', mode: 'max' },
    { label: '开放 Issue', val: r => r.b.repo.open_issues_count, disp: r => fmt(r.b.repo.open_issues_count), mode: 'min' },
  ];

  el.innerHTML = `
    <div class="cmp-wrap">
      <canvas id="cmp-radar"></canvas>
      <div class="cmp-legend">${results.map((r, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(r.b.repo.full_name)}</span>`).join('')}</div>
      <div class="cmp-sides">
        ${results.map((r, i) => `
          <div class="cmp-side ${r.total === maxTotal ? 'win' : ''}">
            <img src="${r.b.repo.owner.avatar_url}" alt=""><b>${esc(r.b.repo.full_name)}</b>
            <em class="cmp-total" style="background:${toneOf(r.total)}">${r.total}</em>
            ${r.total === maxTotal ? `<span class="win-tag">${tie ? '🤝 并列第一' : '🏆 胜出'}</span>` : ''}
          </div>`).join('')}
      </div>
    </div>
    <div class="card"><table class="cmp-table">
      <tr><th>指标</th>${results.map(r => `<th>${esc(r.b.repo.full_name)}</th>`).join('')}</tr>
      ${defs.map(def => {
        const vals = results.map(def.val);
        const best = def.mode === 'min' ? Math.min(...vals) : Math.max(...vals);
        const uniqueBest = vals.filter(v => v === best).length === 1;
        return `<tr><td>${def.label}</td>${results.map((r, i) => `<td class="${vals[i] === best && uniqueBest ? 'better' : ''}">${def.disp(r)}</td>`).join('')}</tr>`;
      }).join('')}
    </table></div>
    <div class="grid-2">
      ${DIMENSIONS.map(d => `
        <div class="card dim-pair">
          <div class="dim-head"><b>${d.label}</b><span>${results.map(r => r.scores[d.key]).join(' <i>vs</i> ')}</span></div>
          <div class="cmp-bars">${results.map((r, i) => `<div class="cb"><i style="width:${r.scores[d.key]}%;background:${PALETTE[i % PALETTE.length]}"></i></div>`).join('')}</div>
        </div>`).join('')}
    </div>`;

  drawRadar($('#cmp-radar', el), results.map((r, i) => ({ label: r.b.repo.full_name, scores: r.scores, color: PALETTE[i % PALETTE.length] })), { width: 380, height: 330 });
}

// ---------------- 设置(Token) ----------------
function openSettings() {
  let mask = document.querySelector('.mask');
  if (mask) mask.remove();
  mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML = `
    <div class="modal card">
      <h2>⚙️ 设置</h2>
      <label class="field"><span>GitHub Personal Access Token(可选)</span>
        <input id="token-input" type="password" placeholder="ghp_… 提升限额到 5000 次/小时" value="${esc(getToken())}">
      </label>
      <label class="field"><span>GitHub API 地址(GHE 用户可改为企业实例)</span>
        <input id="api-input" type="text" placeholder="https://api.github.com" value="${esc(getApiBase())}" spellcheck="false">
      </label>
      <p class="hint">Token 与 API 地址仅保存在你的浏览器 localStorage,请求只发往你配置的实例。</p>
      <div class="row-gap right">
        <button class="btn" id="tok-clear">清除</button>
        <button class="btn btn-primary" id="tok-save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
  $('#tok-save', mask).onclick = () => {
    setToken($('#token-input', mask).value);
    setApiBase($('#api-input', mask).value);
    updateQuotaChip();
    toast('已保存');
    mask.remove();
  };
  $('#tok-clear', mask).onclick = () => { setToken(''); updateQuotaChip(); $('#token-input', mask).value = ''; toast('已清除'); };
}

// 顶栏配额芯片:剩余/上限 三档配色,Token 已配置时加 🔑
function updateQuotaChip() {
  const chip = document.querySelector('.quota-chip');
  if (!chip) return;
  const { remaining, limit } = rate;
  chip.classList.toggle('token', !!getToken());
  chip.title = getToken() ? '已配置 Token · GitHub API 剩余配额' : '未登录 · GitHub API 剩余配额(点 ⚙️ 可设置 Token)';
  if (remaining == null) {
    chip.innerHTML = `${getToken() ? '🔑' : ''}⚡ —`;
    chip.dataset.level = 'unknown';
    return;
  }
  chip.innerHTML = `${getToken() ? '🔑' : ''}⚡ ${remaining}${limit ? '/' + limit : ''}`;
  const frac = limit ? remaining / limit : remaining / 60;
  chip.dataset.level = frac > .33 ? 'ok' : frac > .08 ? 'low' : 'crit';
}

// ---------------- 语言色板 ----------------
const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Go: '#00ADD8',
  Rust: '#dea584', Java: '#b07219', 'C++': '#f34b7d', C: '#555555', 'C#': '#178600',
  Ruby: '#701516', PHP: '#4F5D95', Swift: '#F05138', Kotlin: '#A97BFF', Dart: '#00B4AB',
  Shell: '#89e051', HTML: '#e34c26', CSS: '#563d7c', Vue: '#41b883', Zig: '#ec915c',
  'Jupyter Notebook': '#DA5B0B', Lua: '#000080', Scala: '#c22d40', R: '#198CE7',
};
function langColor(l) { return LANG_COLORS[l] || '#8a93b2'; }

// ---------------- 启动 ----------------
bindGlobalSearch();
document.querySelector('.brand').addEventListener('click', e => { if (location.hash === '#/' || location.hash === '') location.reload(); });
// 设置入口:点击页脚 logo 右侧齿轮(顶栏)
const gear = document.createElement('button');
gear.className = 'gear-btn'; gear.title = '设置'; gear.textContent = '⚙️';
document.querySelector('.topbar').appendChild(gear);
gear.onclick = () => openSettings();

// 配额指示器
const quotaChip = document.createElement('div');
quotaChip.className = 'quota-chip';
document.querySelector('.topbar').appendChild(quotaChip);
onRate(updateQuotaChip);
updateQuotaChip();

// URL ?w= 中的自定义权重优先于本地持久化(便于分享口径)
const qw = new URLSearchParams(location.search).get('w');
if (qw !== null) {
  const parsed = decodeWeights(qw);
  setWeights(parsed); // 解析失败(null)即恢复默认
}

navigate();
