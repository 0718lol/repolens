// RepoLens · PNG 记分卡导出(纯 Canvas 绘制,零依赖)
import { DIMENSIONS } from './score.js';

const DIM_KEYS = ['activity', 'community', 'popularity', 'maintenance', 'response'];
const DIM_LABELS = { activity: '活跃', community: '社区', popularity: '热度', maintenance: '维护', response: '响应' };

const fmt = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
const ago = iso => {
  const d = Math.floor((Date.now() - new Date(iso)) / 864e5);
  return d < 1 ? '今天' : d < 30 ? `${d} 天前` : d < 365 ? `${Math.floor(d / 30)} 个月前` : `${(d / 365).toFixed(1)} 年前`;
};

const TONE = {
  good: ['#00b894'],
  warn: ['#fdcb6e'],
  bad:  ['#e17055'],
  info: ['#74b9ff'],
};

export function exportScorecard(b, scores, total, v) {
  const W = 1000, H = 620, S = 2; // 2x 导出更清晰
  const canvas = document.createElement('canvas');
  canvas.width = W * S; canvas.height = H * S;
  const ctx = canvas.getContext('2d');
  ctx.scale(S, S);
  const repo = b.repo;

  // 背景
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#12142b'); bg.addColorStop(1, '#1c1040');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  // 装饰光斑
  const glow = (x, y, r, c) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, c); g.addColorStop(1, 'transparent'); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2); };
  glow(880, 80, 300, 'rgba(108,92,231,.25)');
  glow(120, 560, 260, 'rgba(0,184,148,.14)');

  const [toneColor] = TONE[v.tone] || TONE.warn;

  // 头部
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.font = '600 15px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText('REPOLENS · 仓库健康记分卡', 48, 56);
  ctx.fillStyle = '#fff';
  ctx.font = '700 40px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(repo.full_name, 48, 108);
  ctx.fillStyle = repo.description ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.4)';
  ctx.font = '16px -apple-system, "PingFang SC", sans-serif';
  const desc = repo.description ? (repo.description.length > 64 ? repo.description.slice(0, 64) + '…' : repo.description) : '(无描述)';
  ctx.fillText(desc, 48, 138);

  // 左:总分圆环
  const cx = 150, cy = 350, R = 88;
  ctx.lineWidth = 16; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  const ring = ctx.createLinearGradient(cx - R, cy, cx + R, cy);
  ring.addColorStop(0, '#6c5ce7'); ring.addColorStop(1, toneColor);
  ctx.strokeStyle = ring;
  ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * total / 100); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  ctx.font = '800 56px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(String(total), cx, cy + 14);
  ctx.font = '600 14px -apple-system, "PingFang SC", sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,.6)';
  ctx.fillText('综合健康分', cx, cy + 44);
  ctx.fillStyle = toneColor;
  ctx.font = '700 20px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(v.title, cx, cy + R + 46);
  ctx.textAlign = 'left';

  // 中:五维条形
  const bx = 300, bw = 330;
  DIMENSIONS.forEach((d, i) => {
    const y = 260 + i * 52;
    const val = scores[d.key];
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.font = '600 15px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(DIM_LABELS[d.key], bx, y);
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    ctx.textAlign = 'right';
    ctx.fillText(`${val}`, bx + bw, y);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,.1)';
    roundRect(ctx, bx, y + 10, bw, 10, 5); ctx.fill();
    const g2 = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    g2.addColorStop(0, '#6c5ce7'); g2.addColorStop(1, toneColor);
    ctx.fillStyle = g2;
    roundRect(ctx, bx, y + 10, Math.max(6, bw * val / 100), 10, 5); ctx.fill();
  });

  // 右:雷达(中心略左移,避免"社区"标签贴边被裁)
  drawRadarCard(ctx, 830, 340, 110, scores, toneColor);  // 底部关键指标
  const stats = [
    ['Stars', fmt(repo.stargazers_count)],
    ['Forks', fmt(repo.forks_count)],
    ['贡献者', fmt(b.contributorTotal)],
    ['最近推送', ago(repo.pushed_at)],
    ['最近发布', b.latestRelease ? ago(b.latestRelease.published_at) : '—'],
    ['开放 Issue', fmt(repo.open_issues_count)],
  ];
  const sw = (W - 96) / 6;
  stats.forEach(([label, val], i) => {
    const x = 48 + i * sw;
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    roundRect(ctx, x, 548, sw - 16, 44, 10); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(label, x + 12, 568);
    ctx.fillStyle = '#fff';
    ctx.font = '700 17px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(val, x + 12, 586);
  });

  // 下载
  canvas.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `repolens-${repo.full_name.replace('/', '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  });
}

// 记分卡内嵌小雷达(绘制到已有 ctx)
function drawRadarCard(ctx, cx, cy, R, scores, color) {
  const N = DIM_KEYS.length;
  const angle = i => -Math.PI / 2 + i * 2 * Math.PI / N;
  for (let ring = 1; ring <= 4; ring++) {
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = angle(i % N), r = R * ring / 4;
      i ? ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r) : ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
  for (let i = 0; i < N; i++) {
    const a = angle(i);
    ctx.strokeStyle = 'rgba(255,255,255,.1)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.textAlign = Math.abs(Math.cos(a)) < .3 ? 'center' : (Math.cos(a) > 0 ? 'left' : 'right');
    ctx.fillText(DIM_LABELS[DIM_KEYS[i]], cx + Math.cos(a) * (R + 14), cy + Math.sin(a) * (R + 12) + 4);
  }
  ctx.beginPath();
  DIM_KEYS.forEach((k, i) => {
    const a = angle(i), r = R * scores[k] / 100;
    i ? ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r) : ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  });
  ctx.closePath();
  ctx.fillStyle = color + '55'; ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  ctx.textAlign = 'left';
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
