// The Catalog Editor page: sign in with GitLab, pick a project, edit its catalog-info.yaml, save it on a branch.
// Branch rule: the file loads from the default branch when it exists there; otherwise you choose the branch to start
// from. Saves always go to a branch, never the default branch or a protected one, then optionally a merge request.
// config.json (written by the pages job): { "url": GitLab URL, "clientId": OAuth application ID, "orgGroup"?: "" }
import './catalog-editor.js'
import { nameFromSlug, newEntity, stringify } from './catalog.js'
import { accessToken, completeSignIn, gitlab, isSignedIn, lookups, signIn, signOut } from './gitlab.js'

const FILE = 'catalog-info.yaml'
const $ = id => document.getElementById(id)
const editor = $('editor'), yaml = $('yaml')
let cfg, gl, me, project = null
let base = null            // { ref, text }: what the file was on that ref when loaded (text null: no file yet)

const status = (msg, cls = '') => { $('status').textContent = msg; $('status').className = cls }
// The YAML pane is what gets saved: form edits write to it, and text typed there keeps its exact formatting
const dirty = () => base !== null && yaml.value !== (base.text ?? '')
const confirmDiscard = () => !dirty() || confirm('Discard your unsaved changes?')
addEventListener('beforeunload', e => { if (dirty()) e.preventDefault() })

// ---------------------------------------------------------------- the form and the YAML stay in step
editor.addEventListener('change', () => { yaml.value = editor.value; refresh() })
yaml.addEventListener('input', () => { editor.value = yaml.value; refresh() })

function refresh() {
  const issues = editor.issues
  $('issues').replaceChildren(...issues.map(i => Object.assign(document.createElement('li'), {
    className: i.level,
    textContent: `${issues.some(x => x.entity > 0) ? `Entity ${i.entity + 1} · ` : ''}${i.path ? `${i.path}: ` : ''}${i.message}`,
  })))
  const why = !project ? 'Choose a project' : issues.some(i => i.level === 'error') ? 'Fix the errors first' : !dirty() ? 'No changes yet' : ''
  $('save-why').textContent = why
  $('save-button').disabled = !!why
}

function show(text) { editor.value = yaml.value = text; refresh() }

// ---------------------------------------------------------------- start-up
show(stringify([newEntity()]))
start().catch(e => status(e.message, 'error'))

async function start() {
  cfg = await fetch('config.json').then(r => (r.ok ? r.json() : null)).catch(() => null)
  if (!cfg?.url || !cfg?.clientId) return status('GitLab sign-in is not configured (config.json): you can edit and copy the YAML, not load or save.')
  $('signin').onclick = () => signIn(cfg)
  $('signout').onclick = () => confirmDiscard() && signOut(cfg).then(() => { base = null; location.reload() })
  await completeSignIn(cfg).catch(e => status(e.message, 'error'))
  if (!isSignedIn()) { $('signin').hidden = false; return status('Sign in with GitLab to load and save a project’s catalog-info.yaml.') }

  gl = gitlab(cfg.url, accessToken(cfg))
  me = await gl.user()
  $('who').textContent = `@${me.username}`
  $('signout').hidden = $('source').hidden = $('save').hidden = false

  let timer
  const search = async q => $('projects').replaceChildren(...(await gl.projects(q) ?? []).map(p => new Option(p.name_with_namespace, p.path_with_namespace)))
  $('project').oninput = e => { clearTimeout(timer); timer = setTimeout(() => search(e.target.value.trim()).catch(() => {}), 250) }
  $('project').onchange = e => e.target.value.trim() && openProject(e.target.value.trim())
  await search('')
  const fromLink = decodeURIComponent(location.hash.slice(1))
  if (fromLink) { $('project').value = fromLink; await openProject(fromLink) } else status('Choose a project.')
}

// ---------------------------------------------------------------- load
async function openProject(path) {
  if (!confirmDiscard()) { $('project').value = project?.path_with_namespace ?? ''; return }
  status(`Opening ${path}…`)
  const p = await gl.project(path).catch(e => { status(e.message, 'error'); return null })
  if (!p) return status(`${path}: not found, or you have no access`, 'error')
  if (!p.default_branch) return status(`${path} has no repository yet`, 'error')
  project = p
  history.replaceState(null, '', `#${p.path_with_namespace}`)
  editor.lookup = lookups(gl, p, cfg.orgGroup)
  editor.defaults = { name: nameFromSlug(p.path_with_namespace, cfg.orgGroup) }
  $('default-branch').textContent = p.default_branch

  const branches = await gl.branches(p.id) ?? []
  $('branches').replaceChildren(...branches.filter(b => !b.protected && !b.default).map(b => new Option('', b.name)))
  const text = await gl.file(p.id, FILE, p.default_branch)
  $('branch-pick').hidden = text !== null
  if (text === null) {
    // No file on the default branch: let the user choose where to start (it may exist on a working branch)
    $('branch').replaceChildren(...[p.default_branch, ...branches.map(b => b.name).filter(n => n !== p.default_branch)]
      .map(n => new Option(n === p.default_branch ? `${n} (new file)` : n, n)))
    $('branch').onchange = e => confirmDiscard() ? loadRef(e.target.value) : (e.target.value = base.ref)
  }
  load(p.default_branch, text, branches)
}

async function loadRef(ref) {
  status(`Loading ${FILE} from ${ref}…`)
  load(ref, await gl.file(project.id, FILE, ref), await gl.branches(project.id) ?? [])
}

function load(ref, text, branches) {
  base = { ref, text }
  show(text ?? stringify([newEntity('Component', {
    ...editor.defaults,
    title: project.name,
    ...(project.description && { description: project.description }),
    annotations: { 'gitlab.com/project-slug': project.path_with_namespace },
  })]))
  // Save target: the branch you started from when you may write to it, otherwise a new branch of your own
  const from = branches.find(b => b.name === ref), mine = `catalog-info-${me.username}`
  $('target').value = from && !from.default && !from.protected ? ref
    : branches.some(b => b.name === mine) ? `${mine}-${new Date().toISOString().slice(0, 10)}` : mine
  $('message').value = `${text === null ? 'Add' : 'Update'} ${FILE}`
  $('result').replaceChildren()
  status(text === null ? `No ${FILE} on ${ref}: a new one is filled in from the project. Saving creates it.` : `Loaded ${FILE} from ${ref}.`)
  refresh()
}

// ---------------------------------------------------------------- save: one commit on a branch, then a merge request
$('save').onsubmit = async e => {
  e.preventDefault()
  const target = $('target').value.trim(), message = $('message').value.trim(), text = yaml.value
  const result = $('result')
  $('save-button').disabled = true
  result.replaceChildren('Saving…')
  try {
    if (target === project.default_branch) throw new Error(`Changes are never saved to ${target}: save to a branch, then merge the merge request`)
    const branch = await gl.branch(project.id, target)
    if (branch?.protected || branch?.default) throw new Error(`${target} is protected: choose another branch`)
    // Conflict check: the file must still be as loaded, on the branch the commit lands on
    const ref = branch ? target : base.ref
    const now = await gl.file(project.id, FILE, ref)
    if (now !== base.text) {
      throw new Error(ref === base.ref
        ? `${FILE} on ${ref} changed since you loaded it. Copy your YAML, open the project again, and reapply your change.`
        : `${target} already has a different ${FILE}: save to a new branch name.`)
    }
    if (now === text) throw new Error(`${FILE} on ${ref} is already exactly this`)
    const commit = await gl.commit(project.id, {
      branch: target,
      ...(!branch && { start_branch: base.ref }),
      commit_message: message,
      actions: [{ action: now === null ? 'create' : 'update', file_path: FILE, content: text }],
    })
    base = { ref: target, text }
    const links = [link(commit.web_url, `Commit ${commit.short_id} on ${target}`)]
    if ($('mr').checked) {
      const mr = await gl.openMergeRequest(project.id, target) ?? await gl.createMergeRequest(project.id, {
        source_branch: target, target_branch: project.default_branch, title: message, remove_source_branch: true,
        description: `${FILE} edited with the Catalog Editor.`,
      })
      links.push(' · ', link(mr.web_url, `Merge request !${mr.iid}`))
    }
    result.replaceChildren(Object.assign(document.createElement('span'), { className: 'ok', textContent: 'Saved. ' }), ...links)
    status(`Editing ${FILE} on ${target}: further saves add commits to that branch.`)
  } catch (err) {
    result.replaceChildren(Object.assign(document.createElement('span'), { className: 'error', textContent: err.message }))
  }
  refresh()
}

const link = (href, text) => Object.assign(document.createElement('a'), { href, textContent: text, target: '_blank', rel: 'noopener' })
