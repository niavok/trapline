# trapline

Personal multimodal shopping-tour optimizer: visit one shop of each brand,
starting and ending at home, mixing walking, public transport and car.

Status: the pure solver and its tests are implemented; the Google APIs, UI and
deployment are next. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```bash
npm install
npm test          # solver unit tests + brute-force cross-check
npm run typecheck
```
