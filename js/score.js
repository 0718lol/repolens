// RepoLens · 评分模型
// 五维健康度评分,全部 0~100 分。纯函数,权重透明;analyze() 额外输出每个维度的得分依据。

export const DIMENSIONS = [
  { key: 'activity',  label: '活跃', weight: 0.28, desc: '最近推送与全年提交量、近期动量' },
  { key: 'community', label: '社区', weight: 0.22, desc: '贡献者规模与讨论参与' },
  { key: 'popularity',label: '热度', weight: 0.18, desc: 'Stars / Forks / Watchers' },
  { key: 'maintenance',label: '维护', weight: 0.18, desc: 'Release 频率与最近发布' },
  { key: 'response',  label: '响应', weight: 0.14, desc: 'Issue 开放占比与处理速度' },
];

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const logScale = (v, max) => clamp(Math.log10(1 + Math.max(0, v)) / Math.log10(1 + max) * 100);
const daysBetween = (a, b) => (a - b) / 864e5;
const fmtN = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(Math.round(n));

// 52 周统计 → 年度总量 + 近 13 周(一个季度)占比
function yearFromActivity(activity) {
  if (!Array.isArray(activity) || !activity.length) return null;
  const year = activity.reduce((s, w) => s + (w.total || 0), 0);
  const recent = activity.slice(-13).reduce((s, w) => s + (w.total || 0), 0);
  return { year, recent, share: year ? recent / year : 0 };
}

// 采样 Issue → 中位关闭时长(天)
export function medianCloseDays(issues) {
  const durs = issues.filter(i => i.state === 'closed' && i.closed_at)
    .map(i => daysBetween(new Date(i.closed_at), new Date(i.created_at)))
    .filter(d => d >= 0)
    .sort((a, b) => a - b);
  if (!durs.length) return null;
  return durs[Math.floor(durs.length / 2)];
}

// 各维度打分 + 依据。输入为 fetchRepoBundle 的产物。
export function scoreDimensions(b) {
  const { repo, issues, releases, latestRelease, contributorTotal, commitActivity, issueCounts } = b;
  const now = Date.now();
  const scores = {};

  // —— 活跃:最近推送(45%)+ 全年提交量(35%)+ 近期动量(20%)
  const lastPushDays = Math.max(0, daysBetween(now, new Date(repo.pushed_at || repo.updated_at)));
  const fresh = clamp(100 - lastPushDays * 3.5);
  const yearStats = yearFromActivity(commitActivity);
  let volume, momentum, volumeLabel, momentumLabel;
  if (yearStats) {
    volume = clamp(logScale(yearStats.year, 2000));
    momentum = yearStats.year ? clamp(yearStats.share * 4 * 100) : 0;   // 均匀分布应占 25%,达标即满
  } else {
    // stats 未就绪时的降级:退回 100 条采样
    const commits = b._fallbackCommits || [];
    volume = clamp(logScale(commits.length, 100));
    momentum = 50;
  }
  scores.activity = Math.round(fresh * .45 + volume * .35 + momentum * .20);

  // —— 社区:贡献者规模(60%)+ 讨论活跃(40%)
  const contribScore = clamp(logScale(contributorTotal, 500));
  const withComments = issues.filter(i => i.comments > 0).length;
  const discuss = issues.length ? clamp(withComments / issues.length * 130) : 0;
  scores.community = Math.round(contribScore * .6 + discuss * .4);
  const evidenceCommunity = [
    `贡献者 ${fmtN(contributorTotal)} 人`,
    issues.length ? `样本 Issue 中 ${Math.round(withComments / issues.length * 100)}% 有互动` : '无 Issue 样本',
  ];

  // —— 热度
  scores.popularity = Math.round(
    logScale(repo.stargazers_count, 100000) * .55 +
    logScale(repo.forks_count, 20000) * .30 +
    logScale(repo.subscribers_count ?? repo.watchers_count ?? 0, 5000) * .15
  );

  // —— 维护:最近 release 新鲜度(50%)+ 一年 release 节奏(50%)
  let maintenance;
  if (!latestRelease && !(releases && releases.length)) {
    maintenance = 0;
  } else {
    const latest = latestRelease || releases[0];
    const lastRelDays = daysBetween(now, new Date(latest.published_at));
    const relFresh = clamp(100 - lastRelDays * 1.4);
    const yearRels = (releases || []).filter(r => new Date(r.published_at) >= now - 365 * 864e5).length;
    maintenance = Math.round(relFresh * .5 + clamp(logScale(yearRels, 12)) * .5);
  }
  scores.maintenance = maintenance;

  // —— 响应:开放 Issue 占比(60%,越低越好)+ 关闭速度(40%)
  let openness, speed;
  if (issueCounts && issueCounts.open != null && (issueCounts.open + issueCounts.closed) > 0) {
    const openRatio = issueCounts.open / (issueCounts.open + issueCounts.closed);
    openness = clamp(100 - openRatio * 160);
  } else if (issues.length) {
    const openRatio = 1 - issues.filter(i => i.state === 'closed').length / issues.length;
    openness = clamp(100 - openRatio * 160);
  } else {
    openness = 50;
  }
  const med = medianCloseDays(issues);
  speed = med == null ? 50 : clamp(100 - Math.log10(1 + med) * 40);
  scores.response = Math.round(openness * .6 + speed * .4);

  return {
    activity: scores.activity,
    community: scores.community,
    popularity: scores.popularity,
    maintenance: scores.maintenance,
    response: scores.response,
  };
}

// 每个维度的“得分依据”(与 scoreDimensions 同源计算,避免两处漂移)
export function scoreEvidence(b) {
  const { repo, issues, releases, latestRelease, contributorTotal, commitActivity, issueCounts } = b;
  const now = Date.now();
  const lastPushDays = Math.max(0, daysBetween(now, new Date(repo.pushed_at || repo.updated_at)));
  const yearStats = yearFromActivity(commitActivity);
  const med = medianCloseDays(issues);

  const ago = d => d < 1 ? '今天' : d < 30 ? Math.round(d) + ' 天前' : d < 365 ? Math.round(d / 30) + ' 个月前' : (d / 365).toFixed(1) + ' 年前';
  const withComments = issues.filter(i => i.comments > 0).length;

  return {
    activity: [
      `最近推送 ${ago(lastPushDays)}`,
      yearStats
        ? `全年提交 ${fmtN(yearStats.year)} 次`
        : `提交统计不可用(采样 ${b._fallbackCommits?.length || 0} 条)`,
      yearStats
        ? `近90天占全年 ${(yearStats.share * 100).toFixed(0)}%(基准 25%)`
        : '动量数据暂缺',
    ],
    community: [
      `贡献者 ${fmtN(contributorTotal)} 人`,
      issues.length ? `样本 Issue 中 ${Math.round(withComments / issues.length * 100)}% 有互动` : '无 Issue 样本',
    ],
    popularity: [
      `Stars ${fmtN(repo.stargazers_count)} · Forks ${fmtN(repo.forks_count)}`,
      `Watchers ${fmtN(repo.subscribers_count ?? repo.watchers_count ?? 0)}`,
    ],
    maintenance: latestRelease || (releases && releases.length)
      ? [
          `最近发布 ${ago(daysBetween(now, new Date((latestRelease || releases[0]).published_at)))}`,
          `一年 Release ${(releases || []).filter(r => new Date(r.published_at) >= now - 365 * 864e5).length} 次`,
        ]
      : ['从未发布 Release'],
    response: [
      issueCounts && issueCounts.open != null && (issueCounts.open + issueCounts.closed) > 0
        ? `全库开放 Issue 占比 ${(issueCounts.open / (issueCounts.open + issueCounts.closed) * 100).toFixed(0)}%`
        : issues.length
          ? `开放 Issue 占比 ${((1 - issues.filter(i => i.state === 'closed').length / issues.length) * 100).toFixed(0)}%(采样)`
          : '无 Issue 数据',
      med == null ? '样本中无已关闭 Issue' : med < 1 ? '样本中位关闭 <1 天' : med < 30 ? `样本中位关闭 ${med.toFixed(0)} 天` : `样本中位关闭 ${(med / 30).toFixed(1)} 个月`,
    ],
  };
}

export function weightedScore(scores) {
  let sum = 0, wsum = 0;
  for (const d of DIMENSIONS) { sum += scores[d.key] * d.weight; wsum += d.weight; }
  return Math.round(sum / wsum);
}

// 高层封装:一次算出分数 + 依据 + 总分
export function analyze(b) {
  const scores = scoreDimensions(b);
  return { scores, evidence: scoreEvidence(b), total: weightedScore(scores) };
}

// 综合结论(供记分卡与详情页"一句话判断"使用)
export function verdict(b, scores, total) {
  const pushDays = daysBetween(Date.now(), new Date(b.repo.pushed_at || b.repo.updated_at));
  if (b.repo.archived) return { tone: 'info', title: '已归档仓库', text: '该仓库已被作者归档,只读保留,不再接受更新。' };
  if (pushDays > 365) return { tone: 'bad', title: '疑似停止维护', text: `已超过 ${Math.floor(pushDays / 365)} 年没有推送,选型请谨慎。` };
  if (total >= 80) return { tone: 'good', title: '非常健康', text: `活跃、社区与维护俱佳,最近一次推送在 ${Math.max(1, Math.floor(pushDays))} 天前。可放心使用。` };
  if (total >= 60) return { tone: 'good', title: '状态良好', text: '整体健康,个别维度有短板,适合大多数场景。' };
  if (total >= 40) return { tone: 'warn', title: '需要留意', text: '仓库仍在运转,但某些维度明显偏弱,建议阅读下方分项明细。' };
  return { tone: 'bad', title: '状态堪忧', text: '多个维度得分偏低,可能是个人实验项目或已进入低维护期。' };
}
