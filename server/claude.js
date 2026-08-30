// claude.js — 大脑适配器
// 三种模式(CLAUDIO_BRAIN 显式指定优先,否则按 key 自动选):
//   1. codex 模式(CLAUDIO_BRAIN=codex): spawn codex exec,走 ChatGPT/Codex 会员订阅
//   2. API 模式(ANTHROPIC_API_KEY 存在): 调 api.anthropic.com
//   3. CLI 模式(fallback): spawn claude -p --output-format json
//
// 如果设了 HTTPS_PROXY,走 node-fetch + https-proxy-agent(避开 undici 坑)

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDIO_MODEL || 'claude-sonnet-4-5-20250929';
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

// 大脑选择: 'codex' 走 Codex 会员订阅; 其余按 API_KEY 自动判断
const BRAIN = (process.env.CLAUDIO_BRAIN || '').toLowerCase();
const CODEX_REASONING = process.env.CODEX_REASONING || 'medium';
const CODEX_MODEL = process.env.CODEX_MODEL; // 留空用 codex 默认模型
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 120_000);

// 代理 agent
const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;
if (PROXY) {
  console.log(`[claude] 走代理 ${PROXY}`);
}

export async function invoke(prompt) {
  if (BRAIN === 'codex') {
    return invokeCodex(prompt);
  }
  if (API_KEY) {
    return invokeApi(prompt);
  }
  return invokeCli(prompt);
}

// 间奏报幕: 同一个 API, max_tokens 砍小, 只要 say 字段
export async function invokeIntro(prompt) {
  if (BRAIN === 'codex') {
    const r = await invokeCodex(prompt);
    return { say: r.say || '' };
  }
  if (!API_KEY) {
    // CLI 模式不太适合短调用,直接返空让客户端 fallback 浏览器 TTS
    return { say: '' };
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }]
    }),
    agent
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`API ${r.status}: ${err.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = data.content?.map(c => c.text || '').join('') || '';
  const inner = extractJson(text);
  return { say: inner.say || '' };
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

// ——— 路线 3: codex 子进程(走 ChatGPT/Codex 会员订阅)———
// codex exec 是非交互模式;--output-last-message 把最终消息落到临时文件,
// 读出来再 extractJson。隔离在临时目录跑,避免 codex 把 claudio 项目文件读进上下文。
//
// codex 冷启动有已知瞬态病: 卡在模型列表刷新后 exit 0 但一个字没写
// (2026-07-09 首次调用复现过一回, 07-05 也卡过 5 分钟)。所以:
//   - out 文件空时先从 stdout 兜底 (exec 模式最终消息也会流到 stdout)
//   - 还是空 → 重试一次; 挂死超过 CODEX_TIMEOUT_MS 也杀掉算一次失败
async function invokeCodex(prompt) {
  try {
    return await invokeCodexOnce(prompt);
  } catch (e) {
    if (!e.retryable) throw e;
    console.warn('[claude] codex 空手而归, 重试一次:', e.message.slice(0, 200));
    return invokeCodexOnce(prompt);
  }
}

async function invokeCodexOnce(prompt) {
  const dir = await mkdtemp(join(tmpdir(), 'claudio-codex-'));
  const outFile = join(dir, 'out.txt');
  const args = [
    'exec',
    '--ephemeral',            // 不持久化会话
    '--skip-git-repo-check',  // 临时目录不是 git 仓库
    '--ignore-user-config',   // 跳过 ~/.codex/config.toml(避开无关 MCP 噪音);auth 仍生效
    '-s', 'read-only',        // 只读沙箱
    '-c', `model_reasoning_effort=${CODEX_REASONING}`,
    '-o', outFile,
  ];
  if (CODEX_MODEL) args.push('-m', CODEX_MODEL);
  args.push('-');             // prompt 从 stdin 读

  return new Promise((resolve, reject) => {
    const proc = spawn('codex', args, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, CODEX_TIMEOUT_MS);

    proc.on('error', err => {
      clearTimeout(timer);
      rm(dir, { recursive: true, force: true }).catch(() => {});
      if (err.code === 'ENOENT') {
        return reject(new Error(
          'codex CLI 没找到。装一下(brew install codex)或把 CLAUDIO_BRAIN 改掉。'
        ));
      }
      reject(err);
    });

    proc.on('close', async code => {
      clearTimeout(timer);
      let text = '';
      try { text = await readFile(outFile, 'utf8'); } catch {}
      rm(dir, { recursive: true, force: true }).catch(() => {});

      // out 文件空 → stdout 兜底 (exec 模式会把最终消息流到 stdout)
      if (!text.trim()) text = stdout;

      if (!text.trim()) {
        // banner + prompt 回显在 stderr 开头, 有用的错误在尾部 → 取尾不取头
        const err = new Error(
          `codex 无输出 (exit=${code}${timedOut ? ', 超时被杀' : ''}): ` +
          `…${stderr.slice(-400).trim() || '(stderr 也空)'}`
        );
        err.retryable = true;
        return reject(err);
      }

      const inner = extractJson(text);
      resolve({
        say: inner.say || '',
        play: Array.isArray(inner.play) ? inner.play : [],
        reason: inner.reason || '',
        segue: inner.segue || '',
        _raw: text
      });
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
