// A small YAML reader and writer for catalog-info.yaml, with no dependencies.
// It covers what descriptor files use: block mappings and sequences; plain, quoted and block (| >) scalars;
// flow [ ] and { } collections; documents separated by ---; and comments and blank lines, which edits keep.
// Anything else (anchors, aliases, tags, complex keys, tab indentation) is reported as an error, never guessed.
// Plain scalars resolve as in YAML 1.2's core schema, like Backstage's own reader: null, booleans, numbers, else strings.
// ponytail: a subset of YAML; if real files need anchors or tags, put a full parser behind the same Doc API.
//
// Nodes: { kind: 'map', pairs: [{ key, rawKey?, node, before: [], inline }], flow? }
//        { kind: 'seq', items: [{ node, before: [], inline }], flow? }
//        { kind: 'scalar', value, style?: 'plain' | 'single' | 'double' | 'block', raw?, header?, lines? }
// before: the comment and blank lines above an entry; inline: the comment after it; raw: the text as written.

class YAMLError extends Error {
  constructor(message, line) { super(line ? `${message} (line ${line})` : message); this.text = message; this.line = line }
}

// ---------------------------------------------------------------- scalars
export function resolve(s) {
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null
  if (/^(true|True|TRUE)$/.test(s)) return true
  if (/^(false|False|FALSE)$/.test(s)) return false
  if (/^[-+]?[0-9]+$/.test(s)) return parseInt(s, 10)
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8)
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16)
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return parseFloat(s)
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s[0] === '-' ? -Infinity : Infinity
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN
  return s
}

const plain = raw => ({ kind: 'scalar', value: resolve(raw), style: 'plain', raw })
const ESC = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' }

/** A quoted scalar starting at s[i]: [node, end], or null when the closing quote is not in s */
function readQuoted(s, i) {
  const q = s[i]
  let out = ''
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j]
    if (q === "'") {
      if (c !== "'") out += c
      else if (s[j + 1] === "'") { out += "'"; j++ }
      else return [{ kind: 'scalar', value: out, style: 'single', raw: s.slice(i, j + 1) }, j + 1]
    } else if (c === '"') return [{ kind: 'scalar', value: out, style: 'double', raw: s.slice(i, j + 1) }, j + 1]
    else if (c !== '\\') out += c
    else {
      const e = s[++j], n = { x: 2, u: 4, U: 8 }[e], hex = n && s.slice(j + 1, j + 1 + n)
      if (n && !/^[0-9a-fA-F]+$/.test(hex)) throw new YAMLError(`bad escape \\${e}${hex}`)
      if (n) { out += String.fromCodePoint(parseInt(hex, 16)); j += n }
      else if (e in ESC) out += ESC[e]
      else throw new YAMLError(`unknown escape \\${e}`)
    }
  }
  return null
}

// ---------------------------------------------------------------- flow collections
const skip = (s, i) => { while (s[i] === ' ' || s[i] === '\t') i++; return i }

/** A flow collection starting at s[i]: [node, end], or null when it does not close within s */
function readFlow(s, i) {
  const close = s[i] === '[' ? ']' : '}'
  const node = close === ']' ? { kind: 'seq', items: [], flow: true } : { kind: 'map', pairs: [], flow: true }
  for (i = skip(s, i + 1); ; i = skip(s, i)) {
    if (i >= s.length) return null
    if (s[i] === close) return [node, i + 1]
    let r = readFlowItem(s, i)
    if (!r) return null
    if (node.kind === 'seq') node.items.push({ node: r[0], before: [], inline: '' })
    else {
      const key = String(r[0].value ?? '')
      let value = plain('')
      i = skip(s, r[1])
      if (s[i] === ':') {
        i = skip(s, i + 1)
        if (s[i] !== ',' && s[i] !== close) { const v = readFlowItem(s, i); if (!v) return null; [value, i] = v }
      }
      r = [value, i]
      node.pairs.push({ key, node: value, before: [], inline: '' })
    }
    i = skip(s, r[1])
    if (s[i] === ',') i++
    else if (i < s.length && s[i] !== close) throw new YAMLError(`expected , or ${close}`)
  }
}

function readFlowItem(s, i) {
  if (s[i] === '[' || s[i] === '{') return readFlow(s, i)
  if (s[i] === '"' || s[i] === "'") return readQuoted(s, i)
  if ('&*!'.includes(s[i])) throw new YAMLError('anchors, aliases and tags are not supported')
  let j = i
  while (j < s.length && !',[]{}'.includes(s[j]) && !(s[j] === ':' && /^(\s|,|]|}|$)/.test(s.slice(j + 1, j + 2))) && !(s[j] === '#' && /\s/.test(s[j - 1]))) j++
  return j >= s.length ? null : [plain(s.slice(i, j).trim()), j]
}

// ---------------------------------------------------------------- block structure
const isDash = t => t === '-' || t.startsWith('- ')

/** "key: rest" → { key, rawKey, rest }, or null when the line is not a mapping entry */
function keyOf(t) {
  if (t.startsWith('? ')) throw new YAMLError('complex keys are not supported')
  if (t[0] === '"' || t[0] === "'") {
    const r = readQuoted(t, 0)
    if (!r) return null
    const after = t.slice(r[1])
    return /^\s*:(\s|$)/.test(after) ? { key: r[0].value, rawKey: r[0].raw, rest: after.replace(/^\s*:/, '').trim() } : null
  }
  if ('[{#'.includes(t[0])) return null
  const m = /^([^#]*?)\s*:(\s+|$)(.*)$/.exec(t)
  return m && m[1] ? { key: m[1], rawKey: m[1], rest: m[3].trim() } : null
}

/** Plain text and its trailing comment: "a b # c" → ["a b", "# c"] */
const splitComment = t => { const m = /(^|\s)#/.exec(t); return m ? [t.slice(0, m.index).trimEnd(), t.slice(m.index).trim()] : [t, ''] }

class Parser {
  constructor(lines) { this.lines = lines; this.i = 0; this.pending = []; this.seen = false }

  // The next content line; comment and blank lines on the way are kept for the next entry
  peek() {
    for (; this.i < this.lines.length; this.i++) {
      const l = this.lines[this.i]
      if (l.text === '') { if (this.pending.at(-1) !== '') this.pending.push('') }
      else if (l.text[0] === '#') this.pending.push(l.text)
      else if (l.ws.includes('\t')) throw new YAMLError('tabs cannot indent YAML', l.no)
      else return l
    }
    return null
  }

  before() {
    const b = this.pending
    this.pending = []
    if (!this.seen) { while (b[0] === '') b.shift(); this.seen = true }
    return b
  }

  blockAt(ind) {
    const l = this.peek()
    if (isDash(l.text)) return this.seq(ind)
    if (keyOf(l.text)) return this.map(ind)
    this.i++
    return this.value(l.text, ind - 1, l).node
  }

  map(ind) {
    const node = { kind: 'map', pairs: [] }
    for (let l; (l = this.peek()) && l.indent === ind && !isDash(l.text);) {
      const k = keyOf(l.text)
      if (!k) throw new YAMLError('expected key: value', l.no)
      if (node.pairs.some(p => p.key === k.key)) throw new YAMLError(`duplicate key ${k.key}`, l.no)
      const pair = { key: k.key, rawKey: k.rawKey, before: this.before(), inline: '', node: null }
      this.i++
      if (k.rest === '' || k.rest[0] === '#') {
        pair.inline = k.rest
        const next = this.peek()   // a sequence may sit at its key's own indentation
        pair.node = next && (next.indent > ind || (next.indent === ind && isDash(next.text))) ? this.blockAt(next.indent) : plain('')
      } else Object.assign(pair, this.value(k.rest, ind, l))
      node.pairs.push(pair)
    }
    return node
  }

  seq(ind) {
    const node = { kind: 'seq', items: [] }
    for (let l; (l = this.peek()) && l.indent === ind && isDash(l.text);) {
      const item = { before: this.before(), inline: '', node: null }
      const rest = l.text.slice(1).trimStart()
      if (rest === '' || rest[0] === '#') {
        this.i++
        item.inline = rest
        const next = this.peek()
        item.node = next && next.indent > ind ? this.blockAt(next.indent) : plain('')
      } else if (isDash(rest) || keyOf(rest)) {
        // "- key: value" or "- - x": the rest is a block of its own, at its own column
        this.lines[this.i] = { ...l, indent: ind + l.text.length - rest.length, text: rest }
        item.node = this.blockAt(this.lines[this.i].indent)
      } else { this.i++; Object.assign(item, this.value(rest, ind, l)) }
      node.items.push(item)
    }
    return node
  }

  // A value written after "key:" or "-" on line l, continued on more-indented lines; ind: the key's or dash's column
  value(t, ind, l) {
    if ('&*!'.includes(t[0])) throw new YAMLError('anchors, aliases and tags are not supported', l.no)
    if (t[0] === '|' || t[0] === '>') {
      const m = /^([|>])([1-9]?)([-+]?)([1-9]?)\s*(#.*)?$/.exec(t)
      if (!m) throw new YAMLError('bad block scalar header', l.no)
      return { node: this.blockScalar(m[1], m[3], +(m[2] || m[4]), ind, t.replace(/\s*#.*$/, '')), inline: m[5] ?? '' }
    }
    if ('[{"\''.includes(t[0])) {
      for (let s = t; ;) {
        const r = t[0] === '[' || t[0] === '{' ? readFlow(s, 0) : readQuoted(s, 0)
        if (r) {
          const rest = s.slice(r[1]).trim()
          if (rest && rest[0] !== '#') throw new YAMLError('unexpected text after a value', l.no)
          if (s !== t) delete r[0].raw   // spans lines: written fresh
          return { node: r[0], inline: rest }
        }
        const next = this.lines[this.i]
        if (!next || (next.text !== '' && next.indent <= ind)) throw new YAMLError(t[0] === '[' || t[0] === '{' ? 'unclosed [ or {' : 'unclosed quote', l.no)
        s += next.text === '' ? '\n' : ` ${next.text}`
        this.i++
      }
    }
    let [v, inline] = splitComment(t)
    let folded = false
    for (let next; !inline && (next = this.lines[this.i]) && next.text !== '' && next.text[0] !== '#' && next.indent > ind; this.i++) {
      if (keyOf(next.text)) throw new YAMLError('bad indentation: a key under a value', next.no)
      const [more, comment] = splitComment(next.text)
      v += ` ${more}`
      inline = comment
      folded = true
    }
    const node = plain(v)
    if (folded) delete node.raw
    return { node, inline }
  }

  blockScalar(style, chomp, explicit, ind, header) {
    const lines = []
    let base = explicit ? ind + explicit : 0
    for (; this.i < this.lines.length; this.i++) {
      const l = this.lines[this.i]
      if (l.text === '') { lines.push(''); continue }
      if (!base) base = l.indent
      if (l.indent < base || l.indent <= ind) break
      lines.push(l.raw.slice(base).trimEnd())
    }
    let trail = 0
    while (lines.at(-1) === '') { lines.pop(); trail++ }
    if (chomp !== '+') this.i -= trail      // blank lines after it separate entries
    const body = style === '|' ? lines.join('\n') : fold(lines)
    const value = chomp === '-' ? body : chomp === '+' ? body + '\n'.repeat(trail + 1) : body + (lines.length ? '\n' : '')
    return { kind: 'scalar', value, style: 'block', header, lines: chomp === '+' ? [...lines, ...Array(trail).fill('')] : lines }
  }
}

// A folded (>) scalar: lines join with spaces; blank lines and more-indented lines keep their breaks
function fold(lines) {
  return lines.reduce((out, line, k) => {
    if (k === 0) return line
    const prev = lines[k - 1]
    if (line === '') return `${out}\n`
    if (prev === '') return out + line
    return out + (/^\s/.test(line) || /^\s/.test(prev) ? '\n' : ' ') + line
  }, '')
}

// ---------------------------------------------------------------- documents
export class Doc {
  constructor(root = { kind: 'map', pairs: [] }, { start = false, errors = [], head = [], after = [] } = {}) {
    Object.assign(this, { root, start, errors, head, after })
  }

  /** The node at a path (map keys as strings, list indexes as numbers), or undefined */
  node(path) {
    let n = this.root
    for (const seg of path) n = entryOf(n, seg)?.node
    return n
  }

  /** The plain JavaScript value at a path */
  get(path = []) { return toJS(this.node(path)) }

  /** The [key, value] pairs of the mapping at a path, in file order */
  entries(path) {
    const n = this.node(path)
    return n?.kind === 'map' ? n.pairs.map(p => [p.key, toJS(p.node)]) : []
  }

  /** Set a value, creating mappings (or a list, for a numeric next segment) on the way. Comments and style stay. */
  set(path, value) {
    let n = this.root
    for (let k = 0; k < path.length - 1; k++) {
      const want = typeof path[k + 1] === 'number' ? 'seq' : 'map'
      const e = entryOf(n, path[k]) ?? addEntry(n, path[k], empty(want))
      if (e.node.kind === 'scalar') e.node = empty(want)
      n = e.node
    }
    const e = entryOf(n, path.at(-1))
    if (e) e.node = fromJS(value, e.node); else addEntry(n, path.at(-1), fromJS(value))
  }

  delete(path) {
    const n = this.node(path.slice(0, -1)), seg = path.at(-1)
    if (n?.kind === 'map') n.pairs = n.pairs.filter(p => p.key !== String(seg))
    if (n?.kind === 'seq' && seg < n.items.length) n.items.splice(seg, 1)
  }

  /** Rename the key at a path, keeping its place and comments */
  rename(path, key) {
    const e = entryOf(this.node(path.slice(0, -1)), path.at(-1))
    if (e) { e.key = key; delete e.rawKey }
  }

  toJS() { return toJS(this.root) }

  toString(index = 0) {
    const out = [...this.head]
    if (index > 0 || this.start) out.push('---')
    if (this.root) out.push(...emitTop(this.root))
    out.push(...this.after)
    return `${out.join('\n')}\n`
  }
}

const empty = kind => (kind === 'seq' ? { kind, items: [] } : { kind, pairs: [] })
const entries = n => (n.kind === 'map' ? n.pairs : n.items)

function entryOf(n, seg) {
  if (n?.kind === 'map') return n.pairs.find(p => p.key === String(seg))
  if (n?.kind === 'seq') return n.items[seg]
}

function addEntry(n, seg, node) {
  const e = { node, before: [], inline: '' }
  if (n.kind === 'map') n.pairs.push(Object.assign(e, { key: String(seg) }))
  else if (seg === n.items.length) n.items.push(e)
  else throw new Error(`no list item ${seg}`)
  return e
}

/** A node for a JavaScript value; an old scalar keeps its quoting style, and stays as is when the value is the same */
export function fromJS(v, old) {
  if (Array.isArray(v)) return { kind: 'seq', items: v.map(x => ({ node: fromJS(x), before: [], inline: '' })) }
  if (v !== null && typeof v === 'object') return { kind: 'map', pairs: Object.entries(v).map(([key, x]) => ({ key, node: fromJS(x), before: [], inline: '' })) }
  if (old?.kind === 'scalar' && Object.is(old.value, v)) return old
  return { kind: 'scalar', value: v, style: old?.kind === 'scalar' && old.style !== 'block' ? old.style : 'plain' }
}

export function toJS(n) {
  if (!n) return undefined
  if (n.kind === 'seq') return n.items.map(e => toJS(e.node))
  if (n.kind === 'scalar') return n.value
  const o = {}
  for (const p of n.pairs) Object.defineProperty(o, p.key, { value: toJS(p.node), enumerable: true, writable: true, configurable: true })
  return o
}

/** Every document in a file. A document that cannot be read has errors (and no root); the others are unaffected. */
export function parseAll(text) {
  const segs = [{ start: false, lines: [] }]
  String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').forEach((raw, k) => {
    const content = segs.at(-1).lines.some(l => l.text && l.text[0] !== '#')
    if (/^---(\s|$)/.test(raw)) {
      segs.push({ start: true, lines: [] })
      const rest = raw.slice(3).trim()
      if (rest && rest[0] !== '#') segs.at(-1).lines.push({ no: k + 1, raw: rest, ws: '', indent: 0, text: rest })
    } else if (/^\.\.\.(\s|$)/.test(raw)) segs.push({ start: false, lines: [] })
    else if (raw[0] === '%' && !content) { /* a directive: nothing to keep */ }
    else {
      const ws = /^[ \t]*/.exec(raw)[0]
      segs.at(-1).lines.push({ no: k + 1, raw, ws, indent: ws.length, text: raw.slice(ws.length).trimEnd() })
    }
  })
  const docs = []
  let head = []
  for (const seg of segs) {
    const comments = seg.lines.filter(l => l.text[0] === '#').map(l => l.text)
    if (!seg.lines.some(l => l.text && l.text[0] !== '#')) {     // only comments: they go with the next document
      head = [...head, ...comments]
      continue
    }
    docs.push(parseDoc(seg.lines, seg.start, head))
    head = []
  }
  if (head.length) (docs.at(-1)?.after ?? []).push(...head)
  return docs.filter(d => d.errors.length || d.root.pairs?.length !== 0 || d.head.length)
}

function parseDoc(lines, start, head) {
  const p = new Parser(lines)
  try {
    const root = p.blockAt(p.peek().indent)
    const extra = p.peek()
    if (extra) throw new YAMLError('unexpected indentation', extra.no)
    const after = p.pending
    while (after.at(-1) === '') after.pop()
    return new Doc(root, { start, head, after })
  } catch (e) {
    if (!(e instanceof YAMLError)) throw e
    const error = e.line ? e : new YAMLError(e.text, lines[Math.min(p.i, lines.length - 1)]?.no)
    return new Doc(null, { start, head, errors: [error] })
  }
}

export const stringify = docs => docs.map((d, i) => d.toString(i)).join('')

// ---------------------------------------------------------------- writing
const PLAIN_START = /^[-?:,[\]{}#&*!|>'"%@`]/
const plainSafe = (s, flow) => s !== '' && s === s.trim() && !s.includes('\n') && !PLAIN_START.test(s) && !/: |:$| #/.test(s)
  && resolve(s) === s && !(flow && /[,[\]{}]/.test(s))
const keyText = (k, flow) => (plainSafe(k, flow) ? k : JSON.stringify(k))

function emitTop(n) {
  if (n.kind === 'scalar') return scalarText(n, -2)
  return entries(n).length ? emitBlock(n, 0) : [n.kind === 'map' ? '{}' : '[]']
}

function emitBlock(n, ind) {
  const pad = ' '.repeat(ind), out = []
  for (const e of entries(n)) {
    for (const b of e.before) out.push(b && pad + b)
    const head = n.kind === 'map' ? `${pad}${e.rawKey ?? keyText(e.key)}:` : `${pad}-`
    const c = e.node, inline = e.inline ? ` ${e.inline}` : ''
    if (c.kind === 'scalar') {
      const [first, ...rest] = scalarText(c, ind)
      out.push(head + (first === '' ? '' : ` ${first}`) + inline, ...rest)
    } else if (!entries(c).length) out.push(`${head} ${c.kind === 'map' ? '{}' : '[]'}${inline}`)
    else if (c.flow && flowable(c)) out.push(`${head} ${flowText(c)}${inline}`)
    else if (n.kind === 'map' || inline) out.push(head + inline, ...emitBlock(c, ind + 2))
    else {
      // a collection in a list item: its first line goes after the dash
      const sub = emitBlock(c, ind + 2)
      const k = sub.findIndex(s => s.trim() && s.trim()[0] !== '#')
      sub[k] = `${pad}- ${sub[k].slice(ind + 2)}`
      out.push(...sub)
    }
  }
  return out
}

function scalarText(n, ind) {
  const pad = ' '.repeat(ind + 2)
  if (n.style === 'block' && n.lines) return [n.header, ...n.lines.map(l => l && pad + l)]
  if (n.raw !== undefined) return [n.raw]
  const v = n.value
  if (v === null) return ['null']
  if (typeof v === 'number') return [Number.isNaN(v) ? '.nan' : v === Infinity ? '.inf' : v === -Infinity ? '-.inf' : String(v)]
  if (typeof v !== 'string') return [String(v)]
  if (v.includes('\n')) {
    const body = v.replace(/\n+$/, ''), trail = v.length - body.length
    const header = `|${/^\s/.test(body) ? '2' : ''}${trail === 0 ? '-' : trail === 1 ? '' : '+'}`
    return [header, ...[...body.split('\n'), ...Array(Math.max(0, trail - 1)).fill('')].map(l => l && pad + l)]
  }
  if (n.style === 'single') return [`'${v.replaceAll("'", "''")}'`]
  return [n.style !== 'double' && plainSafe(v) ? v : JSON.stringify(v)]
}

const flowable = n => entries(n).every(e => !e.before.length && !e.inline
  && (e.node.kind === 'scalar' ? !(typeof e.node.value === 'string' && e.node.value.includes('\n')) : flowable(e.node)))

function flowItem(n) {
  if (n.kind !== 'scalar') return flowText(n)
  if (n.raw !== undefined) return n.raw
  return typeof n.value === 'string' && !plainSafe(n.value, true) ? JSON.stringify(n.value) : scalarText(n, 0)[0]
}

function flowText(n) {
  if (n.kind === 'seq') return `[${n.items.map(e => flowItem(e.node)).join(', ')}]`
  return n.pairs.length ? `{ ${n.pairs.map(p => `${keyText(p.key, true)}: ${flowItem(p.node)}`).join(', ')} }` : '{}'
}
