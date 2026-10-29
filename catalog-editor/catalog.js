// Backstage catalog descriptor (catalog-info.yaml): the schema, YAML in and out, and a lightweight validator.
// No DOM, no GitLab, no dependencies: the same module serves the web editor, a VS Code extension (webview or host) and CI.
// Source: https://backstage.io/docs/features/software-catalog/descriptor-format/
//
// The schema is the repository-level profile: what a product owner registers in their own repository. In the
// Developer Portal's architecture, each repository's catalog-info.yaml names its owner, type, lifecycle and
// IT product. So: Components (and the APIs they expose), owned by a GitLab group or user, part of an IT product.
// IT products (System) come from the IT product registry, teams and people (Group, User) from GitLab; other
// kinds and fields are managed centrally. The editor keeps whatever else is in a file, and the validator flags it.
import { Doc, fromJS, parseAll } from './yaml.js'

export { stringify } from './yaml.js'

// ---------------------------------------------------------------- schema
// control: text | textarea | select (a dropdown of `options`, plus Other… for your own value) | combo (one value,
//          suggestions) | list (many values, suggestions) | map (key/value) | links | definition
// Suggestions come from `options` (hardcoded), `source` (a lookup the host provides, e.g. GitLab) and
// `ref` (entities of those kinds declared in the same file). `ref.default` is the kind a bare name refers to.
// The hardcoded values are Backstage's well-known ones, plus common ones for a Python, R and JavaScript toolchain.
// Every one of them can be overridden by typing.
export const LIFECYCLES = ['experimental', 'production', 'deprecated']
export const COMPONENT_TYPES = ['service', 'website', 'library', 'data-pipeline', 'tool', 'documentation']
export const API_TYPES = ['openapi', 'asyncapi', 'graphql', 'grpc']
export const TAGS = ['python', 'r', 'javascript', 'typescript', 'java', 'dotnet', 'sas', 'sql', 'quarto', 'shiny',
  'fastapi', 'django', 'flask', 'react', 'angular', 'spring-boot', 'spark', 'docker', 'kubernetes']
export const DEFINITIONS = ['./openapi.yaml', './openapi.json', './asyncapi.yaml', './schema.graphql', './api.proto']
export const LINK_TITLES = ['Support', 'Chat channel', 'Runbook', 'Dashboard', 'Documentation', 'Issue tracker', 'Release notes']
export const LINK_TYPES = ['support', 'chat', 'runbook', 'dashboard', 'documentation', 'issues']
export const LINK_ICONS = ['help', 'chat', 'docs', 'dashboard', 'email', 'warning']   // closed: an icon shows only if the portal has it
export const ANNOTATIONS = ['backstage.io/techdocs-ref', 'gitlab.com/project-slug']
export const ANNOTATION_VALUES = { 'backstage.io/techdocs-ref': ['dir:.'] }

// help: the explanatory note shown beside each field, written for a product owner (\n starts a new line)
const owner = {
  path: 'spec.owner', label: 'Owner', control: 'combo', source: 'owner', ref: { kinds: ['Group', 'User'], default: 'Group' }, required: true,
  help: 'The GitLab group (team) accountable for it; a person (user:…) only when there is no team. Prefer a group: people change roles.',
}
const lifecycle = {
  path: 'spec.lifecycle', label: 'Lifecycle', control: 'select', options: LIFECYCLES, required: true,
  help: 'experimental: early or trial; do not rely on it.\nproduction: in use and maintained.\ndeprecated: being retired; move off it.',
}
// ponytail: free text until the catalog has a source of IT products to look up; then a 'product' lookup
const product = {
  path: 'spec.system', label: 'IT product', control: 'combo', placeholder: 'the IT product name', ref: { kinds: ['System'], default: 'System' },
  help: 'The IT product this belongs to, as named in the IT product registry. The portal lists a product’s repositories together.',
}

export const KIND_HELP = 'Component: software this repository builds. API: an interface a component exposes. Most repositories have one Component, plus one API per interface they publish.'

export const METADATA = [
  { path: 'metadata.name', label: 'Name', required: true, check: 'name',
    help: 'The catalog ID, filled in from the GitLab project slug (group/project becomes group-project) so it is unique. Others refer to it by this name, so avoid renaming it.' },
  { path: 'metadata.title', label: 'Title',
    help: 'Optional display name, shown instead of the name. Keep it short.' },
  { path: 'metadata.description', label: 'Description', control: 'textarea',
    help: 'One or two sentences: what it does and who uses it. Shown in search and on the catalog card.' },
  { path: 'metadata.tags', label: 'Tags', control: 'list', source: 'tag', options: TAGS, check: 'tag',
    help: 'Keywords for search, such as the language or framework (python, r, react). Lowercase, words joined by -. Suggestions include this project’s GitLab topics.' },
  { path: 'metadata.links', label: 'Links', control: 'links',
    help: 'Pages outside the portal: a dashboard, runbook or support channel. A full https:// URL, with a short title.' },
  { path: 'metadata.annotations', label: 'Annotations', control: 'map', options: ANNOTATIONS, values: ANNOTATION_VALUES,
    help: 'Connections to other tools. gitlab.com/project-slug shows this project’s pipelines and merge requests; backstage.io/techdocs-ref: dir:. publishes this repository’s docs (mkdocs.yml) with TechDocs.' },
]

const V1 = 'backstage.io/v1alpha1'
export const KINDS = {
  Component: {
    apiVersion: V1, seed: { type: 'service', lifecycle: 'experimental' },
    spec: [
      { path: 'spec.type', label: 'Type', control: 'select', options: COMPONENT_TYPES, required: true,
        help: 'service: a backend that runs and answers requests.\nwebsite: used in a browser, including Shiny apps and dashboards.\nlibrary: code others import (a Python, R or npm package).\ndata-pipeline: ingests, transforms or publishes data, on a schedule or a trigger.\ntool: a command-line tool or script others run.\ndocumentation: a documentation or publication site (Quarto, MkDocs).' },
      lifecycle, owner, product,
      { path: 'spec.providesApis', label: 'Provides APIs', control: 'list', ref: { kinds: ['API'], default: 'API' },
        help: 'APIs this component exposes. Describe each one as an API entity in this file (+ Entity) so others can find its definition.' },
      { path: 'spec.consumesApis', label: 'Consumes APIs', control: 'list', ref: { kinds: ['API'], default: 'API' },
        help: 'Other teams’ APIs this component calls. Their owners can then see who depends on them.' },
    ],
  },
  API: {
    apiVersion: V1, seed: { type: 'openapi', lifecycle: 'experimental', definition: { $text: './openapi.yaml' } },
    spec: [
      { path: 'spec.type', label: 'Type', control: 'select', options: API_TYPES, required: true,
        help: 'The definition’s format: openapi (REST), asyncapi (events and messaging), graphql, or grpc (Protocol Buffers).' },
      lifecycle, owner, product,
      { path: 'spec.definition', label: 'Definition', control: 'definition', options: DEFINITIONS, required: true,
        help: 'The API’s machine-readable definition, shown in the portal: a file in this repository (./openapi.yaml) or a URL.' },
    ],
  },
}

/** Where entities of the kinds a repository does not register come from (the validator's hint) */
export const ELSEWHERE = { System: 'IT products come from the IT product registry', Group: 'teams come from GitLab', User: 'people come from GitLab' }

/**
 * A catalog name from a GitLab path: group/sub/project → group-sub-project, minus the org group prefix when set.
 * Entity names come from the project slug; groups are named the same way by Backstage's GitLab org provider
 * (defaultGroupNameTransformer), so owners and names line up.
 */
export function nameFromSlug(slug, orgGroup = '') {
  const path = orgGroup && slug.startsWith(`${orgGroup}/`) ? slug.slice(orgGroup.length + 1) : slug
  return path.replaceAll('/', '-').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/[-_.]{2,}/g, '-').replace(/^[-_.]+|[-_.]+$/g, '')
}

/** The form fields of an entity of this kind (metadata first). Other kinds get metadata only. */
export const fieldsFor = kind => [...METADATA, ...(KINDS[kind]?.spec ?? [])]
export const split = path => path.split('.')

// ---------------------------------------------------------------- YAML
/** A file to Docs (one per entity). Edit them with doc.set/delete/rename: comments and order survive. */
export const parse = text => parseAll(text)

/** A new entity of this kind, with its required spec fields seeded. */
export function newEntity(kind = 'Component', metadata = {}, spec = {}) {
  const def = KINDS[kind]
  return new Doc(fromJS({ apiVersion: def?.apiVersion ?? V1, kind, metadata: { name: '', ...metadata }, spec: { ...def?.seed, ...spec } }))
}

/** Change an entity's kind: keep every field, fix a default apiVersion, seed the new kind's required fields
 *  where they are missing or hold a value the new kind's list does not have (a Component's type on an API). */
export function setKind(doc, kind) {
  const before = KINDS[doc.get(['kind'])], def = KINDS[kind]
  doc.set(['kind'], kind)
  if (!doc.get(['apiVersion']) || doc.get(['apiVersion']) === before?.apiVersion) doc.set(['apiVersion'], def?.apiVersion ?? V1)
  if (doc.node(['spec'])?.kind !== 'map') doc.set(['spec'], {})
  for (const [k, v] of Object.entries(def?.seed ?? {})) {
    const cur = doc.get(['spec', k]), f = def.spec.find(f => f.path === `spec.${k}`)
    if (!cur || (f?.control === 'select' && !f.options.includes(cur))) doc.set(['spec', k], v)
  }
}

// ---------------------------------------------------------------- validator
// Lightweight: the envelope, required fields per kind, value types and the documented formats.
// Errors make the catalog reject the entity. Warnings are what Backstage accepts but a repository should not
// register here: kinds and fields outside the repository-level profile. Values outside the dropdowns are fine.
const NAME = /^[a-zA-Z0-9]+(?:[-_.][a-zA-Z0-9]+)*$/                 // also link icons
const NAMESPACE = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/
const TAG = /^[a-z0-9:+#]+(?:-[a-z0-9:+#]+)*$/
const DOMAIN = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isUrl = v => { try { return /^https?:$/.test(new URL(v).protocol) } catch { return false } }
const get = (o, path) => split(path).reduce((v, k) => (isObj(v) ? v[k] : undefined), o)

const FORMAT = {
  name: v => (v.length <= 63 && NAME.test(v)) || 'letters and digits, separated by - _ or . (at most 63)',
  namespace: v => (v.length <= 63 && NAMESPACE.test(v)) || 'letters and digits, separated by - (at most 63)',
  tag: v => (v.length <= 63 && TAG.test(v)) || 'lowercase letters, digits and : + #, separated by - (at most 63)',
  key: v => {
    const [prefix, name] = v.includes('/') ? [v.slice(0, v.lastIndexOf('/')), v.slice(v.lastIndexOf('/') + 1)] : [null, v]
    if (prefix !== null && !(prefix.length <= 253 && DOMAIN.test(prefix))) return 'the prefix must be a lowercase domain name'
    return (name.length <= 63 && NAME.test(name)) || 'the name part must be letters and digits, separated by - _ or . (at most 63)'
  },
}

/** An entity reference: [kind:][namespace/]name. Returns a message, or null when valid. */
export function checkRef(v, ref) {
  const m = /^(?:([^:/]+):)?(?:([^:/]+)\/)?([^:/]+)$/.exec(v)
  if (!m) return 'not an entity reference: [kind:][namespace/]name'
  const [, kind, ns, name] = m
  if (ns && FORMAT.namespace(ns) !== true) return `namespace: ${FORMAT.namespace(ns)}`
  if (FORMAT.name(name) !== true) return `name: ${FORMAT.name(name)}`
  if (!kind && !ref.default) return `needs a kind: ${ref.kinds.map(k => `${k.toLowerCase()}:${name}`).join(' or ')}`
  return null
}

/** Issues in one entity (a plain object): [{ path, message, level: 'error' | 'warning' }] */
export function validate(e) {
  const issues = []
  const err = (path, message) => issues.push({ path, message, level: 'error' })
  const warn = (path, message) => issues.push({ path, message, level: 'warning' })
  if (!isObj(e)) return err('', 'an entity must be a mapping (apiVersion, kind, metadata, spec)'), issues

  for (const k of ['apiVersion', 'kind']) if (typeof e[k] !== 'string' || !e[k]) err(k, 'is required')
  const def = KINDS[e.kind]
  if (e.kind && !def) warn('kind', `${e.kind} is not registered in a repository${ELSEWHERE[e.kind] ? `: ${ELSEWHERE[e.kind]}` : ''}`)
  if (def && e.apiVersion && e.apiVersion !== def.apiVersion) warn('apiVersion', `${e.kind} is usually ${def.apiVersion}`)
  if (!isObj(e.metadata)) err('metadata', 'is required')
  if (def && !isObj(e.spec)) err('spec', 'is required')

  for (const f of fieldsFor(e.kind)) {
    const v = get(e, f.path)
    const control = f.control ?? 'text'
    if (v === undefined || v === null || v === '') { if (f.required) err(f.path, 'is required'); continue }
    if (control === 'list') {
      if (!Array.isArray(v)) { err(f.path, 'must be a list'); continue }
      v.forEach((x, i) => checkValue(`${f.path}.${i}`, x, f))
    } else if (control === 'map') {
      if (!isObj(v)) { err(f.path, 'must be a mapping of key: value'); continue }
      for (const [k, x] of Object.entries(v)) {
        const kp = `${f.path}.${k}`, ok = FORMAT.key(k)
        if (ok !== true) err(kp, `key: ${ok}`)
        if (typeof x !== 'string') err(kp, 'value must be a string (quote it)')
        else if (f.check) checkValue(kp, x, f)
      }
    } else if (control === 'links') {
      if (!Array.isArray(v)) { err(f.path, 'must be a list'); continue }
      v.forEach((l, i) => {
        const lp = `${f.path}.${i}`
        if (!isObj(l)) return err(lp, 'must be a mapping with a url')
        if (typeof l.url !== 'string' || !l.url) err(`${lp}.url`, 'is required')
        else if (!isUrl(l.url)) err(`${lp}.url`, 'not an http(s) URL')
        for (const k of ['title', 'icon', 'type']) if (l[k] !== undefined && typeof l[k] !== 'string') err(`${lp}.${k}`, 'must be a string')
        if (typeof l.icon === 'string' && !NAME.test(l.icon)) err(`${lp}.icon`, 'letters and digits, separated by - _ or .')
      })
    } else if (control === 'definition') {
      if (typeof v !== 'string' && !(isObj(v) && ['$text', '$json', '$yaml'].some(k => typeof v[k] === 'string'))) err(f.path, 'must be text, or { $text: <path or URL> }')
    } else checkValue(f.path, v, f)
  }
  // Fields outside the profile: kept as they are, flagged so the owner knows they are not managed here
  if (def) {
    for (const part of ['metadata', 'spec']) {
      const known = new Set(fieldsFor(e.kind).map(f => split(f.path)).filter(p => p[0] === part).map(p => p[1]))
      for (const k of Object.keys(isObj(e[part]) ? e[part] : {})) if (!known.has(k)) warn(`${part}.${k}`, 'not part of the repository-level profile; kept as it is')
    }
  }
  return issues

  function checkValue(path, v, f) {
    if (typeof v !== 'string') return err(path, 'must be a string (quote it)')
    if (f.check) { const ok = FORMAT[f.check](v); if (ok !== true) return err(path, ok) }
    if (f.ref) {
      const bad = checkRef(v, f.ref)
      if (bad) return err(path, bad)
      const kind = v.includes(':') ? v.slice(0, v.indexOf(':')) : f.ref.default
      if (!f.ref.kinds.some(k => k.toLowerCase() === kind.toLowerCase())) warn(path, `usually refers to a ${f.ref.kinds.join(' or ')}`)
    }
  }
}

/** Issues in a whole file: YAML errors, each entity's issues, and duplicate entities. Each issue carries its entity index. */
export function validateAll(docs) {
  const issues = [], seen = new Map()
  docs.forEach((d, entity) => {
    if (d.errors.length) return d.errors.forEach(e => issues.push({ entity, path: '', message: e.message, level: 'error' }))
    const e = d.toJS()
    issues.push(...validate(e).map(i => ({ entity, ...i })))
    const id = [e?.kind, e?.metadata?.namespace ?? 'default', e?.metadata?.name].join(':').toLowerCase()
    if (seen.has(id)) issues.push({ entity, path: 'metadata.name', message: `same kind and name as entity ${seen.get(id) + 1}`, level: 'error' })
    else seen.set(id, entity)
  })
  return issues
}

// ---------------------------------------------------------------- registry
/**
 * The registry of a set of projects [{ path, name, url, text }] (text: catalog-info.yaml, or null for none):
 * every entity they register (valid: false when it has errors), the projects that register nothing, and every error.
 */
export function registry(projects) {
  const out = { entities: [], unregistered: [], errors: [] }
  for (const project of projects) {
    if (!project.text?.trim()) { out.unregistered.push(project); continue }
    const docs = parse(project.text)
    const errors = validateAll(docs).filter(i => i.level === 'error')
    out.errors.push(...errors.map(issue => ({ project, issue })))
    docs.forEach((d, k) => {
      const entity = d.errors.length ? null : d.toJS()
      if (isObj(entity)) out.entities.push({ project, entity, valid: !errors.some(i => i.entity === k) })
    })
  }
  return out
}
