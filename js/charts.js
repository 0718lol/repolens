// RepoLens · Canvas 图表(零依赖)
// radar(可叠加多仓库)、heatmap(周提交热力图)、bars(月度趋势)
// 热力图/趋势的数据源是 GitHub stats 的 52 周全量统计,不再依赖 100 条采样。

function setupCanvas(canvas, w, h) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

const DIM_KEYS = ['activity', 'community', 'popularity', 'maintenance', 'response'];
const DIM_LABELS = { activity: '活跃', community: '社区', popularity: '热度', maintenance: '维护', response: '响应' };

const PALETTE = ['#6c5ce7', '#00b894', '#e17055', '#0984e3'];

// stats/commit_activity 或采样 commits → 按日提交量 Map<'YYYY-MM-DD', n>
export function bundleToDaily(b) {
  const map = new Map();
  if (Array.isArray(b.commitActivity) && b.commitActivity.length) {
    for (const week of b.commitActivity) {
      const sunday = new Date(week.week * 1000); // week: 周日 UTC 时间戳
      week.days.forEach((n, k) => {
        const d = new Date(sunday); d.setUTCDate(sunday.getUTCDate() + k); // k=0 周日 … 6 周六
        if (n) map.set(d.toISOString().slice(0, 10), (map.get(d.toISOString().slice(0, 10)) || 0) + n);
      });
    }
  } else if (Array.isArray(b._fallbackCommits)) {
    for (const c of b._fallbackCommits) {
      const key = c.commit.committer.date.slice(0, 10);
      map.set(key, (map.get(key) || 0) + 1);
    }
  }
  return map;
}

// 单轴半径比例(r = t * R)
export function drawRadar(canvas, series, opts = {}) {
  // series: [{ label, scores, color? }]
  const W = opts.width || 320, H = opts.height || 320;
  const ctx = setupCanvas(canvas, W, H);
  const cx = W / 2, cy = H / 2 + 4;
  const R = Math.min(W, H) / 2 - 40;
  const N = DIM_KEYS.length;
  const angle = i => -Math.PI / 2 + i * 2 * Math.PI / N;

  // 背景网格
  ctx.clearRect(0, 0, W, H);
  for (let ring = 1; ring <= 4; ring++) {
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = angle(i % N), r = R * ring / 4;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = ring === 4 ? 'rgba(110,120,150,.45)' : 'rgba(110,120,150,.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  // 轴线与标签
  ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
  for (let i = 0; i < N; i++) {
    const a = angle(i);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.strokeStyle = 'rgba(110,120,150,.2)';
    ctx.stroke();
    const lx = cx + Math.cos(a) * (R + 18), ly = cy + Math.sin(a) * (R + 16);
    ctx.fillStyle = 'rgba(140,150,180,.9)';
    ctx.textAlign = Math.abs(Math.cos(a)) < .3 ? 'center' : (Math.cos(a) > 0 ? 'left' : 'right');
    ctx.fillText(DIM_LABELS[DIM_KEYS[i]], lx, ly + 4);
  }

  // 数据多边形
  series.forEach((s, si) => {
    const color = s.color || PALETTE[si % PALETTE.length];
    ctx.beginPath();
    DIM_KEYS.forEach((k, i) => {
      const a = angle(i), r = R * (s.scores[k] / 100);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = color + (series.length > 1 ? '26' : '3d'); // alpha hex
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = color;
    DIM_KEYS.forEach((k, i) => {
      const a = angle(i), r = R * (s.scores[k] / 100);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  });
}

// 一年提交热力图(GitHub 风格,53 列 × 7 行,行序周一→周日)
export function drawHeatmap(container, daily) {
  container.innerHTML = '';
  const map = daily instanceof Map ? daily : new Map();
  let max = 0;
  for (const v of map.values()) max = Math.max(max, v);

  const cell = 13, gap = 3, weeks = 53;
  const W = weeks * (cell + gap) + 30, H = 7 * (cell + gap) + 20;
  const wrap = document.createElement('div');
  wrap.className = 'heatmap-scroll';
  const canvas = document.createElement('canvas');
  wrap.appendChild(canvas);
  container.appendChild(wrap);

  const ctx = setupCanvas(canvas, W, H);
  const end = new Date(); end.setUTCHours(0, 0, 0, 0);
  const endDay = (end.getUTCDay() + 6) % 7; // 周一=0
  const lastMonday = new Date(end); lastMonday.setUTCDate(end.getUTCDate() - endDay);

  for (let w = weeks - 1; w >= 0; w--) {
    for (let d = 0; d < 7; d++) {
      // 第 w 列 = 当前周往前推 w 周;d=0..6 对应周一..周日
      const date = new Date(lastMonday); date.setUTCDate(lastMonday.getUTCDate() - w * 7 + d);
      if (date > end) continue;
      const key = date.toISOString().slice(0, 10);
      const n = map.get(key) || 0;
      const t = max ? Math.min(1, Math.pow(n / max, .6)) : 0;
      const x = 30 + (weeks - 1 - w) * (cell + gap);
      const y = d * (cell + gap);
      ctx.fillStyle = t === 0 ? 'rgba(120,130,160,.12)' : `rgba(108,92,231,${.25 + t * .75})`;
      roundRect(ctx, x, y, cell, cell, 3);
      ctx.fill();
    }
  }
  // 月份标签(每逢新月份标一次)
  ctx.fillStyle = 'rgba(140,150,180,.8)';
  ctx.font = '10px -apple-system, sans-serif';
  let lastMonth = -1;
  for (let w = weeks - 1; w >= 0; w--) {
    const date = new Date(lastMonday); date.setUTCDate(lastMonday.getUTCDate() - w * 7);
    if (date.getUTCMonth() !== lastMonth) {
      lastMonth = date.getUTCMonth();
      const x = 30 + (weeks - 1 - w) * (cell + gap);
      ctx.fillText(`${lastMonth + 1}月`, x, 10);
    }
  }
  // 星期标签
  ['一', '三', '五'].forEach((label, i) => {
    ctx.fillText(label, 8, (i * 2 + 1) * (cell + gap) + 10);
  });
}

// 近 12 个月提交柱状趋势(数据源同热力图)
export function drawBars(container, daily) {
  container.innerHTML = '';
  const map = daily instanceof Map ? daily : new Map();
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ key: d.toISOString().slice(0, 7), label: `${d.getUTCMonth() + 1}`, count: 0 });
  }
  const idx = new Map(months.map((m, i) => [m.key, i]));
  for (const [key, n] of map) {
    if (idx.has(key)) months[idx.get(key)].count += n;
  }
  const max = Math.max(1, ...months.map(m => m.count));
  const W = 320, H = 110, barW = 18;
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);
  const ctx = setupCanvas(canvas, W, H);
  months.forEach((m, i) => {
    const h = Math.max(2, m.count / max * (H - 28));
    const x = i * (barW + 8) + 6, y = H - 18 - h;
    const grad = ctx.createLinearGradient(0, y, 0, H - 18);
    grad.addColorStop(0, '#6c5ce7'); grad.addColorStop(1, '#a29bfe');
    ctx.fillStyle = grad;
    roundRect(ctx, x, y, barW, h, 4); ctx.fill();
    ctx.fillStyle = 'rgba(140,150,180,.9)';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(m.label, x + barW / 2, H - 4);
    if (m.count) {
      ctx.fillStyle = 'rgba(200,205,225,.9)';
      ctx.fillText(m.count >= 10000 ? (m.count / 1000).toFixed(0) + 'k' : String(m.count), x + barW / 2, y - 4);
    }
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export { PALETTE };
