# Digital Twin Watch — Accessible journeys, informed by real-world evidence

A Helsinki accessible-journey assistant for wheelchair users. The central
question is: *“Can I reach this destination with my mobility requirements, and
what needs checking along the way?”*

An independent hackathon demonstrator using Helsinki public data and
Digitransit/HSL routing. It is **not endorsed by HSL or the City of Helsinki**,
does not guarantee accessibility, and is not a complete MaaS service. Cached
data is always labelled with its snapshot date and is never described as live.

[Watch the 2-minute 50-second demo](https://youtu.be/Xm1Oq95ldsQ)

**How it flows:** natural-language request → live routing → requirement
checks (step-free request, distance limit, times) → journey preview along
the returned route → an explanation of what is confirmed in the sources
and what remains unknown.

## Quick start

```bash
npm start          # reads .env if present; serves http://localhost:4173
```

Open `http://localhost:4173` in a browser. No build step and no dependencies to
install (Node.js >= 20 only). Refresh the data snapshot with:

```bash
npm run ingest     # python3 scripts/ingest.py, writes data/snapshot-YYYY-MM-DD.json
npm test           # workflow, geospatial, privacy and AI-status tests
```

## Accessible journey experience

The first screen is a journey planner over a clean HSL geographic map
(English tiles served through this server, never with a key in the browser):
From / To with address suggestions (Digitransit geocoding plus snapshot
places), Leave now / Depart at / Arrive by (Europe/Helsinki), and mobility
requirements — step-free access as a hard requirement, an optional maximum
walking/wheeling distance, and a preference for fewer transfers. The primary
action is “Find journey options”; one conversational entry (“Tell me where
you want to go and what you need”) opens the Meta assistant. Device location
is requested only after “Use my location” is clicked, and no medical
diagnosis is ever requested.

Up to three real alternatives are shown as full text itineraries (the map is
optional): departure/arrival in Europe/Helsinki, duration, modes and lines,
transfer count, walking/wheeling distance, step-by-step legs, known
accessibility, service alerts, nearby works/reports as **possible context,
never proven barriers**, and what remains unknown — including “Entrance
unverified”. Selecting an option highlights its actual returned geometry.
Hard requirements are never silently relaxed: an option that violates one is
marked unsuitable, and “No suitable option found” is a valid result. Unknown
accessibility (`NO_INFORMATION` / null) is always shown as unknown, never as
accessible, and a wheelchair-configured itinerary does not certify the final
entrance or the entire route.

One shared panel only (planning, results, chat or details), one visible chat
composer only. Urban layers (works, services, buildings, accessibility
routes) are on by default and can be turned off under “Area context”;
markers are grouped by proximity with details at higher zoom, works use a
neutral site symbol (dated context, not confirmed barriers), and the
selected journey remains the visual focus. Reports and reviewer operations
remain available as secondary functions.

The chat uses a bounded, backend-only Meta tool-calling loop (max 5 model
steps, allowlisted tools only: search locations, plan journey, search
works/places, get project, get nearby places, get approved
evidence/findings, prepare report/barrier drafts). Routing supplies routes
and times; Meta coordinates the checks and explains results with sources —
it must not invent entrances, lifts, ramps or timetables. Drafts are never
saved until the user confirms. Pending submissions and their findings never
reach public chat or APIs, and precise journeys are not logged by default.

Reviewer operations (review queue, analysis, actions, closure, private
upload retrieval) require `Authorization: Bearer <REVIEWER_TOKEN>` on the
server; switching to the City perspective only opens a sign-in form.
Evidence uploads accept PNG/JPEG/WebP/PDF up to 5 MB, are stored privately
under `data/uploads/` (git-ignored), and real image pixels are passed to
Meta during reviewer analysis; PDFs/oversized images are reported as
unreadable by that path. Analyses are versioned: the input hash covers the
work record, evidence versions, model and prompt version, concurrent
duplicate runs are rejected, and model-supplied source references are
validated against the evidence actually supplied. User-supplied document
URLs must be public HTTPS: DNS, redirects and size are checked and private
network destinations are blocked.

## Configuring Digitransit/HSL (for live journeys and the HSL basemap)

Without a key, browsing area context and reporting work, and routing/tiles
show **“Not configured”**. No simulated routes are ever produced.

1. Register at the [Digitransit API portal](https://portal-api.digitransit.fi/),
   subscribe to the Routing product, and copy the subscription key.
2. Copy `.env.example` to `.env` (server-side only, never commit it).
3. Set `DIGITRANSIT_API_KEY` in `.env`. The backend sends it upstream only as
   the `digitransit-subscription-key` header and never exposes it to the
   frontend, URLs, chat or logs. Restart with `npm start`.

Verified against the official Digitransit documentation: the backend calls
`POST https://api.digitransit.fi/routing/v2/hsl/gtfs/v1` (GraphQL
`planConnection`, `preferences.accessibility.wheelchair.enabled` — currently
the only accessibility mode, and explicitly not a guarantee), geocoding at
`https://api.digitransit.fi/geocoding/v1/search`, and English raster tiles at
`https://cdn.digitransit.fi/map/v3/hsl-map-en/{z}/{x}/{y}.png` proxied through
the fixed, validated backend route `/api/map/{z}/{x}/{y}.png` with caching
and attribution. Invalid credentials, rate limits, upstream failures,
missing data and “no suitable route” are reported as distinct states. Data
licence: CC BY 4.0 (Digitransit, attribution with retrieval time); OSM-based
street/address data under ODbL.

## Preview journey (2.5D route preview)

Every journey card (chat and form results, including older messages) has a
**Preview journey** button; an option that fails your requirements is labelled
**Preview returned route** and keeps its rejection reason — a preview never
turns it into a recommendation. Starting a preview (only ever from a user
click, never automatically) collapses the panel, keeps the conversation and
its scroll position, frames the route, and animates an oblique 2.5D camera
along the **returned** leg geometry: progress is measured in metres along the
geometry at fixed preview speeds (6 m/s walking/wheeling, 30 m/s transit —
not the real travel time), with a single camera loop, pitch 52°, lookahead
and time-based bearing turns. Controls: Play/Pause, Restart, Previous/Next
step, a distance-based progress bar and a compact step label (“Step 2 of 3 ·
Train I · Helsinki → Pasila”). Steps without returned geometry are announced
and skipped, never animated as precise paths; metro legs are labelled as
underground sections followed on the map, not surface views. Building
extrusions use snapshot floor counts at 3 m per floor, always labelled
estimates; buildings without a floor count stay flat, and outside the
snapshot area nothing is invented. `prefers-reduced-motion` switches the
camera to step-by-step jumps; all controls are keyboard-operable buttons.
Changing the journey or exiting stops the animation completely.

Where street-level photos exist for a walking/wheeling step, a
**Street photos (N)** button opens them large, ordered along the direction
of travel, each with its Mapillary source, capture date, contributor
attribution (CC BY-SA 4.0), distance from the step and position. A photo
counts as the route view only when it is within 25 m of the step **and**
its camera faced within 60° of the direction of travel; anything else is
kept as a separate **Nearby imagery** group. With fewer than three route
photos the bar says “Limited historical photo coverage”; where nothing
qualifies, it says “Street photos unavailable here” and the map preview
continues. Imagery failures never block routing or chat. Imagery
requires a Mapillary client access token in the server-side
`MAPILLARY_ACCESS_TOKEN` (see `.env.example`); without it the imagery
endpoints report `not_configured` and no imagery is simulated. **What should
I check here?** sends the selected step's actual facts (mode, line, stops,
recorded accessibility, alerts, imagery metadata) to Meta; the image itself
is not sent, and the answer states that the image was not analysed.

## Configuring Meta AI (optional)

Without a key, browsing and reporting work and AI shows **“Not configured”**.
No simulated AI results are ever produced.

1. Copy `.env.example` to `.env` (server-side only, never commit it).
2. Set `MODEL_API_KEY` to your Meta Model API key in `.env`. Do not paste the
   key into chat, code, Git, the frontend, or logs.
3. Optionally set `META_MODEL` (default `muse-spark-1.2`).

Verified against Meta's official documentation (dev.meta.ai): the backend
calls `POST https://api.meta.ai/v1/chat/completions` with
`Authorization: Bearer <key>`. Calls are backend-only, time-bounded (30 s, one
retry), input-bounded (12 k characters), and duplicate submissions against
unchanged evidence reuse existing findings. The model receives deterministic,
server-computed distances and must never invent coordinates or distances; a
photograph does not prove whole-project completion or wrongdoing.

## What works

- Accessible journeys from Digitransit/HSL: wheelchair-configured
  `planConnection` itineraries with actual geometry, stops, lines, transfers,
  Europe/Helsinki timings, leg service alerts, and deterministic works/report
  context computed in code — plus geocoded From/To suggestions. Requested
  times are interpreted explicitly in Europe/Helsinki and validated (an
  option that starts before a requested departure is not compliant), a
  missing walking/wheeling total is treated as unknown rather than zero,
  and the search widens to five returned options when a hard limit must be
  satisfied, without claiming to be exhaustive. Implemented
  and covered by mocked-endpoint tests, and **verified live on 2026-11-04**
  with server-side keys configured: real geocoding, a valid HSL tile through
  the backend route, and a wheelchair-configured Helsinki Central Station →
  Oodi itinerary whose walk leg correctly stayed `unknown` (never upgraded
  to accessible). Mocked tests remain labelled as mocked and are not live
  evidence.
- Clean geographic HSL map (MapLibre GL + English HSL raster tiles served
  only through the validated backend route `/api/map/{z}/{x}/{y}.png` with the
  subscription key kept server-side, response caching, and “© Digitransit /
  HSL” attribution). The blocked direct OpenStreetMap tile endpoint, key-gated
  CARTO tiles and the earlier OpenFreeMap style are no longer used. If tiles
  are unavailable, the app says so in-map and keeps journey lines visible on a
  plain background. Works and places markers are shown by default (their
  urban layers start on) and can be turned off under “Area context”.
- Project detail with preserved source record, original Finnish text, source
  ID/URL, retrieval time, timeline, and “Not available / Missing evidence” for
  contracts, budgets and progress reports (never inferred from permits).
- Citizen reports (including accessibility barriers), evidence/document links
  and business concerns. Submissions are **pending review** by default, appear
  publicly only after approval in the City perspective, and contact details are
  stored privately and never returned by the API.
- Meta AI verification with visible, actual tool activity (records retrieved,
  deterministic distances computed, model call), structured findings with
  source references, persisted analysis status, actions, follow-up evidence,
  reassessment, and human-confirmed closure only.
- Resident / Business / City perspectives over the same underlying data.
- Evidence comparison for two dated entries; dated snapshots only (historical
  views exist only for snapshots actually stored in `data/`).
- 2.5D city view: the map opens tilted with building footprints extruded
  and coloured by the use recorded in the City of Helsinki register
  (floor-based height estimates; buildings without data stay flat). A
  clearly labelled **simulated** demo-traffic layer animates pulses on
  real OpenStreetMap carriageway geometry from the snapshot; its states
  are deterministic demonstration values, not live traffic. Ground-level
  layers (traffic and the journey route) render under buildings. This is
  an orientation aid, not evidence about slopes or accessibility.
- Barrier reporting tied to a journey: describe a possible barrier (optional
  photo), Meta prepares a structured draft from visible evidence only,
  nothing is saved until the user confirms, the report stays private until a
  reviewer approves it, the reporter can reassess their own journey against
  it as an explicitly **unverified** concern, and once approved it is
  considered as community-reported context on the next check. If Digitransit
  cannot avoid a reported barrier, the returned candidates are explained —
  no detour is fabricated. A clearly labelled **“Demo scenario”** staged
  entry (seeded in local runtime state only, removable by deleting
  `data/runtime.json`) makes no factual claim about any real project.
- Meta journey assistant (backend-only, bounded allowlisted tool loop):
  interprets a natural-language request, asks for a necessary clarification,
  searches locations, requests real itineraries, checks alerts and approved
  evidence, compares alternatives against hard requirements vs preferences
  with source references, and prepares barrier drafts for explicit
  confirmation. Progress lines reflect real tool execution only.

## Demonstration sequence

1. Open the planner, choose From/To (try Central Station → Oodi), require
   step-free access, and select “Find journey options”.
2. Compare up to three options in text; select one and watch the map focus on
   its actual geometry. Check what is recorded, what is unknown, and the
   “Entrance unverified” note.
3. Choose “Report a possible barrier” on an option, describe it (optional
   photo), review the Meta draft, and confirm submission.
4. Reassess from the options view — your report appears only as an unverified
   concern and changes no public status.
5. Switch to City review, sign in with the reviewer token, and approve it.
6. Plan again: the approved report now appears as community-reported context
   with its source and date.

Steps 1–2 and the live parts of 3 need `DIGITRANSIT_API_KEY` (and step 3’s
analysis needs `MODEL_API_KEY`) configured server-side; without keys the app
shows the exact setup state instead of simulated results.

## Data provenance (verified live, 2026-11-03)

| Source | Verified response | Use |
|---|---|---|
| City of Helsinki GeoServer WFS `kartta.hel.fi/ws/geoserver/avoindata/wfs` | GetCapabilities 200; layers `Kaivuilmoitus_alue`, `Tilapainen_liikennejarjestely_alue`, `Aluevuokraus_alue`, `Rakennukset_alue_rekisteritiedot`, `Esteettomyysreitti_viiva`; native CRS EPSG:3879 | Works, buildings, accessibility routes in a 750 m bounded sample around Kamppi-Kluuvi |
| CKAN dataset (avoindata.suomi.fi) | Package metadata 200; licence **CC BY 4.0**, City of Helsinki environment division | Licence and attribution for the permit system |
| Helsinki Service Map REST v4 `www.hel.fi/palvelukarttaws/rest/v4/unit/` | Returns all published units (21,499 at retrieval); filtered client-side to the demo area | 80 nearest public services with accessibility viewpoint codes |
| Helsinki 3D / roadworks pages | Reviewed; full-city photogrammetry not used | Simplified extruded footprints instead, documented above |
| Digitransit Routing API `api.digitransit.fi/routing/v2/hsl/gtfs/v1` | Official docs reviewed; live probe without a key returns HTTP 401 (missing/invalid subscription key) | Wheelchair-configured `planConnection` journeys (key required, backend only) |
| Digitransit Geocoding `api.digitransit.fi/geocoding/v1/search` | Official docs reviewed | From/To address suggestions (key required for remote results) |
| Digitransit Map API `cdn.digitransit.fi/map/v3/hsl-map-en` | Official docs reviewed; live probe without a key returns HTTP 401 | English HSL basemap via validated backend tile route (key required) |
| OpenStreetMap via Overpass API | Fetched 2026-11-04; carriageway classes only (primary/secondary/tertiary/residential/unclassified/living_street) | Road geometry for the labelled simulated-traffic layer. Licence **ODbL 1.0** (© OpenStreetMap contributors) |
| Mapillary (backend token) | Live street-level photos with capture date, contributor and licence metadata | Historical street photos in journey preview. Imagery © Mapillary contributors, **CC BY-SA 4.0** |

Snapshot `data/snapshot-2026-11-03.json` preserves source identifiers, source
URLs, original values (`source.original`), and the retrieval timestamp
(`retrievedAt`), distinct from source dates. Import counts: 84 works, 80
services, 450 buildings, 240 accessibility-route segments, 240 road ways,
0 source failures. If a source fails at import, the ingester reports it and
continues with verified sources; it never substitutes fiction.

Attribution: Source: City of Helsinki. Licence CC BY 4.0. Road geometry:
© OpenStreetMap contributors, ODbL 1.0. Street imagery: © Mapillary
contributors, CC BY-SA 4.0.

## Limitations

- **Views**: the integrated 2.5D mode draws real building footprints on the
  same Helsinki map for orientation. Heights appear only where the source
  provides them; floor-based heights are labelled estimates and buildings
  without data stay flat. It does not simulate slopes, kerbs or
  accessibility, and building coverage is the dated snapshot area.
- **Live keys configured (verified 2026-11-04)**: `DIGITRANSIT_API_KEY` and
  `MODEL_API_KEY` are set server-side (Codespaces secrets) and
  `REVIEWER_TOKEN` is set in the local git-ignored `.env`. Successful live
  calls are claimed only for what was observed that day: Digitransit
  geocoding, a valid HSL PNG tile via `/api/map/{z}/{x}/{y}.png`,
  wheelchair-configured itineraries (including Central Station → Oodi,
  Central → Pasila and a daytime Central → Itäkeskus metro option), a direct
  Meta completion, the conversational journey flow (location search plus
  routing tools), barrier-draft analysis, and one reviewer verification —
  each checked on the actual response content, with unknowns preserved and
  hard requirements never relaxed. The automated suite (`npm test`, 55
  tests) still runs against **mocked** endpoints and is labelled as such;
  it is not live evidence. Keys can expire or be revoked, so re-check
  `/api/health` after any restart.
- Demonstrator scope: one bounded central-Helsinki snapshot for works/places
  context (dated, never live), journey planning delegated to Digitransit/HSL,
  reviewer token as the only access control, and destination entrances remain
  unverified unless a source documents them. Precise user journeys and
  mobility requirements are not logged or stored by default; preferences and
  history are kept only in the current page until the user explicitly submits
  a report.
- Publication status: this repository is now public. No public
  deployment of the application is claimed. Secrets live only in
  server-side environment variables (see `.env.example` for names, never
  values); local recordings, logs, runtime state and uploads are
  git-ignored and must not be committed.

## Hackathon contributions

The project was developed during the hackathon, from 28 October to
4 November 2026. Development included work preceding the commits in this
repository; Git commit dates do not represent the full development
timeline.

**Repository starting point (from Git history):** the initial commit (2026-11-03) contained only a `.gitignore`
and a two-line placeholder README — no application code. Everything else
in this repository was built during the period above:
the Helsinki open-data snapshot and ingestion, the zero-dependency
Node backend, the map-first frontend, accessible journeys over
Digitransit/HSL with the honesty rules for unknown accessibility, the
conversational assistant, the 2.5D journey preview with historical
Mapillary street photos, the simulated-traffic and building-use city
view, and the citizen barrier-report / reviewer workflow. External data
and services (City of Helsinki open data, Digitransit/HSL, OpenStreetMap,
Mapillary, Meta Model API) are third-party inputs, integrated with
attribution — not work claimed as ours.

**Meta models — two different things, kept separate:**

- *In the application:* the Meta Model API, model `muse-spark-1.2` by
  default (configurable via `META_MODEL`), called **backend-only** from
  `server.mjs`. It runs the conversational tool-calling assistant,
  journey step checks, barrier-draft preparation and reviewer
  verification. It never receives API keys for other services and its
  answers are grounded in tool results; the provider-returned model
  name, call time and status are shown under “Sources and details”.
- *For development only:* this codebase was developed with Muse Code
  (Meta models). Muse Code is not part of the application, is not
  called at runtime, and end users never interact with it.

No AI vendor other than Meta is used in the application.

## What each server-side key enables

| Variable | Without it | With it |
|---|---|---|
| *(none)* | Browse the dated Helsinki snapshot, map context, and this README's offline behaviour; AI, routing and imagery report “Not configured” — nothing is simulated | — |
| `DIGITRANSIT_API_KEY` | Journey planning and HSL tiles show “Not configured” | Live wheelchair-configured journeys, geocoding and the HSL basemap (backend only) |
| `MODEL_API_KEY` | Chat assistant, step checks, barrier drafts and reviewer analysis show “Not configured” | Meta assistant and verification as described above |
| `MAPILLARY_ACCESS_TOKEN` | Journey preview runs without street photos and says so | Historical Mapillary street photos in Preview journey |
| `REVIEWER_TOKEN` | City review sign-in cannot succeed; review endpoints return 401 | Reviewer queue, analysis and closure for an authorised reviewer |

An evaluator can clone this repository, copy `.env.example` to `.env`,
add their own keys, and run `npm start` (Node.js >= 20, no install
step). Public hosting is not required and is not claimed.

## Architecture

Zero-dependency Node.js backend (`server.mjs`, `node:http`) serving the static
frontend (`public/`) and a JSON API, with deterministic geospatial helpers,
persistent runtime storage in `data/runtime.json` (git-ignored), and backend
ingestion in `scripts/ingest.py` (Python standard library).
