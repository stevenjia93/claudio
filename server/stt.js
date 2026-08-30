// stt.js — 语音识别 (ElevenLabs Scribe)
// 复用 TTS 同一个 API key; 手机/车上"对 DJ 说话"的后端半边

import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const API_KEY = process.env.ELEVENLABS_API_KEY;
const MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;

/**
 * 录音 → 文字
 * @param {Buffer} audio - 录音原始字节 (webm/mp4/m4a 都吃)
 * @param {string} mimeType - 录音的 MIME 类型, 如 'audio/webm'
 * @returns {Promise<string>} 识别出的文本 (可能为空串 = 没听到话)
 */
export async function transcribe(audio, mimeType) {
  if (!API_KEY) {
    throw new Error('ELEVENLABS_API_KEY 没配, 语音识别用不了');
  }

  const form = new FormData();
  form.append('model_id', MODEL);
  form.append('file', new Blob([audio], { type: mimeType }), `voice.${extOf(mimeType)}`);

  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY },
    body: form,
    agent,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs STT ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}

function extOf(mimeType) {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}
