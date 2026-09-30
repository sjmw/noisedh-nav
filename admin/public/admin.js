'use strict';
/* 导航站后台单页（spec §7）：口令条(sessionStorage) + 列表/导入/新增 三视图，原生 JS 零依赖。
 * 约定：
 *  - 口令存 sessionStorage（brief 拍板；spec §7 原文写 localStorage，以 brief 为准——关标签页即失效）。
 *  - 任何地方不打印/不落盘 token；401 → 清除口令并重新显示口令条。
 *  - 所有请求走 /api/admin/*，响应壳：单行 {site}、列表 {sites,total,page,perPage}、
 *    导入 {added,skipped_dup,failed,items}、发布 {commitUrl,count,friendlinks,navitems,files}（Task 9 三文件化）、
 *    友链单行 {friendlink} / 列表 {friendlinks}（Task 4）、导航单行 {navitem} / 列表 {navitems}（Task 5）、错误 {error,message}。
 *  - URL 锚定源根（location.origin + '/api/admin/'）：页面可能挂在 /（本地 dev）或 /admin/
 *    （线上区域路由），路径相对解析在 /admin/ 下会指向 /admin/api/... 而失效；同源绝对路径两处均正确。
 */
const API = location.origin + '/api/admin/';
const TOKEN_KEY = 'noisedh-admin-token';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = String(text);
  return n;
};
const tokenBar = $('token-bar'), tabs = $('tabs'), tokenHint = $('token-hint');

/* ---------- toast ---------- */
const TOAST_ICONS = { ok: '✓', err: '✕' };
function toast(msg, { type = '', linkUrl = '', linkText = '查看提交', ttl = 6000 } = {}) {
  const box = el('div', 'toast' + (type ? ' ' + type : ''));
  box.append(el('span', 'toast-ic', TOAST_ICONS[type] || 'ℹ'), msg); // 美化轮：状态图标（纯展示）
  if (linkUrl && /^https?:/i.test(linkUrl)) { // 只接受 http(s) 链接，防 javascript: 注入
    const a = el('a', '', ' ' + linkText + ' ↗');
    a.href = linkUrl; a.target = '_blank'; a.rel = 'noopener';
    box.append(a);
  }
  $('toasts').append(box);
  // 美化轮：到期先加 .hide 淡出（CSS .3s），再摘除节点；移除时机与原来同为 ttl
  setTimeout(() => { box.classList.add('hide'); setTimeout(() => box.remove(), 320); }, ttl);
}

/* ---------- 认证 + 请求封装 ---------- */
const getToken = () => sessionStorage.getItem(TOKEN_KEY) || '';
function setToken(v) { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); }

function applyAuthedUi(authed) {
  tabs.classList.toggle('hidden', !authed);
  tokenBar.classList.toggle('hidden', authed);
  if (!authed) {
    tabs.querySelectorAll('button.on').forEach((b) => b.classList.remove('on'));
    document.querySelectorAll('main section').forEach((s) => s.classList.add('hidden'));
  }
}

// 统一入口：带 Bearer、解析 JSON、非 2xx 抛 {message,status,code}；401 时清口令回到口令条。
async function api(path, opts = {}) {
  const headers = { Authorization: 'Bearer ' + getToken(), ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
  const res = await fetch(API + path, { ...opts, headers });
  if (res.status === 401) {
    setToken('');
    tokenHint.classList.remove('hidden');
    applyAuthedUi(false);
    const err = new Error('口令无效或已过期，请重新输入'); err.status = 401; throw err;
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 兜底 */ }
  if (!res.ok) {
    const err = new Error((data && data.message) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status; err.code = data && data.error; throw err;
  }
  return data;
}

/* ---------- 视图切换 ---------- */
function showView(name) {
  for (const b of tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === name);
  for (const s of document.querySelectorAll('main section')) s.classList.toggle('hidden', s.id !== 'view-' + name);
  if (name === 'list') { loadList(); loadTaxonomies(); }
  if (name === 'add') loadTaxonomies(); // 保证新增视图的分类建议不依赖「先去列表」顺序
  if (name === 'categories') loadCategories(); // 分类表数据自足（categories+shapes 同响应），不依赖先去列表
  if (name === 'friends') loadFriends();  // 友链表数据自足（GET friendlinks 全量，无分页）
  if (name === 'navs') loadNavs();        // 导航表数据自足（GET navitems 已按 顶层-(sort,id)-子项紧随 分组）
}
tabs.addEventListener('click', (e) => {
  const v = e.target && e.target.dataset && e.target.dataset.view;
  if (v) showView(v);
});

// ── confirmModal（spec-27 §7）：多行删除统一弹窗；requireText 逐字解锁；零 innerHTML ──
const modalHost = document.createElement('div'); modalHost.id = 'modal-host'; document.body.appendChild(modalHost);
function confirmModal({ title, lines = [], danger = false, requireText = '' }) {
  return new Promise((resolve) => {
    modalHost.replaceChildren();
    const back = el('div', 'modal-back');
    const box = el('div', 'modal');
    box.appendChild(el('h3', danger ? 'modal-title danger' : 'modal-title', title));
    for (const l of lines) box.appendChild(el('p', 'modal-line', l));
    let input = null;
    if (requireText) { input = el('input'); input.type = 'text'; input.placeholder = `输入「${requireText}」解锁`; }
    const ok = el('button', danger ? 'primary danger' : 'primary', '确认');
    ok.disabled = !!requireText;
    const cancel = el('button', '', '取消');
    const close = (v) => { document.removeEventListener('keydown', onKey); modalHost.replaceChildren(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    ok.onclick = () => close(true);
    cancel.onclick = () => close(false);
    back.onclick = (e) => { if (e.target === back) close(false); };
    if (input) input.oninput = () => { ok.disabled = input.value !== requireText; };
    box.append(input ?? document.createDocumentFragment(), ok, cancel);
    back.appendChild(box); modalHost.appendChild(back); document.addEventListener('keydown', onKey);
    (input ?? ok).focus();
  });
}

/* ---------- 口令条 ---------- */
async function enter() {
  const t = $('token-input').value.trim();
  if (!t) { toast('请输入口令', { type: 'err' }); return; }
  setToken(t);
  try {
    await api('sites?perPage=1'); // 用一次最小读请求校验口令
    tokenHint.classList.add('hidden');
    $('token-input').value = '';
    applyAuthedUi(true);
    showView('list');
    toast('口令已保存（仅本标签页有效）', { type: 'ok', ttl: 3000 });
  } catch (e) {
    if (e.status !== 401) toast(e.message, { type: 'err' }); // 401 已在 api() 里回退口令条
  }
}
$('token-save').addEventListener('click', enter);
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
$('token-clear').addEventListener('click', () => { setToken(''); applyAuthedUi(false); toast('口令已清除', { ttl: 3000 }); });

/* ---------- 列表视图 ---------- */
const listState = { q: '', status: '', taxonomy: '', term: '', page: 1, perPage: 50, total: 0, sites: [] };
// Task 10 删除族：勾选态（id 集合）与最近一次 loadList 命中的 total（del-filter 弹窗摘要用）。
// loadList 开头 sel.clear()——翻页/换筛选后旧勾选不残留（防幽灵选择误删他页数据）。
const sel = new Set();
let lastTotal = 0;

/* ---------- 分类形态缓存与组合框（2026-09-27 反馈修复轮：datalist → 自制 combobox） ----------
 * 数据源 = GET categories 的 shapes 字段（categories∪sites union 形态视图，与后端
 * resolveCategoryShape 同一取证口径）。后端已对四个写入口做形态归一，前端只负责「给对建议」，
 * 提交逻辑不变（flat 分类填了子分类也会被后端静默置空，placeholder 明示规则）。
 * 原生 datalist 点击输入框不弹建议（Chrome 要先打字、iOS Safari 干脆不渲染），改为
 * 点 ▾ / 点输入框即弹出全部可选项的自制菜单；输入过滤与自由输入新分类均保留。 */
const shapeState = { shapes: [] };
// 旧服务端/旧响应缺 shapes 时降级为空清单：弹单显示「暂无可选项」、输入仍自由（后端兜底）。
const shapeOf = (tax) => shapeState.shapes.find((s) => s.taxonomy === tax.trim()) || null;
const allTaxonomies = () => [...new Set(shapeState.shapes.map((s) => s.taxonomy))].sort();
const termsFor = (tax) => {
  const s = shapeOf(tax);
  if (s && s.nested) return s.terms;
  if (s) return []; // flat 分类无子分类
  return [...new Set(shapeState.shapes.filter((x) => x.nested).flatMap((x) => x.terms))].sort(); // 未定分类：给全部已有子分类兜底
};

/* 单例弹出菜单：挂在 body 下（fixed 定位），避免被表格滚动容器/卡片 overflow 裁剪 */
let comboOwner = null; // { input, menu, optsFn }
function closeCombo() {
  if (!comboOwner) return;
  comboOwner.menu.remove();
  comboOwner = null;
}
function openCombo(input, optsFn) {
  if (comboOwner && comboOwner.input === input) { renderCombo(); return; } // 已开着：按当前输入重过滤
  closeCombo();
  const menu = el('div', 'combo-menu');
  comboOwner = { input, menu, optsFn };
  document.body.append(menu);
  renderCombo();
  const r = input.getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.width = Math.max(r.width, 160) + 'px';
  // 视口下方放不下就向上翻
  if (r.bottom + menu.offsetHeight + 8 > innerHeight) menu.style.top = Math.max(8, r.top - menu.offsetHeight - 4) + 'px';
  else menu.style.top = (r.bottom + 4) + 'px';
}
function renderCombo() {
  if (!comboOwner) return;
  const { input, menu, optsFn } = comboOwner;
  const opts = optsFn() || [];
  const kw = input.value.trim().toLowerCase();
  // 输入非空时按「包含」过滤；若恰为已选值本身（选中回填后未继续打字）不过滤，全清单仍可见
  const match = kw && !opts.includes(input.value.trim()) ? opts.filter((o) => o.toLowerCase().includes(kw)) : opts;
  menu.replaceChildren();
  for (const o of match.slice(0, 300)) {
    const b = el('button', 'combo-opt', o);
    b.type = 'button';
    if (o === input.value) b.classList.add('on');
    b.addEventListener('mousedown', (e) => e.preventDefault()); // 先于 input blur 触发，防菜单被提前关掉
    b.addEventListener('click', () => {
      input.value = o;
      input.dispatchEvent(new Event('input', { bubbles: true })); // 走原生联动（term 建议/placeholder）
      closeCombo();
    });
    menu.append(b);
  }
  if (!match.length) menu.append(el('div', 'combo-none', '无可选项——直接输入即为新分类'));
}
document.addEventListener('click', (e) => {
  if (!comboOwner) return;
  if (comboOwner.input === e.target || comboOwner.menu.contains(e.target)) return;
  closeCombo();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCombo(); });
addEventListener('resize', closeCombo);
addEventListener('scroll', (e) => { // 页面/表格滚动时菜单不跟位，直接收起；菜单自身内滚不动作
  if (comboOwner && e.target instanceof Node && comboOwner.menu.contains(e.target)) return;
  closeCombo();
}, true);

// 把「input + ▾ 按钮」接成组合框：点 ▾ 或点输入框都弹全清单；继续打字实时过滤。
function attachCombo(input, btn, optsFn) {
  btn.addEventListener('click', (e) => { e.stopPropagation(); openCombo(input, optsFn); });
  input.addEventListener('click', () => openCombo(input, optsFn));
  input.addEventListener('input', () => { if (comboOwner && comboOwner.input === input) renderCombo(); });
}

// term 的 placeholder 随当前 taxonomy 联动；返回 sync 供数据刷新后重算（建议清单经
// termsFor 实时读取，弹出时天然跟随分类输入，无需缓存回填）
function bindTermLink(taxInput, termInput) {
  const sync = () => {
    const shape = shapeOf(taxInput.value);
    if (shape && shape.nested) termInput.placeholder = '子分类（点 ▾ 选已有或输入新子分类名）';
    else if (shape) termInput.placeholder = '平铺分类：子分类留空即可（填了会被丢弃）';
    else termInput.placeholder = taxInput.value.trim() ? '新分类：可直接起子分类名' : '子分类（可选）';
  };
  taxInput.addEventListener('input', sync);
  sync();
  return sync;
}

let addTermSync = null; // 新增视图的联动句柄（loadTaxonomies 刷新数据后重算建议）

async function loadTaxonomies() {
  try {
    const { categories, shapes } = await api('categories');
    shapeState.shapes = Array.isArray(shapes) ? shapes : [];
    const sel = $('f-taxonomy');
    const cur = sel.value;
    sel.replaceChildren(new Option('全部分类', ''));
    // 筛选项取 union 全集（shapes 覆盖「有站点行但 categories 表无行」的分类），无 shapes 时回退 categories
    const taxes = shapes && shapes.length ? shapes.map((s) => s.taxonomy) : categories.map((c) => c.taxonomy);
    for (const t of [...new Set(taxes)].sort()) sel.append(new Option(t, t));
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    syncTermFilter();
    if (addTermSync) addTermSync(); // 数据刷新后重算新增表单 term 的 placeholder
  } catch { /* 401 已由 api() 处理，其余静默（筛选器缺分类不致命） */ }
}

// 子分类筛选级联：选项 = 当前所选分类的嵌套 terms；未选分类或平铺分类时禁用
function syncTermFilter() {
  const sel = $('f-term');
  const cur = sel.value;
  const shape = shapeOf($('f-taxonomy').value);
  const terms = shape && shape.nested ? shape.terms : [];
  sel.replaceChildren(new Option(terms.length ? '全部子分类' : '无子分类', ''));
  for (const t of terms) sel.append(new Option(t, t));
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  sel.disabled = !terms.length;
  if (sel.disabled) sel.value = '';
}
$('f-taxonomy').addEventListener('change', syncTermFilter);

async function loadList() {
  sel.clear(); // 每次重载清空勾选：新页行重建，旧 id 不残留（Task 10）
  try {
    const p = new URLSearchParams();
    if (listState.q) p.set('q', listState.q);
    if (listState.status) p.set('status', listState.status);
    if (listState.taxonomy) p.set('taxonomy', listState.taxonomy);
    if (listState.term) p.set('term', listState.term);
    p.set('page', String(listState.page));
    p.set('perPage', String(listState.perPage));
    const data = await api('sites?' + p.toString());
    Object.assign(listState, { total: data.total, sites: data.sites });
    lastTotal = data.total;
    renderList();
  } catch (e) { if (e.status !== 401) toast('加载列表失败：' + e.message, { type: 'err' }); }
  renderChecks(); // 成功/失败都同步勾选态与删除钮（失败时旧表仍在屏上，需跟随已清空的 sel）
}

function renderList() {
  const pages = Math.max(1, Math.ceil(listState.total / listState.perPage));
  $('list-meta').textContent = `共 ${listState.total} 条 · 第 ${listState.page}/${pages} 页 · 每页 ${listState.perPage} 条`;
  $('page-info').textContent = `${listState.page} / ${pages}`;
  $('page-prev').disabled = listState.page <= 1;
  $('page-next').disabled = listState.page >= pages;
  // 美化轮：列定义带宽度类（col-*），空结果给空态卡（原样返回，分页按钮状态上面已算好）
  if (!listState.sites.length) {
    $('table-wrap').replaceChildren(el('div', 'empty', '没有匹配的站点——换个筛选条件，或去「新增」添加一条'));
    return;
  }
  const table = el('table');
  // 美化轮：显式 thead/tbody —— DOM API 构建不会自动包 tbody，而 admin.css 的
  // 行悬停与移动端卡片规则都以 thead/tbody 为选择器锚点。
  const thead = el('thead');
  const head = el('tr');
  // Task 10：表头勾选列由 JS 创建（不写死进 HTML），点选=全选/清空当前页
  const chkTh = el('th', 'chk-col');
  const chkAll = el('input');
  chkAll.type = 'checkbox'; chkAll.id = 'chk-all'; chkAll.setAttribute('aria-label', '全选本页');
  chkAll.onchange = () => {
    for (const s of listState.sites) { if (chkAll.checked) sel.add(s.id); else sel.delete(s.id); }
    renderChecks();
  };
  chkTh.append(chkAll);
  head.append(chkTh);
  const cols = [['ID', 'col-id'], ['URL(原样)', ''], ['标题', ''], ['描述', ''], ['Logo', ''], ['分类', ''], ['子分类', ''], ['状态', 'col-status'], ['排序', 'col-sort'], ['来源', ''], ['操作', 'col-ops']];
  for (const [t, cls] of cols) head.append(el('th', cls, t));
  thead.append(head);
  table.append(thead);
  const tbody = el('tbody');
  for (const site of listState.sites) tbody.append(buildRow(site));
  table.append(tbody);
  $('table-wrap').replaceChildren(table);
}

function actionBtn(label, fn, danger) {
  const b = el('button', danger ? 'btn-danger' : '', label); // 美化轮：危险色走类（admin.css），不再内联
  b.type = 'button';
  b.addEventListener('click', () => fn(b));
  return b;
}

function fieldInput(type, value, ph) {
  const i = el('input');
  i.type = type; i.value = value ?? '';
  if (ph) i.placeholder = ph;
  return i;
}

// 行内编辑：各字段 input 初值 = 该行现值；「保存」只提交改动过的字段（PATCH 白名单）。
function buildRow(site) {
  const tr = document.createElement('tr');
  tr.dataset.id = String(site.id);
  // 美化轮：td(label, cls, ...nodes) —— label 写入 data-label，供 ≤760px 卡片布局的 ::before 显示
  const td = (label, cls, ...nodes) => { const c = el('td', cls); c.dataset.label = label; c.append(...nodes); tr.append(c); return c; };
  // Task 10：行勾选列（前置到 ID 前），data-id 与行同步；勾选即时增删 sel
  const chk = el('input', 'row-chk');
  chk.type = 'checkbox'; chk.dataset.id = String(site.id); chk.checked = sel.has(site.id);
  chk.setAttribute('aria-label', `选择站点 #${site.id}`);
  chk.onchange = () => { if (chk.checked) sel.add(site.id); else sel.delete(site.id); renderChecks(); };
  td('', 'chk-col', chk);
  td('ID', 'cell-id', el('span', '', site.id));
  // 展示口径（Task 9/10 裁定）：url_raw || url —— 原样 URL 保真，编辑后仍显示用户输入形态
  const inUrl = fieldInput('text', site.url_raw || site.url, 'https://…');
  const inTitle = fieldInput('text', site.title);
  const inDesc = fieldInput('text', site.description);
  const inLogo = fieldInput('text', site.logo, '文件名或 URL');
  // 分类/子分类：自制 combobox（输入框+▾ 弹单，选项打开时实时取，多行并行编辑互不串扰）。
  // term placeholder/建议跟随本行 taxonomy 输入联动；行销毁时弹单由外点/Esc/滚动兜底关闭。
  const inTax = fieldInput('text', site.taxonomy);
  const btnTax = el('button', 'combo-btn', '▾'); btnTax.type = 'button'; btnTax.setAttribute('aria-label', '选择分类');
  const taxWrap = el('span', 'combo'); taxWrap.append(inTax, btnTax);
  attachCombo(inTax, btnTax, allTaxonomies);
  const inTerm = fieldInput('text', site.term);
  const btnTerm = el('button', 'combo-btn', '▾'); btnTerm.type = 'button'; btnTerm.setAttribute('aria-label', '选择子分类');
  const termWrap = el('span', 'combo'); termWrap.append(inTerm, btnTerm);
  bindTermLink(inTax, inTerm);
  attachCombo(inTerm, btnTerm, () => termsFor(inTax.value));
  const inStatus = el('select');
  // 美化轮：option 文案去掉英文尾巴（value 仍是 pending/published 不变），胶囊徽标不再截断
  inStatus.append(new Option('待发布', 'pending'), new Option('已发布', 'published'));
  inStatus.value = site.status;
  // 美化轮：状态选择器按值配色（待发布=琥珀 / 已发布=绿），纯 class 切换不改 option 与取值逻辑
  const paintStatus = () => { inStatus.className = 'status-select ' + (inStatus.value === 'published' ? 'st-pub' : 'st-pend'); };
  inStatus.addEventListener('change', paintStatus);
  paintStatus();
  const inSort = fieldInput('number', site.sort); // 美化轮：宽度交给列类 col-sort，去掉内联 5rem
  td('URL(原样)', '', inUrl); td('标题', 'cell-title', inTitle); td('描述', '', inDesc); td('Logo', '', inLogo);
  td('分类', '', taxWrap); td('子分类', '', termWrap); td('状态', 'col-status', inStatus); td('排序', 'col-sort', inSort);
  td('来源', '', el('span', 'dim', site.source));

  const ops = el('div', 'row-ops');
  ops.append(
    actionBtn('保存', async (btn) => {
      const patch = {};
      for (const [k, input, orig] of [
        ['title', inTitle, site.title], ['description', inDesc, site.description],
        ['logo', inLogo, site.logo], ['taxonomy', inTax, site.taxonomy], ['term', inTerm, site.term],
      ]) {
        if (input.value !== (orig ?? '')) patch[k] = input.value;
      }
      if (inStatus.value !== site.status) patch.status = inStatus.value;
      // 排序留空 = 未改动：Number('')===0 会把清空误提交为 0（Task13 打磨④，四处同此口径）
      const sortNum = inSort.value.trim() === '' ? NaN : Number(inSort.value);
      if (Number.isFinite(sortNum) && sortNum !== site.sort) patch.sort = sortNum;
      // 裁定(a)：改 URL 时必须在同一个 PATCH 里同时送 url + url_raw（=编辑值）。
      // 导出取 url_raw||url：若只送 url（或漏送 url_raw），webstack.yml 会停在旧 URL（导出陈旧）；
      // 服务端会把 url 再规范化为去重键，url_raw 保留用户输入原样（漏送时服务端亦兜底同步）。
      const urlEdited = inUrl.value.trim();
      if (urlEdited !== (site.url_raw || site.url)) { patch.url = urlEdited; patch.url_raw = urlEdited; }
      if (Object.keys(patch).length === 0) { toast('没有改动可保存', { ttl: 3000 }); return; }
      btn.disabled = true;
      try {
        const { site: fresh } = await api(`sites/${site.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
        const i = listState.sites.findIndex((s) => s.id === site.id);
        if (i >= 0) listState.sites[i] = fresh;
        tr.replaceWith(buildRow(fresh));
        toast(`站点 #${fresh.id} 已保存`, { type: 'ok', ttl: 3000 });
      } catch (e) {
        if (e.status !== 401) toast('保存失败：' + e.message, { type: 'err' });
        btn.disabled = false;
      }
    }),
    actionBtn('重分析', async (btn) => {
      btn.disabled = true;
      toast(`站点 #${site.id} 重新分析中…`, { ttl: 4000 });
      try {
        const { site: fresh } = await api(`sites/${site.id}/analyze`, { method: 'POST', body: '{}' });
        const i = listState.sites.findIndex((s) => s.id === site.id);
        if (i >= 0) listState.sites[i] = fresh; else listState.total++;
        tr.replaceWith(buildRow(fresh));
        toast(`分析完成，新行 #${fresh.id}`, { type: 'ok', ttl: 4000 });
      } catch (e) {
        if (e.status !== 401) toast('重分析失败：' + e.message, { type: 'err' });
        btn.disabled = false;
      }
    }),
    actionBtn('删除', async (btn) => {
      // 单行删除统一 confirmModal（Task13 打磨⑤：与批删族同一弹窗纪律，零 innerHTML）
      const ok = await confirmModal({
        title: '确认删除站点？',
        lines: [`站点 #${site.id}：${site.url_raw || site.url}`, '该行将从库中删除；前台生效需再点批量发布。'],
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        await api(`sites/${site.id}`, { method: 'DELETE' });
        const i = listState.sites.findIndex((s) => s.id === site.id);
        if (i >= 0) listState.sites.splice(i, 1);
        if (listState.total > 0) listState.total--;
        tr.remove();
        toast(`站点 #${site.id} 已删除`, { type: 'ok', ttl: 3000 });
      } catch (e) {
        if (e.status !== 401) toast('删除失败：' + e.message, { type: 'err' });
        btn.disabled = false;
      }
    }, true),
  );
  td('操作', 'col-ops', ops);
  return tr;
}

$('f-apply').addEventListener('click', () => {
  listState.q = $('f-q').value.trim();
  listState.status = $('f-status').value;
  listState.taxonomy = $('f-taxonomy').value;
  listState.term = $('f-term').disabled ? '' : $('f-term').value;
  listState.page = 1;
  loadList();
});
$('f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('f-apply').click(); });
$('list-reload').addEventListener('click', () => { loadList(); loadTaxonomies(); });
$('page-prev').addEventListener('click', () => { if (listState.page > 1) { listState.page--; loadList(); } });
$('page-next').addEventListener('click', () => {
  if (listState.page * listState.perPage < listState.total) { listState.page++; loadList(); }
});

/* ---------- Task 10 删除族：勾选批删 / 按筛选全删 / 清空全库 ---------- */
// 当前筛选是否有非空条件（后端 filter 形态要求至少一条，空条件会 400——UI 先行禁用）
const hasFilterCond = () => ['q', 'status', 'taxonomy', 'term'].some((k) => listState[k] !== '');
// 筛选摘要文字：del-filter 弹窗行用（与后端白名单四键一一对应）
function filterDesc() {
  const parts = [];
  if (listState.q) parts.push(`关键词「${listState.q}」`);
  if (listState.status) parts.push(`状态=${listState.status === 'published' ? '已发布' : '待发布'}`);
  if (listState.taxonomy) parts.push(`分类「${listState.taxonomy}」`);
  if (listState.term) parts.push(`子分类「${listState.term}」`);
  return parts.join(' · ');
}

// 勾选态单向渲染：行/头 checkbox 跟随 sel，按钮文案与 disabled 联动（幂等，可反复调）
function renderChecks() {
  for (const cb of $('table-wrap').querySelectorAll('input.row-chk')) {
    cb.checked = sel.has(Number(cb.dataset.id));
  }
  const chkAll = $('chk-all');
  if (chkAll) {
    const ids = listState.sites.map((s) => s.id);
    chkAll.checked = ids.length > 0 && ids.every((id) => sel.has(id));
    chkAll.indeterminate = !chkAll.checked && ids.some((id) => sel.has(id));
  }
  const bSel = $('del-sel');
  bSel.textContent = `删除选中 (${sel.size})`;
  bSel.disabled = sel.size === 0;
  $('del-filter').disabled = !(lastTotal > 0) || !hasFilterCond();
}

async function deleteFlow(body, summaryLines, { danger = false, requireText = '' } = {}) {
  const ok = await confirmModal({ title: '确认删除？', lines: summaryLines, danger, requireText });
  if (!ok) return;
  const r = await api('sites/batch-delete', { method: 'POST', body: JSON.stringify(body) });
  toast(`已删除 ${r.deleted} 条（前台生效需再点批量发布）`); loadList(); loadTaxonomies();
}
// Task 11 carry-fix（T10 审查 Important）：deleteFlow 里 api() 的失败此前是未处理的 Promise
// rejection（弹窗关掉后无声无息）。统一包一层 guarded：后端 400/5xx 的 message 原文走 err toast。
// confirmModal 契约不变（它本身永不 reject），只兜 api 抛错；401 已由 api() 回退口令条，不再重复提示。
const guarded = (fn) => async (...args) => {
  try { await fn(...args); }
  catch (e) { if (e.status !== 401) toast(e.message, { type: 'err', ttl: 8000 }); }
};
$('del-sel').onclick = guarded(() => {
  const ids = [...sel];
  return deleteFlow({ ids }, [`共 ${ids.length} 条选中站点。`]);
});
$('del-filter').onclick = guarded(() => {
  // listState 含 total/sites 等非筛选键，只取后端白名单四键组 filter（空键剔除后至少一条，
  // 由 hasFilterCond 的按钮禁用态保证，后端亦有 400 兜底）
  const f = { q: listState.q, status: listState.status, taxonomy: listState.taxonomy, term: listState.term };
  const filter = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
  return deleteFlow({ filter }, [`当前筛选命中 ${lastTotal} 条（${filterDesc()}）。`, '分类下站点被清空后，其分类行会留在分类页（可去分类页删）。']);
});
$('del-wipe').onclick = guarded(() => deleteFlow({ wipe: '全部删除' }, ['将清空 D1 中全部站点行（不限筛选）。', '前台内容在下一次批量发布前不变；发布有 0 行/骤降闸兜底。'], { danger: true, requireText: '全部删除' }));

/* ---------- 分类视图（Task 11：一等公民 CRUD + 改名级联 + 批删 + 自动 icon 回显） ----------
 * 后端契约（Task 7）与 UI 侧裁决的落地方式：
 *  - GET categories → {categories:[{taxonomy,term,icon,sort,siteCount}], shapes}；分组渲染在前端做。
 *  - PATCH 改名请求会整体忽略 icon/sort（T7 Minor ④）：「保存」把 diff 拆成两步串行 PATCH
 *    （先改名、后 icon/sort），改名请求里绝不夹带 meta。
 *  - 顶层行（term=''）只暴露 taxonomy 改名、不暴露 term 编辑（T7 Minor ③：header 行 term 改名
 *    会静默丢 icon/sort 载体）；子行只暴露 term 改名（整类改名语义专属顶层行，从子行发起会误导）。
 *  - childless-pair 行 PATCH icon/sort 可能返回 {category:null} 200（T7 Minor ②）：保存后一律
 *    loadCategories() 整表重载，不信回显。
 *  - 空 taxonomy 后端 400：UI 先行拦截。
 *  - 「（未登记）」灰条 = shapes（categories∪sites union）中存在但 categories 表无行的 pair：
 *    只读、不可勾不可删，「补登记」把 pair 填入新建表单（提交仍走 POST 形态闸）。
 *  - icon 零前端规则（防漂移裁决）：自动 icon 唯一可见路径 = POST 缺 icon → 201 {category.icon} → toast 文案
 *    （T12 carry 起不再回填输入框，回显不带入下一次新增）。 */
let catRows = [];                 // GET categories 的 categories（含 siteCount）
const catSel = new Set();         // 勾选 pair 键；每次整表重载清空（同列表页幽灵选择纪律）
let catFormTermSync = null;       // 新建表单 term placeholder 联动句柄
const catKey = (tax, term) => tax + '\u0000' + term;
const catLabel = (r) => (r.term === '' ? `分类「${r.taxonomy}」` : `子分类「${r.taxonomy}/${r.term}」`);
const catIconOptions = () => [...new Set(catRows.map((r) => r.icon).filter(Boolean))].sort();


async function loadCategories() {
  catSel.clear(); // 整表重建前先清勾选：改名后旧 pair 键失效，残留即幽灵选择（T10 同纪律）
  try {
    const { categories, shapes } = await api('categories');
    catRows = Array.isArray(categories) ? categories : [];
    if (Array.isArray(shapes)) shapeState.shapes = shapes; // 同响应顺带刷新 combo 建议，不再二次 GET
    if (catFormTermSync) catFormTermSync();
    renderCategories();
  } catch (e) { if (e.status !== 401) toast('加载分类失败：' + e.message, { type: 'err' }); }
  renderCatChecks(); // 成功/失败都同步勾选态与批删钮（失败时旧表仍在屏上，需跟随已清空的 catSel）
}

function renderCategories() {
  const groups = new Map(); // taxonomy -> {header, children[], unnamed[]}
  const ensure = (tax) => {
    let g = groups.get(tax);
    if (!g) { g = { header: null, children: [], unnamed: [] }; groups.set(tax, g); }
    return g;
  };
  for (const r of catRows) {
    const g = ensure(r.taxonomy);
    if (r.term === '') g.header = r; else g.children.push(r);
  }
  const reg = new Set(catRows.map((r) => catKey(r.taxonomy, r.term)));
  let unnamedTotal = 0;
  for (const s of shapeState.shapes) { // union 形态里只在站点出现的 pair → 组尾灰条（不可勾删）
    const g = ensure(s.taxonomy);
    for (const t of (s.nested ? s.terms : [''])) {
      if (!reg.has(catKey(s.taxonomy, t))) { g.unnamed.push(t); unnamedTotal++; }
    }
  }
  $('cat-meta').textContent = `共 ${catRows.length} 分类行${unnamedTotal ? ` · ${unnamedTotal} 个站点 pair 未登记（组尾灰行）` : ''}`;
  if (!groups.size) { $('cat-table').replaceChildren(el('div', 'empty', '还没有分类——用下方表单新建，或先导入站点')); return; }
  // 组序：有顶层行的按 sort 排（同值按名），无顶层行的排最后按名
  const gs = [...groups.entries()].sort((ea, eb) => {
    const [ta, a] = ea; const [tb, b] = eb;
    if (a.header && b.header) return (a.header.sort - b.header.sort) || ta.localeCompare(tb);
    if (a.header) return -1;
    if (b.header) return 1;
    return ta.localeCompare(tb);
  });
  const table = el('table');
  const thead = el('thead');
  const head = el('tr');
  const chkTh = el('th', 'chk-col');
  const chkAll = el('input');
  chkAll.type = 'checkbox'; chkAll.id = 'cat-chk-all'; chkAll.setAttribute('aria-label', '全选分类行');
  chkAll.onchange = () => {
    for (const r of catRows) { const k = catKey(r.taxonomy, r.term); if (chkAll.checked) catSel.add(k); else catSel.delete(k); }
    renderCatChecks();
  };
  chkTh.append(chkAll);
  head.append(chkTh);
  for (const [t, cls] of [['分类', ''], ['子分类', ''], ['icon', 'cat-icon-col'], ['排序', 'col-sort'], ['站点', ''], ['操作', 'col-ops']]) head.append(el('th', cls, t));
  thead.append(head);
  table.append(thead);
  for (const [tax, g] of gs) {
    const tbody = el('tbody'); // 一组一 tbody：顶层行粗上边线做分组间隔（admin.css）
    if (g.header) tbody.append(buildCatRow(g.header, true));
    for (const r of [...g.children].sort((a, b) => (a.sort - b.sort) || a.term.localeCompare(b.term))) tbody.append(buildCatRow(r, false));
    for (const t of [...g.unnamed].sort((a, b) => a.localeCompare(b))) tbody.append(buildCatUnnamed(tax, t));
    table.append(tbody);
  }
  $('cat-table').replaceChildren(table);
}

function buildCatRow(row, isHeader) {
  const tr = el('tr', isHeader ? 'cat-head' : '');
  const td = (label, cls, ...nodes) => { const c = el('td', cls); c.dataset.label = label; c.append(...nodes); tr.append(c); return c; };
  const chk = el('input', 'row-chk');
  chk.type = 'checkbox'; chk.dataset.key = catKey(row.taxonomy, row.term);
  chk.setAttribute('aria-label', `选择 ${catLabel(row)}`);
  chk.onchange = () => { if (chk.checked) catSel.add(chk.dataset.key); else catSel.delete(chk.dataset.key); renderCatChecks(); };
  td('', 'chk-col', chk);
  let inTax = null;
  let inTerm = null;
  if (isHeader) {
    // 顶层行：taxonomy 输入=整类改名入口；term 不给编辑（T7 Minor ③）
    inTax = fieldInput('text', row.taxonomy);
    const bTax = el('button', 'combo-btn', '▾'); bTax.type = 'button'; bTax.setAttribute('aria-label', '选择分类');
    const wrap = el('span', 'combo'); wrap.append(inTax, bTax);
    attachCombo(inTax, bTax, allTaxonomies);
    td('分类', 'cat-tax', wrap);
    td('子分类', '', el('span', 'dim', '—（顶层）'));
  } else {
    td('分类', 'cat-tax cat-child', el('span', '', row.taxonomy)); // 子行分类只读：整类改名从顶层行发起
    inTerm = fieldInput('text', row.term);
    td('子分类', 'cat-term', inTerm);
  }
  const inIcon = fieldInput('text', row.icon, 'fas fa-xxx'); // 非法类名由后端 FA_CLASS 闸拒 400（前端零规则）
  const bIcon = el('button', 'combo-btn', '▾'); bIcon.type = 'button'; bIcon.setAttribute('aria-label', '选择现有 icon');
  const iconWrap = el('span', 'combo'); iconWrap.append(inIcon, bIcon);
  attachCombo(inIcon, bIcon, catIconOptions);
  td('icon', 'cat-icon', iconWrap);
  const inSort = fieldInput('number', row.sort);
  td('排序', 'col-sort', inSort);
  const cnt = el('span', 'cnt' + (row.siteCount > 0 ? ' on' : ''), row.siteCount);
  cnt.title = isHeader ? '直挂该分类（term 空）的站点数' : '该子分类下的站点数';
  td('站点', '', cnt);
  const ops = el('div', 'row-ops');
  ops.append(
    actionBtn('保存', (btn) => saveCat(row, { btn, isHeader, inTax, inTerm, inIcon, inSort })),
    actionBtn('删除', (btn) => delCat(row, isHeader, btn), true),
  );
  td('操作', 'col-ops', ops);
  return tr;
}

function buildCatUnnamed(tax, term) {
  // 未登记灰条：站点在用但该 pair 在 categories 表无行——不可勾不可删，只能「补登记」为正式行
  const tr = el('tr', 'cat-unnamed');
  const td = (label, ...nodes) => { const c = el('td'); c.dataset.label = label; c.append(...nodes); tr.append(c); return c; };
  const pad = el('td', 'chk-col'); pad.dataset.label = ''; tr.append(pad);
  td('分类', el('span', '', tax));
  td('子分类', el('span', '', term === '' ? '—（顶层）' : term), el('span', 'cat-flag', '（未登记）'));
  td('icon', el('span', 'dim', '—'));
  td('排序', el('span', 'dim', '—'));
  td('站点', el('span', 'dim', '有站点在用'));
  const ops = el('div', 'row-ops');
  ops.append(actionBtn('补登记', () => {
    $('cat-new-tax').value = tax;
    $('cat-new-term').value = term;
    $('cat-new-tax').dispatchEvent(new Event('input', { bubbles: true })); // 触发 term placeholder 级联重算
    $('cat-new-term').dispatchEvent(new Event('input', { bubbles: true }));
    toast(`「${tax}${term ? '/' + term : ''}」已填入新建表单，点「添加」完成登记`, { ttl: 6000 });
  }));
  td('操作', ops);
  return tr;
}

// 勾选族公共实现（Task13 打磨①：原 cat/fr/nv 三份 11 行克隆合一，行为逐字不变）。
// 与 sites 页 renderChecks 不同族：那个额外管「按筛选删除」钮 disabled，不并。
// rowKeys=当前表全部行键（分类用 catKey 字符串，友链/导航用数字 id）；sel=已选集合；
// read=从行勾选框 dataset 读回键（cat 挂 key，fr/nv 挂 id）。
function renderRowChecks(tableId, allId, btnId, sel, rowKeys, read) {
  for (const cb of $(tableId).querySelectorAll('input.row-chk')) cb.checked = sel.has(read(cb));
  const chkAll = $(allId);
  if (chkAll) {
    chkAll.checked = rowKeys.length > 0 && rowKeys.every((k) => sel.has(k));
    chkAll.indeterminate = !chkAll.checked && rowKeys.some((k) => sel.has(k));
  }
  const b = $(btnId);
  b.textContent = `删除选中 (${sel.size})`;
  b.disabled = sel.size === 0;
}

function renderCatChecks() {
  renderRowChecks('cat-table', 'cat-chk-all', 'cat-del-sel', catSel,
    catRows.map((r) => catKey(r.taxonomy, r.term)), (cb) => cb.dataset.key);
}

async function saveCat(row, { btn, isHeader, inTax, inTerm, inIcon, inSort }) {
  const ren = {};  // 改名键：单独一个 PATCH（后端在改名时忽略夹带的 icon/sort——T7 Minor ④）
  const meta = {}; // icon/sort 键：改名成功后的第二个 PATCH（或无改名时唯一一次）
  if (isHeader) {
    const v = inTax.value.trim();
    if (v !== row.taxonomy) {
      if (!v) { toast('分类名不能为空（空分类名会被后端拒绝）', { type: 'err' }); return; }
      ren.taxonomy = v;
    }
  } else {
    const v = inTerm.value.trim();
    if (v !== row.term) {
      if (!v) { toast('子分类名不能为空', { type: 'err' }); return; }
      ren.term = v;
    }
  }
  const iconV = inIcon.value.trim();
  if (iconV && iconV !== row.icon) meta.icon = iconV; // 空串后端静默忽略：不送、UI 也不假称已清空
  else if (!iconV && row.icon) toast('icon 不可清空（空值会被后端忽略，保留原值）', { ttl: 4000 });
  const sortN = inSort.value.trim() === '' ? NaN : Number(inSort.value); // 留空=未改（打磨④）
  if (Number.isFinite(sortN) && sortN !== row.sort) meta.sort = sortN;
  if (!Object.keys(ren).length && !Object.keys(meta).length) { toast('没有改动可保存', { ttl: 3000 }); return; }
  if (Object.keys(ren).length) { // 改名先过级联确认（T10 confirmModal，零 innerHTML）
    const lines = isHeader
      ? [`将把「${row.taxonomy}」整体改名为「${ren.taxonomy}」。`, '级联范围：该分类全部分类行 + 其下所有站点行的分类字段同步更新。']
      : [`将把「${row.taxonomy}/${row.term}」改名为「${row.taxonomy}/${ren.term}」。`, `级联范围：该子分类下 ${row.siteCount} 个站点行同步更新。`];
    lines.push('目标名已存在时后端会直接拒绝（不提供隐式合并）。');
    if (!(await confirmModal({ title: '确认改名分类？', lines, danger: true }))) return;
  }
  btn.disabled = true;
  let renamed = false;
  const loc = { taxonomy: row.taxonomy, term: row.term };
  try {
    if (Object.keys(ren).length) {
      await api('categories', { method: 'PATCH', body: JSON.stringify({ taxonomy: row.taxonomy, term: row.term, new: ren }) });
      if (ren.taxonomy !== undefined) loc.taxonomy = ren.taxonomy;
      if (ren.term !== undefined) loc.term = ren.term;
      renamed = true;
    }
    if (Object.keys(meta).length) {
      await api('categories', { method: 'PATCH', body: JSON.stringify({ taxonomy: loc.taxonomy, term: loc.term, new: meta }) });
    }
    toast(`已保存 ${catLabel(loc)}`, { type: 'ok', ttl: 3000 });
  } catch (e) {
    if (e.status !== 401) toast(e.message, { type: 'err', ttl: 10000 }); // 撞名 400 等：后端 message 原文
  } finally {
    // 一律重载整表（改名可能成功、meta 步可能失败，屏上必须反映真实态；{category:null} 也不可信）
    await loadCategories();
    if (renamed) { loadTaxonomies(); loadList(); } // spec 联动语义：筛选下拉与列表同步新名
    else btn.disabled = false;
  }
}

async function delCat(row, isHeader, btn) {
  // Task 12 carry（T11 审查结转④）：删除闸看的是「整类」站点数——顶层行确认行改为本地求和
  // （header+children 的 siteCount；GET 序保证子行紧随其父，catRows 现值即可算，无需二次请求）。
  const headTotal = isHeader ? catRows.filter((r) => r.taxonomy === row.taxonomy).reduce((a, r) => a + (r.siteCount || 0), 0) : row.siteCount;
  const lines = [isHeader
    ? `${catLabel(row)}：整类（含全部子分类）当前共 ${headTotal} 个站点。`
    : `${catLabel(row)}：当前直挂 ${row.siteCount} 个站点。`];
  if (isHeader) lines.push('删除闸：整类（含全部子分类）必须零站点；通过后连带删除其全部子分类行（只动分类表，不触碰站点行）。');
  const ok = await confirmModal({ title: '确认删除分类？', lines, danger: true });
  if (!ok) return;
  btn.disabled = true;
  try {
    await api('categories?' + new URLSearchParams({ taxonomy: row.taxonomy, term: row.term }).toString(), { method: 'DELETE' });
    toast(`已删除 ${catLabel(row)}`, { type: 'ok', ttl: 3000 });
  } catch (e) {
    if (e.status !== 401) toast(e.message, { type: 'err', ttl: 10000 }); // 非空 400：后端 message 含站点条数，原文呈现
    btn.disabled = false;
    return;
  }
  await loadCategories(); loadTaxonomies(); // 分类集合变了：筛选下拉同步（站点行不受影响，无需 loadList）
}

async function catBatchDelete() {
  const pairs = catRows.filter((r) => catSel.has(catKey(r.taxonomy, r.term))).map((r) => ({ taxonomy: r.taxonomy, term: r.term }));
  if (!pairs.length) return;
  const names = pairs.map((p) => (p.term === '' ? `${p.taxonomy}（顶层）` : `${p.taxonomy}/${p.term}`)).join('、');
  const ok = await confirmModal({
    title: '确认批量删除分类？',
    lines: [`已选 ${pairs.length} 行：${names}`, '原子删除：任一分类非空 → 后端 400 列全阻塞清单，整体拒绝零删除。', '删顶层行会连带删除其子分类行。'],
    danger: true,
  });
  if (!ok) return;
  const r = await api('categories/batch-delete', { method: 'POST', body: JSON.stringify({ pairs }) });
  toast(`已删除 ${r.deleted} 分类行（前台生效需再点批量发布）`, { type: 'ok', ttl: 5000 });
  await loadCategories(); loadTaxonomies();
}
// 后端 400（阻塞清单原文）经 guarded 统一 err toast——与 sites 删除族同一错误呈现纪律
$('cat-del-sel').onclick = guarded(catBatchDelete);

async function createCat() {
  const tax = $('cat-new-tax').value.trim();
  if (!tax) { toast('请输入分类名（空分类会被后端拒绝）', { type: 'err' }); return; }
  const term = $('cat-new-term').value.trim();
  const icon = $('cat-new-icon').value.trim();
  const payload = { taxonomy: tax };
  if (term) payload.term = term;
  if (icon) payload.icon = icon; // 缺省走后端 resolveIcon；自动结果只进成功 toast（T12 carry：不回填表单，防静默带入下一笔新增）
  const btn = $('cat-new-go'); btn.disabled = true;
  try {
    const { category } = await api('categories', { method: 'POST', body: JSON.stringify(payload) });
    const label = category ? catLabel(category) : `分类「${tax}${term ? '/' + term : ''}」`;
    if (!icon && category) {
      // Task 12 carry（T11 审查结转①）：自动配 icon 只进 toast 文案，不再回填输入框——
      // 回显值若留在表单会被下一次新增静默带走（POST 显式带 icon = 绕过后端 resolveIcon 决策链）。
      toast(`${label} 已添加；已自动配 icon「${category.icon}」`, { type: 'ok', ttl: 6000 });
    } else {
      toast(`${label} 已添加`, { type: 'ok', ttl: 4000 });
    }
    $('cat-new-tax').value = '';
    $('cat-new-term').value = '';
    $('cat-new-icon').value = ''; // 成功即复位（含手填 icon 的场景），下一笔新增默认回到自动决策链
    await loadCategories(); loadTaxonomies();
  } catch (e) {
    if (e.status !== 401) toast(e.message, { type: 'err', ttl: 10000 }); // 形态相反 400 等：后端 message 原文
  } finally {
    btn.disabled = false;
  }
}
$('cat-new-go').addEventListener('click', createCat);
$('cat-reload').addEventListener('click', () => loadCategories());
// 新建表单联动：term placeholder 随 taxonomy 级联；三个 combo 的选项全部实时取自现有数据（零规则）
catFormTermSync = bindTermLink($('cat-new-tax'), $('cat-new-term'));
attachCombo($('cat-new-tax'), document.querySelector('.combo-btn[data-combo-for="cat-new-tax"]'), allTaxonomies);
attachCombo($('cat-new-term'), document.querySelector('.combo-btn[data-combo-for="cat-new-term"]'), () => termsFor($('cat-new-tax').value));
attachCombo($('cat-new-icon'), document.querySelector('.combo-btn[data-combo-for="cat-new-icon"]'), catIconOptions);

/* ---------- 友链视图（Task 12：简单表 CRUD + 勾选批删） ----------
 * 后端契约（Task 4，routes.ts friendlinks 段）与 UI 侧落地方式：
 *  - GET friendlinks → {friendlinks:[{id,title,url,description,sort,created_at,updated_at}]}（sort,id 序，全量无分页）。
 *  - POST 需 {title,url} 均非空字符串 → 201 {friendlink}；description 可选；sort 缺省 0（表单不暴露，行内可改）。
 *  - PATCH 白名单 title/url/description/sort；title/url 传空串会被 400「需为非空字符串」——保存只送差量，
 *    空标题/URL 在 UI 先行拦截；行不存在 404。
 *  - DELETE → 204 幂等；POST batch-delete {ids:正整数数组} → {deleted}（无原子闸，友链互相独立）。
 *  - url 原样存不做规范化（人工维护的字节保真数据，与 sites 的 url_raw||url 口径无关）。
 *  - 改动只写 D1：前台生效需再点「批量发布」（发布三文件化之 friendlinks.yml，Task 9）。 */
let flRows = [];                 // GET friendlinks 的全量行
const flSel = new Set();         // 勾选 id；每次整表重载清空（幽灵选择纪律，同列表页）

async function loadFriends() {
  flSel.clear();
  try {
    const { friendlinks } = await api('friendlinks');
    flRows = Array.isArray(friendlinks) ? friendlinks : [];
    renderFriends();
  } catch (e) { if (e.status !== 401) toast('加载友链失败：' + e.message, { type: 'err' }); }
  renderFrChecks(); // 成功/失败都同步勾选态与批删钮（失败时旧表仍在屏上，需跟随已清空的 flSel）
}

function renderFriends() {
  $('fr-meta').textContent = `共 ${flRows.length} 条友链`;
  if (!flRows.length) { $('fr-table').replaceChildren(el('div', 'empty', '还没有友链——用下方表单添加')); return; }
  const table = el('table');
  const thead = el('thead');
  const head = el('tr');
  const chkTh = el('th', 'chk-col');
  const chkAll = el('input');
  chkAll.type = 'checkbox'; chkAll.id = 'fr-chk-all'; chkAll.setAttribute('aria-label', '全选友链');
  chkAll.onchange = () => {
    for (const r of flRows) { if (chkAll.checked) flSel.add(r.id); else flSel.delete(r.id); }
    renderFrChecks();
  };
  chkTh.append(chkAll);
  head.append(chkTh);
  for (const [t, cls] of [['ID', 'col-id'], ['标题', ''], ['URL', ''], ['描述', ''], ['排序', 'col-sort'], ['操作', 'col-ops']]) head.append(el('th', cls, t));
  thead.append(head);
  table.append(thead);
  const tbody = el('tbody');
  for (const r of flRows) tbody.append(buildFlRow(r));
  table.append(tbody);
  $('fr-table').replaceChildren(table);
}

function buildFlRow(fl) {
  const tr = document.createElement('tr');
  tr.dataset.id = String(fl.id);
  const td = (label, cls, ...nodes) => { const c = el('td', cls); c.dataset.label = label; c.append(...nodes); tr.append(c); return c; };
  const chk = el('input', 'row-chk');
  chk.type = 'checkbox'; chk.dataset.id = String(fl.id); chk.checked = flSel.has(fl.id);
  chk.setAttribute('aria-label', `选择友链 #${fl.id}`);
  chk.onchange = () => { if (chk.checked) flSel.add(fl.id); else flSel.delete(fl.id); renderFrChecks(); };
  td('', 'chk-col', chk);
  td('ID', 'cell-id', el('span', '', fl.id));
  const inTitle = fieldInput('text', fl.title);
  const inUrl = fieldInput('text', fl.url, 'https://…');
  const inDesc = fieldInput('text', fl.description);
  const inSort = fieldInput('number', fl.sort);
  td('标题', 'cell-title', inTitle); td('URL', '', inUrl); td('描述', '', inDesc); td('排序', 'col-sort', inSort);
  const ops = el('div', 'row-ops');
  ops.append(
    actionBtn('保存', (btn) => saveFriend(fl, { btn, inTitle, inUrl, inDesc, inSort })),
    actionBtn('删除', (btn) => delFriend(fl, btn), true),
  );
  td('操作', 'col-ops', ops);
  return tr;
}

// 行内编辑：只提交差量（PATCH 白名单四键）；标题/URL 清空先行拦截（后端 400 需非空串）。
async function saveFriend(fl, { btn, inTitle, inUrl, inDesc, inSort }) {
  const patch = {};
  const titleV = inTitle.value.trim();
  if (titleV !== fl.title) {
    if (!titleV) { toast('标题不能为空（后端会拒绝空标题）', { type: 'err' }); return; }
    patch.title = titleV;
  }
  const urlV = inUrl.value.trim();
  if (urlV !== fl.url) {
    if (!urlV) { toast('URL 不能为空（后端会拒绝空 URL）', { type: 'err' }); return; }
    patch.url = urlV; // 原样送：后端不规范化（字节保真）
  }
  if (inDesc.value !== fl.description) patch.description = inDesc.value; // 描述允许空串
  const sortN = inSort.value.trim() === '' ? NaN : Number(inSort.value); // 留空=未改（打磨④）
  if (Number.isFinite(sortN) && sortN !== fl.sort) patch.sort = sortN;
  if (!Object.keys(patch).length) { toast('没有改动可保存', { ttl: 3000 }); return; }
  btn.disabled = true;
  try {
    const { friendlink: fresh } = await api(`friendlinks/${fl.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    const i = flRows.findIndex((r) => r.id === fl.id);
    if (i >= 0) flRows[i] = fresh;
    document.querySelector(`#fr-table tr[data-id="${fl.id}"]`)?.replaceWith(buildFlRow(fresh));
    toast(`友链 #${fresh.id} 已保存`, { type: 'ok', ttl: 3000 });
  } catch (e) {
    if (e.status !== 401) toast('保存失败：' + e.message, { type: 'err', ttl: 8000 }); // 404（行已被他端删除）等原文呈现
    btn.disabled = false;
  }
}

// 单行删除统一 confirmModal（Task13 打磨⑤，与批删族同纪律）。
// 更新策略注（打磨③）：友链是平表（无分组序），保存/删除就地打补丁（flRows 增删 + 行节点替换）即可保真；
// 导航因改名/换父会影响分组排序与父下拉选项，保存/删除均整表重拉（见 saveNav/delNavitem）——两种策略各自成立。
async function delFriend(fl, btn) {
  const ok = await confirmModal({
    title: '确认删除友链？',
    lines: [`友链 #${fl.id}：${fl.title}`, '前台生效需再点批量发布。'],
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await api(`friendlinks/${fl.id}`, { method: 'DELETE' });
  } catch (e) {
    if (e.status !== 401) toast('删除失败：' + e.message, { type: 'err', ttl: 8000 });
    btn.disabled = false;
    return;
  }
  const i = flRows.findIndex((r) => r.id === fl.id);
  if (i >= 0) flRows.splice(i, 1);
  flSel.delete(fl.id);
  document.querySelector(`#fr-table tr[data-id="${fl.id}"]`)?.remove();
  toast(`友链 #${fl.id} 已删除（前台生效需再点批量发布）`, { type: 'ok', ttl: 4000 });
  renderFrChecks();
}

function renderFrChecks() {
  renderRowChecks('fr-table', 'fr-chk-all', 'fr-del-sel', flSel,
    flRows.map((r) => r.id), (cb) => Number(cb.dataset.id));
}

async function frBatchDelete() {
  const rows = flRows.filter((r) => flSel.has(r.id));
  if (!rows.length) return;
  const names = rows.slice(0, 8).map((r) => r.title).join('、') + (rows.length > 8 ? `…等 ${rows.length} 条` : '');
  const ok = await confirmModal({ title: '确认批量删除友链？', lines: [`已选 ${rows.length} 条：${names}`, '前台生效需再点批量发布。'], danger: true });
  if (!ok) return;
  const r = await api('friendlinks/batch-delete', { method: 'POST', body: JSON.stringify({ ids: rows.map((x) => x.id) }) });
  toast(`已删除 ${r.deleted} 条友链（前台生效需再点批量发布）`, { type: 'ok', ttl: 5000 });
  await loadFriends();
}
// 后端 400（ids 形状拒等）经 guarded 统一 err toast——与 sites/categories 删除族同一错误呈现纪律
$('fr-del-sel').onclick = guarded(frBatchDelete);

async function createFriend() {
  const title = $('fr-new-title').value.trim();
  const url = $('fr-new-url').value.trim();
  if (!title || !url) { toast('标题和 URL 均必填（空值会被后端拒绝）', { type: 'err' }); return; }
  const payload = { title, url };
  const desc = $('fr-new-desc').value.trim();
  if (desc) payload.description = desc;
  const btn = $('fr-new-go'); btn.disabled = true;
  try {
    const { friendlink } = await api('friendlinks', { method: 'POST', body: JSON.stringify(payload) });
    $('fr-new-title').value = '';
    $('fr-new-url').value = '';
    $('fr-new-desc').value = '';
    toast(`友链「${friendlink.title}」已添加（前台生效需再点批量发布）`, { type: 'ok', ttl: 4000 });
    await loadFriends();
  } catch (e) {
    if (e.status !== 401) toast(e.message, { type: 'err', ttl: 8000 });
  } finally {
    btn.disabled = false;
  }
}
$('fr-new-go').addEventListener('click', createFriend);
$('fr-reload').addEventListener('click', () => loadFriends());

/* ---------- 导航视图（Task 12：一层父子 CRUD + 原子批删） ----------
 * 后端契约（Task 5，routes.ts navitems 段）与 UI 侧落地方式：
 *  - GET navitems → {navitems}：顶层按 (sort,id)、子项紧随其父且组内 (sort,id)；孤儿子项殿后（不静默丢行）。
 *    渲染直接按返回序走，不再前端排序；顶层行加 .nv-head 底色分组，子项名称格复用 .cat-child 缩进。
 *  - POST 需 item 非空；parent_id 仅可为顶层项 id 或 null/缺省（子项之下挂子项 400「仅支持一层下拉」）→ 201 {navitem}。
 *  - PATCH 白名单 item/icon/link/parent_id/sort；icon/link 允许空串（纯下拉容器）。
 *    容器闸（裁决2 三形态）：顶层「有子」行收到 parent_id:null（哪怕是不变回显）→ 400「请删除子项后再升顶」；
 *    UI 纪律：parent_id 只在相对现值真的变化时才进 payload——编辑有子顶层的其它字段绝不夹带 parent_id 键。
 *    降挂闸：有子顶层不能降为子项（三层）——本行父下拉直接禁用；子项升顶（parent_id:null）与换父
 *    （含挂到「已有子的顶层」，目标侧裁决1 已放行）正常提供。
 *  - DELETE 单行：有子顶层 400（message 含子项数与引导文案）→ toast 原文；不存在幂等 204。
 *  - POST batch-delete {ids}：原子——勾了顶层必须连同其全部子项，否则 400 列阻塞清单、整体拒绝零删除。
 *  - 改动只写 D1：前台生效需再点「批量发布」（发布三文件化之 headers.yml，Task 9）。 */
let nvRows = [];                 // GET navitems 的分组序全量行
const nvSel = new Set();         // 勾选 id；每次整表重载清空
const nvTops = () => nvRows.filter((r) => r.parent_id === null);
const nvOptLabel = (t) => `${t.item}（#${t.id}）`;

async function loadNavs() {
  nvSel.clear();
  try {
    const { navitems } = await api('navitems');
    nvRows = Array.isArray(navitems) ? navitems : [];
    renderNavs();
  } catch (e) { if (e.status !== 401) toast('加载导航失败：' + e.message, { type: 'err' }); }
  renderNvChecks();
}

// 「父项」下拉只列顶层（brief 原样）；行内编辑与新增表单共用同一选项构造。
function fillParentOptions(select, { current, excludeId }) {
  const cur = current === undefined || current === null ? '' : String(current);
  select.replaceChildren(new Option('（无）= 顶层', ''));
  for (const t of nvTops()) {
    if (t.id === excludeId) continue; // 不能挂向自身（后端同闸 400，UI 直接不列）
    select.append(new Option(nvOptLabel(t), String(t.id)));
  }
  if (cur !== '' && ![...select.options].some((o) => o.value === cur)) {
    select.append(new Option(`（父 #${cur} 缺失）`, cur)); // 孤儿子项兜底：原父值可见可选，不被静默改成顶层
  }
  select.value = cur;
}

function renderNavs() {
  $('nv-meta').textContent = `共 ${nvRows.length} 项 · 顶层 ${nvTops().length}（前台生效需再点批量发布）`;
  refillNvNewParent();
  if (!nvRows.length) { $('nv-table').replaceChildren(el('div', 'empty', '还没有导航项——用下方表单新建')); return; }
  const kids = new Map();
  for (const r of nvRows) if (r.parent_id !== null) kids.set(r.parent_id, (kids.get(r.parent_id) ?? 0) + 1);
  const table = el('table');
  const thead = el('thead');
  const head = el('tr');
  const chkTh = el('th', 'chk-col');
  const chkAll = el('input');
  chkAll.type = 'checkbox'; chkAll.id = 'nv-chk-all'; chkAll.setAttribute('aria-label', '全选导航项');
  chkAll.onchange = () => {
    for (const r of nvRows) { if (chkAll.checked) nvSel.add(r.id); else nvSel.delete(r.id); }
    renderNvChecks();
  };
  chkTh.append(chkAll);
  head.append(chkTh);
  for (const [t, cls] of [['ID', 'col-id'], ['名称', ''], ['icon', 'nv-icon'], ['link', ''], ['父项', ''], ['排序', 'col-sort'], ['操作', 'col-ops']]) head.append(el('th', cls, t));
  thead.append(head);
  table.append(thead);
  const tbody = el('tbody');
  for (const r of nvRows) tbody.append(buildNavRow(r, kids.get(r.id) ?? 0));
  table.append(tbody);
  $('nv-table').replaceChildren(table);
}

function buildNavRow(row, kidCount) {
  const isTop = row.parent_id === null;
  const tr = document.createElement('tr');
  tr.dataset.id = String(row.id);
  if (isTop) tr.classList.add('nv-head'); // 顶层行底色分组（admin.css）
  const td = (label, cls, ...nodes) => { const c = el('td', cls); c.dataset.label = label; c.append(...nodes); tr.append(c); return c; };
  const chk = el('input', 'row-chk');
  chk.type = 'checkbox'; chk.dataset.id = String(row.id); chk.checked = nvSel.has(row.id);
  chk.setAttribute('aria-label', `选择导航项 #${row.id}`);
  chk.onchange = () => { if (chk.checked) nvSel.add(row.id); else nvSel.delete(row.id); renderNvChecks(); };
  td('', 'chk-col', chk);
  td('ID', 'cell-id', el('span', '', row.id));
  const inItem = fieldInput('text', row.item);
  td('名称', isTop ? '' : 'cat-child', inItem); // 子项缩进复用 T11 的 .cat-child
  const inIcon = fieldInput('text', row.icon, 'fa fa-home 等');
  const inLink = fieldInput('text', row.link, 'https://… 或 ./path/');
  td('icon', 'nv-icon', inIcon); td('link', '', inLink);
  const selParent = el('select', 'parent');
  selParent.setAttribute('aria-label', `导航项 #${row.id} 的父项`);
  fillParentOptions(selParent, { current: row.parent_id, excludeId: row.id });
  if (isTop && kidCount > 0) {
    // 降挂闸 UI 化：有子顶层改挂任何父都必 400（三层），直接禁用；其值保持「（无）」，保存时 parent_id 键被省略。
    selParent.disabled = true;
    selParent.title = '该顶层项有子项：不能作为子项挂载（会超过一层）';
  }
  td('父项', '', selParent);
  const inSort = fieldInput('number', row.sort);
  td('排序', 'col-sort', inSort);
  const ops = el('div', 'row-ops');
  ops.append(
    actionBtn('保存', (btn) => saveNavitem(row, { btn, inItem, inIcon, inLink, selParent, inSort })),
    actionBtn('删除', (btn) => delNavitem(row, btn), true),
  );
  td('操作', 'col-ops', ops);
  return tr;
}

async function saveNavitem(row, { btn, inItem, inIcon, inLink, selParent, inSort }) {
  const patch = {};
  const itemV = inItem.value.trim();
  if (itemV !== row.item) {
    if (!itemV) { toast('名称不能为空（后端会拒绝）', { type: 'err' }); return; }
    patch.item = itemV;
  }
  const iconV = inIcon.value.trim();
  if (iconV !== row.icon) patch.icon = iconV; // icon/link 允许空串（纯下拉容器语义）
  const linkV = inLink.value.trim();
  if (linkV !== row.link) patch.link = linkV;
  // 容器闸规避核心纪律：parent_id 仅在相对现值变化时才进 payload。
  // 编辑「有子顶层」其它字段时本值不变（（无）↔null）→ 键完全不出现 → 不触发 400「请删除子项后再升顶」。
  const pidV = selParent.value === '' ? null : Number(selParent.value);
  if (pidV !== row.parent_id) patch.parent_id = pidV;
  const sortN = inSort.value.trim() === '' ? NaN : Number(inSort.value); // 留空=未改（打磨④）
  if (Number.isFinite(sortN) && sortN !== row.sort) patch.sort = sortN;
  if (!Object.keys(patch).length) { toast('没有改动可保存', { ttl: 3000 }); return; }
  btn.disabled = true;
  try {
    const { navitem: fresh } = await api(`navitems/${row.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    // 改名/换父/排序都可能影响分组序与父下拉选项：整表重载，屏上必反映真实态（同分类页纪律）
    toast(`导航项 #${fresh.id} 已保存`, { type: 'ok', ttl: 3000 });
    await loadNavs();
  } catch (e) {
    if (e.status !== 401) toast('保存失败：' + e.message, { type: 'err', ttl: 8000 }); // 降挂/子挂子等 400 原文呈现
    btn.disabled = false;
  }
}

async function delNavitem(row, btn) {
  const ok = await confirmModal({
    title: '确认删除导航项？',
    lines: [`导航项 #${row.id}：${row.item}`, '有子项的顶层会被后端 400 拒绝——请改用批删并连选其子项。', '前台生效需再点批量发布。'],
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await api(`navitems/${row.id}`, { method: 'DELETE' });
  } catch (e) {
    // 有子顶层 400：后端 message 含子项数与「先删子项或 batch-delete 连选」引导，原文 toast
    if (e.status !== 401) toast(e.message, { type: 'err', ttl: 10000 });
    btn.disabled = false;
    return;
  }
  toast(`导航项 #${row.id} 已删除（前台生效需再点批量发布）`, { type: 'ok', ttl: 4000 });
  await loadNavs();
}

function renderNvChecks() {
  renderRowChecks('nv-table', 'nv-chk-all', 'nv-del-sel', nvSel,
    nvRows.map((r) => r.id), (cb) => Number(cb.dataset.id));
}

async function nvBatchDelete() {
  const rows = nvRows.filter((r) => nvSel.has(r.id));
  if (!rows.length) return;
  const names = rows.slice(0, 8).map((r) => `${r.item}（#${r.id}）`).join('、') + (rows.length > 8 ? `…等 ${rows.length} 项` : '');
  const ok = await confirmModal({
    title: '确认批量删除导航项？',
    lines: [`已选 ${rows.length} 项：${names}`, '原子删除：勾了顶层项必须连同其全部子项一并勾选，否则后端 400 列阻塞清单，整体拒绝零删除。', '前台生效需再点批量发布。'],
    danger: true,
  });
  if (!ok) return;
  const r = await api('navitems/batch-delete', { method: 'POST', body: JSON.stringify({ ids: rows.map((x) => x.id) }) });
  toast(`已删除 ${r.deleted} 个导航项（前台生效需再点批量发布）`, { type: 'ok', ttl: 5000 });
  await loadNavs();
}
$('nv-del-sel').onclick = guarded(nvBatchDelete);

// 新增表单的父下拉：只列顶层；重载后保留仍有效的现选项（新出现的顶层也会即时可选）。
function refillNvNewParent() {
  const sel = $('nv-new-parent');
  fillParentOptions(sel, { current: sel.value === '' ? null : Number(sel.value), excludeId: null });
}

async function createNavitem() {
  const item = $('nv-new-item').value.trim();
  if (!item) { toast('请输入导航项名称（空名称会被后端拒绝）', { type: 'err' }); return; }
  const payload = { item };
  const icon = $('nv-new-icon').value.trim();
  if (icon) payload.icon = icon;
  const link = $('nv-new-link').value.trim();
  if (link) payload.link = link;
  const pv = $('nv-new-parent').value;
  if (pv !== '') payload.parent_id = Number(pv); // 缺省即顶层（后端 null）；子挂子 400 由后端闸拒、toast 原文
  const btn = $('nv-new-go'); btn.disabled = true;
  try {
    const { navitem } = await api('navitems', { method: 'POST', body: JSON.stringify(payload) });
    $('nv-new-item').value = '';
    $('nv-new-icon').value = '';
    $('nv-new-link').value = '';
    $('nv-new-parent').value = '';
    toast(`导航项「${navitem.item}」已添加（前台生效需再点批量发布）`, { type: 'ok', ttl: 4000 });
    await loadNavs();
  } catch (e) {
    if (e.status !== 401) toast(e.message, { type: 'err', ttl: 8000 });
  } finally {
    btn.disabled = false;
  }
}
$('nv-new-go').addEventListener('click', createNavitem);
$('nv-reload').addEventListener('click', () => loadNavs());

/* ---------- 批量发布 ---------- */
$('publish-btn').addEventListener('click', async (btn) => {
  // 终局评审 Important #2 裁定落地：保留「发布即快照」，但确认前必须列出将要上线的 pending 清单
  // （人工确认前移到发布按钮的弹窗）。零 innerHTML 约束：confirm 原生文本，列表用 string join。
  btn.disabled = true; btn.textContent = '读取待发布清单…';
  let pending;
  try {
    pending = await api('sites?status=pending&perPage=200'); // 现有接口；total 给全量条数，清单最多展示 15 条
  } catch (e) {
    if (e.status !== 401) toast('读取待发布清单失败：' + e.message, { type: 'err', ttl: 8000 });
    btn.disabled = false; btn.textContent = '批量发布';
    return; // 清单读不到就不进确认——发布是不可逆写线上仓库的动作
  }
  const titles = pending.sites.slice(0, 15).map((s) => s.title || s.url_raw || s.url).join('、');
  const listText = pending.total === 0
    ? '当前没有待发布站点（本次仅重推现有已发布集合）。'
    : `待发布 ${pending.total} 条：${titles}${pending.total > 15 ? `…等 ${pending.total} 条` : ''}`;
  if (!confirm(`把所有待发布站点写入 webstack.yml 并推送 GitHub（触发前台 Pages 重建）？\n${listText}`)) {
    btn.disabled = false; btn.textContent = '批量发布';
    return;
  }
  btn.textContent = '发布中…';
  try {
    const r = await api('publish', { method: 'POST', body: '{}' });
    toast(`发布成功：${r.count} 条站点已写入 webstack/friendlinks/headers 三数据文件。`, { type: 'ok', linkUrl: r.commitUrl, ttl: 12000 });
    loadList();
  } catch (e) {
    // 失败路径：后端统一错误信封 {error,message}（如 GITHUB_TOKEN 未配置/冲突/空库与骤降保护闸），toast 呈现，不崩
    if (e.status !== 401) toast('发布失败：' + e.message, { type: 'err', ttl: 10000 });
  } finally {
    btn.disabled = false; btn.textContent = '批量发布';
  }
});

/* ---------- 导入视图 ---------- */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024; // 与服务端 routes.ts MAX_IMPORT_BYTES（spec §4.1）同值
$('import-file').addEventListener('change', () => {
  const f = $('import-file').files && $('import-file').files[0];
  if (!f) return;
  // 客户端预检：>10MB 直接 toast 跳过，不读文件也不发请求（服务端仍按解码后 UTF-8 字节兜底拒 413）
  if (f.size > MAX_IMPORT_BYTES) {
    toast(`文件「${f.name}」约 ${(f.size / 1024 / 1024).toFixed(1)} MB，超过 10MB 上限，已忽略`, { type: 'err', ttl: 8000 });
    $('import-file').value = '';
    return;
  }
  const rd = new FileReader();
  rd.onload = () => {
    const html = String(rd.result || '');
    $('import-text').value = html; // 回填文本框：可见、可再编辑，「开始导入」统一读文本框
    toast(`已读取文件 ${f.name}（约 ${(html.length / 1024).toFixed(0)} KB），点「开始导入」提交`, { type: 'ok', ttl: 5000 });
  };
  rd.onerror = () => toast('文件读取失败', { type: 'err' });
  rd.readAsText(f, 'utf-8');
});
$('import-go').addEventListener('click', async (btn) => {
  const html = $('import-text').value;
  if (!html.trim()) { toast('请先选择文件或粘贴书签 HTML', { type: 'err' }); return; }
  btn.disabled = true; $('import-busy').classList.remove('hidden');
  $('import-result').replaceChildren();
  try {
    const r = await api('import', { method: 'POST', body: JSON.stringify({ html }) });
    renderImportResult(r);
    const resumeHint = r.failed ? '。若因超时/限流部分失败，直接再点一次导入即可续传（已加入的会记为 skipped_dup）' : '';
    toast(`导入完成：新增 ${r.added}，重复跳过 ${r.skipped_dup}，失败 ${r.failed}${resumeHint}`, { type: r.failed ? 'err' : 'ok', ttl: 8000 });
  } catch (e) {
    if (e.status !== 401) toast('导入失败：' + e.message, { type: 'err', ttl: 8000 });
  } finally {
    btn.disabled = false; $('import-busy').classList.add('hidden');
  }
});
function renderImportResult(r) {
  const box = $('import-result');
  box.replaceChildren();
  box.append(el('h2', '', `结果：新增 ${r.added} · 重复跳过 ${r.skipped_dup} · 失败 ${r.failed}`));
  const label = { added: '新增', skipped_dup: '重复跳过', failed: '失败' };
  const table = el('table');
  const head = el('tr');
  for (const t of ['URL', '结果', '原因']) head.append(el('th', '', t));
  table.append(head);
  for (const it of r.items) {
    const tr = el('tr');
    const c1 = el('td'); c1.append(el('span', '', it.url));
    const c2 = el('td'); c2.append(el('span', 'stat-' + it.status, label[it.status] || it.status));
    const c3 = el('td'); c3.append(el('span', 'dim', it.reason || ''));
    tr.append(c1, c2, c3);
    table.append(tr);
  }
  const wrap = el('div', 'scroll-x'); // el() 第三参是 textContent，节点须手动 append
  wrap.append(table);
  box.append(wrap); // 美化轮：手机上长 URL 横向滚动而不是撑破卡片
}

/* ---------- 新增视图 ---------- */
async function addSite() {
  const url = $('add-url').value.trim();
  if (!url) { toast('请输入 URL', { type: 'err' }); return; }
  const btn = $('add-go'); btn.disabled = true;
  $('add-result').replaceChildren();
  try {
    // 服务端 analyzeAndUpsert 已完成抓取+分析（未配 AI/抓取失败 → 降级 pending 行），UI 只展示结果行。
    // 分类/子分类为可选 hint：taxonomy 非空才随单送（term 单独送无意义——后端形态归一兜底）。
    const payload = { url };
    const tax = $('add-taxonomy').value.trim();
    const term = $('add-term').value.trim();
    if (tax) { payload.taxonomy = tax; if (term) payload.term = term; }
    const { site } = await api('sites', { method: 'POST', body: JSON.stringify(payload) });
    $('add-url').value = '';
    $('add-taxonomy').value = '';
    $('add-term').value = '';
    const pairs = {
      ID: site.id, 'URL（规范化）': site.url, 'URL（原样）': site.url_raw, 标题: site.title,
      描述: site.description || '（空）', 分类: site.taxonomy, 子分类: site.term || '（无）',
      状态: site.status === 'published' ? '已发布' : '待发布（如为降级占位行，可在列表编辑或点「重分析」）',
      来源: site.source,
    };
    const dl = el('dl');
    for (const [k, v] of Object.entries(pairs)) { dl.append(el('dt', '', k), el('dd', '', v)); }
    $('add-result').append(el('h2', '', '已添加，服务端分析结果：'), dl);
    toast(`站点 #${site.id} 已入库`, { type: 'ok', ttl: 4000 });
  } catch (e) {
    if (e.status !== 401) toast('添加失败：' + e.message, { type: 'err', ttl: 8000 }); // dup_url 409 等走此分支
  } finally {
    btn.disabled = false;
  }
}
$('add-go').addEventListener('click', addSite);
$('add-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSite(); });
// 新增表单联动：term 建议随 taxonomy 输入变化（自制 combobox，弹单选项打开时实时取 shapes）
addTermSync = bindTermLink($('add-taxonomy'), $('add-term'));
attachCombo($('add-taxonomy'), document.querySelector('.combo-btn[data-combo-for="add-taxonomy"]'), allTaxonomies);
attachCombo($('add-term'), document.querySelector('.combo-btn[data-combo-for="add-term"]'), () => termsFor($('add-taxonomy').value));

/* ---------- 启动 ---------- */
if (getToken()) {
  api('sites?perPage=1')
    .then(() => { applyAuthedUi(true); showView('list'); })
    .catch(() => { /* 401 已在 api() 内回退口令条；网络类错误也停留口令条，可重试 */ });
} else {
  applyAuthedUi(false);
}
