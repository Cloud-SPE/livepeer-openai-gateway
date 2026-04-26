# bridge-ui/shared

Cross-UI primitives shared by `bridge-ui/portal` and `bridge-ui/admin`. **Not** an npm package — a directory of source files imported by consumers via relative paths (`import { ObservableController } from '../shared/controllers/observable-controller.js'`). Each consumer's Vite build tree-shakes shared source into the consumer bundle and resolves `lit` / `rxjs` against the consumer's `node_modules`.

`package.json` here declares **peerDependencies only** to document version expectations; there are no own deps, no build, no `node_modules`.

## What belongs here

- Cross-UI CSS layers: `@layer reset`, `@layer tokens`, `@layer base`, `@layer utilities`. (Per-module `@layer layout` and `@layer components` stay in the consumer's stylesheet.)
- `controllers/observable-controller.js` — Lit ↔ RxJS glue, no domain knowledge.
- `lib/api-base.js` — `createApi(...)` factory; consumers wrap with their own auth strategy.
- `lib/validators.js` — runtime-validator combinators (the primitives, not the schemas).
- `lib/session-storage.js` — generic sessionStorage helpers (key namespacing, JSON wrap).
- `lib/events.js` — `bridge:`-namespaced CustomEvent helpers.
- `lib/route.js` — hash-route allowlist + View-Transition swap helper.
- `components/` — generic web components: button, dialog, confirm-dialog, table, toast, spinner, popover-menu.

## What does not belong

- Domain services (`account.service`, `nodes.service`).
- App shell components (`portal-app`, `admin-app`).
- Page components.
- Endpoint-shape response schemas.
- Auth-header strategy details (Bearer vs admin-token + actor).

## Light DOM caveat

Consumers use `createRenderRoot() { return this; }` (light DOM) so cascade layers reach every component. Lit's `static styles` is silently ignored in light DOM. Generic shared components instead inject their styles into `document.adoptedStyleSheets` once on first construction, idempotent and keyed by tag name. See `components/_adopt-styles.js`.
