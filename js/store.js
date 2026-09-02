// RepoLens · 本地存储层:分析历史与收藏(localStorage,不收集任何远端数据)

const HKEY = 'repolens_history';
const FKEY = 'repolens_favs';
const MAX_HISTORY = 20;

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, v) {
  localStorage.setItem(key, JSON.stringify(v));
}

// ---------- 历史 ----------
export function getHistory() {
  const h = read(HKEY, []);
  return Array.isArray(h) ? h : [];
}

// 记录一次分析(去重置顶,封顶 20 条);total 可为 null(归档)
export function pushHistory(full, total) {
  if (!full) return;
  const list = getHistory().filter(x => x.full !== full);
  list.unshift({ full, total, ts: Date.now() });
  write(HKEY, list.slice(0, MAX_HISTORY));
}

export function removeHistory(full) {
  write(HKEY, getHistory().filter(x => x.full !== full));
}

export function clearHistory() {
  localStorage.removeItem(HKEY);
}

// ---------- 收藏 ----------
export function getFavs() {
  const f = read(FKEY, []);
  return Array.isArray(f) ? f : [];
}

export function isFav(full) {
  return getFavs().includes(full);
}

// 返回切换后的状态:true=已收藏
export function toggleFav(full) {
  const favs = getFavs();
  const i = favs.indexOf(full);
  if (i >= 0) favs.splice(i, 1);
  else favs.unshift(full);
  write(FKEY, favs);
  return i < 0;
}

// ---------- 自定义权重 ----------
const WKEY = 'repolens_weights';

// 返回原始权重对象(0–40 档)或 null(默认)
export function getWeights() {
  const w = read(WKEY, null);
  return w && typeof w === 'object' && !Array.isArray(w) ? w : null;
}

export function setWeights(w) {
  if (w && typeof w === 'object') write(WKEY, w);
  else localStorage.removeItem(WKEY);
}

// 权重 ↔ URL 片段("activity:30,community:20,..." ↔ 对象),非法输入返回 null
export function encodeWeights(w) {
  if (!w || typeof w !== 'object') return null;
  const s = Object.entries(w).map(([k, v]) => `${k}:${Number(v) || 0}`).join(',');
  return encodeURIComponent(s);
}

export function decodeWeights(str) {
  if (!str) return null;
  try {
    const out = {};
    for (const pair of decodeURIComponent(str).split(',')) {
      const [k, v] = pair.split(':');
      if (!/^[\w]+$/.test(k || '') || !Number.isFinite(Number(v))) return null;
      out[k] = Math.max(0, Math.min(40, Number(v)));
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}
