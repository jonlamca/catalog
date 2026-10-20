# Software Catalog

Tools for registering software in the Developer Portal's [Backstage software catalog](https://backstage.io/docs/features/software-catalog/).

## Catalog Editor

`catalog-editor/` is a one-page static site where a product owner registers a repository in the catalog without writing YAML:

1. **Sign in with GitLab.** OAuth 2.0 with PKCE: a public client, no secret, no server. The token stays in the tab's `sessionStorage`.
2. **Pick a project.** Its `catalog-info.yaml` loads from the default branch. If the default branch has none, you choose the branch to start from. A new file is filled in from the project: its name comes from the slug (`group/project` becomes `group-project`), and the title and description come from GitLab.
3. **Edit** in the form or in the YAML beside it; each updates the other. Comments, key order and entities the form doesn't cover are kept.
4. **Save.** One commit to a branch, never the default branch or a protected one, then an optional merge request. The catalog changes when the merge request is merged.

### What a repository registers

The form covers the repository-level profile: what a product owner registers in their own repository.

| | Fields |
|---|---|
| **Component**: the software this repository builds | type, lifecycle, owner, IT product, APIs provided and consumed |
| **API**: an interface the component exposes | type, lifecycle, owner, IT product, definition |
| **Both** | name, title, description, tags, links, annotations |

Other kinds come from elsewhere: IT products (`System`) come from ITPD, and teams and people (`Group`, `User`) come from GitLab. If a file contains them, they are kept unchanged and flagged as warnings.

Every field has a note beside it explaining it. The dropdowns are editable:

| Dropdown | Values |
|---|---|
| Owner | GitLab: the project's groups and members, or a search of all groups and users |
| Tags | The project's GitLab topics, GitLab topic search, and common languages and frameworks |
| Type, lifecycle, API type | Backstage's well-known values plus a few more, and **Other…** for your own |
| IT product, APIs | Entities declared in the same file; otherwise typed |
| Definition, link title and type, annotation keys and values | Common values |

Group names follow Backstage's GitLab org provider (`defaultGroupNameTransformer`), so owners resolve.

### Validator

`validate()` and `validateAll()` in `catalog.js` check:

- the envelope, and the required fields of each kind;
- value types;
- the Backstage formats: names, tags, annotation keys, entity references and link URLs;
- duplicate entities in a file.

Errors block saving; warnings (anything outside the profile) don't. The validator has no DOM or GitLab dependency, so it can also run in CI.

### Run it locally

```bash
cd catalog-editor
npm install
npm test
npm start
```

`npm start` serves the editor on http://localhost:8080. Without `config.json` you can edit and copy YAML, but not sign in. To sign in, register `http://localhost:8080/` as a redirect URI on a GitLab OAuth application (not confidential, scope `api`). Then create `catalog-editor/config.json`:

```json
{ "url": "https://gitlab.example.com", "clientId": "<application ID>", "orgGroup": "" }
```

### Deploy

`.gitlab-ci.yml` publishes the editor to GitLab Pages on the default branch. It needs `GITLAB_OAUTH_CLIENT_ID`, and the OAuth application must have `<Pages URL>/` as a redirect URI; the pipeline file's header describes every variable. The page's Content-Security-Policy lets the token go only to that GitLab.

### Reuse in a VS Code extension

The logic is plain ES modules, with `yaml` as the only dependency:

| File | What it is | Runs in |
|---|---|---|
| `catalog.js` | the schema, YAML in and out (comments kept), validator, `nameFromSlug()` | anywhere: webview, extension host, Node, CI |
| `catalog-editor.js` | the `<catalog-editor>` web component | any page or webview |
| `gitlab.js` | `gitlab(url, token)` REST client and `lookups()` for the dropdowns; PKCE sign-in for browsers | anywhere with `fetch`; sign-in in a browser only |
| `app.js`, `index.html` | this site: sign-in, project and branch picking, saving | browser |

The component's host contract:

```js
editor.value = text                                // load a file; read it back after edits
editor.addEventListener('change', …)               // fired after every edit in the form
editor.issues                                      // the validator's findings
editor.lookup = async (source, query) => [{ value, label }]   // 'owner' | 'tag' dropdown data, optional
editor.defaults = { name }                         // metadata for entities added with + Entity
```

Theming uses `--ce-*` custom properties, which fall back to VS Code's theme variables.
