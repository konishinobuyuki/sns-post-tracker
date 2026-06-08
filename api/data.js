/**
 * Vercel Serverless Function: /api/data
 *
 * ストレージ優先順位:
 *   1. Vercel KV (Upstash Redis) — 環境変数 KV_REST_API_URL / KV_REST_API_TOKEN があれば使用（高速・即時）
 *   2. GitHub Contents API — KV 未設定時のフォールバック（低速・約2.5秒）
 *
 * KV 接続後の初回 GET 時に、GitHub の現データを自動で KV へ移行（シード）する。
 *
 * GET  → 現在の sns_post_status を返す
 * POST → 受け取ったデータを保存
 *
 * KV(Upstash) 接続済み: sns-tracker-kv（KV_REST_API_URL / KV_REST_API_TOKEN）
 */

import { createHash } from 'crypto';

const GITHUB_API = 'https://api.github.com';
const FILE_PATH  = 'data/sns_post_status.json';
const KV_KEY     = 'sns_post_status';

// アクセスコードの SHA-256 ハッシュ（平文は保存しない）
const ACCESS_CODE_SHA256 =
  process.env.ACCESS_CODE_SHA256 ||
  '46c6ab05252534c033fec735f20f1af651fa53ebb8fe3a26e814ea7a04d65b8b';

function sha256(s) { return createHash('sha256').update(String(s)).digest('hex'); }

function isAuthorized(req) {
  if (!ACCESS_CODE_SHA256) return true;
  const code = req.headers['x-access-code'] || (req.query && req.query.code) || '';
  if (!code) return false;
  return sha256(code) === ACCESS_CODE_SHA256;
}

// ── Vercel KV (Upstash REST) ───────────────────────────────────────────
function kvEnabled() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}
async function kvCommand(cmd) {
  const res = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error('KV error: ' + (j.error || res.status));
  return j.result;
}
async function kvGet() {
  const r = await kvCommand(['GET', KV_KEY]);
  return r ? JSON.parse(r) : null;
}
async function kvSet(obj) {
  await kvCommand(['SET', KV_KEY, JSON.stringify(obj)]);
}

// ── GitHub ─────────────────────────────────────────────────────────────
function getGitEnv() {
  const token  = process.env.GITHUB_TOKEN;
  const owner  = process.env.GITHUB_OWNER;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !owner || !repo) {
    throw new Error('環境変数 GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO が未設定です');
  }
  return { token, owner, repo, branch };
}
async function ghFetch(path, options = {}, token) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  return { status: res.status, body: await res.json() };
}
async function githubRead() {
  const { token, owner, repo, branch } = getGitEnv();
  const apiPath = `/repos/${owner}/${repo}/contents/${FILE_PATH}`;
  const { status, body } = await ghFetch(`${apiPath}?ref=${branch}`, {}, token);
  if (status !== 200) throw new Error(body.message || `GitHub GET ${status}`);
  return JSON.parse(Buffer.from(body.content, 'base64').toString('utf-8'));
}
async function githubWrite(data) {
  const { token, owner, repo, branch } = getGitEnv();
  const apiPath = `/repos/${owner}/${repo}/contents/${FILE_PATH}`;
  const { status: getStatus, body: current } = await ghFetch(`${apiPath}?ref=${branch}`, {}, token);
  if (getStatus !== 200) throw new Error(current.message || `GitHub GET ${getStatus}`);
  const encoded = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const { status: putStatus, body: putResult } = await ghFetch(apiPath, {
    method: 'PUT',
    body: JSON.stringify({
      message: `chore: update SNS status (${data.lastUpdated})`,
      content: encoded, sha: current.sha, branch,
    }),
  }, token);
  if (putStatus !== 200 && putStatus !== 201) throw new Error(putResult.message || `GitHub PUT ${putStatus}`);
}

function stampNow(data) {
  data.lastUpdated = new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return data;
}

// ── ハンドラ ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-access-code');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'アクセスコードが正しくありません' });
  }

  try {
    // ── GET ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      let data;
      if (kvEnabled()) {
        data = await kvGet();
        if (!data) {                       // 初回: GitHub から KV へ移行
          try { data = await githubRead(); } catch (e) {
            data = { driveFolder: '', driveFolderUrl: '', lastUpdated: '', lastSynced: '', videos: [] };
          }
          await kvSet(data);
        }
      } else {
        data = await githubRead();
      }
      return res.status(200).json(data);
    }

    // ── POST ─────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      let data = req.body;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) {} }
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ ok: false, error: 'リクエストボディが不正です' });
      }
      stampNow(data);
      if (kvEnabled()) {
        await kvSet(data);                 // 高速保存（約50〜150ms）
      } else {
        await githubWrite(data);           // フォールバック（約2.5秒）
      }
      return res.status(200).json({ ok: true, lastUpdated: data.lastUpdated, storage: kvEnabled() ? 'kv' : 'github' });
    }

    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
