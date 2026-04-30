// router.js — 意图分流
// 施工图: 简单指令直连 · 音乐走 ncm · 自然语言走 claude

/**
 * 判定一条用户输入的处理方式
 * @param {string} input
 * @returns {{kind: 'control'|'play_direct'|'chat', payload?: any}}
 */
export function route(input) {
  const s = input.trim();
  const lower = s.toLowerCase();

  // 1) 播放控制
  if (/^(pause|暂停)$/i.test(s)) return { kind: 'control', payload: { cmd: 'pause' } };
  if (/^(resume|继续|播放)$/i.test(s)) return { kind: 'control', payload: { cmd: 'resume' } };
  if (/^(next|下一首|skip)$/i.test(s)) return { kind: 'control', payload: { cmd: 'next' } };
  if (/^(stop|停)$/i.test(s)) return { kind: 'control', payload: { cmd: 'stop' } };

  // 2) 直连放歌: "play XXX" 或 "放 XXX" 或 "来首 XXX"
  const m = s.match(/^(?:play|放|来一?首?|点)\s+(.+)$/i);
  if (m) {
    return { kind: 'play_direct', payload: { query: m[1].trim() } };
  }

  // 3) 其他都走 claude 大脑
  return { kind: 'chat', payload: { text: s } };
}
