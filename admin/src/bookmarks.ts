// Chrome 书签（Netscape Bookmark File Format）解析，spec §4.1：
// 手写正则+状态机（零依赖），按文档序扫描 <DL>/<\/DL>/<H3>/<A>，维护文件夹栈；
// 首层为账户根（丢弃），其后的「书签栏/其他书签」前缀也丢弃，剩余栈即 folder 路径。
// 解析器不做筛选：重复 URL、非法 URL 原样保留，由路由层分类计数。

export interface BookmarkItem {
  title: string;
  url: string;
  folder: string;
  addDate?: number;
}

// 账户层之后可能出现的第一层「书签栏/其他书签」类容器名（大小写不敏感）
const CHROME_ROOT = /^(书签栏|其他书签|书签菜单|移动设备书签|bookmark(s)?\s*bar|barre\s*de\s*favoris|other\s+bookmarks|mobile\s+bookmarks)$/i;

const decodeEntities = (s: string): string =>
  s
    .replace(/&#(\d+);|&#x([0-9a-f]+);/gi, (_m, dec, hex) =>
      String.fromCodePoint(dec ? Number(dec) : parseInt(hex as string, 16)),
    )
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0?39;/gi, "'")
    .replace(/&amp;/gi, '&'); // 最后处理，避免 &amp;#38; 双重解码

const cleanText = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// 属性值三形态："…"、'…'、裸 token（不含空白/引号/等号/尖括号/反引号）；
// NAME 前锚定属性名边界字符（或串首），防止 ADD_DATE 命中 LAST_ADD_DATE 这类包含关系
const attrRaw = (attrs: string, name: string): string | undefined => {
  const m = new RegExp('(?:^|[^A-Za-z0-9_-])' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>`]+))', 'i').exec(' ' + attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined;
};

export function parseChromeBookmarks(html: string): BookmarkItem[] {
  const items: BookmarkItem[] = [];
  const stack: string[] = [];
  let pending: string | null = null; // 最近一次 H3 文本，遇到 <DL> 时入栈
  const tokenRe = /<DL>|<\/DL>|<H3\b[^>]*>([\s\S]*?)<\/H3>|<A\b([^>]*)>([\s\S]*?)<\/A>/gi;
  for (const m of html.matchAll(tokenRe)) {
    const token = m[0];
    if (/^<DL>/i.test(token)) {
      stack.push(pending ?? '');
      pending = null;
    } else if (/^<\/DL>/i.test(token)) {
      stack.pop();
    } else if (/^<H3/i.test(token)) {
      pending = cleanText(m[1] ?? '');
    } else {
      // <A>：m[2]=属性串 m[3]=内文
      const attrs = m[2] ?? '';
      const href = attrRaw(attrs, 'HREF');
      if (href === undefined) continue;
      const add = attrRaw(attrs, 'ADD_DATE');
      const addNum = add !== undefined && /^\d+$/.test(add.trim()) ? Number(add) : undefined;
      const item: BookmarkItem = { title: cleanText(m[3] ?? ''), url: decodeEntities(href.trim()), folder: folderPath(stack) };
      if (addNum !== undefined) item.addDate = addNum;
      items.push(item);
    }
  }
  return items;
}

function folderPath(stack: string[]): string {
  // stack[0] = 顶层 <DL>（无账户名时的空占位），stack[1] = 账户根 H3（若有）
  let path = stack.slice(2);
  if (path.length > 0 && CHROME_ROOT.test(path[0]!)) path = path.slice(1);
  return path.join('/');
}
