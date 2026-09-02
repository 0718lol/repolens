// 图表数据聚合单测(node test/charts.test.mjs)—— bundleToDaily 纯函数
const { bundleToDaily } = await import('../js/charts.js');

let failed = 0;
const check = (cond, msg) => { if (!cond) { console.error('  ✗ ' + msg); failed++; } };
const iso = ts => new Date(ts * 1000).toISOString().slice(0, 10);

// 1. commitActivity 路径:days[0]=周日 … days[6]=周六,week 为周日时间戳(秒)
const sunday = 1758979200; // 2025-09-27(周六)? 需为周日:2025-09-28 00:00 UTC = 1759017600
const weekTs = 1759017600; // 2025-09-28 是周日
check(new Date(weekTs * 1000).getUTCDay() === 0, '测试数据本身应是周日');
const activity = [{
  week: weekTs,
  total: 6,
  days: [1, 2, 0, 3, 0, 0, 0], // 周日1 周一2 周二0 周三3 …
}];
const daily = bundleToDaily({ commitActivity: activity });
check(daily.size === 3, '应聚合出 3 个有提交的日期: ' + daily.size);
check(daily.get(iso(weekTs)) === 1, '周日计数错误');
check(daily.get(iso(weekTs + 86400)) === 2, '周一计数错误');
check(daily.get(iso(weekTs + 3 * 86400)) === 3, '周三计数错误');
check(!daily.has(iso(weekTs + 2 * 86400)), '0 提交日不应入表');

// 2. 采样降级路径:按自然日计数
const fb = { _fallbackCommits: [
  { commit: { committer: { date: '2026-03-01T10:00:00Z' } } },
  { commit: { committer: { date: '2026-03-01T15:00:00Z' } } },
  { commit: { committer: { date: '2026-03-02T09:00:00Z' } } },
] };
const daily2 = bundleToDaily(fb);
check(daily2.get('2026-03-01') === 2 && daily2.get('2026-03-02') === 1, '降级采样按日计数错误');

// 3. 空数据
check(bundleToDaily({}).size === 0 && bundleToDaily({ commitActivity: null, _fallbackCommits: [] }).size === 0, '空数据应返回空 Map');

if (failed) throw new Error(`${failed} 项断言失败`);
console.log('charts 聚合测试全部通过 ✅');
