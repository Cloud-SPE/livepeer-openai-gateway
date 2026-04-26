---
id: 0022
slug: customer-portal
title: Customer Portal — Lit + RxJS + modern-CSS web app for self-service account / keys / top-ups / usage
status: active
owner: agent
opened: 2026-04-26
---

## Goal

Stand up the customer-facing self-service portal at `bridge-ui/portal/`, **plus** a sibling `bridge-ui/shared/` module that holds every cross-UI primitive (design tokens, base CSS, RxJS-Lit `ObservableController`, fetch-wrapper base, generic web components, validator combinators, session helpers). [`0023-operator-admin.md`](./0023-operator-admin.md) imports from `bridge-ui/shared/` from its first commit — no copy-and-extract-later. Mirrors the proven module pattern in [`livepeer-cloud-openai-ui`](../../../../livepeer-cloud-openai-ui/portal/) (sibling-of-`src/`, per-module `package.json` and `vite.config.js`, plain-JS ES modules, Lit `LitElement` subclasses with **light DOM**, hash-based routing, design tokens via CSS custom properties, `@layer`-organized styles, sessionStorage-held credential, namespaced `CustomEvent` cross-component signaling, fetch wrapper that attaches `Authorization: Bearer`).

Two deliberate departures from the reference UI, both per project standards:

1. **Add RxJS streams.** The reference uses Lit reactive properties + `window.CustomEvent` only — fine for its surface. The bridge portal has live balance + in-flight top-up + usage rollups + key list with optimistic add-and-confirm + free-tier quota countdown, all needing synchronization across header, dashboard, billing, and keys pages simultaneously. RxJS `BehaviorSubject` per domain (`account$`, `keys$`, `usage$`, `topups$`) gives a single source of truth and a Lit `ReactiveController` glues subscription to component lifecycle.
2. **Modern CSS 2026** per the project's CSS standard (`example-modern-css-2026.md` in the sibling `accountability-agent-platform/` repo): `@layer reset, tokens, base, layout, components, utilities`; native nesting; `light-dark()` with `color-scheme: light dark`; OKLCH palette; `color-mix()` for state variants; `@property` for animatable color tokens; `@container` for table-to-card collapse on narrow viewports; `@scope` for component-local rules in light DOM; `@starting-style` for dialog/menu entry; View Transitions across route changes; `clamp()` fluid type; `text-wrap: balance/pretty`; `field-sizing: content`; `:user-invalid` form validation; `:has()` for parent-state styling.

Backend adds a new `/v1/account/*` JSON surface — Zod-validated, **USD-only** (Invariant 1, customer never sees wei). UI ships as static assets built from `bridge-ui/portal/`, served by the customer Fastify instance at `/portal/*` via `@fastify/static`.

Picking the portal first because: (a) operator currently issues every API key by hand (AGENTS-noted "TODO: self-service" in `src/service/auth/`), so portal unlocks revenue self-service; (b) it's the lower-stakes surface for proving the UI infra before [`0023`](./0023-operator-admin.md) lands destructive operator actions on top of it.

## Non-goals

- **React, Tailwind, CSS-in-JS, Next.js, any SSR framework** — explicit project directive. Lit + plain-JS + native CSS only.
- **TypeScript in the UI bundle** — reference UI is plain JS; portal follows. Server-side `/v1/account/*` Zod schemas remain TS in `src/types/`. UI ships hand-mirrored runtime validators (see Decisions).
- **Shadow DOM** — components use light DOM (`createRenderRoot() { return this; }`) so cascade layers apply. `@scope { ... }` provides component-local rules where needed.
- **Monorepo tooling.** `bridge-ui/portal/` and `bridge-ui/admin/` each have their own `package.json`, deps, lockfile, vite config. No npm workspaces. `bridge-ui/shared/` is a directory of source files imported via relative paths — peerDependencies-only, no own `node_modules` or build, not an npm package. (Matches reference's "no monorepo tooling" call while still making the cross-UI boundary explicit.)
- **Signup / onboarding / email verification.** Customer arrives with an existing key (operator-issued today, operator-issued via 0023 admin tomorrow).
- **OAuth / SSO / passwordless.** v1 auth is "paste your API key" → sessionStorage → Bearer header.
- **Multi-tenant org / team management.** One customer = one account.
- **Marketing site / docs.** Future `bridge-ui/site/` module; not this plan.
- **In-app charts library.** Vanilla CSS bars off rollup data; no Chart.js / Recharts. (Same call as the prior console draft; survives the rewrite.)

## Approach

### Workspace layout

New top-level sibling to `src/` (deliberate — see Decisions). **Two modules stood up in this plan**: `shared/` and `portal/`. 0023 lands `admin/` next to them.

```
bridge-ui/
├── shared/                       # this plan stands it up; admin imports day one
│   ├── package.json              # peerDependencies only: lit, rxjs (no own node_modules / build)
│   ├── README.md                 # what belongs here, what does not
│   ├── css/
│   │   ├── reset.css             # @layer reset
│   │   ├── tokens.css            # @layer tokens — OKLCH + light-dark() palette, scales
│   │   ├── base.css              # @layer base — element defaults
│   │   └── utilities.css         # @layer utilities — single-purpose helpers
│   ├── controllers/
│   │   └── observable-controller.js     # Lit ReactiveController for RxJS subscriptions
│   ├── lib/
│   │   ├── api-base.js                  # fetch wrapper factory; consumer passes auth strategy
│   │   ├── session-storage.js           # generic sessionStorage helpers (key namespacing, JSON wrap)
│   │   ├── validators.js                # tiny combinators: object/string/number/array/optional/union
│   │   ├── events.js                    # bridge: namespaced CustomEvent helpers
│   │   └── route.js                     # hash-route allowlist + view-transition swap helper
│   └── components/
│       ├── bridge-button.js             # variant + loading + danger states
│       ├── bridge-dialog.js             # <dialog> wrapper + Popover + @starting-style
│       ├── bridge-confirm-dialog.js     # type-to-confirm pattern (admin refund/suspend, portal revoke-self)
│       ├── bridge-table.js              # @container narrow-mode → card collapse
│       ├── bridge-toast.js              # notifications stack
│       ├── bridge-spinner.js            # loading affordance
│       └── bridge-popover-menu.js       # anchor-positioned menu (graceful fallback)
└── portal/
    ├── package.json              # deps: lit, rxjs, vite
    ├── vite.config.js            # dev port 5173, proxies /v1/* → bridge
    ├── index.html
    ├── main.js                   # imports portal.css and components/*; relative-imports from ../shared/
    ├── portal.css                # @import "../shared/css/*.css" + @layer layout/components blocks
    ├── components/
    │   ├── portal-app.js         # root: hash router + auth gate
    │   ├── portal-login.js
    │   ├── portal-dashboard.js
    │   ├── portal-keys.js
    │   ├── portal-usage.js
    │   ├── portal-billing.js
    │   └── portal-settings.js
    └── lib/
        ├── api.js                # wraps shared/lib/api-base.js with Bearer-key auth
        ├── session.js            # wraps shared/lib/session-storage.js with portal namespace
        ├── schemas.js            # response validators built from shared/lib/validators.js
        └── services/
            ├── account.service.js
            ├── keys.service.js
            ├── usage.service.js
            └── topups.service.js
```

**Shared module mechanics**: `bridge-ui/shared/` is a directory of source files, **not** an npm package with its own `node_modules` or build. Consumers import via relative paths (`import { ObservableController } from '../shared/controllers/observable-controller.js'`). Vite tree-shakes from each consumer's bundle. `shared/package.json` declares `peerDependencies` only (`lit ^3.3`, `rxjs ^7.8`) and a one-line description; no `dependencies`, no `scripts`. This matches the reference UI's "no monorepo tooling" simplification while still making the boundary explicit.

**What belongs in `shared/`** — primitives reusable across any UI in the bridge fleet:
- Cross-cutting CSS layers (`reset`, `tokens`, `base`, `utilities`) — the `@layer components` block stays per-module since component blocks are domain-specific.
- The `ObservableController` (RxJS ↔ Lit glue, no domain knowledge).
- `api-base.js` — a `createApi({ baseUrl, getAuthHeader, onUnauthorized })` factory; consumers wrap with their own auth strategy (Bearer key for portal, `X-Admin-Token` + `X-Admin-Actor` for admin).
- Validator combinators (the primitives, not the schemas).
- Generic web components: button, dialog, confirm-dialog, table, toast, spinner, popover-menu.
- Session-storage and namespaced-event helpers.

**What does NOT belong in `shared/`** — domain or app-shell concerns:
- Domain services (`account.service`, `nodes.service`) — module-specific.
- App shell components (`portal-app`, `admin-app`) — different routing tables, different auth UIs.
- Page components — module-specific.
- The actual response-validator schemas — they describe specific endpoints.
- Auth-header strategy details — Bearer key vs admin token + actor.

Tasks:
- [ ] `bridge-ui/shared/package.json` — `peerDependencies`: `lit ^3.3`, `rxjs ^7.8`. No `dependencies`. No `scripts`.
- [ ] `bridge-ui/shared/README.md` — what belongs / does not belong (mirror the lists above), peer-version expectations, "imported via relative paths, not as an npm package."
- [ ] All `bridge-ui/shared/css/*.css`, `controllers/`, `lib/`, `components/` files listed above.
- [ ] `bridge-ui/portal/package.json` with `lit ^3.3`, `rxjs ^7.8`, `vite ^8`. Versions match shared's `peerDependencies`.
- [ ] `bridge-ui/portal/vite.config.js` — dev server `5173`, build to `bridge-ui/portal/dist/`, base `/portal/`, dev proxy `/v1` → `http://localhost:<BRIDGE_PORT>`. No alias config — Vite resolves `../shared/` natively.
- [ ] `bridge-ui/portal/index.html` mounts `<portal-app>` and links `portal.css`.
- [ ] Top-level `package.json` `build` script: `tsc && (cd bridge-ui/portal && npm ci && npm run build)`.
- [ ] `Dockerfile` adds a UI build stage; copies `bridge-ui/portal/dist/` into the runtime image at `/app/bridge-ui/portal/dist/`. `bridge-ui/shared/` participates in the build context but is not copied separately (its files end up tree-shaken into `portal/dist/`).
- [ ] `.dockerignore` carves the `dist/` exception.
- [ ] `npm run doc-lint` — extend to enforce that no module under `bridge-ui/<consumer>/lib/` re-implements anything that exists in `bridge-ui/shared/lib/`. Initial impl: a list of forbidden filenames in consumer/lib/ that must instead come from shared/.

### CSS architecture (modern 2026)

Layer order is the project standard, declared in `bridge-ui/portal/portal.css` and populated from a mix of `shared/css/*.css` (reset, tokens, base, utilities) and per-module blocks (layout, components):

```css
@layer reset, tokens, base, layout, components, utilities;
@import url("../shared/css/reset.css") layer(reset);
@import url("../shared/css/tokens.css") layer(tokens);
@import url("../shared/css/base.css") layer(base);
@import url("../shared/css/utilities.css") layer(utilities);
/* @layer layout and @layer components defined below, in this file */
```

- [ ] `shared/css/reset.css` — minimal modern reset (box-sizing, margin/padding zero on the usual list, `text-wrap: pretty` global, `scrollbar-gutter: stable` on `html`).
- [ ] `shared/css/tokens.css` — `:root { color-scheme: light dark; }` plus the design-token catalogue:
  - Color: OKLCH primary / accent / surface / text / danger / warning / success, each defined via `light-dark(<light>, <dark>)`. Example: `--surface-1: light-dark(oklch(98% 0.005 250), oklch(18% 0.01 250));`.
  - State derivations via `color-mix()`: `--accent-hover: color-mix(in oklch, var(--accent), white 12%);` etc.
  - `@property --accent-glow { syntax: '<color>'; inherits: false; initial-value: transparent; }` for animatable focus rings.
  - Spacing scale `--space-1` through `--space-12` (rem-based, fluid where appropriate).
  - Typography: `--font-sans` (system), `--font-mono` (system mono); sizes via `clamp()` for h1–h3.
  - Radii, shadows, durations, easings.
- [ ] `shared/css/base.css` — element defaults: `body`, headings (`text-wrap: balance`), `p` (`text-wrap: pretty`), form controls (`field-sizing: content` on textareas), `dialog::backdrop`, `:user-invalid` outline.
- [ ] `@layer layout` (per-module, in `portal.css`) — app shell grid (header / nav / main), main outlet `view-transition-name: portal-main`.
- [ ] `@layer components` (per-module, in `portal.css`) — per-component blocks using **native nesting**. Generic component styling (`bridge-button`, `bridge-dialog`, `bridge-table`, etc.) lives in the components themselves under `bridge-ui/shared/components/*.js` as tagged-template strings; per-page styling stays in `portal.css`. Example skeleton for a page block:
  ```css
  @layer components {
    portal-dashboard {
      @scope (portal-dashboard) to (portal-dashboard .nested-app) {
        .balance { font-size: clamp(2rem, 6cqi, 3.5rem); }
        .quota:has([data-low='true']) { color: var(--warning); }
      }
    }
    portal-keys table { container-type: inline-size; }
    @container (max-width: 600px) {
      portal-keys table { display: none; }
      portal-keys .cards { display: grid; gap: var(--space-3); }
    }
  }
  ```
- [ ] `shared/css/utilities.css` — single-purpose helpers (`.sr-only`, `.flex-center`, `.truncate`, etc.).

**Light DOM caveat for shared components**: even though shared/components live in light DOM, their generic styles ship as tagged-template `static styles = css\`...\`` blocks that Lit applies via constructable stylesheets. With `createRenderRoot() { return this; }` Lit ignores `static styles`, so shared components instead inject their CSS into `document.adoptedStyleSheets` once on first construction (idempotent, keyed by tag name). Documented in `shared/components/README.md` and the design doc.
- [ ] **Entry animations**: `@starting-style` on dialogs, menus, toasts. Example:
  ```css
  dialog[open] { opacity: 1; translate: 0 0; transition: opacity .15s, translate .15s; }
  @starting-style { dialog[open] { opacity: 0; translate: 0 -8px; } }
  ```
- [ ] **View Transitions** wrap the route swap (manually triggered — hash routing is JS-driven). `portal-app._setView` calls `document.startViewTransition(() => { this.view = next; })` when supported, else falls through.
- [ ] **Popover API** for contextual menus and the "I've saved my new key" confirmation: `popover` attribute + `:popover-open` styling, with `::backdrop` dim.

### Lit component pattern

- [ ] All components extend `LitElement` from `lit` (^3.3).
- [ ] `createRenderRoot() { return this; }` — light DOM, matches reference; cascade layers and `@scope` blocks apply.
- [ ] Reactive state is local: form fields, ephemeral UI flags (`loading`, `error`, `dialogOpen`). Domain state (account, keys list, usage, topups) is read from RxJS services via `ObservableController` — components do not own it.
- [ ] Cross-cutting signals via window CustomEvents, namespaced `bridge:` (the reference uses `bc:`):
  - `bridge:authenticated` — emitted after login success.
  - `bridge:unauthorized` — emitted by `api.js` on 401; root component swaps to login.
  - `bridge:routechange` — emitted on `hashchange` and reflected into a top-level `route$` subject.
- [ ] Lifecycle: `connectedCallback()` for setup (controller wiring + window listeners); `disconnectedCallback()` cleans up. The `ObservableController` handles its own subscribe/unsubscribe via `hostConnected`/`hostDisconnected`.

### RxJS service layer

Pattern: each service exports a singleton object owning one or more `BehaviorSubject`s plus async commands that push into them. Components never call `fetch` directly — they call service methods and subscribe to service streams. The `ObservableController` lives in `bridge-ui/shared/controllers/`; services live in the consumer module since they're domain-specific.

- [ ] `lib/services/account.service.js`
  ```js
  // representative shape
  import { BehaviorSubject } from 'rxjs';
  import { api } from '../api.js';
  const _account = new BehaviorSubject(/** @type {AccountSummary|null} */(null));
  export const accountService = {
    account$: _account.asObservable(),
    async refresh() { _account.next(await api.get('/v1/account')); },
    signOut() { _account.next(null); },
  };
  ```
- [ ] `lib/services/keys.service.js` — `keys$`, `create(label)` (optimistic insert with `pending: true`, replace on response or rollback on error), `revoke(id)` (optimistic mark, rollback on 412).
- [ ] `lib/services/usage.service.js` — `query({ from, to, group_by })` returns a fresh cold `Observable` per call (no shared subject — usage is on-demand).
- [ ] `lib/services/topups.service.js` — `topups$` + `pollUntilSettled(sessionId, timeoutMs)` returning an Observable that `interval(2000).pipe(switchMap(refetch), takeWhile(notSettled, true), takeUntil(timer(timeoutMs)))`.
- [ ] `bridge-ui/shared/controllers/observable-controller.js` — Lit `ReactiveController`:
  ```js
  // representative shape — lives in shared/, imported by portal and admin
  export class ObservableController {
    constructor(host, observable, initial = undefined) {
      this.host = host;
      this.observable = observable;
      this.value = initial;
      host.addController(this);
    }
    hostConnected() { this._sub = this.observable.subscribe(v => { this.value = v; this.host.requestUpdate(); }); }
    hostDisconnected() { this._sub?.unsubscribe(); }
  }
  ```
- [ ] `bridge-ui/shared/lib/api-base.js` — fetch wrapper **factory**, not a singleton:
  ```js
  // representative shape
  export function createApi({ baseUrl, getAuthHeaders, onUnauthorized, parseResponse }) {
    return {
      async request(method, path, body) {
        const res = await fetch(`${baseUrl}${path}`, { method, headers: { ...getAuthHeaders(), 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
        if (res.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
        if (!res.ok) throw new Error(`http_${res.status}`);
        return parseResponse(path, await res.json());
      },
      get(path) { return this.request('GET', path); },
      // post / delete / etc.
    };
  }
  ```
- [ ] `bridge-ui/portal/lib/api.js` — wraps `createApi(...)` with portal-specific config: `baseUrl: ''` (same origin), `getAuthHeaders: () => ({ authorization: 'Bearer ' + getSession() })`, `onUnauthorized: () => { clearSession(); window.dispatchEvent(new CustomEvent('bridge:unauthorized')); }`, `parseResponse` dispatches by path through `portal/lib/schemas.js` validators.

### Routing

- [ ] Hash-based (`location.hash`), no library — match reference.
- [ ] `portal-app` listens to `hashchange`, validates against an allowlist (`dashboard`, `keys`, `usage`, `billing`, `billing/return`, `settings`), default `dashboard`.
- [ ] Route swap wrapped in `document.startViewTransition` when supported; falls through otherwise.
- [ ] Auth gate: if `!hasSession()` render `<portal-login>`; else render the chosen view inside the app shell.

### Auth

- [ ] Login: paste API key → `lib/api.js` calls `GET /v1/account` with the pasted key as Bearer; on 200 the key is the session — store under `sessionStorage["bridge.portal.session"]` and dispatch `bridge:authenticated`.
- [ ] All subsequent fetches read the session and set the header automatically.
- [ ] Sign out: clear sessionStorage, `accountService.signOut()`, `bridge:unauthorized`.
- [ ] Cannot revoke the key being used to make the request — server returns 412; UI surfaces "you're using this key right now".

### Backend: `/v1/account/*` (new)

All routes require `Authorization: Bearer <api-key>` (existing customer-auth middleware). Zod-validated. **USD-only**, never wei.

- [ ] `GET /v1/account` → `{ id, email, tier, status, balance_usd, free_tokens_remaining, free_tokens_reset_at, created_at }`.
- [ ] `GET /v1/account/api-keys` → `{ keys: [{ id, label, created_at, last_used_at, revoked_at }] }`. Hash never returned.
- [ ] `POST /v1/account/api-keys` body `{ label: string<=64 }` → `{ id, label, key, created_at }`. **`key` returned exactly once** (cleartext); hash stored. Prefix `lpb_live_`.
- [ ] `DELETE /v1/account/api-keys/:id` → 204; idempotent on already-revoked; **412 if revoking the request's own key**.
- [ ] `GET /v1/account/usage?from=&to=&group_by=day|model|capability` — rollups over `usage_records`. Default last 30 days.
- [ ] `GET /v1/account/topups?limit=50&cursor=` — paginated `topups` rows for this customer.
- [ ] `POST /v1/billing/topup` exists. Portal calls with `success_url=/portal/billing/return?session_id={CHECKOUT_SESSION_ID}`, `cancel_url=/portal/billing`.
- [ ] `GET /v1/account/limits` → `{ tier, max_concurrent, requests_per_minute, max_tokens_per_request, monthly_token_quota }` (rate-card view).

Files:
- [ ] `src/runtime/http/account/routes.ts` — Fastify plugin.
- [ ] `src/runtime/http/account/usage.test.ts` — rollup grouping, date-range edges.
- [ ] `src/repo/customers.ts` — extend with `findApiKeysByCustomer`, `insertApiKey`, `revokeApiKey`.
- [ ] `src/service/auth/keys.ts` — generation: `lpb_live_` + 32 random bytes (base32 of crypto.randomBytes), HMAC-SHA-256(`API_KEY_PEPPER`) for storage.
- [ ] `src/repo/usageRollups.ts` — one SQL per `group_by`. TestPg-backed.
- [ ] `src/runtime/http/portal/static.ts` — `@fastify/static` registration at `/portal/*` serving `bridge-ui/portal/dist/` with hash-route SPA fallback (only `index.html` needed).

### Tests

- [ ] **Backend unit + integration**: each new route happy/sad; cross-customer isolation; key-creation roundtrip via TestPg; rollup correctness against seeded `usage_records` (mixed success / partial / failed across multiple models).
- [ ] **Shared module tests** (`@open-wc/testing` + `@web/test-runner`): `ObservableController` subscribe/unsubscribe on host connect/disconnect; `createApi` 401 → `onUnauthorized` callback fires + throws; validator combinators reject malformed input; each generic web component (`bridge-button` loading state, `bridge-confirm-dialog` blocks until typed match, `bridge-table` collapses to cards under container query).
- [ ] **UI service tests** (vitest + jsdom): each service's BehaviorSubject contract; optimistic add → confirm; optimistic add → rollback on error; `pollUntilSettled` time-based behavior with fake timers.
- [ ] **UI component tests** (`@open-wc/testing` via `@web/test-runner` — **no React Testing Library**): each page mounts against stubbed services, asserts visible text, ARIA, and dialog focus traps.
- [ ] **End-to-end** (Playwright): sign-in → create-key (assert cleartext shown once) → sign-out → sign-in-with-new-key → revoke-original. Runs against compose stack.
- [ ] **CSS smoke**: a Playwright assertion that computed `color-scheme` flips with OS preference and `light-dark()` resolves to the dark token in dark mode.
- [ ] Coverage stays at 75% across all four v8 metrics (Invariant 7 in [`AGENTS.md`](../../../AGENTS.md)). UI counts toward the floor.

### Docs

- [ ] **New design doc** `docs/design-docs/ui-architecture.md` — captures: Lit + RxJS + modern CSS; `bridge-ui/` sibling layout with `shared/` + per-consumer module split (what belongs in shared, what does not); light DOM rationale + adoptedStyleSheets caveat for shared component CSS; cascade layer order with `@import url(...) layer(...)` pulls from shared; OKLCH + `light-dark()` theming; `ObservableController` pattern; namespaced `bridge:` events; hash routing + View Transitions; sessionStorage credential; per-module `package.json` + shared as a peerDependencies-only directory module; supported-browsers floor. Both consoles reference this; design-docs may not reference plans (per [PLANS.md](../../../PLANS.md)).
- [ ] **New product spec** `docs/product-specs/customer-portal.md` — page-by-page UX, rate-card display rules, dispute / refund visibility, USD formatting rules.
- [ ] **Update** `docs/design-docs/architecture.md` — replace the `ui/ admin UI (v2+)` row with a pointer to `bridge-ui/` sibling layout. Note layer rule still holds *within* `src/`; `bridge-ui/` is a separate static-asset deliverable that talks to the bridge over HTTP only.
- [ ] **Update** `AGENTS.md` "Knowledge base layout" and "Where to look for X" — add the new `bridge-ui/` and design / product entries.
- [ ] **Update** `docs/operations/deployment.md` — `bridge-ui/portal/` build step, `@fastify/static` mount, Docker UI stage, Grafana not required for portal.

## Decisions log

### 2026-04-26 — Lit + RxJS + modern CSS, no React / Tailwind / CSS-in-JS

Project directive. Pattern lifted from `livepeer-cloud-openai-ui/portal` (Lit, light DOM, hash routing, design tokens, `@layer`-organized CSS, sessionStorage, namespaced CustomEvents); RxJS layered on top because the bridge state surface is bigger than the reference's. Modern CSS per the project's CSS standard (`example-modern-css-2026.md` in the sibling `accountability-agent-platform/` repo).

### 2026-04-26 — Stand up `bridge-ui/shared/` from day one, not on rule-of-three

Two consumers (portal + admin) are being designed in the same planning session. The rule-of-three protects against premature abstraction *discovered* too early; here the abstraction isn't premature because both consumers are already on the design table. Copy-then-extract would waste 0023's implementation time and risks the two copies drifting before extraction. `shared/` is a directory of source files (no own `node_modules` / build), peerDependencies declared, imported via relative paths. Easy to grow, easy to delete what doesn't earn its keep.

### 2026-04-26 — Sibling `bridge-ui/`, not `src/ui/`

Architecture doc originally slotted `ui/` inside `src/`. Rewriting to sibling-of-`src/` because: (1) the reference UI is sibling, and the directive is to borrow its module pattern; (2) UI is plain-JS browser bundles, `src/` is server TS — mixing them forces tsconfig coordination, mixed lint rules, and a mixed build graph for no gain; (3) per-module `package.json` is the reference's hard-won simplification — keeps browser-only deps (`lit`, `rxjs`) out of the bridge npm package. Architecture doc gets updated; the bridge's layer rule is unaffected because `bridge-ui/` doesn't import from `src/` at all.

### 2026-04-26 — Light DOM (no shadow DOM)

Matches reference. Trade: no style encapsulation, but cascade layers and `@scope` blocks give the same isolation effect with less ceremony, and the global `@layer tokens` reaches every component without prop-drilling CSS-custom-property values. Reference proved the pattern at scale across portal/admin/site.

### 2026-04-26 — Per-module `package.json`, plain JS, no UI TypeScript

Matches reference exactly. UI is a static-asset build, not part of the bridge's TS compile. Adding TS would force tsconfig coordination, slow the dev loop, and isn't justified by the surface size. JSDoc `@type` annotations cover the documentation need where helpful.

### 2026-04-26 — RxJS services own `BehaviorSubject`s; Lit `ReactiveController` subscribes

Reference uses `@property` + `window.CustomEvent` only — fine for two pages. Bridge portal needs the balance and tier visible in the header simultaneously with the dashboard tile and the billing-page summary; an event-bus pattern would re-fetch n times. One `BehaviorSubject`, n subscribers, push-based updates. The `ObservableController` is ~12 lines — barely an abstraction, but it removes the subscribe/unsubscribe ceremony from every component.

### 2026-04-26 — Hand-mirrored response validators in the UI, not shared Zod from `src/types/`

Sharing TS-Zod into a plain-JS browser bundle requires either (a) a TS-build step the UI doesn't otherwise need, or (b) shipping ~12 kB gz of Zod runtime. Hand-mirrored validators in `bridge-ui/portal/lib/schemas.js` (plain JS, ~200 LOC for the six routes) plus a `npm run doc-lint` rule that diffs the server's Zod field names against the UI's keeps them honest. Codegen UI validators from server schemas is a Phase 2 if drift becomes a real cost.

### 2026-04-26 — Cascade layer order `reset, tokens, base, layout, components, utilities`

Matches reference and the project CSS standard. Utilities last so single-purpose helpers always win. Tokens before base so design tokens are available to element defaults.

### 2026-04-26 — OKLCH palette + `light-dark()` for theming, no `[data-theme]` toggle in v1

`color-scheme: light dark` on `:root`; tokens defined as `light-dark(<light>, <dark>)`. User picks via OS. A future toggle just flips `color-scheme` on `:root` — no per-element style swap. Reference uses static palette and a `data-theme` attribute on the site module; we upgrade to OKLCH + `light-dark()` per the project standard.

### 2026-04-26 — `sessionStorage` for the API-key session

Matches reference. Tab-scoped — closing the tab signs out. localStorage was rejected because the credential is the live API key (full account scope); narrowing exposure to the session is cheap and matches the reference's call. A "remember me" toggle that flips to localStorage is a Phase 2 question.

### 2026-04-26 — Hash routing, no router library

Matches reference. Saves a dep. View Transitions (`document.startViewTransition`) handle the visual polish that a router library would otherwise provide. Hash works without server config (no SPA fallback for client routes — only `/portal/index.html` needs to be served).

### 2026-04-26 — Vanilla CSS bars, no chart library (carried from prior draft)

Survives the rewrite. Recharts / Chart.js add 60–100 kB gz for what is, in v1, three bar charts driven directly off `usage_records` rollups.

### 2026-04-26 — `lpb_live_` API-key prefix (carried from prior draft)

Stripe-style prefix makes leak detection (gitleaks, secret scanners) trivial.

### 2026-04-26 — Cannot revoke the request's own key (carried from prior draft)

412 + UI warning prevents accidental self-lockout when no other key exists.

### 2026-04-26 — Component CSS lives in one file (`portal.css`), not co-located

Matches reference for **page-level** styling. Single stylesheet under `@layer components` with `@scope (portal-dashboard) { ... }` blocks per page component. Trade: one file grows; gain: one cascade, simple link from `index.html`. If the file crosses ~1500 lines we'll split by `@import url(...) layer(components)`. **Generic shared web components** (`bridge-button`, `bridge-dialog`, etc.) are an exception: their styles ship co-located in the component module via `adoptedStyleSheets` injection, since they're consumed by both portal and admin and shouldn't require each consumer to copy boilerplate into its own `portal.css` / `admin.css`.

## Open questions

- **`@fastify/static` vs the `no-cross-cutting-import` lint.** It's a Fastify plugin (no DB / network), so it should not trip the rule, but a quick spike before adoption is safer. Fall back to a hand-rolled `sendFile` plugin (~30 lines) if it does.
- **Browser-support floor.** The modern CSS reference assumes recent evergreen. State the matrix in `ui-architecture.md`: Chrome/Edge ≥ 122, Firefox ≥ 124, Safari ≥ 17.5. `@scope` and anchor positioning are the most cutting-edge — both degrade gracefully (rules just don't apply). The bridge audience is API-first developer customers, who run modern browsers.
- **View Transitions on hash routing.** The native API targets full-document navigations; with hash routing we call `document.startViewTransition(() => updateView())` manually. Document the polyfill story (none in v1 — fall through where unsupported).
- **CSV export size.** Client-side from already-fetched JSON is fine to ~100 k rows. Server-side streaming (`GET /v1/account/usage.csv`) is a follow-up if a real customer needs a year of high-volume usage.
- **Where do customers get their first key?** Operator-issued today; [`0023`](./0023-operator-admin.md) surfaces issuance in the admin console. Self-service signup is its own plan.
- **Lit component test runner choice.** `@open-wc/testing` + `@web/test-runner` is the Lit-idiomatic option. Vitest can run Lit components in jsdom but loses `:has()` / `@container` / `@scope` semantics in tests — those are visual-regression / Playwright concerns anyway.

## Artifacts produced

Implementation in progress (status remains `active` — see "What's still pending" below).

### Files added (uncommitted)

- **`bridge-ui/shared/`** — workspace member with peerDeps-only `package.json`, README, `css/{reset,tokens,base,utilities}.css`, `controllers/observable-controller.js`, `lib/{api-base,session-storage,validators,events,route}.js`, `components/{bridge-button,bridge-spinner,bridge-dialog,bridge-confirm-dialog,bridge-table,bridge-toast,bridge-popover-menu,_adopt-styles}.js`.
- **`bridge-ui/portal/`** — workspace member with `package.json`, `vite.config.js`, `vitest.config.js`, `web-test-runner.config.js`, `index.html`, `main.js`, `portal.css`, `lib/{api,session,schemas}.js`, `lib/services/{account,keys,usage,topups}.service.js`, `components/{portal-app,portal-login,portal-dashboard,portal-keys,portal-usage,portal-billing,portal-settings}.js`.
- **`bridge-ui/package.json`** — npm-workspace root hoisting `lit ^3.3.2` + `rxjs ^7.8.1` for shared and consumers.
- **Backend `/v1/account/*` (7 routes)** — `src/runtime/http/account/routes.ts` + `src/runtime/http/portal/static.ts`. Repo extensions in `src/repo/{customers,apiKeys,topups}.ts`; new `src/repo/usageRollups.ts`. Wired in `src/main.ts`. `package.json` gains `@fastify/static`.
- **Tests** — `src/repo/usageRollups.test.ts` (8); `src/repo/repo.test.ts` extensions (8 for apiKeys + topups extensions); `src/runtime/http/account/routes.test.ts` (17); `src/runtime/http/portal/static.test.ts` (2). UI: `bridge-ui/shared/tests/{validators,observable-controller,api-base,session-storage}.test.js` + `bridge-ui/portal/tests/{account,keys}.service.test.js` (vitest, 42 tests). Component: `bridge-ui/portal/tests/wtr/{shared/*,portal-*}.test.js` (Web Test Runner + Chromium, 68 tests).
- **Docker / scripts** — multi-stage `Dockerfile` ui-build stage builds the workspace and copies `dist/` outputs into the runtime image. Top-level `npm run build` and `npm test` chain through `bridge-ui` workspace scripts.
- **Design doc** — `docs/design-docs/ui-architecture.md` captures the stack, layout, what belongs in shared, CSS architecture, Lit + RxJS patterns, auth, routing, build/serve/deploy, testing, lint enforcement. Indexed in `docs/design-docs/index.md`.

### What's still pending

- Per-page product spec (`docs/product-specs/customer-portal.md`).
- `docs/design-docs/architecture.md` and `AGENTS.md` updates pointing to `bridge-ui/`.
- `docs/operations/deployment.md` notes for the new build/serve.
- End-to-end Playwright happy-path (sign-in → create-key → sign-out → re-sign-in → revoke). Infrastructure not stood up; deferred.
- Doc-lint rule forbidding consumer/lib redefining shared/lib filenames.
- CSS smoke test for `light-dark()` resolution.

### Plan-level corrections (erratum)

- The plan wrote `lpb_live_` as the API-key prefix; the existing implementation uses `sk-live-` / `sk-test-` (per `src/service/auth/keys.ts` and `API_KEY_PATTERN`). Built code uses the existing format; this plan is in error. No action needed beyond noting it.
