// RepoLens · 应用入口:hash 路由 + 视图渲染
import { fetchRepoBundle, searchRepos, getToken, setToken, RateLimitError, NotFoundError } from './github.js';
import { analyze, verdict, DIMENSIONS } from './score.js';
import { drawRadar, drawHeatmap, drawBars, bundleToDaily, PALETTE } from './charts.js';
import { exportScorecard } from './card.js';

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
  { re: /^#\/compare\/(.+?)\.\.\.(.*)$/, fn: (m) => renderCompare(decodeURIComponent(m[1]), decodeURIComponent(m[2])) },
  { re: /^#\/compare\/?$/, fn: () => renderCompare() },
  { re: /^#\/repo\/([^/]+)\/(.+)$/, fn: (m) => renderRepo(`${m[1]}/${m[2]}`) },
  { re: /^#\/about\/?$/, fn: renderAbout },
];

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
    const { scores, evidence, total: rawTotal } = analyze(b);
    const archived = !!b.repo.archived;
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
          <h2>维度明细 <small>每项均给出得分依据</small></h2>
          <div class="dims">
            ${DIMENSIONS.map(d => `
              <div class="dim" title="${esc(d.desc)}">
                <div class="dim-head"><span>${d.label}<small>权重 ${(d.weight * 100).toFixed(0)}%</small></span><b>${scores[d.key]}</b></div>
                <div class="dim-bar"><i style="width:${scores[d.key]}%" data-c="${toneOf(scores[d.key])}"></i></div>
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

    // 动作
    $('#btn-card').onclick = () => exportScorecard(b, scores, rawTotal, v);
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
// 深链格式:#/compare/<owner/repo>...<owner/repo> ,可直接分享
async function renderCompare(preA = '', preB = '') {
  page(`
    <h2 class="section-title">⚔️ 双仓库对比 <small>输入两个 owner/repo,雷达叠加 + 指标对决;对比结果可直接分享链接</small></h2>
    <div class="card compare-inputs">
      <input id="cmp-a" placeholder="仓库 A,如 vuejs/core" value="${esc(preA)}" spellcheck="false">
      <span class="vs">VS</span>
      <input id="cmp-b" placeholder="仓库 B,如 solidjs/solid" value="${esc(preB)}" spellcheck="false">
      <button class="btn btn-primary" id="cmp-go">开始对比</button>
    </div>
    <div id="cmp-body">${preA && preB ? '<div class="spinner"></div><p class="hint">正在拉取两个仓库的数据…</p>' : preA ? '<p class="hint">已带入仓库 A,填写仓库 B 后点击「开始对比」。</p>' : '<p class="hint">提示:对比完成后链接可直接分享;在洞察页点「加入对比」可自动带入 A。</p>'}</div>`);

  $('#cmp-go').onclick = runCompare;
  const go = e => { if (e.key === 'Enter') runCompare(); };
  $('#cmp-a').addEventListener('keydown', go);
  $('#cmp-b').addEventListener('keydown', go);

  async function runCompare() {
    const a = $('#cmp-a').value.trim().replace(/^https?:\/\/github\.com\//i, '');
    const bb = $('#cmp-b').value.trim().replace(/^https?:\/\/github\.com\//i, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(a) || !/^[\w.-]+\/[\w.-]+$/.test(bb)) { toast('请输入 owner/repo 格式的仓库名', true); return; }
    // 同步深链(不触发重新导航)
    const deep = `#/compare/${encodeURIComponent(a)}...${encodeURIComponent(bb)}`;
    if (location.hash !== deep) history.replaceState(null, '', deep);
    const body = $('#cmp-body');
    body.innerHTML = '<div class="spinner"></div><p class="hint">正在拉取两个仓库的数据…</p>';
    try {
      const [ra, rb] = await Promise.all([getScored(a), getScored(bb)]);
      renderCompareResult(body, ra, rb);
    } catch (e) {
      body.innerHTML = `<div class="card err-card"><p>${esc(e.message)}</p></div>`;
    }
  }

  if (preA && preB) runCompare(); // 深链进入时自动执行
}

async function getScored(full) {
  if (scoresCache.has(full)) return scoresCache.get(full);
  const b = await fetchRepoBundle(full, () => {});
  const { scores, total } = analyze(b);
  const r = { b, scores, total };
  scoresCache.set(full, r);
  return r;
}

function renderCompareResult(el, ra, rb) {
  const { b: ba, scores: sa, total: ta } = ra;
  const { b: bb, scores: sb, total: tb } = rb;
  const winA = ta > tb, tie = ta === tb;
  const yearOf = r => (r.commitActivity || []).reduce((s, w) => s + (w.total || 0), 0);
  const rows = [
    ['综合健康分', ta, tb, true],
    ['Stars', ba.repo.stargazers_count, bb.repo.stargazers_count],
    ['Forks', ba.repo.forks_count, bb.repo.forks_count],
    ['贡献者', ba.contributorTotal, bb.contributorTotal],
    ['近一年提交', yearOf(ba), yearOf(bb)],
    ['最近推送', ba.repo.pushed_at, bb.repo.pushed_at, 'ago'],
    ['最新 Release', ba.latestRelease?.published_at || null, bb.latestRelease?.published_at || null, 'ago'],
    ['开放 Issue', ba.repo.open_issues_count, bb.repo.open_issues_count, 'less'],
  ];
  el.innerHTML = `
    <div class="cmp-hero">
      <div class="cmp-side ${winA ? 'win' : ''}">
        <img src="${ba.repo.owner.avatar_url}" alt=""><b>${esc(ba.repo.full_name)}</b>
        <em class="cmp-total" style="background:${toneOf(ta)}">${ta}</em>
        ${winA ? '<span class="win-tag">🏆 胜出</span>' : tie ? '<span class="win-tag tie">平手</span>' : ''}
      </div>
      <canvas id="cmp-radar"></canvas>
      <div class="cmp-side ${!winA ? 'win' : ''}">
        <img src="${bb.repo.owner.avatar_url}" alt=""><b>${esc(bb.repo.full_name)}</b>
        <em class="cmp-total" style="background:${toneOf(tb)}">${tb}</em>
        ${!winA ? '<span class="win-tag">🏆 胜出</span>' : tie ? '<span class="win-tag tie">平手</span>' : ''}
      </div>
    </div>
    <div class="card"><table class="cmp-table">
      <tr><th>指标</th><th>${esc(ba.repo.full_name)}</th><th>${esc(bb.repo.full_name)}</th></tr>
      ${rows.map(([label, va, vb, mode]) => {
        let cellA = mode === 'ago' ? ago(va) : fmt(va), cellB = mode === 'ago' ? ago(vb) : fmt(vb);
        let aBetter = mode === 'less' ? (va ?? Infinity) < (vb ?? Infinity) : (va ?? -1) > (vb ?? -1);
        if (mode !== true && (va == null || vb == null)) aBetter = null;
        if (mode === true) aBetter = ta > tb ? true : ta < tb ? false : null;
        return `<tr><td>${label}</td><td class="${aBetter === true ? 'better' : ''}">${cellA}</td><td class="${aBetter === false ? 'better' : ''}">${cellB}</td></tr>`;
      }).join('')}
    </table></div>
    <div class="grid-2">
      ${DIMENSIONS.map(d => {
        const va = sa[d.key], vb = sb[d.key];
        return `<div class="card dim-pair">
          <div class="dim-head"><b>${d.label}</b><span>${va} <i>vs</i> ${vb}</span></div>
          <div class="cmp-bars">
            <div class="cb"><i style="width:${va}%;background:${PALETTE[0]}"></i></div>
            <div class="cb"><i style="width:${vb}%;background:${PALETTE[1]}"></i></div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  drawRadar($('#cmp-radar', el), [
    { label: ba.repo.full_name, scores: sa, color: PALETTE[0] },
    { label: bb.repo.full_name, scores: sb, color: PALETTE[1] },
  ], { width: 360, height: 320 });
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
      <p class="hint">Token 仅保存在你的浏览器 localStorage,请求只发往 GitHub。建议创建只读、无过期时间的 classic token 即可。</p>
      <div class="row-gap right">
        <button class="btn" id="tok-clear">清除</button>
        <button class="btn btn-primary" id="tok-save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
  $('#tok-save', mask).onclick = () => { setToken($('#token-input', mask).value); toast('已保存'); mask.remove(); };
  $('#tok-clear', mask).onclick = () => { setToken(''); $('#token-input', mask).value = ''; toast('已清除'); };
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

navigate();
