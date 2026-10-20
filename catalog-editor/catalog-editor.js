// <catalog-editor>: a form over a whole catalog-info.yaml (every entity in the file), built from catalog.js.
// The same element runs in this page and in a VS Code webview. Host contract:
//   el.value = text      load a file            el.value     the edited text (comments and order kept)
//   el.issues            validateAll() result    'change'     fired after every edit in the form
//   el.lookup = async (source, query) => [{ value, label? }]   optional dropdown data for 'owner' | 'tag'
//   el.defaults = { name, … }   optional metadata for entities added with + Entity (the host's project slug name)
// Theme: --ce-* custom properties, falling back to VS Code's theme variables, then to system colours.
import { isCollection, isMap, isScalar, isSeq } from 'yaml'
import { ELSEWHERE, KIND_HELP, KINDS, LINK_ICONS, LINK_TITLES, LINK_TYPES, METADATA, fieldsFor, newEntity, parse, setKind, split, stringify, validateAll } from './catalog.js'

const css = `
:host { display: block; container-type: inline-size; color-scheme: light dark;
  font-family: var(--ce-font, var(--vscode-font-family, system-ui, sans-serif)); font-size: var(--vscode-font-size, 14px);
  color: var(--ce-fg, var(--vscode-foreground, CanvasText));
  --_field: var(--ce-field, var(--vscode-input-background, Field)); --_line: var(--ce-line, var(--vscode-input-border, color-mix(in srgb, currentColor 28%, transparent)));
  --_accent: var(--ce-accent, var(--vscode-focusBorder, #1a5a96)); --_muted: var(--ce-muted, var(--vscode-descriptionForeground, GrayText));
  --_error: var(--ce-error, var(--vscode-errorForeground, #b3261e)); --_warning: var(--ce-warning, var(--vscode-editorWarning-foreground, #8a5a00)); }
* { box-sizing: border-box; }
nav { display: flex; flex-wrap: wrap; gap: .35rem; margin-bottom: 1rem; }
nav button { border: 1px solid var(--_line); background: transparent; color: inherit; border-radius: 999px; padding: .3rem .8rem; font: inherit; cursor: pointer; }
nav button.on { background: var(--_accent); border-color: var(--_accent); color: #fff; }
nav button.bad:not(.on) { border-color: var(--_error); }
section { border-top: 1px solid var(--_line); padding: .75rem 0 .25rem; }
h3 { margin: 0 0 .6rem; font-size: .8em; letter-spacing: .06em; text-transform: uppercase; color: var(--_muted); }
/* A field: label, control, issues, and its note. Narrow: stacked. Medium: the note under the control. Wide: beside it. */
.field { display: grid; grid-template-columns: minmax(0, 1fr); gap: .2rem 1rem; margin-bottom: .8rem; align-items: start; }
.field > label b { color: var(--_error); font-weight: normal; }
.msg { font-size: .85em; }
.msg:empty { display: none; }
.note { font-size: .82em; line-height: 1.35; color: var(--_muted); white-space: pre-line; }
.error { color: var(--_error); } .warning { color: var(--_warning); }
input, select, textarea { width: 100%; font: inherit; color: inherit; background: var(--_field); border: 1px solid var(--_line); border-radius: 4px; padding: .35rem .5rem; }
textarea { min-height: 4.5rem; resize: vertical; }
:focus-visible { outline: 2px solid var(--_accent); outline-offset: 1px; }
.rows { display: grid; gap: .3rem; }
.row { display: flex; gap: .3rem; }
.row > * { flex: 1; min-width: 0; }
.row > .x { flex: 0 0 2rem; }
.row > .key { flex: 1.4; }
.choice { display: flex; gap: .3rem; }
.choice > * { flex: 1; min-width: 0; }
.pad { visibility: hidden; }
.x, .remove { background: transparent; border: 1px solid var(--_line); border-radius: 4px; color: inherit; cursor: pointer; font: inherit; }
.remove { padding: .3rem .7rem; }
.muted { color: var(--_muted); margin: .3rem 0; }
.banner { padding: .6rem .8rem; border-radius: 4px; border: 1px solid var(--_error); }
@container (width >= 34rem) {
  .field { grid-template-columns: 9rem minmax(0, 1fr); }
  .field > label { padding-top: .4rem; }
  .msg, .note { grid-column: 2; }
}
@container (width >= 44rem) {
  .field { grid-template-columns: 9rem minmax(0, 1fr) minmax(11rem, 15rem); }
  .note { grid-column: 3; grid-row: 1 / span 2; padding-top: .3rem; }
}
`

/** h('input', { value, oninput, 'data-key': k }, ...children): props with a dash, list and for are attributes */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k.includes('-') || k === 'list' || k === 'for') el.setAttribute(k, v)
    else el[k] = v
  }
  el.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false))
  return el
}
const str = v => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
const OTHER = '\u0000other'   // the Other… option of an editable dropdown
const entityLabel = d => `${d.get('kind') ?? '?'} · ${d.getIn(['metadata', 'name']) || 'unnamed'}`

export class CatalogEditor extends HTMLElement {
  #docs = []
  #text = ''
  #i = 0
  #lookup = null
  #cache = new Map()
  #timer = 0
  defaults = {}

  constructor() { super(); this.attachShadow({ mode: 'open' }) }
  connectedCallback() { this.#render() }

  get value() { return this.#broken() ? this.#text : stringify(this.#docs) }
  set value(text) {
    this.#text = text ?? ''
    this.#docs = parse(this.#text)
    this.#i = Math.max(0, Math.min(this.#i, this.#docs.length - 1))
    this.#render()
  }
  get issues() { return validateAll(this.#docs) }
  get lookup() { return this.#lookup }
  set lookup(fn) { this.#lookup = fn; this.#cache.clear() }

  #broken() { return this.#docs.some(d => d.errors.length) }
  get #doc() { return this.#docs[this.#i] }

  // ---------------------------------------------------------------- reading and writing the YAML document
  #get(path) { const v = this.#doc.getIn(path); return v?.toJSON ? v.toJSON() : v }
  #node(path) { return this.#doc.getIn(path, true) }

  #set(path, v) {
    const d = this.#doc
    if (v === undefined || v === '') {
      d.deleteIn(path)
      // drop mappings the delete left empty (spec.profile), never metadata or spec, never a list item
      for (let k = path.length - 1; k > 1 && typeof path[k - 1] === 'string'; k--) {
        const n = d.getIn(path.slice(0, k), true)
        if (isMap(n) && !n.items.length) d.deleteIn(path.slice(0, k)); else break
      }
    } else {
      for (let k = 1; k < path.length; k++) if (!isCollection(d.getIn(path.slice(0, k), true))) d.setIn(path.slice(0, k), d.createNode({}))
      d.setIn(path, typeof v === 'object' ? d.createNode(v) : v)
    }
    this.#changed()
  }

  #changed() {
    this.shadowRoot.querySelector('nav button.on')?.replaceChildren(entityLabel(this.#doc))
    this.#showIssues()
    this.dispatchEvent(new Event('change'))
  }
  #restructured() { this.#changed(); this.#render() }

  // ---------------------------------------------------------------- rendering
  #render() {
    if (!this.isConnected) return
    const root = this.shadowRoot
    const focus = root.activeElement?.dataset.key
    root.replaceChildren(h('style', {}, css), ...this.#body().flat())
    if (focus) this.#focus(focus)
    this.#showIssues()
  }

  #body() {
    if (this.#broken()) {
      return [h('p', { className: 'banner' }, 'The YAML cannot be read. Fix it in the YAML and the form comes back:'),
        h('ul', { className: 'error' }, this.#docs.flatMap(d => d.errors).map(e => h('li', {}, e.message.split('\n')[0])))]
    }
    const nav = h('nav', { 'aria-label': 'Entities in this file' },
      this.#docs.map((d, i) => h('button', {
        type: 'button', className: i === this.#i ? 'on' : '', 'aria-pressed': String(i === this.#i),
        onclick: () => { this.#i = i; this.#render() },
      }, entityLabel(d))),
      h('button', { type: 'button', onclick: () => { this.#docs.push(newEntity('Component', this.defaults)); this.#i = this.#docs.length - 1; this.#restructured() } }, '+ Entity'))
    if (!this.#doc) return [nav, h('p', { className: 'muted' }, 'No entities in this file yet.')]
    if (!isMap(this.#doc.contents)) return [nav, h('p', { className: 'banner' }, 'This entity is not a mapping: fix it in the YAML.')]

    const kind = this.#doc.get('kind')
    const def = KINDS[kind]
    const fields = fieldsFor(kind)
    return [
      nav,
      h('section', {}, h('h3', {}, 'Entity'),
        this.#wrap({ path: 'kind', label: 'Kind', required: true, help: KIND_HELP }, 'f-kind', h('select', {
          id: 'f-kind', 'data-key': 'kind', 'aria-describedby': 'f-kind-note f-kind-msg',
          onchange: e => { setKind(this.#doc, e.target.value); this.#restructured() },
        }, [...new Set([...Object.keys(KINDS), ...(kind ? [kind] : [])])].map(k => h('option', { value: k, selected: k === kind }, k)))),
        h('div', { className: 'field' }, h('span'), h('div', {}, this.#removeButton()))),
      h('section', {}, h('h3', {}, 'Metadata'), METADATA.map(f => this.#field(f))),
      h('section', {}, h('h3', {}, 'Spec'),
        def ? def.spec.map(f => this.#field(f))
          : h('p', { className: 'muted' }, `${kind ?? 'This kind'} is not registered in a repository${ELSEWHERE[kind] ? ` (${ELSEWHERE[kind]})` : ''}: it is kept as it is; edit it in the YAML.`)),
      h('section', { 'data-issues': '', hidden: true }, h('h3', {}, 'Other issues')),
      fields.filter(f => f.control !== 'select' && (f.options || f.ref || f.source)).map(f => h('datalist', { id: `dl-${f.path}` }, this.#options(this.#staticSuggestions(f)))),
    ]
  }

  #removeButton() {
    return h('button', {
      type: 'button', className: 'remove',
      onclick: e => {
        if (!e.target.dataset.armed) { e.target.dataset.armed = '1'; e.target.textContent = 'Click again to remove this entity'; return }
        this.#docs.splice(this.#i, 1)
        this.#i = Math.max(0, this.#i - 1)
        this.#restructured()
      },
    }, 'Remove entity')
  }

  #focus(key) { this.shadowRoot.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus() }

  #wrap(f, id, control) {
    return h('div', { className: 'field', 'data-field': f.path },
      h('label', { for: id }, f.label, f.required ? h('b', { 'aria-hidden': 'true' }, ' *') : null),
      control, h('div', { className: 'msg', id: `${id}-msg`, 'aria-live': 'polite' }),
      f.help && h('div', { className: 'note', id: `${id}-note` }, f.help))
  }

  #field(f) {
    const id = `f-${f.path}`
    return this.#wrap(f, id, this.#control(f, split(f.path), id))
  }

  #control(f, path, id) {
    const v = this.#get(path)
    const common = { id, 'data-key': f.path, 'aria-describedby': `${f.help ? `${id}-note ` : ''}${id}-msg`, 'aria-required': f.required ? 'true' : null }
    const suggest = (f.options || f.ref || f.source) ? { list: `dl-${f.path}`, autocomplete: 'off', onfocus: e => this.#suggest(f, e.target) } : {}
    switch (f.control ?? 'text') {
      case 'textarea':
        return h('textarea', { ...common, value: str(v), oninput: e => this.#set(path, e.target.value) })
      case 'select': {
        // A dropdown of reasonable values, and Other… for your own (a datalist would hide the rest once one is chosen)
        const cur = str(v), custom = cur !== '' && !f.options.includes(cur)
        const other = h('input', { value: custom ? cur : '', placeholder: `Your own ${f.label.toLowerCase()}`, hidden: !custom,
          'data-key': `${f.path}.other`, 'aria-label': `${f.label}: your own value`, oninput: e => this.#set(path, e.target.value) })
        const select = h('select', {
          ...common,
          onchange: e => {
            other.hidden = e.target.value !== OTHER
            if (other.hidden) this.#set(path, e.target.value); else { other.focus(); this.#set(path, other.value) }
          },
        }, h('option', { value: '' }, '—'), f.options.map(o => h('option', { value: o, selected: o === cur }, o)), h('option', { value: OTHER, selected: custom }, 'Other…'))
        return h('div', { className: 'choice' }, select, other)
      }
      case 'combo':
        return h('input', { ...common, ...suggest, value: str(v), placeholder: f.placeholder ?? (f.ref?.default ? `${f.ref.default.toLowerCase()} name or kind:name` : ''),
          oninput: e => { this.#set(path, e.target.value); this.#suggest(f, e.target) } })
      case 'list': return this.#list(f, path, v, common, suggest)
      case 'map': return this.#map(f, path, v, common)
      case 'links': return this.#links(f, path, v, common)
      case 'definition': {
        if (typeof v === 'string') return h('textarea', { ...common, value: v, oninput: e => this.#set(path, e.target.value) })
        const key = ['$text', '$json', '$yaml'].find(k => v?.[k] !== undefined) ?? '$text'
        return h('input', { ...common, ...suggest, value: str(v?.[key]), placeholder: './openapi.yaml', oninput: e => this.#set([...path, key], e.target.value) })
      }
      default:
        return h('input', { ...common, value: str(v), placeholder: f.placeholder ?? '', oninput: e => this.#set(path, e.target.value) })
    }
  }

  // A list: one input per item, and a blank input at the end that adds an item
  #list(f, path, v, common, suggest) {
    if (v !== undefined && v !== null && !Array.isArray(v)) return h('p', { className: 'muted', id: common.id }, 'Not a list: fix it in the YAML.')
    const items = v ?? []
    const remove = i => {
      const seq = this.#node(path)
      seq.delete(i)
      if (!seq.items.length && !f.required) this.#doc.deleteIn(path)
      this.#restructured()
    }
    return h('div', { className: 'rows' },
      items.map((item, i) => h('div', { className: 'row' },
        h('input', { ...suggest, value: str(item), 'data-key': `${f.path}.${i}`, 'aria-label': `${f.label} ${i + 1}`,
          oninput: e => { this.#node(path).set(i, e.target.value); this.#changed(); if (suggest.list) this.#suggest(f, e.target) },
          onchange: e => { if (!e.target.value) remove(i) } }),
        h('button', { type: 'button', className: 'x', 'aria-label': `Remove ${str(item)}`, onclick: () => remove(i) }, '×'))),
      h('input', { ...common, ...suggest, 'data-key': `${f.path}.${items.length}`, placeholder: items.length ? 'Add another…' : 'Add…',
        oninput: e => suggest.list && this.#suggest(f, e.target),
        onchange: e => {
          const value = e.target.value.trim()
          if (!value) return
          const seq = this.#node(path)
          const typing = this.shadowRoot.activeElement === e.target
          if (isSeq(seq)) { seq.add(value); this.#restructured() } else { this.#set(path, [value]); this.#render() }
          if (typing) this.#focus(`${f.path}.${items.length + 1}`)
        } }))
  }

  // A mapping (annotations, labels): key and value per row, and a blank row at the end that adds a pair
  #map(f, path, v, common) {
    if (v !== undefined && v !== null && (typeof v !== 'object' || Array.isArray(v))) return h('p', { className: 'muted', id: common.id }, 'Not a mapping: fix it in the YAML.')
    const node = this.#node(path)
    const entries = isMap(node) ? node.items.map(p => [str(isScalar(p.key) ? p.key.value : p.key), isScalar(p.value) ? p.value.value : p.value?.toJSON?.() ?? p.value]) : []
    const keyList = f.options ? { list: `dl-${f.path}`, autocomplete: 'off' } : {}
    const pair = i => this.#node(path).items[i]
    const taken = k => entries.some(([key]) => key === k)
    const rows = entries.map(([k, val], i) => h('div', { className: 'row' },
      h('input', { ...keyList, className: 'key', value: k, 'data-key': `${f.path}.${i}.k`, 'aria-label': `${f.label} key ${i + 1}`,
        onchange: e => {
          const key = e.target.value.trim()
          if (!key) { this.#node(path).items.splice(i, 1); this.#restructured(); return }
          if (key !== k && taken(key)) { e.target.value = k; return }     // keys are unique
          pair(i).key = this.#doc.createNode(key)
          this.#restructured()
        } }),
      h('input', { value: str(val), 'data-key': `${f.path}.${i}.v`, 'aria-label': `${f.label} value for ${k}`, list: f.values?.[k] ? `dl-${f.path}=${k}` : null,
        oninput: e => { const p = pair(i); if (isScalar(p.value)) p.value.value = e.target.value; else p.value = this.#doc.createNode(e.target.value); this.#changed() } }),
      h('button', { type: 'button', className: 'x', 'aria-label': `Remove ${k}`, onclick: () => { this.#node(path).items.splice(i, 1); if (!this.#node(path).items.length) this.#doc.deleteIn(path); this.#restructured() } }, '×')))
    const n = entries.length
    const value = h('input', { 'data-key': `${f.path}.${n}.v`, placeholder: 'value', 'aria-label': `New ${f.label} value` })
    const key = h('input', { ...common, ...keyList, className: 'key', 'data-key': `${f.path}.${n}.k`, placeholder: 'Add a key…',
      onchange: e => {
        const k = e.target.value.trim()
        if (!k || taken(k)) return
        const map = this.#node(path)
        if (isMap(map)) map.set(k, value.value); else this.#set(path, { [k]: value.value })
        this.#restructured()
      } })
    return h('div', { className: 'rows' }, rows, h('div', { className: 'row' }, key, value, h('span', { className: 'x pad' })),
      Object.entries(f.values ?? {}).map(([k, vals]) => h('datalist', { id: `dl-${f.path}=${k}` }, vals.map(x => new Option('', x)))))
  }

  #links(f, path, v, common) {
    if (v !== undefined && v !== null && !Array.isArray(v)) return h('p', { className: 'muted', id: common.id }, 'Not a list: fix it in the YAML.')
    const links = v ?? []
    const input = (i, k, placeholder, list) => h('input', { value: str(links[i]?.[k]), placeholder, list, 'data-key': `${f.path}.${i}.${k}`, 'aria-label': `Link ${i + 1} ${k}`,
      oninput: e => this.#set([...path, i, k], e.target.value) })
    const icon = i => h('select', { 'data-key': `${f.path}.${i}.icon`, 'aria-label': `Link ${i + 1} icon`, onchange: e => this.#set([...path, i, 'icon'], e.target.value) },
      h('option', { value: '' }, 'icon'), [...new Set([...LINK_ICONS, ...(links[i]?.icon ? [str(links[i].icon)] : [])])].map(o => h('option', { value: o, selected: o === links[i]?.icon }, o)))
    const remove = i => { const seq = this.#node(path); seq.delete(i); if (!seq.items.length) this.#doc.deleteIn(path); this.#restructured() }
    return h('div', { className: 'rows' },
      links.map((_, i) => h('div', { className: 'row' }, input(i, 'url', 'https://…'), input(i, 'title', 'title', 'dl-link-title'), icon(i), input(i, 'type', 'type', 'dl-link-type'),
        h('button', { type: 'button', className: 'x', 'aria-label': `Remove link ${i + 1}`, onclick: () => remove(i) }, '×'))),
      h('input', { ...common, 'data-key': `${f.path}.${links.length}.url`, placeholder: 'Add a link URL…', type: 'url',
        onchange: e => {
          const url = e.target.value.trim()
          if (!url) return
          const seq = this.#node(path)
          if (isSeq(seq)) seq.add(this.#doc.createNode({ url })); else this.#set(path, [{ url }])
          this.#restructured()
        } }),
      h('datalist', { id: 'dl-link-title' }, LINK_TITLES.map(x => new Option('', x))),
      h('datalist', { id: 'dl-link-type' }, LINK_TYPES.map(x => new Option('', x))))
  }

  // ---------------------------------------------------------------- dropdowns
  // Hardcoded options and the entities of the right kinds declared elsewhere in this file
  #staticSuggestions(f) {
    const out = (f.options ?? []).map(value => ({ value }))
    if (f.ref) {
      for (const d of this.#docs) {
        const k = d.get('kind'), name = d.getIn(['metadata', 'name']), ns = d.getIn(['metadata', 'namespace'])
        if (d === this.#doc || !name || !f.ref.kinds.includes(k)) continue
        out.push({ value: `${k === f.ref.default ? '' : `${k.toLowerCase()}:`}${ns && ns !== 'default' ? `${ns}/` : ''}${name}`, label: `${k} in this file` })
      }
    }
    return out
  }

  #options(opts) {
    const seen = new Set()
    return opts.filter(o => !seen.has(o.value) && seen.add(o.value)).map(o => new Option(o.label ?? '', o.value))
  }

  // Adds the host's lookup results (e.g. GitLab groups) to a field's datalist, searching as you type
  #suggest(f, input) {
    if (!f.source || !this.#lookup) return
    const dl = this.shadowRoot.getElementById(`dl-${f.path}`)
    const q = input.value.replace(/^[a-z]+:/i, '').trim()
    clearTimeout(this.#timer)
    this.#timer = setTimeout(async () => {
      const key = `${f.source}\n${q}`
      if (!this.#cache.has(key)) this.#cache.set(key, Promise.resolve(this.#lookup(f.source, q)).catch(() => { this.#cache.delete(key); return [] }))
      const remote = await this.#cache.get(key)
      if (dl?.isConnected) dl.replaceChildren(...this.#options([...this.#staticSuggestions(f), ...remote]))
    }, q ? 250 : 0)
  }

  // ---------------------------------------------------------------- issues
  #showIssues() {
    const root = this.shadowRoot
    const other = root.querySelector('[data-issues]')
    if (!other) return
    root.querySelectorAll('.msg').forEach(m => m.replaceChildren())
    other.querySelectorAll('div').forEach(d => d.remove())
    const all = this.issues
    root.querySelectorAll('nav button').forEach((b, i) => b.classList.toggle('bad', all.some(x => x.entity === i && x.level === 'error')))
    const fields = [...root.querySelectorAll('[data-field]')].sort((a, b) => b.dataset.field.length - a.dataset.field.length)
    for (const issue of all.filter(x => x.entity === this.#i)) {
      const el = fields.find(e => issue.path === e.dataset.field || issue.path.startsWith(`${e.dataset.field}.`))
      const sub = el ? issue.path.slice(el.dataset.field.length + 1) : issue.path
      const at = !sub ? '' : /^\d+$/.test(sub) ? `${JSON.stringify(this.#get([...split(el.dataset.field), +sub]))}: ` : `${sub}: `
      ;(el?.querySelector('.msg') ?? other).append(h('div', { className: issue.level }, at + issue.message))
    }
    other.hidden = !other.querySelector('div')
  }
}

customElements.define('catalog-editor', CatalogEditor)
