# Digital Twin Watch — Handoff

Status as of 2026-11-03. Repository: `EduardDumitrascu/digital-twin-watch`
(private — do not change visibility). Last pushed commit at handoff:
see `git log -1` on `main`; this file is committed on top of the
basemap fix (`fix: replace blocked OSM raster tiles with OpenFreeMap
vector basemap`).

Rules for anyone continuing: read `AGENTS.md` first. Meta-only AI,
secrets only in backend environment variables, product UI/docs in
English, owner communication in Romanian, never present planned or
simulated features as real.

## What is finished

- **Repository setup**: `AGENTS.md` rules, hardened `.gitignore`
  (secrets, `node_modules`, logs, generated/runtime files),
  `.env.example` with variable names only and no real values.
- **Real Helsinki data ingestion** (`scripts/ingest.py`, stdlib only):
  City of Helsinki GeoServer WFS layers for excavation notices, temporary
  traffic arrangements, area rentals, buildings with register data and
  accessibility routes, plus Service Map REST v4 units filtered to a
  bounded Kamppi–Kluuvi sample (750 m). Dated snapshot committed at
  `data/snapshot-2026-11-03.json` (84 works, 80 places, 450 buildings,
  240 route segments), preserving source IDs, URLs, original values and
  retrieval time. Services are classified from source metadata
  (`provider_type`): 19 public services, 55 businesses, 6 unclassified
  places. Buildings carry height provenance (`recorded_floors` vs
  `fallback_estimate`); routes carry realised-accessibility values.
- **Backend** (`server.mjs`, zero-dependency Node): snapshot API,
  deterministic server-side distances, submissions with review workflow
  (pending is never public; contact details stored but never returned),
  real image/PDF uploads (5 MB, type-validated, private storage under
  `data/uploads/`, retrieval only with reviewer auth), SSRF-guarded
  document URLs (public HTTPS only), reviewer authentication
  (`Authorization: Bearer <REVIEWER_TOKEN>`) for review/analysis/action/
  closure endpoints, and versioned Meta analyses (input hash over work
  record + evidence versions + model + prompt version, concurrent-run
  guard, model-supplied source references validated and dropped when not
  in the supplied evidence, real image pixels passed to Meta, PDFs
  reported as unreadable by that path).
- **Meta AI chat**: backend-only, bounded allowlisted tool-calling loop
  (max 5 model steps): search works/places, get project, get nearby
  places, get approved evidence/findings, prepare report draft. Drafts
  are never saved without explicit user confirmation. SSE progress events
  show actual tool activity. Without a key the chat immediately states
  "Not configured" and no simulated answers are produced.
- **Citizen experience (current UI)**: full-area geographic map
  (MapLibre GL + OpenFreeMap "Positron" vector style, credential-free,
  attribution shown), dismissible welcome card with three working
  starters, floating Ask input, exactly one shared closable panel
  (conversation OR results OR details, max ~372 px; mobile bottom
  sheet), one composer at a time (floating when chat is closed, attached
  inside the panel when open), clustered markers below zoom 17 with
  distinct shapes/colours for works, public services and businesses,
  Layers popover closing other surfaces, short top-centre notifications,
  Overview/Evidence/Actions project tabs, evidence comparison, and
  reduced-motion support.
- **Basemap incident, resolved**: CARTO tiles began requiring an API key
  ("API KEY REQUIRED" stamps), then the OpenStreetMap raster server
  served "Access blocked" denial images with HTTP 200 and an
  `x-blocked: Access denied` header, which image-count checks could not
  detect. Both providers were removed. OpenFreeMap was verified
  (style HTTP 200, `Access-Control-Allow-Origin: *`, geographic layers).
  The app shows a clear in-map message if the basemap provider fails.
  A maintained regression test pins this configuration.

## Work in progress (incomplete, explicitly marked)

- **Live Meta validation**: the chat and analysis paths are implemented
  and tested against a *mocked* Meta endpoint in the automated tests
  (labelled as mocked). No real Meta API key has been configured, so no
  successful real Meta call has been made or claimed yet.
- **3D**: removed from the main interface. A geographic 3D view
  integrated with streets, water and selection was not completed to an
  acceptable standard; building footprints remain a 2D layer and floor
  counts stay in the source records. Do not re-add a detached block
  model without integrating it with the geographic map.
- **Codespaces forwarded-preview check**: the final basemap was verified
  in headless Chromium against the same build locally, including CORS
  behaviour for `*.app.github.dev`-style origins. The owner's actual
  forwarded preview URL could not be opened from the agent environment;
  a hard refresh of that preview after restarting the server is still
  worth one look.

## What does not work yet / known limitations

- No Meta key configured: chat answers and "Analyze evidence" stop at
  the explicit "Not configured" state (by design; browsing, reporting
  and review still work).
- No reviewer token configured by default: City review, analysis,
  actions and closure return `reviewer_auth_required` until
  `REVIEWER_TOKEN` is set server-side.
- WFS availability is flaky: a re-import on 2026-11-03 hit HTTP 504
  timeouts on some layers; the previously verified snapshot was kept and
  only classifications were merged. Re-run `npm run ingest` when the
  service is healthy and diff counts before committing a new snapshot.
- PDFs are stored and listed, but the analysis path cannot read PDF
  content; the UI and analysis activity log say so explicitly.
- Demonstrator scope: one bounded central-Helsinki area, dated cached
  snapshot (never described as live), no user accounts beyond the
  reviewer token, no public deployment.

## Accessible journeys (implemented 2026-11-04, live keys still missing)

Implemented on top of the existing product (no rebuild):

- **Digitransit/HSL verified from official docs first**: Routing
  `POST https://api.digitransit.fi/routing/v2/hsl/gtfs/v1` (`planConnection`;
  `preferences.accessibility.wheelchair.enabled` is currently the only
  accessibility mode and explicitly does not guarantee accessibility),
  Geocoding `/geocoding/v1/search`, English tiles
  `cdn.digitransit.fi/map/v3/hsl-map-en`. Production requires a Digitransit
  API portal subscription key, sent backend-only as the
  `digitransit-subscription-key` header (`DIGITRANSIT_API_KEY`). Live probes
  confirmed HTTP 401 without a key and with an invalid key. Terms: CC BY 4.0
  with retrieval-time attribution; OSM-based street data under ODbL.
- **Backend** (`server.mjs`): `/api/mobility/status|geocode|plan`,
  `/api/mobility/analyse-barrier`, and the fixed validated tile route
  `/api/map/{z}/{x}/{y}.png` (English HSL only, in-memory cache, key never
  reaches the frontend). Plans return up to 3 itineraries with decoded
  geometry, stops/lines/transfers, Europe/Helsinki times, leg alerts,
  deterministic nearby works + approved-report context (possible context,
  never proven barriers), explicit unknowns, hard-requirement suitability
  (step-free conflicts, max walking/wheeling distance) with no silent
  relaxation, and distinct error states (not configured, invalid
  credentials, rate limited, unavailable, invalid location, no suitable
  option). Pending barrier reports stay private; a reporter can reassess
  with their own report only as an unverified concern.
- **Meta AI**: allowlisted tools now include `search_locations`,
  `plan_journey` and `prepare_barrier_draft`; progress lines reflect real
  tool execution (“Checking transport options”, “Checking reported
  barriers”). Barrier analysis passes real image pixels where readable and
  may identify a possible obstacle only.
- **UI**: first screen is the journey planner (From/To suggestions, Leave
  now/Depart at/Arrive by, step-free hard requirement, max distance, fewer
  transfers, “Find journey options”, conversational entry, location only on
  explicit click). One shared panel, one composer, journey geometry is the
  map focus, works/places hidden behind “Area context”, full text
  itineraries, preserved requirements/conversation across views.
- **Tests**: `npm test` 16/16 — previous 8 plus mocked-Digitransit/Meta
  mobility tests (geometry + unknowns preserved, hard max-walk not relaxed,
  invalid-credentials mapping, geocoding merge, barrier privacy →
  approval → recheck, own-report reassessment, chat tool loop, tile-route
  validation). Mocked tests are labelled as mocked and are **not** live
  calls.
- **Blockers — superseded by live activation on 2026-11-04**: the owner
  added `DIGITRANSIT_API_KEY` and `MODEL_API_KEY` as Codespaces secrets and
  restarted; a 32-byte `REVIEWER_TOKEN` was generated locally into the
  git-ignored `.env` (never committed or displayed). Live verification that
  day, each on actual response content: Digitransit geocoding for Helsinki
  Central Station and Oodi, a valid HSL PNG tile via the backend tile
  route, a wheelchair-configured Central Station → Oodi itinerary (walk leg
  `unknown`, entrance unverified, hard max-walk correctly unsuitable when
  exceeded), further live transit options (Central → Pasila rail; daytime
  Central → Itäkeskus metro — the same route correctly returned no option
  at night when no service runs), a direct Meta completion, the
  conversational flow using `search_locations` + `plan_journey`, live
  barrier-draft analysis, and one complete reviewer verification. Hard
  requirements were never relaxed. Browser layout was still not
  screenshot-verified in this environment (no Chromium available); the
  owner should open the private forwarded preview of port 4173 and run the
  README demonstration sequence. Earlier “no live key” statements in this
  file describe the pre-activation state only.

## Visual redesign + conversation scrolling (2026-11-04)

- White compact header (~56 px) with the product identity and Helsinki;
  Business and City review moved into a discreet Menu (functions and
  reviewer auth unchanged); “Independent demo” stays visible. Provenance is
  contextual: live queries for journeys, dated snapshot for works.
- One blue accent, white surfaces, 12–16 px card corners, body text 16 px.
  Desktop panel is ~360–410 px with a fixed title header and composer;
  only the history scrolls. Mobile uses a bottom sheet (max 62dvh).
- Journey card is plain white and leads the answer: short place names,
  walking/wheeling metres, ~estimated duration, transfers, then a discreet
  status zone — “Exceeds your distance limit” with limit/route/overage,
  “Step-free access unverified”, or a technical “Couldn’t retrieve routes”
  with working Retry. Rejected routes stay grey dashed. The assistant is
  prompted not to repeat card numbers, not to cite source IDs in the main
  text, and never to suggest raising a user-set hard limit.
- Autoscroll: sending follows to the new message; growth follows only while
  the user is at the bottom (80 px threshold, Resize/Mutation observers, no
  single timeout); scrolling up pauses it and a “New response ↓” button
  appears only for real new content. Only the conversation container
  scrolls; keyboard focus and reduced-motion are respected.
- Verified in a real Chromium (Playwright, installed outside the repo):
  screenshots at 1440×900 and 390×844 for the initial screen, live route
  with unverified step-free access, the 100 m rejection, a long
  conversation, a response arriving while scrolled up (view stayed, button
  shown, click returned to bottom with gap 0), open Sources and details,
  and a simulated network failure with Retry recovering (labelled as
  simulated). Panel wheel produced zero new tile requests; tiles stayed at
  z≤19. `npm test` 19/19, including new targeted autoscroll tests. One
  console error was the intentionally aborted chat request.

## Barrier draft repair (2026-11-04)

- A barrier draft can be prepared without a location, but submission stays
  disabled until title, description and a user-confirmed location (or a
  project) exist. Backend validation is unchanged and still rejects an
  incomplete report (tested: HTTP 400 without a work or Finland location).
- Instead of an empty “For:”, an unlocated draft shows “Location needed”
  with “Choose location on map” plus an address-search alternative. Map or
  address picks are candidates only: the user must confirm the point, and
  station coordinates are never auto-assigned to an unknown obstacle. The
  same draft is updated and stays editable before confirmation; problems
  appear in plain language under the relevant field, never as raw server
  or workId messages.
- Demo character is an explicit `demo` attribute end to end (tool, draft,
  stored submission), not just title text. Demo reports are excluded from
  journey context, chat evidence and reviewer analyses, stay private until
  review, and the submitted state shown is the server-returned status.
  Duplicate submissions are prevented (submitting/submitted guards).
- Verified in Chromium: demo draft without location → “Location needed” →
  map point → confirm point → edit title → successful submit showing
  “pending — private, waiting for review”. `npm test` 23/23 including the
  incomplete-rejection and demo-exclusion tests.

## Tests performed

- `npm test` — 8/8 passing: basemap provider regression (observed
  failing before the fix), deterministic geospatial helpers, snapshot
  classification/accessibility/height provenance, reviewer endpoints
  rejecting unauthorised requests (401), SSRF guard rejecting private
  and non-HTTPS document URLs, real PNG upload reaching private storage
  and the mocked analysis path with pending content staying private,
  chat tool-calling against mocked Meta returning result cards, and the
  reviewer action/closure workflow with human confirmation.
- Browser verification (headless Chromium via Playwright, installed
  locally for testing): screenshots at 1440×900 and 390×844, visually
  inspected — initial screen, chat open/closed single-composer states,
  Layers open, selected project with location visible beside the panel,
  Business perspective, clustered markers. Zero console errors in the
  final pass. Screenshots were kept in the agent environment only
  (`/tmp/shots*`), not in the repository.
- Live HTTP checks of `/api/health`, `/api/snapshot`, nearby-services
  distances and the not-configured verify path.
- Secret scan over the tracked tree: no keys, tokens, `.env` files,
  personal data or private uploads are tracked; `data/runtime.json` and
  `data/uploads/` are git-ignored runtime data (see below).

## How to start

```bash
npm start            # Node >= 20, no dependencies to install
# then open http://localhost:4173 (or the forwarded preview of port 4173)
```

Optional configuration, server-side only — copy `.env.example` to `.env`
and fill in values there; never paste secrets into chat, code, Git,
frontend or logs:

- `DIGITRANSIT_API_KEY` — Digitransit subscription key (backend only;
  register at the Digitransit API portal and subscribe to Routing).
- `MODEL_API_KEY` — Meta Model API key (backend calls
  `https://api.meta.ai/v1/chat/completions`, default model
  `muse-spark-1.2`, override with `META_MODEL`).
- `REVIEWER_TOKEN` — long random value; the City perspective asks for it
  once and keeps it only in the browser tab (`sessionStorage`).

Data refresh: `npm run ingest` (Python 3 stdlib), then review the new
`data/snapshot-*.json` diff before committing.

## Local files intentionally not in the repository

- `data/runtime.json` — local runtime state (demo seed and any local
  submissions/cases created while running). Ignored by design; deleting
  it only resets local demo state. Nothing else depends on it.
- `data/uploads/` — private uploaded evidence, if any uploads were made
  locally (none are required by the committed code; uploads are created
  at runtime and must never be committed).
- Agent-side scratch outside the project (`/tmp/probe`, `/tmp/shots*`,
  `/tmp/browsertest`, downloaded browser binaries under `/tmp`) —
  verification scratch only, safe to ignore; the maintained check that
  matters lives in `test/workflow.test.mjs`.

Nothing was deleted at handoff. The working tree was clean after the
final commit and push.
