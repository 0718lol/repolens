// 存储层单测(node test/store.test.mjs)—— 使用 localStorage 模拟
const backing = new Map();
globalThis.localStorage = {
  getItem: k => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: k => backing.delete(k),
};

const { getHistory, pushHistory, clearHistory, removeHistory, getFavs, isFav, toggleFav } = await import('../js/store.js');

let failed = 0;
const check = (cond, msg) => { if (!cond) { console.error('  ✗ ' + msg); failed++; } };

// 历史:去重置顶
pushHistory('a/b', 80);
pushHistory('c/d', 60);
pushHistory('a/b', 90);
let h = getHistory();
check(h.length === 2, '历史未去重: ' + h.length);
check(h[0].full === 'a/b' && h[0].total === 90, '重分析的仓库未置顶/未更新');
check(h[1].full === 'c/d', '历史顺序错误');

// 历史:封顶 20 条
for (let i = 0; i < 25; i++) pushHistory(`x/repo-${i}`, i);
h = getHistory();
check(h.length === 20, '历史未封顶 20: ' + h.length);
check(h[0].full === 'x/repo-24', '封顶后最新不在首位');

// 删除与清空
removeHistory('x/repo-24');
check(getHistory()[0].full !== 'x/repo-24', 'removeHistory 未删除');
clearHistory();
check(getHistory().length === 0, 'clearHistory 未清空');

// 收藏:切换
check(toggleFav('a/b') === true, '首次收藏应返回 true');
check(isFav('a/b'), 'isFav 失败');
check(toggleFav('a/b') === false, '取消收藏应返回 false');
check(!isFav('a/b'), '取消后 isFav 应为 false');

// 畸形数据防御
backing.set('repolens_history', '{bad json');
check(getHistory().length === 0, '坏 JSON 未回退为空数组');
backing.set('repolens_favs', JSON.stringify('not-array'));
check(getFavs().length === 0, '非数组未回退为空数组');

if (failed) throw new Error(`${failed} 项断言失败`);
console.log('store 测试全部通过 ✅');
