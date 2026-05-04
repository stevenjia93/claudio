// qq.js — QQ 音乐适配器
//
// 直接打 QQ 的 web 接口,不依赖任何外部 server。免费曲不需要 cookie;
// VIP 曲需要 cookie。
//
// 获取 cookie 的方法:
//   1. 浏览器登录 https://y.qq.com (用 QQ 或者微信)
//   2. 打开 DevTools → Application → Cookies → https://y.qq.com
//   3. 复制 uin 和 qm_keyst 两个值
//   4. 在 .env 里填:
//        QQ_UIN=2147483647            # 你的 uin (数字)
//        QQ_QM_KEYST=<qm_keyst 值>    # 完整粘贴
//   5. 也可以一步到位贴整个 Cookie 头:
//        QQ_COOKIE=uin=...; qm_keyst=...; ...

const Q = {
  REFERER: 'https://y.qq.com',
  UA: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const UIN = process.env.QQ_UIN || '0';
const QM_KEYST = process.env.QQ_QM_KEYST || '';
const COOKIE_RAW = process.env.QQ_COOKIE
  || (UIN !== '0' && QM_KEYST ? `uin=${UIN}; qm_keyst=${QM_KEYST}` : '');

function headers() {
  const h = {
    'User-Agent': Q.UA,
    'Referer': Q.REFERER
  };
  if (COOKIE_RAW) h.Cookie = COOKIE_RAW;
  return h;
}

async function getJson(url) {
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`qq HTTP ${r.status} @ ${url.slice(0, 80)}`);
  const txt = await r.text();
  // 有些接口包成 jsonp/callback,清理一下
  const cleaned = txt.replace(/^[^{]*?(\{[\s\S]*\})[^}]*$/, '$1');
  return JSON.parse(cleaned);
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error(`qq HTTP ${r.status} POST`);
  return r.json();
}

export const id = 'qq';
export const name = 'QQ 音乐';

// 封面直链 — 用 albummid 拼,不需要二次查询
function albumPic(albummid, size = 300) {
  if (!albummid) return '';
  return `https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${albummid}.jpg`;
}

// ————— 搜索 —————
//   QQ 的 client_search_cp 老接口返 500;
//   musicu.fcg 新接口返空 list (反爬);
//   smartbox_new.fcg 是免登可用的, 用它。
export async function search(query, limit = 5) {
  const u = new URL('https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg');
  u.searchParams.set('key', query);
  u.searchParams.set('format', 'json');
  u.searchParams.set('inCharset', 'utf-8');
  u.searchParams.set('outCharset', 'utf-8');
  u.searchParams.set('platform', 'yqq.json');
  u.searchParams.set('needNewCode', '0');

  const data = await getJson(u.toString());
  const list = (data?.data?.song?.itemlist || []).slice(0, limit);
  // smartbox 不带封面/专辑/时长, 后续 findPlayable 时再补
  return list.map(s => ({
    source: 'qq',
    id: s.mid,
    name: s.name,
    artist: s.singer || '',
    album: '',
    picUrl: '',
    duration: 0
  })).filter(s => s.id && s.name);
}

// 批量拿 detail + url, 一次请求(走 musicu.fcg)
//   返回 { picUrl, album, url }
async function detailWithUrl(songmid) {
  const guid = String(Math.floor(Math.random() * 1_000_000_000));
  const filename = `M500${songmid}${songmid}.mp3`;
  const payload = {
    songinfo: {
      method: 'get_song_detail_yqq',
      module: 'music.pf_song_detail_svr',
      param: { song_mid: songmid }
    },
    vkey: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        filename: [filename],
        guid,
        songmid: [songmid],
        songtype: [0],
        uin: UIN,
        loginflag: 1,
        platform: '20'
      }
    }
  };
  const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=' +
              encodeURIComponent(JSON.stringify(payload));
  const resp = await getJson(url);
  const info = resp?.songinfo?.data?.track_info;
  const vk = resp?.vkey?.data;
  const purl = vk?.midurlinfo?.[0]?.purl;
  const sip = (vk?.sip || []).find(s => !s.startsWith('http://ws')) || vk?.sip?.[0];
  return {
    picUrl: albumPic(info?.album?.mid),
    album: info?.album?.name || '',
    duration: (info?.interval || 0) * 1000,
    url: purl ? sip + purl : null
  };
}

// ————— 直链 (需要 cookie 才能拿 VIP) —————
export async function songUrl(songmid) {
  if (!songmid) return null;
  try {
    const d = await detailWithUrl(songmid);
    return d.url;
  } catch {
    return null;
  }
}

// ————— 歌词 (返回 base64 编码的 LRC) —————
export async function lyric(songmid) {
  if (!songmid) return '';
  const u = new URL('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg');
  u.searchParams.set('songmid', songmid);
  u.searchParams.set('pcachetime', String(Date.now()));
  u.searchParams.set('format', 'json');
  u.searchParams.set('g_tk', '5381');
  u.searchParams.set('loginUin', '0');
  u.searchParams.set('hostUin', '0');
  u.searchParams.set('inCharset', 'utf8');
  u.searchParams.set('outCharset', 'utf-8');
  u.searchParams.set('notice', '0');
  u.searchParams.set('platform', 'yqq');
  u.searchParams.set('needNewCode', '0');

  try {
    const data = await getJson(u.toString());
    const enc = data?.lyric;
    if (!enc) return '';
    // base64 → utf8
    return Buffer.from(enc, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

export async function songDetail(songmid) {
  if (!songmid) return null;
  // search 已带 picUrl, 这里只在 picUrl 缺失时才补
  return null;
}

// 把 query 拆出 artist 名: "稻香 - 周杰伦" / "稻香 周杰伦" / "Spiral Floating Points" 都行
function extractArtistHint(query) {
  // 用 ' - ' 切; 没有 dash 就用最后一个空格段
  const dashed = query.split(/\s*[-–—]\s*/);
  if (dashed.length >= 2) return dashed[dashed.length - 1].trim().toLowerCase();
  const tokens = query.trim().split(/\s+/);
  if (tokens.length >= 2) return tokens.slice(1).join(' ').toLowerCase();
  return '';
}

function rankByArtist(candidates, hint) {
  if (!hint) return candidates;
  const matched = candidates.filter(c => (c.artist || '').toLowerCase().includes(hint));
  const others = candidates.filter(c => !matched.includes(c));
  return [...matched, ...others];
}

export async function findPlayable(query) {
  const candidates = await search(query, 5);
  const hint = extractArtistHint(query);
  const ranked = rankByArtist(candidates, hint);
  for (const c of ranked) {
    try {
      const d = await detailWithUrl(c.id);
      if (d.url) {
        return { ...c, url: d.url, picUrl: d.picUrl, album: d.album, duration: d.duration };
      }
    } catch {}
  }
  return null;
}
