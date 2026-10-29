// The Catalog Registry page: what every repository in a GitLab group registers in its catalog-info.yaml, read live
// from GitLab as the signed-in user, so each person sees only the projects GitLab lets them see. Also the projects
// with no catalog-info.yaml yet, and the files with errors, each with a link to fix it in the editor.
import { registry } from './catalog.js'
import { accessToken, completeSignIn, gitlab, isSignedIn, signIn, signOut } from './gitlab.js'

const $ = id => document.getElementById(id)
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== ''))
  return e
}
const text = v => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
const status = (msg, className = '') => Object.assign($('status'), { textContent: msg, className })
const repoLink = p => el('a', { href: p.url, textContent: p.path, target: '_blank', rel: 'noopener' })
const editLink = (p, label = 'Edit') => el('a', { href: `./#${p.path}`, textContent: label })
const CACHE = 'catalog-registry:'

// The filters of the registered view: [id, label, value of an entity]
const FILTERS = [
  ['kind', 'Kind', e => e.kind],
  ['type', 'Type', e => e.spec?.type],
  ['lifecycle', 'Lifecycle', e => e.spec?.lifecycle],
  ['owner', 'Owner', e => e.spec?.owner],
  ['product', 'IT product', e => e.spec?.system],
]

let cfg, gl, data = registry([])
start().catch(e => status(e.message, 'error'))

async function start() {
  cfg = await fetch('config.json').then(r => (r.ok ? r.json() : null)).catch(() => null)
  if (!cfg?.url || !cfg?.clientId) return status('GitLab sign-in is not configured (config.json).')
  $('signin').onclick = () => signIn(cfg)
  $('signout').onclick = () => {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(CACHE)) sessionStorage.removeItem(k)
    signOut(cfg).then(() => location.reload())
  }
  await completeSignIn(cfg).catch(e => status(e.message, 'error'))
  if (!isSignedIn()) { $('signin').hidden = false; return status('Sign in with GitLab to see the registry.') }

  gl = gitlab(cfg.url, accessToken(cfg))
  $('who').textContent = `@${(await gl.user()).username}`
  $('signout').hidden = $('scope').hidden = false
  for (const [id, label] of FILTERS) $('filters').append(el('label', { className: 'filter' }, label, el('select', { id: `f-${id}`, onchange: render })))
  $('view').onchange = render
  $('q').oninput = render

  let timer
  $('group').oninput = e => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      const groups = await gl.groups(e.target.value.trim()).catch(() => [])
      $('groups').replaceChildren(...(groups ?? []).map(g => new Option(g.name, g.full_path)))
    }, 250)
  }
  $('scope').onsubmit = e => { e.preventDefault(); load(false) }
  $('refresh').onclick = () => load(true)
  $('group').value = decodeURIComponent(location.hash.slice(1)) || cfg.orgGroup || ''
  await load(false)
}

// Read every project's catalog-info.yaml from GitLab, kept for this browser session until Refresh
async function load(fresh) {
  const group = $('group').value.trim(), where = group || 'your projects', key = `${CACHE}${cfg.url}:${group}`
  history.replaceState(null, '', group ? `#${group}` : location.pathname)
  let saved = null
  try { if (!fresh) saved = JSON.parse(sessionStorage.getItem(key)) } catch { /* nothing kept */ }
  if (!saved) {
    $('refresh').disabled = true
    status(`Reading ${where}…`)
    try {
      saved = { at: Date.now(), projects: await gl.catalogFiles(group, n => status(`Reading ${where}… ${n} projects`)) }
    } catch (e) {
      return status(e.message, 'error')
    } finally {
      $('refresh').disabled = false
    }
    try { sessionStorage.setItem(key, JSON.stringify(saved)) } catch { /* too large to keep: read again next time */ }
  }
  data = registry(saved.projects)
  status(`${saved.projects.length} projects in ${where}, read at ${new Date(saved.at).toLocaleTimeString()}.`)

  const [registered, unregistered, errors] = $('view').options
  registered.textContent = `Registered (${data.entities.length})`
  unregistered.textContent = `Not registered (${data.unregistered.length})`
  errors.textContent = `With errors (${data.errors.length})`
  for (const [id, , value] of FILTERS) {
    const select = $(`f-${id}`), current = select.value
    const values = [...new Set(data.entities.map(x => text(value(x.entity))).filter(Boolean))].sort()
    select.replaceChildren(new Option('All', ''), ...values.map(v => new Option(v, v, false, v === current)))
  }
  $('main').hidden = false
  render()
}

function render() {
  const view = $('view').value, q = $('q').value.trim().toLowerCase()
  const match = (...fields) => !q || fields.some(f => text(f).toLowerCase().includes(q))
  document.querySelectorAll('.filter').forEach(l => (l.hidden = view !== 'entities'))
  let head, rows
  if (view === 'entities') {
    const name = e => text(e.metadata?.title || e.metadata?.name)
    head = ['Name', 'Kind', 'Type', 'Lifecycle', 'Owner', 'IT product', 'Tags', 'Repository', '']
    rows = data.entities
      .filter(({ entity: e, project: p }) => FILTERS.every(([id, , value]) => !$(`f-${id}`).value || text(value(e)) === $(`f-${id}`).value)
        && match(e.metadata?.name, e.metadata?.title, e.metadata?.description, e.spec?.owner, e.spec?.system, p.path, ...[e.metadata?.tags].flat()))
      .sort((a, b) => name(a.entity).localeCompare(name(b.entity), undefined, { numeric: true, sensitivity: 'base' }))
      .map(({ entity: e, project: p, valid }) => [
        [el('strong', { textContent: name(e) }), valid ? '' : [' ', el('span', { className: 'badge', textContent: 'errors' })],
          e.metadata?.title ? el('div', { className: 'sub', textContent: text(e.metadata.name) }) : '',
          e.metadata?.description ? el('div', { className: 'desc', textContent: text(e.metadata.description) }) : ''],
        text(e.kind), text(e.spec?.type), text(e.spec?.lifecycle), text(e.spec?.owner), text(e.spec?.system),
        [e.metadata?.tags].flat().filter(Boolean).map(text).join(', '),
        repoLink(p), editLink(p),
      ])
  } else if (view === 'unregistered') {
    head = ['Repository', 'Project', '']
    rows = data.unregistered.filter(p => match(p.path, p.name)).map(p => [repoLink(p), p.name, editLink(p, 'Register')])
  } else {
    head = ['Repository', 'Entity', 'Problem', '']
    rows = data.errors.filter(({ project: p, issue: i }) => match(p.path, i.path, i.message))
      .map(({ project: p, issue: i }) => [repoLink(p), String(i.entity + 1), `${i.path ? `${i.path}: ` : ''}${i.message}`, editLink(p)])
  }
  $('head').replaceChildren(el('tr', {}, head.map(h => el('th', { scope: 'col', textContent: h }))))
  $('rows').replaceChildren(...rows.map(cells => el('tr', {}, cells.map(c => el('td', {}, c)))))
  $('count').textContent = `${rows.length} shown`
}
