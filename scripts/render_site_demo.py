"""Render the product site's demo catalogue with the real engine.

    python backend/scripts/render_site_demo.py            # -> site/demo/
    python backend/scripts/render_site_demo.py --only warm-analog-bass

For every curated prompt this runs the same text_to_preset pipeline the
backend uses (Claude planner when ANTHROPIC_API_KEY is set, the rule-based
recipe otherwise), renders it through VSTRenderer (Wavetable.vst3 / FM2),
then applies each Refine as explicit preset_editor operations and renders
those branches too. Output: site/demo/<id>[.<refine>].m4a + catalog.json.

Nothing here is invented: the site plays these files and shows the
parameters they were rendered from.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from backend.models.schemas import PresetEditOperation, RenderRequest  # noqa: E402
from backend.renderer.vst_renderer import VSTRenderer  # noqa: E402
from backend.tools.preset_editor import PresetEditorTool, _field_bounds  # noqa: E402
from backend.tools.text_to_preset import TextToPresetTool  # noqa: E402

OUT_DIR = REPO / "site" / "demo"
DURATION_S = 2.6          # note length; the engine adds a short tail

PROMPTS = [
    ("warm-analog-bass", "Warm Analog Bass", "Warm analog bass with a controlled transient and spacious stereo width."),
    ("glassy-bell", "Glassy Bell", "Glassy bell, bright and metallic, with a long release."),
    ("cinematic-pad", "Cinematic Pad", "Cinematic ambient pad, dark and wide, with a slow attack."),
    ("plucky-keys", "Plucky Keys", "Plucky electric keys, short and percussive, slightly detuned."),
    ("aggressive-lead", "Aggressive Lead", "Aggressive lead with a screaming resonant filter and a fast attack."),
    ("sub-bass", "Sub Bass", "Deep clean sub bass, mono, nothing above the fundamental."),
    ("string-pad", "String Pad", "A soft, slightly detuned pad that opens up slowly, like a string section warming up in a large hall."),
    ("woody-pluck", "Woody Pluck", "Hollow, woody pluck with a quick decay and a touch of chorus, sitting in the mids so it doesn't fight the bass."),
]

ATTACKS = ["instant", "very_fast", "fast", "medium", "slow", "very_slow"]
DECAYS = ["very_short", "short", "medium", "long", "very_long"]


def refine_ops(key: str, p: dict[str, Any]) -> list[PresetEditOperation]:
    op = lambda param, operation, value: PresetEditOperation(parameter=param, operation=operation, value=value)  # noqa: E731
    if key == "brighter":
        return [op("filter_1_cutoff", "add", 16)]
    if key == "wider":
        return [op("width", "add", 0.3)]
    if key == "shorter-attack":
        a = p.get("amp_eg_attack", "medium")
        if a in ("instant", "very_fast", "fast"):
            d = p.get("amp_eg_decay", "medium")
            i = DECAYS.index(d) if d in DECAYS else 2
            return [op("amp_eg_decay", "set", DECAYS[max(0, i - 1)])]
        return [op("amp_eg_attack", "set", "fast")]
    if key == "more-analog":
        return [op("osc_1_waveform", "set", "saw"), op("filter_1_resonance", "add", -0.1), op("waveshaper_drive", "add", 3)]
    if key == "less-harsh":
        return [op("filter_1_cutoff", "add", -12), op("filter_1_resonance", "add", -0.15)]
    raise KeyError(key)


REFINES = {
    "brighter": "brighter",
    "wider": "wider",
    "shorter-attack": "shorter attack",
    "more-analog": "more analog",
    "less-harsh": "less harsh",
}


def title(s: str) -> str:
    return " ".join(w.capitalize() for w in str(s).replace("_", " ").split())


def display(p: dict[str, Any]) -> dict[str, str]:
    """The seven cells the app's result card shows, from real parameters."""
    extra = dict(kv.split("=", 1) for kv in str(p.get("extra", "")).split(";") if "=" in kv)
    wavetable = title(extra.get("subtype") or p.get("osc_1_waveform", ""))
    level = float(p.get("global_volume", 0.0))
    return {
        "wavetable": wavetable,
        "cutoff": str(int(round(float(p.get("filter_1_cutoff", 0))))),
        "resonance": f"{int(round(float(p.get('filter_1_resonance', 0)) * 100))}%",
        "attack": title(p.get("amp_eg_attack", "")),
        "decay": title(p.get("amp_eg_decay", "")),
        "stereo": f"{int(round(float(p.get('width', 0)) * 100))}%",
        "level": ("−" if level < 0 else "") + f"{abs(level):.1f} dB",
    }


LABELS = {"wavetable": "wavetable", "cutoff": "filter cutoff", "resonance": "filter resonance",
          "attack": "amp EG attack", "decay": "amp EG decay", "stereo": "stereo width", "level": "output level"}


def diff(a: dict[str, str], b: dict[str, str]) -> list[str]:
    return [f"{LABELS[k]} {a[k]} → {b[k]}" for k in a if a[k] != b[k]]


def understood(p: dict[str, Any]) -> list[str]:
    """What the planner read out of the sentence — shown as chips."""
    extra = dict(kv.split("=", 1) for kv in str(p.get("extra", "")).split(";") if "=" in kv)
    out = []
    for v in (extra.get("archetype"), extra.get("subtype"), p.get("character")):
        if v:
            out.append(str(v).replace("_", " "))
    out.append(f"attack {p.get('amp_eg_attack', '')}".replace("_", " "))
    out.append(f"decay {p.get('amp_eg_decay', '')}".replace("_", " "))
    if float(p.get("width", 0)) >= 0.6:
        out.append("wide")
    return out


def to_m4a(wav: Path, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "128000", str(wav), str(out)],
                   check=True, capture_output=True)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="render a single prompt id")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="synthflow-demo-"))
    renderer = VSTRenderer(render_dir=tmp)
    # pedalboard plugins must be used from the thread that loaded them: give the
    # renderer a single worker thread and load the engine on that same thread.
    from concurrent.futures import ThreadPoolExecutor
    loop = asyncio.get_running_loop()
    loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
    t2p = TextToPresetTool(repository=None)   # only _generate is used (no snapshots)
    bounds = _field_bounds()
    planner = "claude" if os.environ.get("ANTHROPIC_API_KEY") else "rule-based"

    engine = await loop.run_in_executor(None, renderer._get_engine)
    loaded = [n for n, plug in (("Wavetable.vst3", engine._plugin_wavetable), ("AISynth FM2.vst3", engine._plugin_fm2)) if plug is not None]
    print("plugins loaded:", ", ".join(loaded))
    if not loaded:
        sys.exit("No synth plugin loaded — nothing to render with.")

    catalog: dict[str, Any] = {
        # Truthful label: names the plugin(s) that actually rendered these files.
        "engine": "SynthFlow engine, offline render via " + " + ".join(loaded),
        "plugins": loaded,
        "planner": planner,
        "rendered_at": time.strftime("%Y-%m-%d"),
        "presets": [],
    }

    async def render(params: dict[str, Any], out_name: str) -> str:
        res = await renderer.render(RenderRequest(parameters=params, duration_seconds=DURATION_S))
        to_m4a(Path(res.wav_path), OUT_DIR / f"{out_name}.m4a")
        return f"demo/{out_name}.m4a"

    for pid, name, prompt in PROMPTS:
        if args.only and pid != args.only:
            continue
        t0 = time.perf_counter()
        params = await t2p._generate(prompt, None)
        root_display = display(params)
        entry: dict[str, Any] = {
            "id": pid, "prompt": prompt, "name": name,
            "understood": understood(params), "display": root_display,
            "audio": await render(params, pid), "refines": {},
        }
        for key, label in REFINES.items():
            edited = dict(params)
            applied = 0
            for op in refine_ops(key, params):
                if op.parameter not in edited:
                    continue
                try:
                    edited[op.parameter] = PresetEditorTool._apply(edited.get(op.parameter), op, bounds.get(op.parameter, (None, None)))
                    applied += 1
                except ValueError as exc:
                    print(f"   {pid}/{key}: {op.parameter} rejected: {exc}")
            d = diff(root_display, display(edited))
            if not applied or not d:
                entry["refines"][key] = None      # nothing would change; the site says so
                continue
            entry["refines"][key] = {
                "label": label, "display": display(edited), "diff": d,
                "audio": await render(edited, f"{pid}.{key}"),
            }
        twin = next((e["id"] for e in catalog["presets"] if e["display"] == root_display), None)
        if twin:
            print(f"   ⚠ {pid} came out identical to {twin} — the {planner} planner did not distinguish them"
                  + ("" if planner == "claude" else "; set ANTHROPIC_API_KEY to use the Claude planner"))
        catalog["presets"].append(entry)
        print(f"✓ {pid}  ({time.perf_counter() - t0:.1f}s)  {root_display}")

    if args.only and (OUT_DIR / "catalog.json").exists():
        old = json.loads((OUT_DIR / "catalog.json").read_text())
        merged = {e["id"]: e for e in old.get("presets", [])}
        for e in catalog["presets"]:
            merged[e["id"]] = e
        catalog["presets"] = [merged[i] for i, _, _ in PROMPTS if i in merged]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "catalog.json").write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"wrote {OUT_DIR / 'catalog.json'} with {len(catalog['presets'])} presets")


if __name__ == "__main__":
    asyncio.run(main())
