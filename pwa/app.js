// ============================================
// app.js — Claudio PWA 前端逻辑
// 包括: 播放器 / 歌词同步 / 可拖动进度 / 鼠标动效
// ============================================

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const djAudio = new Audio();
djAudio.preload = 'auto';

const songName = $('song-name');
const songArtist = $('song-artist');
const cover = $('cover');
const progressBar = $('progress-bar');
const progressFill = $('progress-fill');
const progressThumb = $('progress-thumb');
const tCurrent = $('t-current');
const tTotal = $('t-total');
const queueList = $('queue-list');
const queueCount = $('queue-count');
const historyList = $('history-list');
const historyCount = $('history-count');
const chatForm = $('chat-form');
const chatInput = $('chat-input');
const chatHistory = $('chat-history');
const btnSend = $('btn-send');
const btnPlay = $('btn-play');
const btnNext = $('btn-next');
const btnLike = $('btn-like');
const btnDislike = $('btn-dislike');
const wsPill = $('ws-pill');
const cardNow = document.querySelector('.card-now');
const cardLyrics = $('card-lyrics');
const lyricsTrack = $('lyrics-track');

let currentQueue = [];
let currentSong = null;
let autoPlayArmed = false;
let lyrics = [];          // [{t: seconds, text: string}]
let currentLyricIndex = -1;
let feedback = { liked: [], disliked: [] };

// ============================================
// 1. WebSocket
// ============================================
let ws;
function connectWs() {
  ws = new WebSocket(`ws://${location.host}/stream`);
  ws.onopen = () => {
    wsPill.textContent = '● ws';
    wsPill.classList.add('live');
  };
  ws.onclose = () => {
    wsPill.textContent = '○ ws';
    wsPill.classList.remove('live');
    setTimeout(connectWs, 3000);
  };
  ws.onmessage = (evt) => handleWs(JSON.parse(evt.data));
}

function handleWs(msg) {
  switch (msg.type) {
    case 'hello':
      if (msg.feedback) feedback = msg.feedback;
      renderQueue(msg.queue || []);
      if (msg.nowPlaying) renderNowPlaying(msg.nowPlaying);
      refreshHistory();
      break;
    case 'queue_update':
      renderQueue(msg.queue);
      maybeStartPlayback();
      break;
    case 'now_playing':
      renderQueue(msg.queue);
      renderNowPlaying(msg.nowPlaying);
      refreshHistory();             // 切歌后刷一下"已播"
      break;
    case 'dj_broadcast':
      // DJ 文本只在右侧 chat 历史里渲染 (chat 提交那条 fetch 已经 appendChat 过了),
      // 不再单独的 DJ 卡。这里只刷队列 + 启声音。
      renderQueue(msg.queue);
      speakThenPlay(msg.say, msg.audio_url);
      break;
    case 'control':
      applyControl(msg.cmd);
      break;
    case 'feedback':
      feedback = msg.feedback || feedback;
      reflectFeedbackButtons();
      break;
  }
}

connectWs();

// ============================================
// 2. 聊天
// ============================================
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  autoPlayArmed = true;
  appendChat('user', text);
  chatInput.value = '';
  btnSend.disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 120)}`);
    }
    const data = await res.json();

    if (data.kind === 'chat') {
      appendChat('assistant', data.say, data.reason);
      // 0 首兜底提示
      if (Array.isArray(data.play) && data.play.length > 0
          && (!data.resolved || data.resolved.length === 0)) {
        appendChat('assistant',
          `(没在网易云找到能播的: ${data.play.slice(0, 3).join(', ')}${data.play.length > 3 ? '…' : ''})`);
      }
    } else if (data.kind === 'play_direct') {
      const names = (data.added || []).map(s => `${s.song} - ${s.artist}`).join(', ');
      appendChat('assistant', `已排好: ${names || '(没找到能播的)'}`);
    } else if (data.kind === 'control') {
      appendChat('assistant', `[${data.cmd}]`);
    }
  } catch (err) {
    appendChat('assistant', `出错了: ${err.message}`);
  } finally {
    btnSend.disabled = false;
    chatInput.focus();
  }
});

function appendChat(role, content, meta) {
  const li = document.createElement('li');
  li.className = role;
  const label = role === 'user' ? '我' : 'claudio';
  li.innerHTML = `<span class="meta">${label}</span>${escapeHtml(content)}`;
  if (meta) {
    const r = document.createElement('span');
    r.className = 'meta';
    r.style.marginTop = '4px';
    r.textContent = `// ${meta}`;
    li.appendChild(r);
  }
  chatHistory.appendChild(li);
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

// ============================================
// 3. 歌曲音频
// ============================================
btnPlay.addEventListener('click', () => {
  autoPlayArmed = true;
  if (!audio.paused) {
    audio.pause();
    return;
  }
  // 已有 src,直接续播
  if (audio.src) {
    audio.play().catch(err => console.warn('play 被挡:', err.message));
    return;
  }
  // 没 src 但 nowPlaying 还在 — 重新装 src 重播,不要去 /api/next 把当前歌弄丢
  if (currentSong?.url) {
    audio.src = currentSong.url;
    audio.play().catch(err => console.warn('play 被挡:', err.message));
    return;
  }
  // 真的什么都没有,才去队列要下一首
  playNext();
});

btnNext.addEventListener('click', () => {
  autoPlayArmed = true;
  playNext();
});

// like / dislike — 当前播放的歌
async function sendFeedback(action) {
  if (!currentSong?.song) return;
  const song = {
    song: currentSong.song,
    artist: currentSong.artist,
    source: currentSong.source || ''
  };
  await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, song })
  }).catch(e => console.warn('[feedback]', e.message));
}

// 点 ♡ 标记 like; 再点变 ♥ → 再点取消
btnLike.addEventListener('click', () => {
  const st = feedbackStateForCurrent();
  sendFeedback(st === 'like' ? 'clear' : 'like');
});

// 点 💔: 标记 dislike + 自动切下一首; 已 dislike 状态再点取消
btnDislike.addEventListener('click', () => {
  const st = feedbackStateForCurrent();
  if (st === 'dislike') {
    sendFeedback('clear');
  } else {
    sendFeedback('dislike');
    autoPlayArmed = true;
    playNext();
  }
});

// 当前歌在 feedback 里的状态 (♥ / ✕ / 无)
function feedbackStateForCurrent() {
  if (!currentSong?.song) return null;
  const sig = `${(currentSong.song || '').toLowerCase()}|${(currentSong.artist || '').toLowerCase()}`;
  if (feedback.liked?.some(f => `${(f.song || '').toLowerCase()}|${(f.artist || '').toLowerCase()}` === sig)) return 'like';
  if (feedback.disliked?.some(f => `${(f.song || '').toLowerCase()}|${(f.artist || '').toLowerCase()}` === sig)) return 'dislike';
  return null;
}

function reflectFeedbackButtons() {
  const st = feedbackStateForCurrent();
  btnLike.classList.toggle('active', st === 'like');
  btnDislike.classList.toggle('active', st === 'dislike');
  btnLike.textContent = st === 'like' ? '♥' : '♡';
}

audio.addEventListener('play', () => {
  btnPlay.textContent = '⏸';
  cardNow.classList.add('playing');
});
audio.addEventListener('pause', () => {
  btnPlay.textContent = '▶';
  cardNow.classList.remove('playing');
});
audio.addEventListener('ended', () => playNext());

// 防死循环: 空 src / 频繁报错时不再触发 next
let lastAudioError = 0;
audio.addEventListener('error', () => {
  if (!audio.currentSrc) return;
  const now = Date.now();
  if (now - lastAudioError < 1500) return;
  lastAudioError = now;
  console.warn('[music] 歌加载失败,跳下一首');
  playNext();
});
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  if (!progressBar.classList.contains('dragging')) {
    setProgressVisual(audio.currentTime / audio.duration);
  }
  tCurrent.textContent = fmtTime(audio.currentTime);
  tTotal.textContent = fmtTime(audio.duration);
  syncLyrics(audio.currentTime);
});
audio.addEventListener('loadedmetadata', () => {
  tTotal.textContent = fmtTime(audio.duration);
});

async function playNext() {
  try {
    const res = await fetch('/api/next');
    const song = await res.json();
    if (!song) {
      // 队列空了 — 只暂停,保留 nowPlaying / 歌词 / 封面,
      // 让用户还能看到刚才在听啥,点 Play 也能从头重播
      audio.pause();
      return;
    }
    if (!song.url) {
      console.warn('[music] 没有直链,跳过:', song.song);
      return playNext();
    }
    audio.src = song.url;
    await audio.play().catch(err => console.warn('audio play 被挡:', err.message));
  } catch (e) {
    console.error('playNext 出错:', e);
  }
}

function maybeStartPlayback() {
  if (autoPlayArmed && audio.paused && currentQueue.length > 0) {
    playNext();
  }
}

// ============================================
// 4. DJ 说话 — 边说边放
//    DJ 一开口就启下一首,把音乐压到 22% 当背景音,
//    DJ 说完渐变回 100%。模拟真电台 DJ 在歌前奏上配音。
// ============================================
function rampVolume(el, target, ms = 1000) {
  const start = el.volume;
  const t0 = performance.now();
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    el.volume = start + (target - start) * k;
    if (k < 1) requestAnimationFrame(tick);
  };
  tick();
}

function speakThenPlay(text, audioUrl) {
  const DUCK = 0.22;
  let restored = false;
  const duck = () => { audio.volume = DUCK; };
  const restore = () => {
    if (restored) return;
    restored = true;
    rampVolume(audio, 1.0, 1300);
  };

  const startNext = () => {
    // 不管之前在不在播,DJ 一开口就推进到下一首,前奏当背景
    if (autoPlayArmed) playNext();
  };

  if (audioUrl) {
    // 真人嗓 ElevenLabs
    djAudio.src = audioUrl;
    djAudio.volume = 1.0;
    // 等音频加载好再压低 + 启下一首,避免黑屏
    djAudio.onloadeddata = () => { duck(); startNext(); };
    djAudio.onended = restore;
    djAudio.onerror = () => {
      console.warn('[dj] mp3 失败,降级浏览器 TTS');
      speakBrowser(text, restore);
    };
    djAudio.play().catch(err => {
      console.warn('[dj] play 被挡:', err.message);
      restore();
      startNext();
    });
    return;
  }

  // 浏览器 TTS 兜底
  duck();
  startNext();
  speakBrowser(text, restore);
}

function speakBrowser(text, onDone) {
  if (!text || !('speechSynthesis' in window)) {
    setTimeout(onDone, 200);
    return;
  }
  const utter = new SpeechSynthesisUtterance(text);
  const hasChinese = /[一-鿿]/.test(text);
  utter.lang = hasChinese ? 'zh-CN' : 'en-US';
  utter.rate = 1.0;
  const voices = speechSynthesis.getVoices();
  const v = voices.find(v => v.lang.startsWith(hasChinese ? 'zh' : 'en'));
  if (v) utter.voice = v;
  utter.onend = onDone;
  utter.onerror = onDone;
  speechSynthesis.speak(utter);
}
speechSynthesis.onvoiceschanged = () => {};

// ============================================
// 5. 控制命令
// ============================================
function applyControl(cmd) {
  switch (cmd) {
    case 'pause':
      audio.pause();
      djAudio.pause();
      break;
    case 'resume': audio.play(); break;
    case 'next': playNext(); break;
    case 'stop':
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      djAudio.pause();
      djAudio.removeAttribute('src');
      speechSynthesis.cancel();
      break;
  }
}

// ============================================
// 6. 渲染
// ============================================
function renderQueue(queue) {
  currentQueue = queue || [];
  queueCount.textContent = String(currentQueue.length);
  queueList.innerHTML = '';
  if (currentQueue.length === 0) {
    queueList.innerHTML = '<li class="queue-empty">队列是空的</li>';
    return;
  }
  currentQueue.forEach((item, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.idx = String(i);
    li.innerHTML = `
      <span class="q-grip" title="拖动重排">⋮⋮</span>
      <span class="idx">${i + 1}.</span>
      <span class="song">${escapeHtml(item.song)}</span>
      <span class="artist">${escapeHtml(item.artist)}</span>
      <button class="q-remove" title="从队列移除">✕</button>
    `;
    bindQueueItem(li, i);
    queueList.appendChild(li);
  });
}

// —— 单个队列项: 删除按钮 + HTML5 拖拽重排 ——
let _dragFromIdx = -1;

function bindQueueItem(li, idx) {
  // 删除
  const x = li.querySelector('.q-remove');
  x.addEventListener('click', async (e) => {
    e.stopPropagation();
    li.style.opacity = '0.4';
    await fetch(`/api/queue/${idx}`, { method: 'DELETE' }).catch(() => {});
    // server 会广播 queue_update, 这里不用手动 render
  });

  // 双击 → 插队立即播
  li.addEventListener('dblclick', async (e) => {
    e.preventDefault();
    autoPlayArmed = true;
    try {
      const r = await fetch(`/api/queue/play/${idx}`, { method: 'POST' });
      const np = await r.json();
      if (np?.url) {
        audio.src = np.url;
        await audio.play().catch(()=>{});
      }
    } catch (e) { console.warn('[queue jump]', e.message); }
  });

  // 拖拽
  li.addEventListener('dragstart', (e) => {
    _dragFromIdx = idx;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(idx)); } catch {}
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    _dragFromIdx = -1;
    document.querySelectorAll('.queue-list li').forEach(el =>
      el.classList.remove('drop-target-above', 'drop-target-below'));
  });
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = li.getBoundingClientRect();
    const above = (e.clientY - r.top) < r.height / 2;
    li.classList.toggle('drop-target-above', above);
    li.classList.toggle('drop-target-below', !above);
  });
  li.addEventListener('dragleave', () => {
    li.classList.remove('drop-target-above', 'drop-target-below');
  });
  li.addEventListener('drop', async (e) => {
    e.preventDefault();
    li.classList.remove('drop-target-above', 'drop-target-below');
    const from = _dragFromIdx;
    if (from < 0 || from === idx) return;
    const r = li.getBoundingClientRect();
    const above = (e.clientY - r.top) < r.height / 2;
    let to = above ? idx : idx + 1;
    if (from < to) to -= 1;
    if (from === to) return;

    // 本地预览,马上重排
    const next = currentQueue.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    renderQueue(next);

    // 落库
    await fetch('/api/queue', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue: next })
    }).catch(() => {});
  });
}

// 已播过列表 — 双击 → 立即重听
async function refreshHistory() {
  if (!historyList) return;
  let plays = [];
  try {
    plays = await fetch('/api/history?limit=20').then(r => r.json());
  } catch {}
  historyCount.textContent = String(plays.length);
  historyList.innerHTML = '';
  if (!plays.length) {
    historyList.innerHTML = '<li class="history-empty">还没听过歌</li>';
    return;
  }
  const fmtAgo = (ts) => {
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return '刚才';
    if (d < 3600) return `${Math.floor(d/60)}分钟前`;
    if (d < 86400) return `${Math.floor(d/3600)}小时前`;
    return `${Math.floor(d/86400)}天前`;
  };
  for (const p of plays) {
    const li = document.createElement('li');
    li.title = '双击重听';
    li.innerHTML = `
      <span class="h-replay">↻</span>
      <span class="h-song">${escapeHtml(p.song || '')}</span>
      <span class="h-artist">${escapeHtml(p.artist || '')}</span>
      <span class="h-time">${fmtAgo(p.ts || Date.now())}</span>
    `;
    li.addEventListener('dblclick', async () => {
      autoPlayArmed = true;
      try {
        const r = await fetch('/api/history/replay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ song: p })
        });
        const np = await r.json();
        if (np?.url) {
          audio.src = np.url;
          await audio.play().catch(()=>{});
        }
      } catch (e) { console.warn('[replay]', e.message); }
    });
    historyList.appendChild(li);
  }
}

function renderNowPlaying(song) {
  // 同一首歌不重新加载 (避免 WS 重连导致歌词被清掉重拉)
  if (song?.id && currentSong?.id === song.id) {
    currentSong = song;
    reflectFeedbackButtons();
    return;
  }
  currentSong = song;
  reflectFeedbackButtons();
  if (!song) {
    songName.textContent = '—';
    songArtist.textContent = '队列空了';
    setProgressVisual(0);
    tCurrent.textContent = '0:00';
    tTotal.textContent = '0:00';
    cover.classList.remove('has-img');
    cover.style.removeProperty('--cover-url');
    setLyrics([]);
    return;
  }
  songName.textContent = song.song;
  songArtist.textContent = song.artist;

  // 封面
  if (song.picUrl) {
    cover.style.setProperty('--cover-url', `url("${song.picUrl}")`);
    cover.classList.add('has-img');
  } else {
    cover.classList.remove('has-img');
    cover.style.removeProperty('--cover-url');
  }

  // 歌词 — 异步拉,不阻塞
  if (song.id) loadLyrics(song.id, song.source);
  else setLyrics([]);
}

// ============================================
// 7. 歌词
// ============================================
// 多 loadLyrics 并发时,只让最新的那次落地,
// 防止旧歌的 fetch 慢回来覆盖新歌的空歌词
let _lyricLoadId = 0;
async function loadLyrics(songId, source) {
  const myId = ++_lyricLoadId;
  try {
    const path = source ? `/api/lyric/${source}/${songId}` : `/api/lyric/${songId}`;
    const res = await fetch(path);
    const data = await res.json();
    if (myId !== _lyricLoadId) return;     // 已被新的 load 取代
    setLyrics(parseLrc(data.lyric || ''));
  } catch (e) {
    if (myId !== _lyricLoadId) return;
    console.warn('[lyrics] 拿不到:', e.message);
    setLyrics([]);
  }
}

// 元信息行: 作词/作曲/编曲/制作人/BPM/风格/KEY 等
// QQ 的 LRC 还用 "词:" "曲:" 短前缀,也得抓
const META_RE = /^\s*(作词|作曲|编曲|词|曲|编|制作人|监制|混音|母带|和声|和音|合声|录音|演奏|吉他|贝斯|贝司|鼓|键盘|弦乐|出品|发行|厂牌|曲风|风格|BPM|KEY|TIME|TEMPO|TUNING|MUSIC|LYRICS|PRODUCER|MIXING|MASTERING|BASS|GUITAR|DRUMS)\s*[:：]/i;

function isMetaLine(text) {
  if (META_RE.test(text)) return true;
  // 形如 "G major" "120 BPM" 单独一行的纯标签也滤掉
  if (/^\s*\d+\s*(bpm|key)\s*$/i.test(text)) return true;
  return false;
}

// LRC 解析: [mm:ss.xx] 文本; 纯文本兜底成 t=-1
function parseLrc(raw) {
  if (!raw) return [];
  const lines = raw.split('\n');
  const out = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  let timed = 0;
  for (const line of lines) {
    const text = line.replace(re, '').trim();
    if (!text) continue;
    if (isMetaLine(text)) continue;       // 跳过元信息
    let m;
    re.lastIndex = 0;
    let matched = false;
    while ((m = re.exec(line)) !== null) {
      matched = true;
      timed++;
      const min = +m[1];
      const sec = +m[2];
      const ms = m[3] ? +`0.${m[3]}` : 0;
      out.push({ t: min * 60 + sec + ms, text });
    }
    if (!matched) out.push({ t: -1, text });
  }
  if (timed === 0) return out;             // 纯文本模式
  return out.filter(o => o.t >= 0).sort((a, b) => a.t - b.t);
}

function setLyrics(arr) {
  lyrics = arr;
  currentLyricIndex = -1;
  lyricsTrack.innerHTML = '';
  const win = lyricsTrack.parentElement;
  if (win) win.scrollTop = 0;
  if (!arr.length) {
    cardLyrics.hidden = true;
    return;
  }
  cardLyrics.hidden = false;
  arr.forEach((l, i) => {
    const div = document.createElement('div');
    div.className = 'line';
    if (l.t < 0) div.classList.add('unsynced');
    div.textContent = l.text;
    div.dataset.idx = String(i);
    // 双击 → seek 到这一行的时间戳 (有时间戳的才行)
    if (l.t >= 0) {
      div.addEventListener('dblclick', () => {
        if (audio.duration) {
          audio.currentTime = l.t;
          syncLyrics(l.t);
          // 双击后立即归位 (用户主动定位)
          _userControlling = false;
          autoScrollToCurrent();
        }
      });
    }
    lyricsTrack.appendChild(div);
  });
  if (arr.some(l => l.t >= 0)) highlightLyric(0);
  else lyricsTrack.firstElementChild?.classList.add('current');
}

function syncLyrics(t) {
  if (!lyrics.length) return;
  // 纯文本模式 (全部 t<0) 不同步
  if (!lyrics.some(l => l.t >= 0)) return;
  let idx = -1;
  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].t >= 0 && lyrics[i].t <= t) idx = i;
    else if (lyrics[i].t > t) break;
  }
  if (idx !== currentLyricIndex) highlightLyric(idx);
}

function highlightLyric(idx) {
  const lines = lyricsTrack.children;
  if (currentLyricIndex >= 0 && lines[currentLyricIndex]) {
    lines[currentLyricIndex].classList.remove('current');
  }
  if (idx >= 0 && lines[idx]) {
    lines[idx].classList.add('current');
  }
  currentLyricIndex = idx;
  // 自动滚到当前 — 用户手动看的时候不打扰
  if (!_userControlling) autoScrollToCurrent();
}

// 把当前高亮行滚到窗口中心 (用 scrollTop, 不再依赖 transform/margin)
function autoScrollToCurrent() {
  const cur = lyricsTrack.querySelector('.line.current');
  if (!cur) return;
  const win = lyricsTrack.parentElement;
  if (!win) return;
  const target = cur.offsetTop - win.clientHeight / 2 + cur.offsetHeight / 2;
  _suppressScrollListener = true;
  win.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  // 平滑滚动需要点时间, 等 600ms 再放开 listener
  clearTimeout(_suppressTimer);
  _suppressTimer = setTimeout(() => { _suppressScrollListener = false; }, 600);
}

// —— 用户手动滚动检测 ——
let _userControlling = false;
let _returnTimer = null;
let _suppressScrollListener = false;
let _suppressTimer = null;

(function bindLyricsManualScroll() {
  const win = lyricsTrack.parentElement;
  if (!win) return;
  win.addEventListener('scroll', () => {
    // 程序自己 scroll 时不算用户操作
    if (_suppressScrollListener) return;
    _userControlling = true;
    clearTimeout(_returnTimer);
    _returnTimer = setTimeout(() => {
      _userControlling = false;
      autoScrollToCurrent();
    }, 4000);
  }, { passive: true });
})();

// ============================================
// 8. 可拖动进度条
// ============================================
(function setupProgressDrag() {
  let dragging = false;

  function pctFromEvent(clientX) {
    const r = progressBar.getBoundingClientRect();
    const p = (clientX - r.left) / r.width;
    return Math.max(0, Math.min(1, p));
  }

  function setProgressFromPct(p) {
    setProgressVisual(p);
    if (audio.duration && isFinite(audio.duration)) {
      audio.currentTime = audio.duration * p;
      syncLyrics(audio.currentTime);
    }
    tCurrent.textContent = fmtTime((audio.duration || 0) * p);
  }

  progressBar.addEventListener('pointerdown', (e) => {
    if (!audio.duration) return;
    dragging = true;
    progressBar.classList.add('dragging');
    progressBar.setPointerCapture(e.pointerId);
    setProgressFromPct(pctFromEvent(e.clientX));
  });
  progressBar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setProgressVisual(pctFromEvent(e.clientX));
    tCurrent.textContent = fmtTime((audio.duration || 0) * pctFromEvent(e.clientX));
  });
  progressBar.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    setProgressFromPct(pctFromEvent(e.clientX));
    dragging = false;
    progressBar.classList.remove('dragging');
    try { progressBar.releasePointerCapture(e.pointerId); } catch {}
  });
  progressBar.addEventListener('pointercancel', () => {
    dragging = false;
    progressBar.classList.remove('dragging');
  });

  // 键盘: 左右箭头 ±5s
  progressBar.addEventListener('keydown', (e) => {
    if (!audio.duration) return;
    if (e.key === 'ArrowLeft') {
      audio.currentTime = Math.max(0, audio.currentTime - 5);
    } else if (e.key === 'ArrowRight') {
      audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    }
  });
})();

function setProgressVisual(p) {
  const pct = Math.max(0, Math.min(1, p)) * 100;
  progressFill.style.width = pct + '%';
  progressThumb.style.left = pct + '%';
}

// ============================================
// utils
// ============================================
function fmtTime(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && document.activeElement === chatInput) {
    chatForm.requestSubmit();
  }
});

// ============================================
// 9. 鼠标动效: 聚光 + 水波纹 + 点击涟漪 + 卡片光斑
// ============================================
(function setupCursorFx() {
  const bubbles = document.getElementById('bubbles');
  if (!bubbles) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let pendingX = window.innerWidth / 2;
  let pendingY = window.innerHeight / 3;
  let rafId = 0;
  const flushCursor = () => {
    document.body.style.setProperty('--mx', pendingX + 'px');
    document.body.style.setProperty('--my', pendingY + 'px');
    rafId = 0;
  };

  const cards = Array.from(document.querySelectorAll('.card'));
  function updateCardSpot(card, x, y) {
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--cmx', (x - rect.left) + 'px');
    card.style.setProperty('--cmy', (y - rect.top)  + 'px');
  }

  let lastX = pendingX, lastY = pendingY, lastSpawn = 0;

  function onMove(x, y) {
    pendingX = x;
    pendingY = y;
    if (!rafId) rafId = requestAnimationFrame(flushCursor);

    for (const c of cards) updateCardSpot(c, x, y);

    if (reduced) return;
    const dx = x - lastX, dy = y - lastY;
    const dist = Math.hypot(dx, dy);
    const now = performance.now();
    // 节流: 距离够远 + 间隔够长才喷一圈,慢悠悠像水滴
    if (dist > 42 && now - lastSpawn > 220) {
      spawnWave(x, y);
      lastX = x; lastY = y; lastSpawn = now;
    }
  }

  window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY), { passive: true });
  window.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; if (t) onMove(t.clientX, t.clientY);
  }, { passive: true });

  function spawnWave(x, y) {
    const w = document.createElement('div');
    w.className = 'wave';
    w.style.left = x + 'px';
    w.style.top  = y + 'px';
    bubbles.appendChild(w);
    setTimeout(() => w.remove(), 2700);
  }

  window.addEventListener('click', (e) => {
    if (reduced) return;
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = e.clientX + 'px';
    r.style.top  = e.clientY + 'px';
    bubbles.appendChild(r);
    setTimeout(() => r.remove(), 1600);
  }, { passive: true });

  flushCursor();
})();
