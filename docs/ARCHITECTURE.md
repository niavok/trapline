# Architecture

Personal multimodal shopping-tour optimizer (Next.js App Router on Vercel).

## Limits that shape the design (checked October 2026)

| Constraint | Value | Consequence |
| --- | --- | --- |
| `computeRouteMatrix` elements per request | 625 in general, **100 for TRANSIT** and for `TRAFFIC_AWARE_OPTIMAL` | Tiles of 25x25 (walk, drive `TRAFFIC_AWARE`) and 10x10 (transit) |
| `computeRouteMatrix` throughput | **3,000 elements / minute** per project | A full 3-mode matrix for ~40 nodes (~4-5k elements) needs a throttled queue over ~2 min, not `Promise.all` |
| Waypoints given as address / placeId | 50 per request | Always send lat/lng |
| Matrix billing | Per element. Essentials ~5 USD / 1000 (10k free / month), Pro ~10 USD / 1000 (5k free / month; traffic-aware routing is Pro) | Pruning pairs matters more than anything else |
| Places Text Search with opening hours | Enterprise SKU, ~35 USD / 1000 requests, 1k free / month | One request per brand, negligible |
| Vercel function duration (Fluid compute) | 300 s default/max on Hobby, up to 800 s on Pro | A solve call fits, but the matrix pass must stream progress |

## Main design decisions

1. **The solver is pure** (`src/lib/solver`): node list + one raw-time matrix per
   mode + opening intervals (minutes since departure) in, ranked tours out. No
   I/O, no dates, no Google types.
2. **Exact k-best search.** Label-setting A\* on the state
   `(position, car position, visited brands)`; each label also carries the
   clock time. Waiting before opening is allowed and costs 1 per minute, which
   gives a clean dominance rule: A beats B at the same state if
   `A.time <= B.time` and `A.cost + (B.time - A.time) <= B.cost`. A label is
   dropped once *k* settled labels dominate it, so the top-k stays exact even
   with opening hours (verified against a brute-force enumerator on 300 random
   instances).
3. **Move pruning (part of the model).** Walk/transit legs only go to a shop of
   a brand not done yet or back to the car; drive legs can go anywhere (any
   reachable node is a parking spot). Walk/transit legs strictly dominated by
   the other mode (slower *and* costlier) are skipped.
4. **Lower bound.** Each remaining brand costs at least its dwell plus the
   cheapest leg into one of its shops; one more leg into home is needed if we
   or the car are away. Consistent, so A\* stays exact. This cut a
   6 brands x 8 candidates case from ~20 s to < 1 s (top-1) / ~4 s (top-10).
5. **Two-pass timing.** Matrices (pass 1) feed the solver with k = 10; the
   refinement pass calls `computeRoutes` on the transit legs of those tours,
   re-prices walking parts at the walk coefficient, and replays each itinerary
   with `simulateItinerary` (which re-checks opening hours with the new times)
   before re-ranking and keeping 5.

## File layout

```
src/
  lib/
    solver/            # pure, fully unit-tested
      types.ts         # SolverInput, Tour, Leg...
      rules.ts         # opening hours, parking penalty, single-leg application
      solve.ts         # k-best A* search
      simulate.ts      # replay a fixed itinerary (refinement pass)
      summary.ts, heap.ts
    google/            # (next step) thin, typed REST clients
      places.ts        # Text Search (IDF bounding box, field mask)
      routeMatrix.ts   # tiling, throttling (elements/min), no-route handling
      routes.ts        # computeRoutes for transit legs (step breakdown)
    planning/          # (next step) glue between APIs and solver
      nodes.ts         # brands + candidates + parkings -> SolverNode[]
      openingHours.ts  # Places periods (Europe/Paris) -> minutes since departure
      elements.ts      # billed-element estimate shown before running
      refine.ts        # pass 2
    cache/
      types.ts         # MatrixCache interface (get/set many)
      memory.ts        # in-memory LRU; Upstash Redis adapter later
    maps/links.ts      # https://www.google.com/maps/dir/?api=1&...&travelmode=
    auth/session.ts    # signed cookie (HMAC of APP_PASSWORD)
    rateLimit.ts
  middleware.ts        # redirects to /login without a valid session
  app/
    page.tsx           # form, candidate checklist, estimate, results
    login/page.tsx
    api/login/route.ts
    api/candidates/route.ts   # Places search -> candidates to review
    api/solve/route.ts        # matrices + solve + refine (streams progress)
  components/          # TourForm, CandidateList, TourList, TourMap (Leaflet, ssr: false)
```

## Open points / known approximations

- Matrices are computed for one departure time slot; real legs depart later.
  The refinement pass uses each leg's actual departure time for transit.
- Pass 1 assumes walk/transit matrices are roughly metric (no detour through a
  node where nothing happens can be shorter).
- Malls close too: a car parked at a shop has no closing-time check.
