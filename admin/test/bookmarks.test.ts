import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseChromeBookmarks } from '../src/bookmarks';

const items = parseChromeBookmarks(readFileSync('test/fixtures/bookmarks.chrome.html', 'utf8'));
const byUrl = (u: string) => items.find((i) => i.url === u);

describe('parseChromeBookmarks', () => {
  it('展平全部 A 标签并跳过账户根文件夹', () => expect(items.length).toBe(11)); // fixture 内全部 A 标签数
  it('folder 为账户层以下路径', () => expect(byUrl('https://cg99.invalid/ziyuan')?.folder).toBe('设计/素材'));
  it('保留 ADD_DATE', () => expect(typeof items[0].addDate).toBe('number'));

  it('书签栏/其他书签前缀丢弃：其直属条目 folder 为空串，中间层保留', () => {
    expect(byUrl('https://a.invalid')?.folder).toBe(''); // 其他书签直属
    expect(byUrl('https://dribbble.invalid')?.folder).toBe(''); // 书签栏直属
    expect(byUrl('https://zcool.invalid')?.folder).toBe('设计'); // 中间层保留
  });
  it('保留重复与非法 URL（解析器不筛选，由路由层分类）', () => {
    expect(byUrl('https://dup.invalid/x')).toBeTruthy();
    expect(byUrl('https://dup.invalid/x/')).toBeTruthy(); // 末尾斜杠差异留给 normalizeUrl 判重
    expect(byUrl('javascript:alert(1)')).toBeTruthy();
    expect(items.filter((i) => /^https?:/.test(i.url)).length).toBe(10);
  });
  it('标题剥内联标签并解码实体', () => {
    expect(byUrl('https://e.invalid')?.title).toBe('E站'); // <IMG> 混入
    expect(byUrl('https://c.invalid/path?q=2')?.title).toBe('C&D 站');
    expect(byUrl('https://cg99.invalid/ziyuan')?.title).toBe('CG99 – CG设计网'); // &#8211;
  });
  it('大小写不敏感：小写 a/href/add_date 也能解析', () => {
    expect(byUrl('javascript:alert(1)')).toMatchObject({ title: '恶意脚本', addDate: 1700000020 });
  });
  it('HREF 中的实体在属性里已解出（&amp; → &）', () => {
    expect(byUrl('https://b.invalid?utm_source=nl&keep=1')?.title).toBe('B站');
  });
  it('无 ADD_DATE 属性时 addDate 缺省', () => {
    const sparse = parseChromeBookmarks('<DL><p><DT><A HREF="https://s.invalid">S</A></DL><p>');
    expect(sparse).toEqual([{ title: 'S', url: 'https://s.invalid', folder: '' }]);
    // LAST_ADD_DATE 不得被误认成 ADD_DATE（属性名前缀包含）
    const last = parseChromeBookmarks('<DL><p><DT><A HREF="https://t.invalid" LAST_ADD_DATE="999">T</A></DL><p>');
    expect(last[0]).not.toHaveProperty('addDate');
  });
});
