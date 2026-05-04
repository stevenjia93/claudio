// ytmusic.js — YouTube Music 适配器
//
// 双轨策略 (按可用性自动选):
//   ① play-dl (npm)          — 走 Node 直连。YouTube 反爬越来越严,
//                                可能要 YT_COOKIE 才能拿流。
//   ② yt-dlp (子进程)        — 装了 yt-dlp 就用它,稳定胜过 play-dl。
//                                brew install yt-dlp
//
// 配置:
//   YT_COOKIES_FROM_BROWSER=chrome       # 借用本机浏览器登录态(最省事,推荐)
//                                          # 可选: chrome / safari / firefox / edge / brave
//   YT_COOKIE=<browser cookie 字符串>     # 也可以手贴 cookie 头
//   YT_DLP_BIN=yt-dlp                    # 自定义路径(默认 PATH 里找)
//
// 流代理: 浏览器拉 /api/proxy/yt/<videoId>, server.js pipe 这里返回的 Readable。

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const YT_COOKIE = process.env.YT_COOKIE || '';
const YT_COOKIES_BROWSER = process.env.YT_COOKIES_FROM_BROWSER || '';
const YT_DLP = process.env.YT_DLP_BIN || 'yt-dlp';

// yt-dlp 通用 cookie 选项
function ytdlpCookieArgs() {
  if (YT_COOKIES_BROWSER) return ['--cookies-from-browser', YT_COOKIES_BROWSER];
  if (YT_COOKIE) return ['--add-header', `Cookie:${YT_COOKIE}`];
  return [];
}

let _play = null;
async function playDl() {
  if (_play) return _play;
  try {
    const m = await import('play-dl');
    _play = m.default || m;
    if (YT_COOKIE) {
      // play-dl 用 cookie 抗反爬
      _play.setToken({ youtube: { cookie: YT_COOKIE } }).catch(() => {});
    }
    return _play;
  } catch {
    return null;
  }
}

async function ytdlpAvailable() {
  return new Promise(resolve => {
    const p = spawn(YT_DLP, ['--version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', code => resolve(code === 0));
  });
}

export const id = 'ytmusic';
export const name = 'YouTube Music';

// ————— 搜索 —————
//   先试 play-dl (含 cookie), 再试 yt-dlp 的 ytsearch:
export async function search(query, limit = 5) {
  const p = await playDl();
  if (p) {
    try {
      const results = await p.search(query, { source: { youtube: 'video' }, limit });
      if (results && results.length) {
        return results.map(v => ({
          source: 'ytmusic',
          id: v.id,
          name: v.title || '',
          artist: v.channel?.name || '',
          album: '',
          picUrl: v.thumbnails?.[v.thumbnails.length - 1]?.url
               || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
          duration: (v.durationInSec || 0) * 1000
        }));
      }
    } catch (e) {
      // 反爬 / 区域限制等, 走 yt-dlp 兜底
    }
  }

  if (await ytdlpAvailable()) {
    return ytdlpSearch(query, limit);
  }

  throw new Error('YT Music 不可用: play-dl 失败且 yt-dlp 没装。'
    + ' 装 yt-dlp 用 `brew install yt-dlp`,或在 .env 里设 YT_COOKIE。');
}

// 用 yt-dlp 搜
function ytdlpSearch(query, limit) {
  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch${limit}:${query}`,
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      ...ytdlpCookieArgs()
    ];
    const proc = spawn(YT_DLP, args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`yt-dlp 退出 ${code}: ${stderr.slice(0, 200)}`));
      const items = stdout.trim().split('\n')
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean)
        .map(v => ({
          source: 'ytmusic',
          id: v.id,
          name: v.title || '',
          artist: v.uploader || v.channel || '',
          album: '',
          picUrl: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
          duration: (v.duration || 0) * 1000
        }));
      resolve(items);
    });
  });
}

// 浏览器走代理拉, 不直接给 YouTube URL
export async function songUrl(videoId) {
  return videoId ? `/api/proxy/yt/${videoId}` : null;
}

export async function lyric(_videoId) {
  return '';
}

export async function songDetail(_videoId) {
  return null;
}

export async function findPlayable(query) {
  const candidates = await search(query, 3);
  for (const c of candidates) {
    if (c.id) return { ...c, url: `/api/proxy/yt/${c.id}` };
  }
  return null;
}

/**
 * server.js 的 /api/proxy/yt/:videoId 调这个拿 audio Readable。
 * 路线: yt-dlp --get-url 拿到 googlevideo 直链 → fetch → 把 body 转给客户端。
 *       比直接 spawn yt-dlp 流式输出快得多。
 * 回落: 没有 yt-dlp 时用 play-dl。
 */
export async function streamAudio(videoId) {
  if (await ytdlpAvailable()) {
    const direct = await ytdlpGetUrl(videoId);
    const r = await fetch(direct);
    if (!r.ok) throw new Error(`googlevideo ${r.status}`);
    // r.body 是 web ReadableStream, pipe 需要 Node Readable
    const nodeStream = Readable.fromWeb(r.body);
    return {
      stream: nodeStream,
      type: r.headers.get('content-type')?.includes('webm') ? 'webm' : 'mp4'
    };
  }

  // 回落 play-dl
  const p = await playDl();
  if (!p) throw new Error('既没 yt-dlp 也没 play-dl');
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const s = await p.stream(url, { quality: 1 });
  return { stream: s.stream, type: s.type === 'webm' ? 'webm' : 'mp4' };
}

// yt-dlp 拿直链 (不下载,只返回签名 URL,1-2s)
function ytdlpGetUrl(videoId) {
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      url,
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '--get-url',
      '--no-warnings',
      ...ytdlpCookieArgs()
    ];
    const proc = spawn(YT_DLP, args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`yt-dlp 退出 ${code}: ${stderr.slice(0, 200)}`));
      const u = stdout.trim().split('\n')[0];
      if (!u || !u.startsWith('http')) return reject(new Error('yt-dlp 没给 URL: ' + stdout.slice(0, 100)));
      resolve(u);
    });
  });
}
