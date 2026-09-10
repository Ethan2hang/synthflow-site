# SynthFlow product website

Compiled static build for https://astherlabs.com/.
GitHub Pages serves the repository root on `main`; `.nojekyll` is intentional.

The homepage keeps the original static ivory sculpture and the accepted gold-sphere motion.
Product routes: `/`, `/workflow/`, `/reference-audio/`, `/preview/`, at the domain root.
The actual frontend preview remains at `/interface/index.html`.
Keep `CNAME` containing `astherlabs.com` when replacing the compiled files.

## Scope and provenance

This is a development demonstration, not a verified SynthFlow product release.
The catalogue contains 48 prerecorded AAC assets and eight prompts with only two distinct displayed parameter recipes. A verified keyed render is still required before formal release.
The page retains its exact offline-render disclosure, Audio provenance details, and backend/plugin availability boundaries.
The source project retains the failing catalogue release gate; this static repository does not run or bypass it.

The repository contains compiled browser assets, the recorded catalogue, the frontend preview and its download package. It does not include the product backend, native plugin, API keys, node_modules or the React source project.
