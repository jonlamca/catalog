// GitLab: a small API client, the editor's dropdown data, and sign-in from the browser (OAuth with PKCE: no secret,
// no server; the token stays in this tab's sessionStorage). gitlab() and lookups() only need fetch and a token,
// so a VS Code extension can reuse them with its own sign-in.
import { nameFromSlug } from './catalog.js'

const enc = encodeURIComponent

/** A client for GitLab at url. token: () => an access token, or a promise of one. */
export function gitlab(url, token) {
  // GET without a body, POST with one. Returns JSON or text; a GET that finds nothing returns null.
  async function call(path, body) {
    const res = await fetch(`${url}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${await token()}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    })
    if (res.status === 404 && !body) return null
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
    if (!res.ok) {
      const msg = data?.message ?? data?.error ?? res.statusText
      throw new Error(`GitLab: ${typeof msg === 'string' ? msg : JSON.stringify(msg)} (${res.status})`)
    }
    return data
  }
  const project = id => `/v4/projects/${enc(id)}`

  return {
    user: () => call('/v4/user'),
    projects: (q = '') => call(`/v4/projects?membership=true&min_access_level=30&simple=true&order_by=last_activity_at&per_page=50&search_namespaces=true&search=${enc(q)}`),
    project: id => call(project(id)),
    branches: id => call(`${project(id)}/repository/branches?per_page=100`),
    branch: (id, name) => call(`${project(id)}/repository/branches/${enc(name)}`),
    file: (id, path, ref) => call(`${project(id)}/repository/files/${enc(path)}/raw?ref=${enc(ref)}`),   // text, or null
    commit: (id, body) => call(`${project(id)}/repository/commits`, body),
    openMergeRequest: async (id, branch) => (await call(`${project(id)}/merge_requests?state=opened&source_branch=${enc(branch)}`))?.[0] ?? null,
    createMergeRequest: (id, body) => call(`${project(id)}/merge_requests`, body),
    members: id => call(`${project(id)}/members/all?per_page=100`),
    projectGroups: id => call(`${project(id)}/groups?per_page=100`),
    groups: (q = '') => call(`/v4/groups?all_available=true&per_page=50&search=${enc(q)}`),
    users: (q = '') => call(`/v4/users?active=true&per_page=20&search=${enc(q)}`),
    topics: (q = '') => call(`/v4/topics?per_page=50&search=${enc(q)}`),

    /**
     * Every unarchived project in a group and its subgroups (no group: the projects you are a member of), with the
     * text of catalog-info.yaml on its default branch, or null. GraphQL, a page of projects per request; the page
     * halves if GitLab finds the query too complex.
     */
    async catalogFiles(group, onProgress) {
      const list = group ? 'group(fullPath: $group) { projects(includeSubgroups: true, first: $first, after: $after) { ...page } }'
        : 'projects(membership: true, first: $first, after: $after) { ...page }'
      const query = `query(${group ? '$group: ID!, ' : ''}$first: Int!, $after: String) { ${list} }
        fragment page on ProjectConnection { pageInfo { hasNextPage endCursor }
          nodes { fullPath name webUrl archived repository { blobs(paths: ["catalog-info.yaml"]) { nodes { rawTextBlob } } } } }`
      const out = []
      for (let after = null, first = 50; ;) {
        const { data, errors } = await call('/graphql', { query, variables: { first, after, ...(group && { group }) } })
        if (errors) {
          if (/complexity/i.test(errors[0].message) && first > 5) { first = Math.ceil(first / 2); continue }
          throw new Error(`GitLab: ${errors[0].message}`)
        }
        const page = group ? data.group?.projects : data.projects
        if (!page) throw new Error(`GitLab: no group ${group}, or you cannot see it`)
        for (const n of page.nodes) {
          if (!n.archived) out.push({ path: n.fullPath, name: n.name, url: n.webUrl, text: n.repository?.blobs?.nodes?.[0]?.rawTextBlob ?? null })
        }
        onProgress?.(out.length)
        if (!page.pageInfo.hasNextPage) return out
        after = page.pageInfo.endCursor
      }
    },
  }
}

/**
 * The editor's dropdown data for one project: lookup(source, query) for 'owner' (GitLab groups and users) and 'tag'
 * (GitLab topics). Groups are named as Backstage's GitLab org provider names them, minus its group prefix (orgGroup).
 */
export function lookups(gl, project, orgGroup = '') {
  const tag = t => t.toLowerCase().replace(/[^a-z0-9:+#]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
  return async (source, q) => {
    if (source === 'owner') {
      const [groups, users] = await Promise.all([q ? gl.groups(q) : gl.projectGroups(project.id), q ? gl.users(q) : gl.members(project.id)])
      return [...(groups ?? []).map(g => ({ value: `group:${nameFromSlug(g.full_path, orgGroup)}`, label: g.full_path })),
        ...(users ?? []).map(u => ({ value: `user:${u.username}`, label: u.name }))]
    }
    if (source === 'tag') {
      const topics = [...(q ? [] : project.topics ?? []), ...(await gl.topics(q) ?? []).map(t => t.name)]
      return [...new Set(topics.map(tag).filter(Boolean))].map(value => ({ value }))
    }
    return []
  }
}

// ---------------------------------------------------------------- sign-in (browser)
// cfg: { url, clientId }. GitLab sends you back to the site's folder (the one redirect URI to register for every
// page), and from there you return to the page you signed in on.
const TOKENS = 'catalog-editor:tokens', PKCE = 'catalog-editor:pkce'
const load = k => { try { return JSON.parse(sessionStorage.getItem(k)) } catch { return null } }
const save = (k, v) => sessionStorage.setItem(k, JSON.stringify(v))
const redirectUri = () => location.origin + location.pathname.replace(/[^/]*$/, '')
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const random = n => b64url(crypto.getRandomValues(new Uint8Array(n)))
const post = (url, params) => fetch(url, { method: 'POST', body: new URLSearchParams(params) })

export async function signIn(cfg) {
  const verifier = random(48), state = random(16)
  save(PKCE, { verifier, state, back: location.pathname + location.hash })
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  location.assign(`${cfg.url}/oauth/authorize?${new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: 'api', state,
    code_challenge: challenge, code_challenge_method: 'S256',
  })}`)
}

/** Call once when a page starts: finishes a sign-in GitLab has just sent back (?code=…). */
export async function completeSignIn(cfg) {
  const q = new URLSearchParams(location.search), pkce = load(PKCE)
  if (!q.has('code') && !q.has('error')) return
  sessionStorage.removeItem(PKCE)
  const [page, hash] = (pkce?.back ?? location.pathname).split('#')
  history.replaceState(null, '', location.pathname + (hash ? `#${hash}` : ''))
  if (q.has('error')) throw new Error(`GitLab sign-in: ${q.get('error_description') ?? q.get('error')}`)
  if (q.get('state') !== pkce?.state) return   // not the sign-in this tab started
  await getTokens(cfg, { grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), code_verifier: pkce.verifier })
  if (page !== location.pathname) { location.replace(pkce.back); await new Promise(() => {}) }   // back to that page
}

async function getTokens(cfg, params) {
  const res = await post(`${cfg.url}/oauth/token`, { client_id: cfg.clientId, ...params })
  if (!res.ok) { sessionStorage.removeItem(TOKENS); throw new Error(`GitLab sign-in failed (${res.status}): sign in again`) }
  const t = await res.json()
  save(TOKENS, { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + (t.expires_in ?? 7200) * 1000 })
}

export const isSignedIn = () => load(TOKENS) !== null

/** The token function for gitlab(): renews the access token shortly before it expires, once for all callers */
let renewing = null
export const accessToken = cfg => async () => {
  let t = load(TOKENS)
  if (!t) throw new Error('Not signed in to GitLab')
  if (t.expires - Date.now() < 60_000) {
    // A refresh token works once: concurrent requests share one renewal
    await (renewing ??= getTokens(cfg, { grant_type: 'refresh_token', refresh_token: t.refresh }).finally(() => { renewing = null }))
    t = load(TOKENS)
  }
  return t.access
}

export async function signOut(cfg) {
  const t = load(TOKENS)
  sessionStorage.removeItem(TOKENS)
  if (t) await post(`${cfg.url}/oauth/revoke`, { client_id: cfg.clientId, token: t.access }).catch(() => {})
}
