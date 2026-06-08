/**
 * Vercel Serverless Function: /api/data
 * GET  -> GitHub から sns_post_status.json を取得して返す
 * POST -> 受け取ったデータを GitHub へコミット保存
 */

const GITHUB_API  = 'https://api.github.com';
const FILE_PATH   = 'data/sns_post_status.json';

function getEnv() {
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
  const res = await fetch(GITHUB_API + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  return { status: res.status, body: await res.json() };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let env;
  try { env = getEnv(); } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  const { token, owner, repo, branch } = env;
  const apiPath = '/repos/' + owner + '/' + repo + '/contents/' + FILE_PATH;

  if (req.method === 'GET') {
    const { status, body } = await ghFetch(apiPath + '?ref=' + branch, {}, token);
    if (status !== 200) {
      return res.status(status).json({ ok: false, error: body.message });
    }
    const data = JSON.parse(Buffer.from(body.content, 'base64').toString('utf-8'));
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate');
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { status: getStatus, body: current } = await ghFetch(
      apiPath + '?ref=' + branch, {}, token
    );
    if (getStatus !== 200) {
      return res.status(getStatus).json({ ok: false, error: current.message });
    }

    const data = req.body;
    data.lastUpdated = new Date().toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    const encoded = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');

    const { status: putStatus, body: putResult } = await ghFetch(apiPath, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'chore: update SNS status (' + data.lastUpdated + ')',
        content: encoded,
        sha: current.sha,
        branch,
      }),
    }, token);

    if (putStatus !== 200 && putStatus !== 201) {
      return res.status(putStatus).json({ ok: false, error: putResult.message });
    }
    return res.status(200).json({ ok: true, lastUpdated: data.lastUpdated });
  }

  return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
}
