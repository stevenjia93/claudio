// claude.js — 大脑适配器
// 两种模式:
//   1. API 模式(ANTHROPIC_API_KEY 存在): 调 api.anthropic.com
//   2. CLI 模式(fallback): spawn claude -p --output-format json
//
// 如果设了 HTTPS_PROXY,走 node-fetch + https-proxy-agent(避开 undici 坑)

import { spawn } from 'node:child_process';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDIO_MODEL || 'claude-sonnet-4-5-20250929';
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

// 代理 agent
const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;
if (PROXY) {
  console.log(`[claude] 走代理 ${PROXY}`);
}

export async function invoke(prompt) {
  if (API_KEY) {
    return invokeApi(prompt);
  }
  return invokeCli(prompt);
}

// ——— 路线 1: 直接调 API ———
async function invokeApi(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    }),
    agent
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`API ${r.status}: ${err.slice(0, 300)}`);
  }

  const data = await r.json();
  const text = data.content?.map(c => c.text || '').join('') || '';
  const inner = extractJson(text);

  return {
    say: inner.say || '',
    play: Array.isArray(inner.play) ? inner.play : [],
    reason: inner.reason || '',
    segue: inner.segue || '',
    _raw: text,
    _usage: data.usage
  };
}

// ——— 路线 2: CLI 子进程(保留做 fallback)———
function invokeCli(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        return reject(new Error(
          'claude CLI 没找到,并且没设 ANTHROPIC_API_KEY。'
        ));
      }
      reject(err);
    });

    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`claude 子进程退出 ${code}: ${stderr.slice(0, 500)}`));
      }
      try {
        const outer = JSON.parse(stdout);
        const text = outer.result || outer.response || stdout;
        const inner = extractJson(text);
        resolve({
          say: inner.say || '',
          play: Array.isArray(inner.play) ? inner.play : [],
          reason: inner.reason || '',
          segue: inner.segue || '',
          _raw: text
        });
      } catch (e) {
        reject(new Error(`解析 claude 输出失败: ${e.message}\n原始: ${stdout.slice(0, 500)}`));
      }
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// 从文本里捞 JSON
function extractJson(text) {
  try { return JSON.parse(text); } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }

  return { say: text.trim(), play: [], reason: '(未能解析 JSON)', segue: '' };
}

export function mockInvoke() {
  return Promise.resolve({
    say: '(mock 模式) 今晚的风有点凉,给你放点柔和的。',
    play: ['晴天 - 周杰伦', '起风了 - 买辣椒也用券', 'Vincent - Don McLean'],
    reason: 'mock 模式',
    segue: '听完这三首我们再聊。'
  });
}
