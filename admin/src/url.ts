const TRACKING = /^(utm_|gclid$|spm$|from$|ref$|fbclid$|ssc.?id$)/i;
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw.trim()); }
  catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
  u.hostname = u.hostname.toLowerCase();
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k));
  u.search = ''; for (const [k, v] of keep) u.searchParams.append(k, v);
  let s = u.toString();
  if (s.endsWith('/') && !u.search && !u.hash) s = s.slice(0, -1);
  return s;
}
