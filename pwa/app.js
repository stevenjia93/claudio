// ============================================
// app.js — Claudio PWA 前端逻辑
// v2: DJ 声音优先用 ElevenLabs mp3,降级才用浏览器 TTS
// ============================================

const $ = (id) => document.getElementById(id);
const audio = $('audio');               // 歌曲播放器
const djAudio = new Audio();            // 独立的 DJ 声音播放器(避免跟歌曲抢)
djAudio.preload = 'auto';

const songName = $('song-name');
const songArtist = $('song-artist');
const progressFill = $('progress-fill');
const tCurrent = $('t-current');
const tTotal = $('t-total');
const queueList = $('queue-list');
const queueCount = $('queue-count');
const djCard = $('dj-card');
const djSay = $('dj-say');
const djReason = $('dj-reason');
const chatForm = $('chat-form');
const chatInput = $('chat-input');
const chatHistory = $('chat-history');
const btnSend = $('btn-send');
const btnPlay = $('btn-play');
const btnNext = $('btn-next');
const wsPill = $('ws-pill');
const cardNow = document.querySelector('.card-now');

let currentQueue = [];
let autoPlayArmed = false;

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
      renderQueue(msg.queue || []);
      if (msg.nowPlaying) renderNowPlaying(msg.nowPlaying);
      break;
    case 'queue_update':
      renderQueue(msg.queue);
      maybeStartPlayback();
      break;
    case 'now_playing':
      renderQueue(msg.queue);
      renderNowPlaying(msg.nowPlaying);
      break;
    case 'dj_broadcast':
      renderDJ(msg.say, msg.reason);
      renderQueue(msg.queue);
      speakThenPlay(msg.say, msg.audio_url);
      break;
    case 'control':
      applyControl(msg.cmd);
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
    const data = await res.json();

    if (data.kind === 'chat') {
      appendChat('assistant', data.say, data.reason);
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
    r.style.marginTop = '6px';
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
  if (audio.paused) {
    if (audio.src) audio.play();
    else playNext();
  } else {
    audio.pause();
  }
});

btnNext.addEventListener('click', () => {
  autoPlayArmed = true;
  playNext();
});

audio.addEventListener('play', () => {
  btnPlay.textContent = '⏸';
  cardNow.classList.add('playing');
});
audio.addEventListener('pause', () => {
  btnPlay.textContent = '▶';
  cardNow.classList.remove('playing');
});
audio.addEventListener('ended', () => playNext());
audio.addEventListener('error', () => {
  console.warn('[music] 歌加载失败,跳下一首');
  playNext();
});
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  progressFill.style.width = (audio.currentTime / audio.duration) * 100 + '%';
  tCurrent.textContent = fmtTime(audio.currentTime);
  tTotal.textContent = fmtTime(audio.duration);
});

async function playNext() {
  try {
    const res = await fetch('/api/next');
    const song = await res.json();
    if (!song) {
      audio.pause();
      audio.src = '';
      renderNowPlaying(null);
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
// 4. DJ 说话 — ElevenLabs 优先,浏览器 TTS fallback
// ============================================
function speakThenPlay(text, audioUrl) {
  // 说话期间先暂停当前歌曲,说完再让队列接管
  const wasPlaying = !audio.paused;
  if (wasPlaying) audio.pause();

  const onDone = () => {
    if (autoPlayArmed) playNext();
  };

  if (audioUrl) {
    // 真人嗓音(ElevenLabs)
    djAudio.src = audioUrl;
    djAudio.onended = onDone;
    djAudio.onerror = () => {
      console.warn('[dj audio] mp3 加载失败,降级浏览器 TTS');
      speakBrowser(text, onDone);
    };
    djAudio.play().catch(err => {
      console.warn('[dj audio] play 被挡:', err.message);
      onDone();
    });
    return;
  }

  // 没有 mp3 → 回落到浏览器合成(带机器味)
  speakBrowser(text, onDone);
}

function speakBrowser(text, onDone) {
  if (!text || !('speechSynthesis' in window)) {
    setTimeout(onDone, 200);
    return;
  }
  const utter = new SpeechSynthesisUtterance(text);
  // 简单判定中英文,挑对应嗓音
  const hasChinese = /[\u4e00-\u9fff]/.test(text);
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
// 5. 控制命令(WS)
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
      audio.src = '';
      djAudio.pause();
      djAudio.src = '';
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
    li.innerHTML = `
      <span class="idx">${i + 1}.</span>
      <span class="song">${escapeHtml(item.song)}</span>
      <span class="artist">${escapeHtml(item.artist)}</span>
    `;
    queueList.appendChild(li);
  });
}

function renderNowPlaying(song) {
  if (!song) {
    songName.textContent = '—';
    songArtist.textContent = '队列空了';
    progressFill.style.width = '0%';
    tCurrent.textContent = '0:00';
    tTotal.textContent = '0:00';
    return;
  }
  songName.textContent = song.song;
  songArtist.textContent = song.artist;
}

function renderDJ(say, reason) {
  djSay.textContent = say || '';
  djReason.textContent = reason || '';
  djCard.hidden = !say;
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
// 7. 鼠标动效: aurora 追光 + 气泡轨迹 + 点击涟漪 + 卡片内光斑
// ============================================
(function setupCursorFx() {
  const bubbles = document.getElementById('bubbles');
  if (!bubbles) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const palette = ['#ff7eb6', '#b48cff', '#67d4ff', '#ffd989', '#ff9ec7'];

  // 全局 aurora 跟随
  let pendingX = window.innerWidth / 2;
  let pendingY = window.innerHeight / 3;
  let rafId = 0;
  const flushAurora = () => {
    document.body.style.setProperty('--mx', pendingX + 'px');
    document.body.style.setProperty('--my', pendingY + 'px');
    rafId = 0;
  };

  // 卡片内光斑
  const cards = Array.from(document.querySelectorAll('.card'));
  function updateCardSpot(card, x, y) {
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--cmx', (x - rect.left) + 'px');
    card.style.setProperty('--cmy', (y - rect.top)  + 'px');
  }

  // 气泡节流
  let lastX = pendingX, lastY = pendingY, lastSpawn = 0;

  function onMove(x, y) {
    pendingX = x;
    pendingY = y;
    if (!rafId) rafId = requestAnimationFrame(flushAurora);

    for (const c of cards) updateCardSpot(c, x, y);

    if (reduced) return;
    const dx = x - lastX, dy = y - lastY;
    const dist = Math.hypot(dx, dy);
    const now = performance.now();
    if (dist > 14 && now - lastSpawn > 38) {
      spawnBubble(x, y);
      lastX = x; lastY = y; lastSpawn = now;
    }
  }

  window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY), { passive: true });
  window.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; if (t) onMove(t.clientX, t.clientY);
  }, { passive: true });

  function spawnBubble(x, y) {
    const b = document.createElement('div');
    b.className = 'bubble';
    const c = palette[(Math.random() * palette.length) | 0];
    const size = 6 + Math.random() * 10;
    const drift = (Math.random() - 0.5) * 36;
    b.style.cssText =
      `left:${x + drift}px;top:${y}px;` +
      `width:${size}px;height:${size}px;` +
      `--c:${c};`;
    bubbles.appendChild(b);
    setTimeout(() => b.remove(), 1500);
  }

  // 点击涟漪 (任何位置)
  window.addEventListener('click', (e) => {
    if (reduced) return;
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = e.clientX + 'px';
    r.style.top  = e.clientY + 'px';
    bubbles.appendChild(r);
    setTimeout(() => r.remove(), 750);
  }, { passive: true });

  // 初始触发一次,让 aurora 不要从默认值跳开
  flushAurora();
})();
