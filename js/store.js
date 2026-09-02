// RepoLens · 本地存储层:分析历史与收藏(localStorage,不收集任何远端数据)

const HKEY = 'repolens_history';
const FKEY = 'repolens_favs';
const MAX_HISTORY = 20;

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function write(key, v) {
  localStorage.setItem(key, JSON.stringify(v));
}

// ---------- 历史 ----------
export function getHistory() {
  return read(HKEY, []);
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
  return read(FKEY, []);
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
