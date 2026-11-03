# Digital Twin Watch — Helsinki Demonstrator

AI-powered infrastructure monitoring with evidence verification, an interactive
map, and citizen participation. Built with Meta AI.

An independent demonstrator using Helsinki public data. It is **not endorsed by
the City of Helsinki**. Cached data is always labelled with its snapshot date
and is never described as live.

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

## Citizen experience

The screen is a full-area calm Helsinki base map with a floating
“Ask about works, accessibility, or report a problem…” input. One shared,
closable panel (max 380 px) shows either the AI conversation, search results
or project details — never two sidebars. A dismissible welcome card offers
three working conversation starters. Places are classified from Service Map
metadata (`provider_type`): city-produced units are “Public service”,
platform-maintained listings are “Business”, the rest stay “Place”.
Accessibility is shown as recorded or explicitly **unknown**; route segments
recorded as realised-accessible are solid green, others dashed grey.

The chat uses a bounded, backend-only Meta tool-calling loop (max 5 model
steps, allowlisted tools only: search works/places, get project, get nearby
places, get approved evidence/findings, prepare report draft). Drafts are
never saved until the user confirms. Pending submissions and their findings
never reach public chat or APIs.

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

- Real works/permits and places on a clean geographic map (MapLibre GL,
  OpenFreeMap “Positron” vector style: muted land, water, parks, buildings and
  street labels; documented free access with no API key or account at
  openfreemap.org, attribution “OpenFreeMap © OpenMapTiles, Data from
  OpenStreetMap”). The OpenStreetMap raster tile server was removed after it
  began serving “Access blocked” denial images to this deployment (the CDN
  returns an `x-blocked: Access denied` header even with HTTP 200, so loaded
  image counts alone did not prove a working map); key-gated CARTO tiles and
  the Helsinki cadastral WMS were removed earlier. If the basemap provider
  fails, the app shows a clear in-map message and keeps project data visible.
  Markers cluster below zoom 17 and expand on click; works (amber diamonds),
  public services (green) and businesses (slate) use distinct shapes and
  colours, with labels on hover/selection only.
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
- 3D limitation: a geographic 3D view integrated with streets, water and
  selection could not be completed to an acceptable standard in this
  iteration, so the 3D toggle was **removed from the main interface** rather
  than shipping a detached block model. Building footprints remain available
  as a 2D layer, and floor counts/height provenance stay in the source
  records.
- A clearly labelled **“Demo scenario”** staged evidence entry on one real work
  record demonstrates: real work record -> nearby service/accessibility
  context -> submitted evidence -> Meta verification -> sourced finding ->
  recorded action -> new evidence -> reassessment -> human-confirmed closure.
  It makes no factual claim about the real project.

## Data provenance (verified live, 2026-11-03)

| Source | Verified response | Use |
|---|---|---|
| City of Helsinki GeoServer WFS `kartta.hel.fi/ws/geoserver/avoindata/wfs` | GetCapabilities 200; layers `Kaivuilmoitus_alue`, `Tilapainen_liikennejarjestely_alue`, `Aluevuokraus_alue`, `Rakennukset_alue_rekisteritiedot`, `Esteettomyysreitti_viiva`; native CRS EPSG:3879 | Works, buildings, accessibility routes in a 750 m bounded sample around Kamppi-Kluuvi |
| CKAN dataset (avoindata.suomi.fi) | Package metadata 200; licence **CC BY 4.0**, City of Helsinki environment division | Licence and attribution for the permit system |
| Helsinki Service Map REST v4 `www.hel.fi/palvelukarttaws/rest/v4/unit/` | Returns all published units (21,499 at retrieval); filtered client-side to the demo area | 80 nearest public services with accessibility viewpoint codes |
| Helsinki 3D / roadworks pages | Reviewed; full-city photogrammetry not used | Simplified extruded footprints instead, documented above |

Snapshot `data/snapshot-2026-11-03.json` preserves source identifiers, source
URLs, original values (`source.original`), and the retrieval timestamp
(`retrievedAt`), distinct from source dates. Import counts: 84 works, 80
services, 450 buildings, 240 accessibility-route segments, 0 source failures.
If a source fails at import, the ingester reports it and continues with
verified sources; it never substitutes fiction.

Attribution: Source: City of Helsinki. Licence CC BY 4.0.

## Limitations

- Demonstrator scope: one bounded central-Helsinki area, dated snapshot, no
  live feed, no authentication (the City review queue is a local demo role, not
  access control), file uploads record the file name only (binaries are not
  stored), and service accessibility codes summarise surveyed features — they
  do not certify an accessible route.
- The repository and preview ports stay private; nothing is deployed publicly.

## Architecture

Zero-dependency Node.js backend (`server.mjs`, `node:http`) serving the static
frontend (`public/`) and a JSON API, with deterministic geospatial helpers,
persistent runtime storage in `data/runtime.json` (git-ignored), and backend
ingestion in `scripts/ingest.py` (Python standard library).
