#!/usr/bin/env node
// netease-auth.js — 一次性 NeteaseCloudMusicApi 扫码登录
//
// 用法:
//   1. 先确认 NCM API 在 :3000 跑着 (./start.sh 或 npx NeteaseCloudMusicApi)
//   2. node scripts/netease-auth.js
//   3. Preview 自动开二维码 → 手机网易云 APP 扫一扫 → 确认
//   4. 脚本把 cookie 写到 state/netease-cookie.json (gitignored)
//   5. 重启 ./start.sh, server 启动日志看到 "[netease] cookie 加载 ✓"
//
// cookie 一般几个月有效, 失效了重跑一次本脚本就行.

import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.dirname(path.dirname(__filename));
const COOKIE_FILE = path.join(PROJECT_ROOT, 'state', 'netease-cookie.json');
const NCM_BASE = process.env.NCM_BASE || 'http://localhost:3000';

// 检查 NCM API 在跑
async function ensureNcm() {
  try {
    const r = await fetch(`${NCM_BASE}/search?keywords=test&limit=1`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(`✗ NCM API 在 ${NCM_BASE} 不可达 (${e.message})`);
    console.error('  请先跑 ./start.sh 或 `npx NeteaseCloudMusicApi`, 再重跑本脚本');
    process.exit(1);
  }
}

async function getUnikey() {
  const r = await fetch(`${NCM_BASE}/login/qr/key?timestamp=${Date.now()}`);
  const d = await r.json();
  if (!d?.data?.unikey) throw new Error('拿 unikey 挂了, 看 NCM 是不是健康');
  return d.data.unikey;
}

async function getQrPng(key) {
  const r = await fetch(`${NCM_BASE}/login/qr/create?key=${key}&qrimg=true&timestamp=${Date.now()}`);
  const d = await r.json();
  if (!d?.data?.qrimg) throw new Error('NCM 没返回 qrimg');
  const b64 = d.data.qrimg.split(',')[1];
  return Buffer.from(b64, 'base64');
}

// 轮询直到登录成 / 二维码过期 / 总超时
async function pollLogin(key, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastCode = -1;
  while (Date.now() < deadline) {
    const r = await fetch(`${NCM_BASE}/login/qr/check?key=${key}&timestamp=${Date.now()}`);
    const d = await r.json();
    if (d.code !== lastCode) {
      const label = {
        800: '二维码已过期',
        801: '等待扫码',
        802: '已扫码, 等手机点确认',
        803: '登录成功 ✓',
      }[d.code] || `unknown(${d.code})`;
      console.log(`  · ${label}`);
      lastCode = d.code;
    }
    if (d.code === 803) return d.cookie || '';
    if (d.code === 800) throw new Error('二维码过期了, 请重跑本脚本');
    await new Promise(res => setTimeout(res, 1500));
  }
  throw new Error('超时 (90s), 没扫码');
}

// NCM 返的 cookie 是 Set-Cookie 串拼起来的 (含 Max-Age, Expires, Path 等元属性),
// 直接发给后续请求会被 NCM 当垃圾忽略. 提取 key=value 形态.
function cleanCookie(raw) {
  const parts = raw.split(';').map(s => s.trim()).filter(Boolean);
  const dedup = {};   // 同 key 留最后一个
  for (const p of parts) {
    const k = p.split('=')[0];
    if (!k) continue;
    if (/^(Max-Age|Expires|Path|HttpOnly|Domain|Secure|SameSite)$/i.test(k)) continue;
    const v = p.slice(k.length + 1);
    dedup[k] = v;
  }
  return Object.entries(dedup).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchAccountInfo(cookie) {
  const r = await fetch(`${NCM_BASE}/user/account?timestamp=${Date.now()}`, {
    headers: { Cookie: cookie },
  });
  const d = await r.json();
  return {
    userId: d?.account?.id,
    nickname: d?.profile?.nickname,
    vipType: d?.account?.vipType,
  };
}

async function main() {
  await ensureNcm();
  console.log(`▸ NCM 在 ${NCM_BASE}`);

  const key = await getUnikey();
  const png = await getQrPng(key);

  const qrPath = '/tmp/ncm-qr.png';
  await fs.writeFile(qrPath, png);
  spawn('open', [qrPath], { detached: true, stdio: 'ignore' }).unref();

  console.log(`▸ 二维码: ${qrPath} (Preview 应该自动打开了)`);
  console.log('▸ 网易云 APP → 我的 → 右上角扫一扫 → 扫这个 → 确认登录');
  console.log('▸ 等你扫 (90s 内)...');

  const rawCookie = await pollLogin(key);
  const cleaned = cleanCookie(rawCookie);

  const info = await fetchAccountInfo(cleaned);
  if (info.userId === undefined) {
    throw new Error('cookie 拿到了但 /user/account 验证失败. NCM 可能版本不对');
  }
  console.log(`✓ 登录成: ${info.nickname || '(no nickname)'}, id ${info.userId}, vipType ${info.vipType}`);

  await fs.mkdir(path.dirname(COOKIE_FILE), { recursive: true });
  await fs.writeFile(
    COOKIE_FILE,
    JSON.stringify(
      {
        cookie: cleaned,
        savedAt: new Date().toISOString(),
        userId: info.userId,
        nickname: info.nickname,
        vipType: info.vipType,
      },
      null,
      2
    )
  );
  console.log(`✓ 写入 ${COOKIE_FILE}`);
  console.log('▸ 重启 ./start.sh 让 server 读到');
}

main().catch(e => {
  console.error('✗', e.message);
  process.exit(1);
});
