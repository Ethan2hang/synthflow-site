# SynthFlow — product site

Static landing page for SynthFlow. No build step: plain HTML, CSS and one ES
module, same convention as `../frontend`.

```bash
cd site
python3 -m http.server 4400
# -> http://localhost:4400
```

On a Mac you can also just double-click `serve.command`. A server is
required: the page loads `demo/catalog.json` and the audio files with
`fetch`, which browsers block from `file://`.

To re-render the demo audio with the real planner and engine (needs the
repo, its `.venv`, and `ANTHROPIC_API_KEY`):

```bash
ANTHROPIC_API_KEY=sk-... .venv/bin/python backend/scripts/render_site_demo.py
```

What's in here:

- `index.html` — the page. The hero is a guided demo of the product loop
  (pick a sound → thinking / mapping / rendering → hear → refine → versions).
- `site.css` — tokens follow `../frontend/css/styles.css` (White & Ink light,
  neutral-grey dark; violet only on the primary action, focus and waveform).
- `site.js` — plays the pre-rendered demo: loads `demo/catalog.json`, decodes
  the audio, draws the waveform from the samples, Refine switches to the
  pre-rendered branch and lists the parameter diff, Download saves a WAV.
- `demo/` — `catalog.json` + audio rendered by `backend/scripts/render_site_demo.py`
  (a copy of the script is in `scripts/` inside the zip). The current files
  were rendered with the rule-based fallback planner; re-run with
  `ANTHROPIC_API_KEY` for real results.

Things still to fill in (search for `[` in `index.html`):

- early-access form endpoint (`#cta-form` currently just explains it isn't wired)
- GitHub and contact links in the footer
- platform line in Specifications
