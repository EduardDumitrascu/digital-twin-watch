#!/usr/bin/env python3
"""Import a bounded, dated snapshot of real Helsinki open data.

Sources (verified live before implementation):
- City of Helsinki GeoServer WFS (kartta.hel.fi), layers for excavation
  notices, temporary traffic arrangements, area rentals, buildings with
  register data and accessibility routes. Native CRS EPSG:3879; we request
  GeoJSON reprojected to EPSG:4326. Licence CC BY 4.0 (see CKAN dataset
  "Helsingin kaupungin yleisten alueiden tapahtuma- ja
  maankayttolupajarjestelma", avoindata.suomi.fi).
- Helsinki Service Map REST v4 (www.hel.fi/palvelukarttaws/rest/v4/unit/),
  which returns all published units; we filter client-side to the demo bbox.

Original source values are preserved under `source`. `retrievedAt` is the
retrieval time, never the source update time.
"""
import json, math, sys, urllib.request
from datetime import datetime, timezone
from pathlib import Path

CENTRE = (60.1695, 24.9385)  # Kamppi-Kluuvi, chosen for works coverage
RADIUS_M = 750
WFS = "https://kartta.hel.fi/ws/geoserver/avoindata/wfs"
SM = "https://www.hel.fi/palvelukarttaws/rest/v4/unit/?municipality=helsinki"
UA = {"User-Agent": "DigitalTwinWatch/1.0 (independent demonstrator)"}

# --- ETRS-GK25 (EPSG:3879) transverse Mercator, for WFS bbox only ---
A = 6378137.0; F = 1 / 298.257222101; E2 = F * (2 - F); EP2 = E2 / (1 - E2)
LON0 = math.radians(25)

def to_gk(lat, lon):
    la, lo = math.radians(lat), math.radians(lon)
    N = A / math.sqrt(1 - E2 * math.sin(la) ** 2)
    T = math.tan(la) ** 2; C = EP2 * math.cos(la) ** 2; Av = (lo - LON0) * math.cos(la)
    M = A * ((1 - E2/4 - 3*E2**2/64 - 5*E2**3/256) * la
             - (3*E2/8 + 3*E2**2/32 + 45*E2**3/1024) * math.sin(2*la)
             + (15*E2**2/256 + 45*E2**3/1024) * math.sin(4*la)
             - (35*E2**3/3072) * math.sin(6*la))
    x = 25500000 + N * Av + (N * math.tan(la) / 6) * Av**3 * (1 - T + C)
    y = M + N * math.tan(la) * (Av**2/2 + (5 - T + 9*C + 4*C**2) / 24 * Av**4)
    return x, y

def hav(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    h = (math.sin((lat2-lat1)*p/2) ** 2
         + math.cos(lat1*p) * math.cos(lat2*p) * math.sin((lon2-lon1)*p/2) ** 2)
    return 12742000 * math.asin(math.sqrt(h))

def fetch(url, timeout=120):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def centroid(geom):
    pts = []
    def walk(c):
        if isinstance(c, list) and c and isinstance(c[0], (int, float)):
            pts.append(c)
        elif isinstance(c, list):
            for x in c: walk(x)
    if geom: walk(geom.get("coordinates"))
    if not pts: return CENTRE
    return (sum(p[1] for p in pts) / len(pts), sum(p[0] for p in pts) / len(pts))

def wfs(layer, bbox, count=1000):
    url = (f"{WFS}?service=WFS&version=2.0.0&request=GetFeature"
           f"&typeName=avoindata:{layer}&outputFormat=application/json"
           f"&srsName=EPSG:4326&count={count}&bbox={bbox},EPSG:3879")
    return fetch(url).get("features", []), url

def main():
    retrieved = datetime.now(timezone.utc).isoformat()
    cx, cy = to_gk(*CENTRE)
    bbox = f"{cx-RADIUS_M:.0f},{cy-RADIUS_M:.0f},{cx+RADIUS_M:.0f},{cy+RADIUS_M:.0f}"
    sources, failures = [], []

    def attempt(name, url, fn):
        try:
            out = fn()
            sources.append({"name": name, "url": url, "ok": True})
            return out
        except Exception as e:  # report and continue, never fabricate
            failures.append({"name": name, "url": url, "error": str(e)[:200]})
            sources.append({"name": name, "url": url, "ok": False, "error": str(e)[:200]})
            return []

    works = []
    for layer, kind, cap in [("Kaivuilmoitus_alue", "Excavation notice", 60),
                             ("Tilapainen_liikennejarjestely_alue", "Temporary traffic arrangement", 30),
                             ("Aluevuokraus_alue", "Area rental permit", 20)]:
        feats, url = (None, None)
        def load(layer=layer):
            f, u = wfs(layer, bbox)
            return f
        feats = attempt(layer, f"{WFS} typeName=avoindata:{layer}", load)
        rows = []
        for f in feats:
            p = f.get("properties") or {}
            la, lo = centroid(f.get("geometry"))
            rows.append((hav(CENTRE[0], CENTRE[1], la, lo), {
                "id": f"wfs:{layer}:{p.get('id')}",
                "kind": kind, "layer": layer,
                "title": p.get("tyon_tarkoitus") or p.get("hakemus") or kind,
                "applicationId": p.get("hakemustunnus"),
                "status": p.get("status"),
                "address": p.get("osoite"), "district": p.get("kaupunginosa"),
                "starts": p.get("tyo_alkaa") or p.get("liikennejarjestely_alkaa"),
                "ends": p.get("tyo_paattyy") or p.get("liikennejarjestely_paattyy"),
                "centroid": {"lat": round(la, 6), "lon": round(lo, 6)},
                "geometry": f.get("geometry"),
                "source": {"provider": "City of Helsinki GeoServer WFS",
                           "layer": f"avoindata:{layer}",
                           "url": "https://kartta.hel.fi/ws/geoserver/avoindata/wfs",
                           "original": p},
            }))
        rows.sort(key=lambda r: r[0])
        works.extend(r for _, r in rows[:cap])

    def load_buildings():
        f, _ = wfs("Rakennukset_alue_rekisteritiedot", bbox)
        rows = []
        for feat in f:
            p = feat.get("properties") or {}
            la, lo = centroid(feat.get("geometry"))
            rows.append((hav(CENTRE[0], CENTRE[1], la, lo), {
                "id": f"wfs:Rakennukset:{p.get('id')}",
                "floors": p.get("i_kerrlkm"),
                "heightSource": "recorded_floors" if p.get("i_kerrlkm") else "fallback_estimate",
                "address": " ".join(str(x) for x in [p.get("katunimi_suomi"), p.get("osoitenumero")] if x),
                "geometry": feat.get("geometry"),
                "source": {"provider": "City of Helsinki GeoServer WFS",
                           "layer": "avoindata:Rakennukset_alue_rekisteritiedot",
                           "original": {k: p.get(k) for k in
                                        ["id", "i_kerrlkm", "tyyppi", "katunimi_suomi",
                                         "osoitenumero", "postinumero", "muokkauspvm"]}},
            }))
        rows.sort(key=lambda r: r[0])
        return [r for _, r in rows[:450]]
    buildings = attempt("Rakennukset_alue_rekisteritiedot", WFS, load_buildings)

    def load_routes():
        f, _ = wfs("Esteettomyysreitti_viiva", bbox)
        return [{"id": f"wfs:Esteettomyys:{(x.get('properties') or {}).get('tunniste', i)}",
                 "realisedAccessibility": (x.get("properties") or {}).get("toteutunut_esteettomyys"),
                 "geometry": x.get("geometry"),
                 "source": {"provider": "City of Helsinki GeoServer WFS",
                            "layer": "avoindata:Esteettomyysreitti_viiva",
                            "original": x.get("properties")}} for i, x in enumerate(f)]
    routes = attempt("Esteettomyysreitti_viiva", WFS, load_routes)

    def load_services():
        units = fetch(SM, timeout=180)
        rows = []
        for u in units:
            la, lo = u.get("latitude"), u.get("longitude")
            if la is None or lo is None: continue
            d = hav(CENTRE[0], CENTRE[1], la, lo)
            if d > RADIUS_M + 250: continue
            vp = u.get("accessibility_viewpoints") or ""
            known = any(v.split(":", 1)[1] != "unknown" for v in vp.split(",") if ":" in v)
            # Classification from source metadata only: city-produced units are
            # public services; platform-maintained listings with unknown
            # production are businesses; anything else stays unclassified.
            if u.get("provider_type") == "SELF_PRODUCED":
                category = "public_service"
            elif u.get("provider_type") == "UNKNOWN_PRODUCTION_METHOD":
                category = "business"
            else:
                category = "place"
            rows.append((d, {
                "id": f"servicemap:{u.get('id')}",
                "name": u.get("name_en") or u.get("name_fi"),
                "nameFi": u.get("name_fi"), "nameSv": u.get("name_sv"),
                "address": u.get("street_address_en") or u.get("street_address_fi"),
                "lat": la, "lon": lo,
                "www": u.get("www_en") or u.get("www_fi"),
                "category": category,
                "providerType": u.get("provider_type"),
                "accessibilityViewpoints": vp or None,
                "accessibilityKnown": known,
                "accessibilityWww": u.get("accessibility_www"),
                "source": {"provider": "Helsinki Service Map REST v4",
                           "url": "https://www.hel.fi/palvelukarttaws/rest/v4/unit/",
                           "original": {k: u.get(k) for k in
                                        ["id", "name_fi", "name_en", "street_address_fi",
                                         "latitude", "longitude", "accessibility_viewpoints",
                                         "accessibility_www", "data_source_url",
                                         "provider_type", "dept_id", "ontologytree_ids"]}},
            }))
        rows.sort(key=lambda r: r[0])
        return [r for _, r in rows[:80]]
    services = attempt("Service Map units", SM, load_services)

    snapshot = {
        "snapshotId": retrieved[:10],
        "retrievedAt": retrieved,
        "demoArea": {"name": "Kamppi-Kluuvi, central Helsinki",
                     "centre": {"lat": CENTRE[0], "lon": CENTRE[1]},
                     "radiusM": RADIUS_M,
                     "note": "Bounded demonstrator sample. Cached snapshot, not live data."},
        "licence": "CC BY 4.0",
        "attribution": "Source: City of Helsinki (Helsingin kaupunkiympäristön toimiala / Service Map). Independent demonstrator; not endorsed by the City of Helsinki.",
        "sources": sources, "failures": failures,
        "works": works, "services": services,
        "buildings": buildings, "accessibilityRoutes": routes,
    }
    out = Path(__file__).resolve().parent.parent / "data" / f"snapshot-{retrieved[:10]}.json"
    out.write_text(json.dumps(snapshot, ensure_ascii=False))
    print(f"wrote {out} works={len(works)} services={len(services)} "
          f"buildings={len(buildings)} routes={len(routes)} failures={failures}")

if __name__ == "__main__":
    sys.exit(main())
