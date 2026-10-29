// node catalog-editor/catalog.test.js — the core module: round trip, kind change, validator (repository-level profile)
import assert from 'node:assert/strict'
import { nameFromSlug, newEntity, parse, registry, setKind, stringify, validate, validateAll } from './catalog.js'
import { Doc, fromJS, parseAll } from './yaml.js'

const file = `# owned by the Acme team
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: artist-web # keep me
  tags: [java, Web Site]
  annotations:
    gitlab.com/project-slug: acme/artist-web
    Bad_Prefix/x: "1"
  links:
    - url: not-a-url
spec:
  type: service
  lifecycle: beta
  owner: group:acme
  dependsOn: [artist-db]
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata: { name: artist-api }
spec: { type: openapi, lifecycle: production, owner: acme, definition: { $text: ./openapi.yaml } }
`

// Round trip: an untouched file keeps its comments; an edit keeps them too
const docs = parse(file)
assert.equal(docs.length, 2)
docs[0].set(['metadata', 'title'], 'Artist Web')
const out = stringify(docs)
assert.match(out, /# owned by the Acme team/)
assert.match(out, /name: artist-web # keep me/)
assert.match(out, /title: Artist Web/)
assert.equal(parse(out).length, 2)

// Validator: each documented rule, by path
const issues = validateAll(docs)
const at = (path, level = 'error') => issues.find(i => i.path === path && i.level === level)
assert.ok(at('metadata.tags.1'), 'tag format')
assert.ok(!at('metadata.tags.0'), 'a valid tag passes')
assert.ok(at('metadata.annotations.Bad_Prefix/x'), 'annotation key prefix must be a lowercase domain')
assert.ok(at('metadata.links.0.url'), 'link url')
assert.ok(!at('spec.lifecycle') && !at('spec.lifecycle', 'warning'), 'your own lifecycle (beta) is fine: the dropdowns are editable')
assert.ok(at('spec.dependsOn', 'warning'), 'fields outside the repository-level profile are flagged')
assert.ok(!at('spec.dependsOn'), '…but not rejected')
assert.equal(issues.filter(i => i.entity === 1).length, 0, 'the API entity is valid')

assert.deepEqual(validate({ apiVersion: 'backstage.io/v1alpha1', kind: 'Component', metadata: {}, spec: {} }).map(i => i.path),
  ['metadata.name', 'spec.type', 'spec.lifecycle', 'spec.owner'])
assert.ok(validate({ apiVersion: 'x', kind: 'Component', metadata: { name: 123 }, spec: { type: 'service', lifecycle: 'production', owner: 'x' } })
  .some(i => i.path === 'metadata.name' && /string/.test(i.message)), 'values must be strings')
assert.ok(validate(['not', 'a', 'map'])[0].message.includes('mapping'))
assert.ok(validateAll(parse('a: [')).length > 0, 'YAML errors are issues')

// Duplicate entities in one file
const dup = validateAll(parse(`${stringify([newEntity('API', { name: 's' }, { owner: 'acme' })])}---\n${stringify([newEntity('API', { name: 's' }, { owner: 'acme' })])}`))
assert.ok(dup.some(i => i.entity === 1 && /same kind and name/.test(i.message)))

// Kinds a repository does not register: a warning that says where they come from
assert.match(validate({ apiVersion: 'backstage.io/v1alpha1', kind: 'Group', metadata: { name: 'acme' }, spec: {} })[0].message, /GitLab/)
assert.match(validate({ apiVersion: 'backstage.io/v1alpha1', kind: 'System', metadata: { name: 'p' }, spec: {} })[0].message, /registry/)

// Kind change keeps fields and seeds the new kind's required ones
const c = newEntity('Component', { name: 'artist-api' }, { owner: 'acme' })
setKind(c, 'API')
assert.equal(c.get(['kind']), 'API')
assert.equal(c.get(['spec', 'owner']), 'acme')
assert.equal(c.get(['spec', 'definition', '$text']), './openapi.yaml')
assert.equal(c.get(['spec', 'type']), 'openapi', 'a Component type is not an API type')
assert.equal(c.get(['spec', 'lifecycle']), 'experimental', 'a value both kinds accept is kept')

// Names from the GitLab slug: unique across groups, valid as catalog names, the org group prefix dropped
assert.equal(nameFromSlug('acme/artist-web'), 'acme-artist-web')
assert.equal(nameFromSlug('example/acme/platform/api', 'example'), 'acme-platform-api')
assert.equal(nameFromSlug('team_a/My.Project'), 'team_a-My.Project')
assert.equal(validate({ apiVersion: 'backstage.io/v1alpha1', kind: 'Component', metadata: { name: nameFromSlug('a/-b..c-/d') }, spec: { type: 'service', lifecycle: 'production', owner: 'acme' } }).length, 0)

// The registry: entities by project, projects with nothing registered, and errors tied to their project and entity
const reg = registry([
  { path: 'a/one', text: 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: { name: one }\nspec: { type: service, lifecycle: production, owner: acme }\n---\nkind: API\nmetadata: { name: one-api }\n' },
  { path: 'a/two', text: null },
  { path: 'a/blank', text: '\n' },
  { path: 'a/three', text: 'a: [' },
])
assert.deepEqual(reg.entities.map(x => [x.project.path, x.entity.metadata.name, x.valid]), [['a/one', 'one', true], ['a/one', 'one-api', false]])
assert.deepEqual(reg.unregistered.map(p => p.path), ['a/two', 'a/blank'])
assert.ok(reg.errors.some(x => x.project.path === 'a/three' && /line 1/.test(x.issue.message)), 'unreadable file')
assert.ok(reg.errors.some(x => x.project.path === 'a/one' && x.issue.entity === 1 && x.issue.path === 'apiVersion'), 'entity 2 of a/one')

// ---------------------------------------------------------------- yaml.js: the reader and writer
// An unchanged file comes back exactly: comments, blank lines, quoting, flow and block styles
const canonical = `# leading comment
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: a # inline
  description: >-
    folded
    text
  tags: [java, "web site"]
  annotations:
    "quoted/key": 'it''s'

  links:
    - url: https://x.example/d
      title: Dashboard
spec:
  version: 1.0
  empty:
  flag: yes
  definition: |
    openapi: 3.0.0
    info:
      title: x
---
kind: API
metadata: { name: b }
# trailing comment
`
assert.equal(stringify(parseAll(canonical)), canonical)

// Values survive a write and a read, whatever characters they hold
const tricky = ['', ' a', 'a ', '#x', 'a #b', 'a: b', 'a:', '- x', '@x', 'null', '~', '123', '1e3', '0x1F', 'true', 'yes', '.inf',
  'multi\nline', 'trail\n', 'two\n\n', '  indented\nfirst', "quote's", '"dq"', 'tab\there', 'é ü 中', '[x]', 'x, y', '{a}', 'back\\slash']
const value = { s: tricky, n: [1, 2.5, -3, true, false, null], m: { 'k with space': 'v', '1': 'one', 'a/b.c': ['x', { y: 'z' }] }, e: [], o: {} }
for (const flow of [false, true]) {
  const d = new Doc(fromJS(value))
  if (flow) d.node(['s']).flow = d.node(['m', 'a/b.c']).flow = true
  assert.deepEqual(parseAll(stringify([d]))[0].toJS(), value, `round trip (flow: ${flow})`)
}

// Plain scalars resolve as in YAML 1.2's core schema, like Backstage's reader
assert.deepEqual(parseAll('a: 1.0\nb: yes\nc: "true"\nd: ~\ne: 0o17\nf: 2026-10-28')[0].toJS(), { a: 1, b: 'yes', c: 'true', d: null, e: 15, f: '2026-10-28' })

// Indentless lists, multi-line plain and quoted scalars, and multi-line flow collections read correctly
assert.deepEqual(parseAll('a:\n- x\n- y\nb: one\n  two\nc: "x\n  y"\nd: [p,\n  q]')[0].toJS(), { a: ['x', 'y'], b: 'one two', c: 'x y', d: ['p', 'q'] })

// What it does not read is an error with a line number, never a guess
for (const [bad, why] of [['a: &x 1', /anchors/], ['a: *x', /aliases/], ['a: !!str 1', /tags/], ['a: [1, 2', /unclosed/], ['a:\n\t- x', /tabs/],
  ['a: 1\na: 2', /duplicate/], ['a: 1\n  b: 2', /indentation/], ['? a\n: b', /complex/], ['a: "\\u12"', /escape/]]) {
  assert.match(parseAll(bad)[0].errors[0]?.message ?? '', why, bad)
  assert.match(parseAll(bad)[0].errors[0].message, /\(line \d+\)/, `${bad}: a line number`)
}

console.log('catalog.js: ok')
