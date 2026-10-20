// node catalog-editor/catalog.test.js — the core module: round trip, kind change, validator (repository-level profile)
import assert from 'node:assert/strict'
import { nameFromSlug, newEntity, parse, setKind, stringify, validate, validateAll } from './catalog.js'

const file = `# owned by the EDP team
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: artist-web # keep me
  tags: [java, Web Site]
  annotations:
    gitlab.com/project-slug: edp/artist-web
    Bad_Prefix/x: "1"
  links:
    - url: not-a-url
spec:
  type: service
  lifecycle: beta
  owner: group:edp
  dependsOn: [artist-db]
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata: { name: artist-api }
spec: { type: openapi, lifecycle: production, owner: edp, definition: { $text: ./openapi.yaml } }
`

// Round trip: an untouched file keeps its comments; an edit keeps them too
const docs = parse(file)
assert.equal(docs.length, 2)
docs[0].setIn(['metadata', 'title'], 'Artist Web')
const out = stringify(docs)
assert.match(out, /# owned by the EDP team/)
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
const dup = validateAll(parse(`${stringify([newEntity('API', { name: 's' }, { owner: 'edp' })])}---\n${stringify([newEntity('API', { name: 's' }, { owner: 'edp' })])}`))
assert.ok(dup.some(i => i.entity === 1 && /same kind and name/.test(i.message)))

// Kinds a repository does not register: a warning that says where they come from
assert.match(validate({ apiVersion: 'backstage.io/v1alpha1', kind: 'Group', metadata: { name: 'edp' }, spec: {} })[0].message, /GitLab/)
assert.match(validate({ apiVersion: 'backstage.io/v1alpha1', kind: 'System', metadata: { name: 'p' }, spec: {} })[0].message, /ITPD/)

// Kind change keeps fields and seeds the new kind's required ones
const c = newEntity('Component', { name: 'artist-api' }, { owner: 'edp' })
setKind(c, 'API')
assert.equal(c.get('kind'), 'API')
assert.equal(c.getIn(['spec', 'owner']), 'edp')
assert.equal(c.getIn(['spec', 'definition', '$text']), './openapi.yaml')
assert.equal(c.getIn(['spec', 'type']), 'openapi', 'a Component type is not an API type')
assert.equal(c.getIn(['spec', 'lifecycle']), 'experimental', 'a value both kinds accept is kept')

// Names from the GitLab slug: unique across groups, valid as catalog names, the org group prefix dropped
assert.equal(nameFromSlug('edp/artist-web'), 'edp-artist-web')
assert.equal(nameFromSlug('statcan/edp/platform/api', 'statcan'), 'edp-platform-api')
assert.equal(nameFromSlug('team_a/My.Project'), 'team_a-My.Project')
assert.equal(validate({ apiVersion: 'backstage.io/v1alpha1', kind: 'Component', metadata: { name: nameFromSlug('a/-b..c-/d') }, spec: { type: 'service', lifecycle: 'production', owner: 'edp' } }).length, 0)

console.log('catalog.js: ok')
