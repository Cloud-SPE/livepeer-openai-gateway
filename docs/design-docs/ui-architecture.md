---
title: UI Architecture
status: accepted
last-reviewed: 2026-04-26
---

# UI Architecture

The bridge ships one or more browser web apps that talk to the bridge over HTTP. They live in `bridge-ui/` (sibling to `src/`), are built per-module by Vite, and are served by the bridge's customer Fastify instance via `@fastify/static` at module-specific path prefixes (`/portal/`, `/admin/console/`).

This document is the canonical reference for **how** every UI module in this repo is built. It is referenced by exec-plans; it never references plans (per [PLANS.md](../../PLANS.md)).

## Stack

- **Lit** (`^3.3`) — `LitElement` subclasses, **light DOM by default** (`createRenderRoot() { return this; }`). Cascade layers and `@scope` blocks reach every component without prop-drilling CSS custom properties. **Exception:** components that need `<slot>` projection use shadow DOM — see "Shadow vs light DOM" below.
- **RxJS** (`^7.8`) — services own `BehaviorSubject`s; pages subscribe via a Lit `ReactiveController` that calls `host.requestUpdate()` on each emission.
- **Modern CSS 2026** — cascade layers, native nesting, OKLCH + `light-dark()`, `color-mix`, `@property`, `@container`, `@scope`, View Transitions, Popover API, `@starting-style`, `clamp()`, `text-wrap`, `field-sizing`, `:has()`, `:user-invalid`. Browser-support floor: Chrome/Edge ≥ 122, Firefox ≥ 124, Safari ≥ 17.5.
- **Vite** (`^8`) — per-module dev server and build. No SSR.
- **Plain JS** (ES modules), **no UI TypeScript**. JSDoc `@type` annotations where useful.

Everything not on this list (React, Tailwind, CSS-in-JS, Next.js, SSR frameworks) is **explicitly excluded** for UI work.

## Workspace layout

```
bridge-ui/                        # sibling of src/, not under it
├── shared/                       # peerDependencies-only directory module
│   ├── package.json              # peerDependencies: lit, rxjs (no own deps, no build)
│   ├── README.md                 # what belongs / does not belong
│   ├── css/                      # @layer reset / tokens / base / utilities
│   ├── controllers/              # ObservableController (Lit ↔ RxJS glue)
│   ├── lib/                      # api-base, session-storage, validators, events, route
│   └── components/               # bridge-button, bridge-dialog, bridge-confirm-dialog,
│                                 # bridge-table, bridge-toast, bridge-spinner, bridge-popover-menu
├── portal/                       # one consumer per UI
│   ├── package.json              # deps: lit, rxjs, vite (versions match shared peerDependencies)
│   ├── vite.config.js
│   ├── index.html
│   ├── main.js
│   ├── portal.css                # @import from ../shared/css/*; per-module @layer layout/components blocks
│   ├── components/               # app shell + page components
│   └── lib/                      # api (wraps shared/api-base), session, schemas, services
└── admin/                        # second consumer, same structure as portal
```

Consumers import from shared via relative paths (`import { ObservableController } from '../shared/controllers/observable-controller.js'`). Vite resolves `lit` and `rxjs` against each consumer's `node_modules` and tree-shakes shared source into the consumer's bundle. No npm workspaces, no path aliases, no build step for `shared/`.

### Why sibling to `src/`, not under `src/ui/`

The `src/` tree is the bridge's TypeScript server. `bridge-ui/` is plain-JS browser bundles. Mixing them forces tsconfig coordination, mixed lint rules, and a mixed build graph for no gain. The bridge's [layer rule](./architecture.md) (`types → config → repo → service → runtime`) is unaffected because `bridge-ui/` does not import from `src/` — it talks to the bridge over HTTP only.

### What belongs in `shared/`

| Belongs                                      | Belongs in the consumer                                |
| -------------------------------------------- | ------------------------------------------------------ |
| `@layer reset / tokens / base / utilities`   | `@layer layout` and `@layer components` (page-specific)|
| `ObservableController` (no domain knowledge) | Domain services (`account.service`, `nodes.service`)   |
| `createApi(...)` factory                     | Auth-strategy wrapper (Bearer key vs. admin+actor)     |
| Validator combinators                        | Per-route response schemas                             |
| Generic web components                       | App shell + page components                            |
| Session-storage helpers + namespaced events  | Module-namespaced session keys                         |

Rule of thumb: if two consumers would write the same code, it goes in shared. If they'd write *similar* code that differs in a parameter, the parameterized factory goes in shared and each consumer passes its parameters.

### What does not belong in `shared/`

- Anything that imports from one specific consumer.
- Anything coupled to one specific endpoint shape.
- Anything that would force a consumer to drag in a transitive dependency it doesn't otherwise need.

## CSS architecture

Every consumer's stylesheet declares the layer order and pulls cross-UI layers from `shared/`:

```css
@layer reset, tokens, base, layout, components, utilities;
@import url("../shared/css/reset.css") layer(reset);
@import url("../shared/css/tokens.css") layer(tokens);
@import url("../shared/css/base.css") layer(base);
@import url("../shared/css/utilities.css") layer(utilities);
/* @layer layout and @layer components defined in this consumer's stylesheet */
```

### Tokens

`shared/css/tokens.css` defines the design-token catalogue:

- `:root { color-scheme: light dark; }`
- Color palette in **OKLCH**, each token resolved via `light-dark(<light>, <dark>)`. Example: `--surface-1: light-dark(oklch(98% 0.005 250), oklch(18% 0.01 250));`
- State variants derived via `color-mix()`: `--accent-hover: color-mix(in oklch, var(--accent), white 12%);`
- `@property` for animatable color tokens (focus rings, glows).
- Spacing scale `--space-1` … `--space-12`; type sizes via `clamp()`; radii, shadows, durations, easings.

Theming is by `color-scheme` only — no `[data-theme]` attribute swap. A future toggle flips `color-scheme: light` / `dark` on `:root`; tokens re-resolve through `light-dark()` automatically.

### Shadow vs light DOM

The default is **light DOM** so cascade layers and `@scope` rules from the consumer's stylesheet reach every component, and tokens flow naturally through inheritance. Components that don't accept slotted content from consumers (`bridge-spinner`, `bridge-table`, `bridge-toast`, `bridge-popover-menu`) keep this default. Their CSS is injected once into `document.adoptedStyleSheets` (`shared/components/_adopt-styles.js`) on first construction — Lit's `static styles` is ignored in light DOM.

Components that **do** accept slotted children — `bridge-button`, `bridge-dialog` — use **shadow DOM**. `<slot>` is a shadow-DOM-specific feature; in light DOM, `<slot>` is inert and consumer-slotted content stays outside the rendered template. For `bridge-button` this means the slotted text renders alongside the inner empty `<button>` instead of inside it (visually broken). For `bridge-dialog` it's worse: when `dialog.showModal()` runs, slotted action buttons end up outside the modal's top layer and become unclickable.

CSS custom properties cross the shadow boundary via inheritance, so the global `--accent`, `--surface-1`, etc. tokens still drive these components without re-declaration. They use `static styles = css\`...\`` for component-scoped CSS. One trade-off: native form submission doesn't cross the shadow boundary, so `<bridge-button type="submit">` manually calls `form.requestSubmit()` on the closest ancestor `<form>` to preserve the expected behavior.

Tests query light-DOM components with `el.querySelector(...)` and shadow-DOM components with `el.shadowRoot.querySelector(...)`. Slotted children remain on the host's light DOM in both cases.

### Modern CSS feature inventory

Used routinely: cascade layers, native nesting, `@scope`, `@container`, `light-dark()`, `color-mix()`, `clamp()`, `text-wrap: balance/pretty`, `field-sizing: content`, `:user-invalid`, `:has()`, View Transitions, Popover API, `<dialog>` + `::backdrop`, `@starting-style`, `@property`, `content-visibility`, `scrollbar-gutter: stable`. Reference: the project's CSS standard, `example-modern-css-2026.md` in the sibling `accountability-agent-platform/` repo.

## Lit component pattern

```js
// representative shape — every component looks like this
import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { accountService } from '../lib/services/account.service.js';

export class PortalDashboard extends LitElement {
  static properties = { /* local UI state only */ };
  createRenderRoot() { return this; }   // light DOM
  constructor() {
    super();
    this.account = new ObservableController(this, accountService.account$);
  }
  connectedCallback() { super.connectedCallback(); accountService.refresh(); }
  render() {
    const a = this.account.value;
    if (!a) return html`<bridge-spinner></bridge-spinner>`;
    return html`<section class="balance">${formatUsd(a.balance_usd)}</section>...`;
  }
}
customElements.define('portal-dashboard', PortalDashboard);
```

Rules:
- Local props for ephemeral UI state (form fields, `loading`, `error`, `dialogOpen`). Domain state from RxJS services via `ObservableController`.
- Cross-cutting signals via `bridge:`-namespaced `CustomEvent` on `window`: `bridge:authenticated`, `bridge:unauthorized`, `bridge:routechange`.
- Components never call `fetch` directly. They call service methods.

## Reactive state — `ObservableController`

A ~12-line Lit `ReactiveController` that subscribes on `hostConnected`, unsubscribes on `hostDisconnected`, and calls `host.requestUpdate()` on each emission. Single source of truth for domain state across pages — header balance, dashboard tile, billing summary all subscribe to the same `account$`, no event-bus refetch storm.

Each consumer's services own `BehaviorSubject`s and expose them as `Observable`s. Async commands push into the subject (optimistic where appropriate, rollback on error). Cold Observables (`from(fetch(...))`) for one-shot reads.

## Auth and credential handling

Every UI module:
1. Has a sign-in page that captures whatever credential the bridge expects (portal: API key as Bearer; admin: `ADMIN_TOKEN` + operator name).
2. Stores the credential in **`sessionStorage`** under a module-namespaced key (`bridge.portal.session`, `bridge.admin.session`). Tab-scoped — closing the tab signs out.
3. Wraps the shared `createApi(...)` factory with a module-specific `getAuthHeaders` that reads from sessionStorage.
4. Treats a 401 response uniformly: `clearSession()` + `window.dispatchEvent(new CustomEvent('bridge:unauthorized'))`. The root component listens and swaps to the sign-in page.

**Why sessionStorage and not localStorage**: tab-scoped exposure for credentials whose blast radius is the full account (portal) or full admin surface (admin). Persistence ("remember me") is a deliberate Phase 2 question per module.

## Routing

Hash-based (`location.hash`), no router library. Consumers maintain an allowlist of valid views; the root component listens to `hashchange`, validates, and dispatches `bridge:routechange`. Route swaps wrap in `document.startViewTransition(() => updateView())` when supported (graceful fallthrough otherwise) for cross-page visual continuity.

## Build, serve, and deploy

- **Dev**: each consumer's `npm run dev` (Vite) on its own port. `vite.config.js` proxies the bridge's API path prefix (`/v1` for portal, `/admin` for admin) to the local bridge port.
- **Build**: `vite build` per consumer outputs to `bridge-ui/<consumer>/dist/`. The top-level `npm run build` chains: `tsc && (cd bridge-ui/portal && npm ci && npm run build) && (cd bridge-ui/admin && npm ci && npm run build)`.
- **Serve**: each consumer is mounted by `@fastify/static` on the customer Fastify instance at its base path (`/portal/`, `/admin/console/`). Hash routing means only `index.html` needs SPA fallback.
- **Docker**: multi-stage Dockerfile — UI build stage runs each consumer's build, runtime stage copies the `dist/` outputs into `/app/bridge-ui/<consumer>/dist/`.

## Testing

- **Shared module suite** — generic component behavior (`bridge-button` loading state, `bridge-confirm-dialog` typed-match guard, `bridge-table` `@container` collapse), `ObservableController` lifecycle, `createApi` 401 path, validator combinators. `@open-wc/testing` + `@web/test-runner`. Each consumer **does not re-test** these — covered once.
- **Per-consumer service tests** — vitest + jsdom for service-level RxJS contracts (optimistic add/rollback, debounce, polling start/stop on host connect/disconnect).
- **Per-consumer component tests** — `@open-wc/testing` for page rendering against stubbed services.
- **End-to-end** — Playwright happy-path against the compose stack.
- Coverage floor stays at 75% across all four v8 metrics (per [core-beliefs.md](./core-beliefs.md) and the bridge invariants in [AGENTS.md](../../AGENTS.md)). UI counts toward the floor.

## Lint and convention enforcement

- `bridge-ui/<consumer>/lib/` may not redefine anything that exists in `bridge-ui/shared/lib/`. Enforced by `npm run doc-lint` with a name-matched check.
- The bridge's `layer-check` lint rule remains enforced in `src/`; `bridge-ui/` is outside its scope (no `src/` layer rule applies because `bridge-ui/` is sibling, not nested).
