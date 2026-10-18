# trapline

Personal multimodal shopping-tour optimizer: visit one shop of each brand,
starting and ending at home, mixing walking, public transport and car.

Status: the pure solver, the estimate models, the zone cache, the lazy
measurement loop and the offline road graph code are implemented and tested;
building the real Ile-de-France graph, the Google / PRIM adapters, the UI and
deployment are next. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```bash
npm install
npm test          # solver unit tests + brute-force cross-check
npm run typecheck
```

## Offline road graph (run on your machine)

```bash
npm run roads:download     # OSM extract from Geofabrik (~300 MB)
npm run roads:build        # -> data/roads/idf-roads.bin
cp data/roads/places.example.json data/roads/places.json                    # then edit
cp data/roads/reference-trips.example.json data/roads/reference-trips.json  # then edit
npm run roads:bench        # speed, matrix between places, error vs your times
GOOGLE_MAPS_API_KEY=... npm run roads:sample   # optional, measured reference trips
npm run roads:calibrate    # -> data/roads/drive-params.json
```

A ready-made prompt for Claude Code is in
[docs/prompts/road-graph-local.md](docs/prompts/road-graph-local.md).
