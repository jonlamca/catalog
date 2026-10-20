// GitLab for the catalog editor: a REST client, the editor's dropdown lookups, and browser sign-in (PKCE).
// gitlab() and lookups() only need fetch and a token, so a VS Code extension host can reuse them with its own sign-in.
// Sign-in: OAuth 2.0 authorization code with PKCE (public client, no secret). Tokens live in sessionStorage only.

import { nameFromSlug } from './catalog.js'

const enc = encodeURIComponent

/** A GitLab REST client. token: () => access token (string or promise). */
export function gitlab(url, token) {
  async function req(path, init = {}) {
    const res = await fetch(`${url}/api/v4${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...init.headers },
    })
    if (res.status === 404 && (init.method ?? 'GET') === 'GET') return null
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      const msg = typeof body.message === 'string' ? body.message : JSON.stringify(body.message ?? body.error ?? res.statusText)
      throw Object.assign(new Error(`GitLab: ${msg} (${res.status})`), { status: res.status })
    }
    return res.status === 204 ? null : res.json()
  }
  const p = id => `/projects/${enc(id)}`
  return {
    req,
    user: () => req('/user'),
    // Projects you can push a branch to (Developer and up)
    projects: (q = '') => req(`/projects?membership=true&min_access_level=30&simple=true&order_by=last_activity_at&per_page=50&search_namespaces=true&search=${enc(q)}`),
    project: id => req(p(id)),
    branches: (id, q = '') => req(`${p(id)}/repository/branches?per_page=100&search=${enc(q)}`),
    branch: (id, name) => req(`${p(id)}/repository/branches/${enc(name)}`),
    /** A file's text, or null when it does not exist on that ref */
    async file(id, path, ref) {
      const f = await req(`${p(id)}/repository/files/${enc(path)}?ref=${enc(ref)}`)
      return f && new TextDecoder().decode(Uint8Array.from(atob(f.content), c => c.charCodeAt(0)))
    },
    commit: (id, body) => req(`${p(id)}/repository/commits`, { method: 'POST', body: JSON.stringify(body) }),
    openMergeRequest: async (id, source) => (await req(`${p(id)}/merge_requests?state=opened&source_branch=${enc(source)}`))?.[0] ?? null,
    createMergeRequest: (id, body) => req(`${p(id)}/merge_requests`, { method: 'POST', body: JSON.stringify(body) }),
    members: id => req(`${p(id)}/members/all?per_page=100`),
    projectGroups: id => req(`${p(id)}/groups?per_page=100`),          // the project's ancestor groups
    groups: (q = '') => req(`/groups?all_available=true&per_page=50&order_by=similarity&search=${enc(q)}`),
    users: (q = '') => req(`/users?active=true&per_page=20&search=${enc(q)}`),
    topics: (q = '') => req(`/topics?per_page=50&search=${enc(q)}`),
  }
}

/**
 * The editor's lookup(source, query) for one project: owners (GitLab groups and users) and tags (GitLab topics).
 * Names follow Backstage's GitLab org provider: a group is nameFromSlug(full path), a user is the username.
 * orgGroup: the provider's `group` prefix, stripped from names.
 */
export function lookups(gl, project, orgGroup = '') {
  const groupName = g => nameFromSlug(g.full_path, orgGroup)
  const groups = async q => (await (q ? gl.groups(q) : gl.projectGroups(project.id)) ?? [])
    .map(g => ({ value: `group:${groupName(g)}`, label: g.full_path }))
  const users = async q => (await (q ? gl.users(q) : gl.members(project.id)) ?? [])
    .map(u => ({ value: `user:${u.username}`, label: u.name }))
  const tag = t => t.toLowerCase().replace(/[^a-z0-9:+#]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
  return async (source, q) => {
    if (source === 'owner') return (await Promise.all([groups(q), users(q)])).flat()
    if (source === 'tag') {
      const topics = [...(q ? [] : project.topics ?? []), ...(await gl.topics(q) ?? []).map(t => t.name)]
      return [...new Set(topics.map(tag).filter(Boolean))].map(value => ({ value }))
    }
    return []
  }
}

// ---------------------------------------------------------------- browser sign-in (PKCE)
// cfg: { url, clientId }. The redirect URI is this page's folder address; register it on the OAuth application.
const KEY = { tokens: 'catalog-editor:tokens', pkce: 'catalog-editor:pkce' }
const store = {
  get: k => { try { return JSON.parse(sessionStorage.getItem(k) ?? 'null') } catch { return null } },
  set: (k, v) => sessionStorage.setItem(k, JSON.stringify(v)),
  del: k => sessionStorage.removeItem(k),
}
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '')
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)))
const sha256 = async s => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))

export async function signIn(cfg) {
  const verifier = random(48), state = random(16)
  store.set(KEY.pkce, { verifier, state, hash: location.hash })
  location.assign(`${cfg.url}/oauth/authorize?${new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: 'api', state,
    code_challenge: await sha256(verifier), code_challenge_method: 'S256',
  })}`)
}

/** Run once at start-up: finishes a sign-in when GitLab has redirected back with ?code=… */
export async function completeSignIn(cfg) {
  const q = new URLSearchParams(location.search)
  const code = q.get('code'), pkce = store.get(KEY.pkce)
  if (!code && !q.get('error')) return
  store.del(KEY.pkce)
  history.replaceState(null, '', location.pathname + (pkce?.hash ?? ''))
  if (q.get('error')) throw new Error(`GitLab sign-in: ${q.get('error_description') ?? q.get('error')}`)
  if (!pkce || q.get('state') !== pkce.state) return // a forged or stale redirect
  await tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: pkce.verifier })
}

async function tokenRequest(cfg, params) {
  const r = await fetch(`${cfg.url}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...params }),
  })
  if (!r.ok) { store.del(KEY.tokens); throw new Error(`GitLab sign-in failed (${r.status})`) }
  const t = await r.json()
  store.set(KEY.tokens, { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in ?? 7200) * 1000 })
}

export const isSignedIn = () => store.get(KEY.tokens) !== null

/** A token function for gitlab(): refreshes the access token when it is about to expire */
export const accessToken = cfg => async () => {
  const t = store.get(KEY.tokens)
  if (!t) throw new Error('Not signed in to GitLab')
  if (t.expires_at - Date.now() > 60_000) return t.access_token
  await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: t.refresh_token })
  return store.get(KEY.tokens).access_token
}

export async function signOut(cfg) {
  const t = store.get(KEY.tokens)
  store.del(KEY.tokens)
  if (t) {
    await fetch(`${cfg.url}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, token: t.access_token }),
    }).catch(() => {})
  }
}
