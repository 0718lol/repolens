// github.js 数据防御单测(node test/github.test.mjs,不发起网络请求)
const { validateBundle, getApiBase, setApiBase } = await import('../js/github.js');

let failed = 0;
const check = (cond, msg) => { if (!cond) { console.error('  ✗ ' + msg); failed++; } };
const okBundle = () => ({
  repo: { full_name: 'x/y', owner: { avatar_url: 'a' }, html_url: 'h', stargazers_count: 1, forks_count: 1, open_issues_count: 0 },
  releases: [], issues: [],
});

// 合法数据通过
check(validateBundle(okBundle()) === true, '合法 bundle 被误杀');

// 各畸形分支
const cases = [
  ['null bundle', null],
  ['缺 repo', {}],
  ['缺 full_name', { repo: { owner: { avatar_url: 'a' }, html_url: 'h', stargazers_count: 1, forks_count: 1, open_issues_count: 0 } }],
  ['缺 owner', { repo: { full_name: 'x/y', html_url: 'h', stargazers_count: 1, forks_count: 1, open_issues_count: 0 } }],
  ['Stars 为 NaN', { repo: { full_name: 'x/y', owner: { avatar_url: 'a' }, html_url: 'h', stargazers_count: NaN, forks_count: 1, open_issues_count: 0 } }],
  ['负数 Forks', { repo: { full_name: 'x/y', owner: { avatar_url: 'a' }, html_url: 'h', stargazers_count: 1, forks_count: -1, open_issues_count: 0 } }],
  ['releases 非数组', { repo: { full_name: 'x/y', owner: { avatar_url: 'a' }, html_url: 'h', stargazers_count: 1, forks_count: 1, open_issues_count: 0 }, releases: 'x', issues: [] }],
];
for (const [name, data] of cases) {
  let threw = false;
  try { validateBundle(data); } catch { threw = true; }
  check(threw, `畸形用例未被拦截: ${name}`);
}

// API base 存取与持久化
const backing = new Map();
globalThis.localStorage = {
  getItem: k => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: k => backing.delete(k),
};
// setApiBase 在模块加载后使用同一 localStorage 抽象(github.js 内部 try/catch 兜底)
setApiBase('https://ghe.example.com/api/v3/');
check(getApiBase() === 'https://ghe.example.com/api/v3', 'API base 未去除尾部斜杠: ' + getApiBase());
setApiBase('');
check(getApiBase() === 'https://api.github.com', '空 base 应回默认');

if (failed) throw new Error(`${failed} 项断言失败`);
console.log('github 数据防御测试全部通过 ✅');
