# Architecture

Personal multimodal shopping-tour optimizer (Next.js App Router on Vercel).
Goal: decide *roughly* where to go (which mall / district, which modes), not a
minute-accurate schedule. A solve may take up to ~1 minute.

## Score vs time

- **Score** (`Tour.cost`) ranks tours: travel x mode coefficient + parking +
  shopping time (+ waiting x `waitCostPerMinute`, default 0). It expresses
  preferences ("15 more minutes are worth avoiding the car") and is **never
  displayed as a time**.
- **Real time** (`durationMinutes`, per-mode minutes, return time) is what the
  UI shows, so preferences are not counted twice.

## Limits that shape the design (checked October 2026)

| Constraint | Value | Consequence |
| --- | --- | --- |
| `computeRouteMatrix` per request | 625 elements, **100 for TRANSIT** / `TRAFFIC_AWARE_OPTIMAL` | Only matters for bulk calibration |
| `computeRouteMatrix` throughput | 3,000 elements / minute | Irrelevant once measurements are lazy |
| Google billing | per element, Essentials ~5 USD / 1000 (10k free / month), Pro ~10 USD / 1000 (5k free) | Measure few legs, cache them |
| Google caching terms | coordinates: 30 days max; Routes durations unclear | Cache TTL 30 days |
| PRIM (IDFM) journey planner | free, 20k req/day and 10 req/s for older tokens (check yours) | Transit measurements from IDFM, not Google |
| Vercel functions | 300 s (Hobby) / 800 s (Pro) with Fluid compute; bundle 250 MB | Offline road graph can ship in the bundle |

## Pipeline

1. **Candidates**: Places Text Search per brand (Ile-de-France bounding box,
   opening hours), K nearest to home, user unticks some.
2. **Estimates (free)** for every pair:
   - walk: crow-fly x 1.3 / 4.8 km/h, used as final value (no cap: the walk
     coefficient decides);
   - drive: offline road graph from OpenStreetMap (junctions only, one-ways,
     traffic lights), time = km x pace per road group + per light + per
     junction + fixed, fitted on reference trips (own times or Google);
   - transit: crow-fly model, superseded by cached zone-to-zone values.
3. **Lazy measurement** (`planning/lazySolve.ts`): solve on estimates, measure
   the unknown transit / drive legs of the best 2k tours (PRIM / Google), solve
   again, until the top-k only uses measured legs. Exact when estimates never
   exceed the real time (and waiting is free in the score); with calibrated
   estimates it measures ~5-10 % of the pairs in < 10 rounds.
4. **Zone cache** (`geo/zones.ts`, `planning/cachedSource.ts`): ~400 m grid
   cells; key = mode + time slot (weekday peak / off-peak, Saturday, Sunday) +
   origin cell + destination cell. Shared across requests (Upstash Redis in
   production; serverless memory does not survive), TTL 30 days. Legs inside a
   single cell are not shared.

## Solver (`src/lib/solver`, pure)

- Label-setting A\* on `(position, car position, visited brands)`; labels carry
  clock time for opening hours. Waiting before opening is allowed.
- Dominance at a state: `A.time <= B.time` and
  `A.g + c x max(0, min(B.time, W) - A.time) <= B.g`, with `c` the waiting cost
  and `W` the latest opening time among shops still to visit.
- **Top-k distinct by shop set** (default): only the best itinerary of each set
  of shops is kept ("Velizy by car" vs "Les Halles by RER" rather than 5 orders
  of the same visit). `distinct: "itinerary"` keeps every itinerary.
- Move pruning: walk / transit legs go to a brand not done yet or back to the
  car; drive legs go anywhere (any node is a place to park). Walk / transit
  legs slower *and* costlier than the other mode are skipped.
- Consistent lower bound: per remaining brand, dwell + cheapest leg into one of
  its shops; one more leg into home when we or the car are away.
- Verified against a brute-force enumerator (300 random instances x both
  distinctness modes, with mutation checks).

## File layout

```
src/lib/
  solver/      types, rules, solve (A*), simulate (replay an itinerary), tests
  geo/         geo (haversine), crowFly (estimate models), zones (cells, slots, keys)
  cache/       TravelTimeCache interface, in-memory implementation
  planning/    lazySolve (measurement loop), cachedSource (zone cache + fetcher)
  roads/       OSM -> compact directed graph (build), binary format, Dijkstra and
               drive matrix (graph), linear time model fit on reference trips
               (calibrate); scripts/roads/ runs them on the real extract
  (next)       google/ (places, routes), prim/ (transit), auth, rateLimit
src/app/       (next) form, candidates, results, map, /api/candidates, /api/solve
```

## Known approximations

- Estimates are calibrated, not strict lower bounds: a leg much slower than its
  estimate is always measured, a leg much faster may hide a better tour.
- Transit time depends on the slot, not on the exact minute.
- The closing time of a mall where the car is parked is not checked.
