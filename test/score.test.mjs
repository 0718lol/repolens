// 评分模型冒烟测试(node test/score.test.mjs)
import { scoreDimensions, weightedScore, verdict, analyze } from '../js/score.js';

const now = Date.now();
const daysAgo = d => new Date(now - d * 864e5).toISOString();

// 52 周提交统计:近 13 周更密集 → 动量健康
function activity(recentPerWeek = 40, olderPerWeek = 20) {
  return Array.from({ length: 52 }, (_, i) => ({
    week: Math.floor((now - (51 - i) * 7 * 864e5) / 1000),
    total: i >= 39 ? recentPerWeek : olderPerWeek,
    days: [1, 1, 1, 1, 1, 1, 1].map(() => Math.floor((i >= 39 ? recentPerWeek : olderPerWeek) / 7)),
  }));
}

function bundle(over = {}) {
  return {
    repo: {
      full_name: 'x/y', archived: false,
      pushed_at: daysAgo(3), created_at: daysAgo(1500),
      stargazers_count: 50000, forks_count: 9000, subscribers_count: 800,
      open_issues_count: 300, size: 20480,
    },
    commitActivity: activity(),
    _fallbackCommits: [],
    contributors: null,
    contributorTotal: 480,
    releases: [
      { published_at: daysAgo(10) }, { published_at: daysAgo(40) }, { published_at: daysAgo(90) },
    ],
    latestRelease: { published_at: daysAgo(10), tag_name: 'v1.0' },
    issues: Array.from({ length: 50 }, (_, i) => i % 2
      ? { state: 'closed', comments: 3, created_at: daysAgo(20), closed_at: daysAgo(10) }
      : { state: 'open', comments: 1 }),
    issueCounts: { open: 300, closed: 1200 },
    ...over,
  };
}

const fmt = s => Object.entries(s).map(([k, v]) => `${k}=${v}`).join(' ');
let failed = 0;
const check = (cond, msg) => { if (!cond) { console.error('  ✗ ' + msg); failed++; } };

// 1. 健康仓库 → 总分应当较高,证据齐全
const a1 = analyze(bundle());
const t1 = a1.total;
console.log('healthy   :', fmt(a1.scores), '→ total', t1, verdict(bundle(), a1.scores, t1).title);
check(t1 >= 65, '健康仓库得分过低: ' + t1);
check(Object.values(a1.evidence).every(arr => Array.isArray(arr) && arr.length >= 2 && arr.every(s => typeof s === 'string' && s.length)), '证据不完整');
check(JSON.stringify(a1.evidence.activity).includes('全年提交'), '活跃证据缺少全年提交');

// 2. 死亡仓库(一年没推送、无 release、无提交)→ 应判"疑似停止维护"
const deadBundle = bundle({
  repo: { ...bundle().repo, pushed_at: daysAgo(500) },
  commitActivity: activity(0, 0),
  latestRelease: null, releases: [],
});
const a2 = analyze(deadBundle);
const t2 = a2.total;
console.log('dead      :', fmt(a2.scores), '→ total', t2, verdict(deadBundle, a2.scores, t2).title);
check(t2 <= 50, '死亡仓库得分过高: ' + t2);
check(verdict(deadBundle, a2.scores, t2).title.includes('停止维护'), '未识别停止维护');
check(a2.evidence.activity.some(s => s.includes('0 次')), '死亡仓库证据未体现 0 提交');

// 3. 归档仓库 → info 结论
const b3 = bundle(); b3.repo.archived = true;
const a3 = analyze(b3);
check(verdict(b3, a3.scores, a3.total).tone === 'info', '归档未识别');

// 4. 空数据仓库(新仓库)→ 不应 NaN / 崩溃
const a4 = analyze(bundle({
  commitActivity: null, _fallbackCommits: [], contributorTotal: 0,
  releases: [], latestRelease: null, issues: [], issueCounts: null,
  repo: { ...bundle().repo, stargazers_count: 0, forks_count: 0, subscribers_count: 0, open_issues_count: 0 },
}));
console.log('empty     :', fmt(a4.scores), '→ total', a4.total);
check(Object.values(a4.scores).every(v => Number.isFinite(v)), '出现 NaN/Infinity');

// 5. stats 缺失时降级到采样
const a5 = analyze(bundle({ commitActivity: null, _fallbackCommits: Array.from({ length: 100 }, () => ({ commit: { committer: { date: daysAgo(5) } } })) }));
console.log('fallback  :', fmt(a5.scores), '→ total', a5.total);
check(Number.isFinite(a5.total), '降级路径崩溃');

// 6. Issue 全量占比参与响应分:开放占比极高应拉低 response
const hi = analyze(bundle({ issueCounts: { open: 2000, closed: 100 } })).scores.response;
const lo = analyze(bundle({ issueCounts: { open: 100, closed: 2000 } })).scores.response;
console.log('response  : 开放占多', hi, 'vs 关闭占多', lo);
check(lo > hi, '响应维度未反映开放占比差异');

if (failed) throw new Error(`${failed} 项断言失败`);
console.log('\n全部 6 组用例通过 ✅');
