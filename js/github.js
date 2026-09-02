// RepoLens · GitHub API 层
// 直接从浏览器请求 GitHub 公开 REST API,带内存缓存、可选 Token 与并发限流。

const API = 'https://api.github.com';

export function getToken() {
  return localStorage.getItem('repolens_token') || '';
}

export function setToken(t) {
  if (t) localStorage.setItem('repolens_token', t.trim());
  else localStorage.removeItem('repolens_token');
}

// 剩余配额(由每次响应更新,供 UI 展示);onRate 订阅变更
export const rate = { remaining: null, limit: null, search: null };
const rateListeners = new Set();
export function onRate(fn) {
  rateListeners.add(fn);
  fn({ ...rate });
  return () => rateListeners.delete(fn);
}
function broadcast() {
  rateListeners.forEach(f => { try { f({ ...rate }); } catch { /* 忽略订阅方异常 */ } });
}

// ---------- 简单内存缓存(会话级) ----------
const cache = new Map();
const TTL = 5 * 60 * 1000; // 5 分钟

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  return null;
}
function cacheSet(key, v) {
  cache.set(key, { t: Date.now(), v });
}

// ---------- 请求封装 ----------
export class RateLimitError extends Error {
  constructor(msg) { super(msg); this.name = 'RateLimitError'; }
}
export class NotFoundError extends Error {
  constructor(msg) { super(msg); this.name = 'NotFoundError'; }
}

// 返回 { data, headers };缓存 headers 以支持 Link 分页解析
async function gh(path) {
  const cached = cacheGet(path);
  if (cached) return cached;

  const headers = { Accept: 'application/vnd.github+json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(API + path, { headers });
  } catch (e) {
    throw new Error('网络请求失败,请检查网络连接');
  }

  if (res.status === 404) throw new NotFoundError('仓库不存在,请检查 owner/repo 拼写');
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get('X-RateLimit-Remaining') === '0') {
      throw new RateLimitError('GitHub API 限额已用尽(未登录每小时 60 次)。可在设置中填入 Personal Access Token 提升到 5000 次/小时。');
    }
    throw new RateLimitError('请求被 GitHub 拒绝(403)。');
  }
  if (res.status === 401) throw new Error('Token 无效或已过期,请在设置中更新。');
  if (!res.ok) throw new Error(`GitHub API 错误:HTTP ${res.status}`);

  const bundle = { data: await res.json(), headers: res.headers };
  cacheSet(path, bundle);
  return bundle;
}

// ---------- 并发限流:避免一次触发次级限额 ----------
export function createLimiter(concurrency = 6) {
  const queue = [];
  let active = 0;
  function next() {
    if (active >= concurrency || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  }
  return function run(fn) {
    return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  };
}
const limit = createLimiter(6);

// 从响应头吸收配额信息并广播
function absorb(headers, path) {
  const rem = headers.get('X-RateLimit-Remaining');
  const lim = headers.get('X-RateLimit-Limit');
  if (rem != null) rate.remaining = Number(rem);
  if (lim != null) rate.limit = Number(lim);
  if (path.startsWith('/search/')) rate.search = Number(rem);
  broadcast();
}

const p = async (path) => {
  const { data, headers } = await limit(() => gh(path));
  absorb(headers, path);
  return data;
};

// 带响应头的请求(解析分页 Link)
const ph = (path) => limit(() => gh(path));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 业务接口 ----------
export async function fetchRepo(full) {
  return p(`/repos/${full}`);
}

// 52 周逐周提交数(stats 端点:GitHub 侧缓存冷启动时返回 202,需重试)
export async function fetchCommitActivity(full, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    const path = `/repos/${full}/stats/commit_activity`;
    const { data, headers } = await ph(path);
    absorb(headers, path);
    if (Array.isArray(data) && data.length) return data;
    if (i < retries) await sleep(900);
  }
  return null; // 缓存始终未就绪,由评分层降级
}

// 贡献者真实总数:per_page=1 读取 Link 分页头的 last 页码
export async function fetchContributorCount(full) {
  const { headers, data } = await ph(`/repos/${full}/contributors?per_page=1&anon=1`);
  const link = headers.get('Link');
  if (link) {
    const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
    if (m) return Number(m[1]);
  }
  return Array.isArray(data) ? data.length : 0;
}

// 开放/关闭 Issue 精确总量(search API 的 total_count)
export async function fetchIssueCounts(full) {
  const q = encodeURIComponent(`repo:${full} type:issue`);
  const [open, closed] = await Promise.all([
    p(`/search/issues?q=${q}+state:open&per_page=1`),
    p(`/search/issues?q=${q}+state:closed&per_page=1`),
  ]);
  return { open: open?.total_count ?? null, closed: closed?.total_count ?? null };
}

// 仓库详情聚合
export async function fetchRepoBundle(full, onProgress = () => {}) {
  onProgress('仓库元信息…', 5);
  const repo = await fetchRepo(full);

  const steps = [
    ['语言构成', 16, () => p(`/repos/${full}/languages`)],
    ['Releases', 28, () => p(`/repos/${full}/releases?per_page=30`).catch(() => [])],
    ['Issue 样本', 40, () => p(`/repos/${full}/issues?state=all&sort=updated&direction=desc&per_page=100`).catch(() => [])],
    ['贡献者总数', 52, () => fetchContributorCount(full).catch(() => 0)],
    ['全年提交统计', 64, () => fetchCommitActivity(full)],
    ['Issue 总量', 78, () => fetchIssueCounts(full).catch(() => null)],
  ];

  const out = { repo };
  for (const [label, pct, fn] of steps) {
    onProgress(label, pct);
    try { out[label] = await fn(); }
    catch (e) { out[label] = null; }
  }
  onProgress('计算评分…', 94);

  const releases = out['Releases'] || [];
  const bundle = {
    repo,
    languages: out['语言构成'] || {},
    releases,
    latestRelease: releases[0] || null, // 列表默认按创建时间倒序
    issues: out['Issue 样本'] || [],
    contributorTotal: out['贡献者总数'] ?? 0,
    commitActivity: out['全年提交统计'],   // 52 周数组,可能为 null
    issueCounts: out['Issue 总量'],        // { open, closed } 或 null
  };
  // stats 端点缓存未就绪时,退回 100 条提交采样供评分降级使用
  if (!bundle.commitActivity) {
    onProgress('提交采样(降级)…', 88);
    bundle._fallbackCommits = await p(`/repos/${full}/commits?per_page=100&since=${encodeURIComponent(new Date(Date.now() - 365 * 864e5).toISOString())}`).catch(() => []);
  }
  return bundle;
}

// 关键词搜索仓库
export async function searchRepos(q, sort = 'stars') {
  const query = encodeURIComponent(q);
  const data = await p(`/search/repositories?q=${query}&sort=${sort}&order=desc&per_page=8`);
  return data.items || [];
}
