"""VeritasAI CLI — put a claim on trial from the terminal.

    python cli.py "the great wall of china is visible from space"
    python cli.py --json "vaccines cause autism" > verdict.json
    python cli.py --models
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table
from rich.text import Text

from veritas import config as cfg
from veritas.config import NoProviderError, ROLE_LABELS, ROLES
from veritas.engine import resolve, try_claim
from veritas.providers import build_catalog
from veritas.schemas import Trial

# On Windows a redirected stdout defaults to cp1252, which cannot encode the
# box-drawing and block characters used below — so `cli.py ... > out.txt`
# crashed with UnicodeEncodeError while the same command to a terminal worked.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):  # detached or already-wrapped stream
            pass

console = Console()

VERDICT_STYLE = {
    "TRUE": "bold green",
    "MOSTLY TRUE": "green",
    "MIXED": "bold yellow",
    "MOSTLY FALSE": "red",
    "FALSE": "bold red",
}
STATE_MARK = {
    "pending": ("[dim]·[/dim]", "dim"),
    "running": ("[yellow]◐[/yellow]", "yellow"),
    "repairing": ("[magenta]↻[/magenta]", "magenta"),
    "done": ("[green]✓[/green]", "white"),
    "failed": ("[red]✗[/red]", "red"),
}


def _bar(score: int, width: int = 40) -> Text:
    filled = round(score / 100 * width)
    style = "green" if score >= 61 else "yellow" if score >= 40 else "red"
    bar = Text()
    bar.append("█" * filled, style=style)
    bar.append("░" * (width - filled), style="dim")
    bar.append(f"  {score}/100", style=f"bold {style}")
    return bar


def _progress_table(states: dict[str, str], roster, stages: list[str]) -> Table:
    t = Table.grid(padding=(0, 2))
    t.add_column(width=2)
    t.add_column(width=20)
    t.add_column(style="dim")
    detail = {cfg.GROUNDING: "live web search", cfg.CITATIONS: "CrossRef lookup"}
    for stage in stages:
        mark, style = STATE_MARK[states[stage]]
        t.add_row(mark, Text(ROLE_LABELS[stage], style=style),
                  detail.get(stage) or roster[stage].model)
    return t


CITE_STYLE = {
    "verified": ("green", "✓"),
    "partial": ("yellow", "~"),
    "unverified": ("bold red", "✗"),
    "journal_only": ("dim", "·"),
    "institutional": ("dim", "·"),
    "unsourced": ("dim", "·"),
}


def _render_grounding(trial: Trial) -> None:
    g = (trial.verdict or {}).get("_grounding")
    node = trial.node(cfg.GROUNDING)
    if not g:
        if node and not node.ok:
            console.print(Panel(
                Text(f"Retrieval unavailable — the parties argued from training data only.\n{node.error}",
                     style="dim"),
                title="[dim]Court Researcher[/dim]", border_style="dim"))
        return

    rows = []
    if g.get("papers"):
        rows.append(Text.from_markup("[bold]Peer-reviewed literature[/bold] [dim](CrossRef)[/dim]"))
        for p in g["papers"]:
            rows.append(Text.from_markup(f"  • {p['title'][:110]}"))
            meta = " ".join(x for x in (p["authors"], f"({p['year']})" if p["year"] else "",
                                        p["journal"][:40]) if x)
            rows.append(Text.from_markup(f"      [dim]{meta}  doi:{p['doi']}[/dim]"))
    if g.get("encyclopedia"):
        rows.append(Text.from_markup("\n[bold]Encyclopedic[/bold] [dim](Wikipedia)[/dim]"))
        for w in g["encyclopedia"]:
            rows.append(Text.from_markup(f"  • [white]{w['title']}[/white] [dim]{w['snippet'][:110]}[/dim]"))
    if g.get("web"):
        rows.append(Text.from_markup("\n[bold]Current web coverage[/bold] [dim](DuckDuckGo)[/dim]"))
        for w in g["web"]:
            rows.append(Text.from_markup(f"  • {w['title'][:100]}"))
            if w["snippet"]:
                rows.append(Text.from_markup(f"      [dim]{w['snippet'][:110]}[/dim]"))

    c = g.get("counts", {})
    title = (f"[bold]Evidence Retrieved[/bold] [dim]({c.get('papers', 0)} papers · "
             f"{c.get('encyclopedia', 0)} encyclopedia · {c.get('web', 0)} web)[/dim]")
    console.print(Panel(Group(*rows), title=title, border_style="magenta"))


def _render_citations(trial: Trial) -> None:
    report = (trial.verdict or {}).get("_citations")
    if not report or not report.get("checks"):
        return

    from veritas.citations import STATUS_ORDER

    rows = []
    for c in sorted(report["checks"], key=lambda c: STATUS_ORDER.index(c["status"])):
        style, mark = CITE_STYLE[c["status"]]
        rows.append(Text.from_markup(
            f"[{style}]{mark}[/{style}] [dim]{c['party'][:4]}[/dim] {c['source'][:86]}"))
        if c["status"] in ("verified", "partial") and c.get("doi"):
            rows.append(Text.from_markup(
                f"      [dim]→ {c['matched_title'][:78]}  doi:{c['doi']}[/dim]"))
        elif c["status"] == "unverified":
            rows.append(Text.from_markup(f"      [red]→ {c['detail']}[/red]"))

    flagged, checked = report["flagged"], report["checked"]
    if flagged:
        head = (f"[bold red]{flagged} of {checked} checkable citations could not be found "
                f"in CrossRef — treat those as unsupported[/bold red]")
        border = "red"
    elif checked:
        head = f"[green]all {checked} checkable citations matched a real record[/green]"
        border = "green"
    else:
        head = "[dim]no specific works were cited, so nothing was checkable[/dim]"
        border = "dim"

    console.print(Panel(Group(Text.from_markup(head), Text(""), *rows),
                        title="[bold]Citation Audit[/bold] [dim](CrossRef)[/dim]",
                        border_style=border))


def _render_briefs(trial: Trial) -> None:
    briefs = (trial.verdict or {}).get("_briefs", {})
    docket = briefs.get("docket") or {}

    subs = Table.grid(padding=(0, 1))
    subs.add_column(style="cyan", width=4)
    subs.add_column()
    for s in docket.get("sub_claims", []):
        subs.add_row(s["id"], s["text"])
    meta = f"[dim]domain:[/dim] {docket.get('domain', '?')}   [dim]type:[/dim] {docket.get('claim_type', '?')}"
    parts = [Text.from_markup(meta), subs]
    if docket.get("ambiguities"):
        parts.append(Text.from_markup("[dim]contested terms:[/dim] " + ", ".join(docket["ambiguities"])))
    console.print(Panel(Group(*parts), title="[bold]The Docket[/bold]", border_style="cyan"))

    for key, title, color in (
        ("prosecution", "The Prosecution — arguing FALSE", "red"),
        ("expert", "Expert Witness — neutral", "blue"),
        ("defense", "The Defense — arguing TRUE", "green"),
    ):
        payload = briefs.get(key)
        if not payload:
            console.print(Panel(Text("Failed to appear.", style="dim"), title=title, border_style="dim"))
            continue

        rows = []
        if key == "expert":
            rows.append(Text.from_markup(f"[dim]expert certainty:[/dim] [bold]{payload['certainty']}/100[/bold]"))
            if payload["consensus"]:
                rows.append(Text(payload["consensus"]))
            for f in payload["key_findings"]:
                rows.append(Text.from_markup(f"  • {f['finding']}  [dim]({f['source']}, {f['year']})[/dim]"))
            for label, items in (("Open questions", payload["open_questions"]), ("Commonly misread as", payload["common_misreadings"])):
                if items:
                    rows.append(Text.from_markup(f"\n[dim]{label}:[/dim]"))
                    rows.extend(Text.from_markup(f"  – {i}") for i in items)
        else:
            side = "false" if key == "prosecution" else "true"
            rows.append(Text.from_markup(f"[dim]confidence claim is {side}:[/dim] [bold]{payload['confidence']}/100[/bold]"))
            if payload["headline"]:
                rows.append(Text(payload["headline"], style="italic"))
            for e in payload["evidence"]:
                mark = {"strong": "▰▰▰", "moderate": "▰▰▱", "weak": "▰▱▱"}[e["strength"]]
                rows.append(Text.from_markup(f"  [dim]{mark}[/dim] {e['point']}  [dim]({e['source']})[/dim]"))
            for label, items in (("Flaws alleged in the other side", payload["fallacies"]), ("Concedes", payload["concessions"])):
                if items:
                    rows.append(Text.from_markup(f"\n[dim]{label}:[/dim]"))
                    rows.extend(Text.from_markup(f"  – {i}") for i in items)

        console.print(Panel(Group(*rows), title=f"[bold]{title}[/bold]", border_style=color))


def _render_verdict(trial: Trial) -> None:
    v = trial.verdict or {}
    label = v.get("verdict", "MIXED")
    style = VERDICT_STYLE.get(label, "yellow")

    body = [
        Text(label, style=f"{style}"),
        _bar(v.get("truth_score", 50)),
        Text.from_markup(f"[dim]judicial confidence:[/dim] {v.get('confidence', 'Moderate')}"),
    ]
    if v.get("reasoning"):
        body += [Text(""), Text(v["reasoning"])]
    if v.get("strongest_for"):
        body += [Text(""), Text.from_markup(f"[green]Strongest for:[/green] {v['strongest_for']}")]
    if v.get("strongest_against"):
        body += [Text.from_markup(f"[red]Strongest against:[/red] {v['strongest_against']}")]
    if v.get("nuances"):
        body += [Text(""), Text.from_markup("[bold]Nuances[/bold]")]
        body += [Text.from_markup(f"  • {n}") for n in v["nuances"]]
    if v.get("recommended_reading"):
        body += [Text(""), Text.from_markup("[bold]Recommended reading[/bold]")]
        body += [Text.from_markup(f"  • {r}") for r in v["recommended_reading"]]

    console.print(Panel(Group(*body), title="[bold]VERDICT[/bold]", border_style=style, padding=(1, 2)))

    stats = Table.grid(padding=(0, 2))
    stats.add_column(style="dim")
    for col in range(4):
        stats.add_column()
    stats.add_row("node", "model", "time", "repairs", "status")
    for n in trial.nodes:
        status = "[green]ok[/green]" if n.ok else f"[red]{n.error[:60]}[/red]"
        stats.add_row(ROLE_LABELS[n.role], n.model, f"{n.latency_s}s", str(n.repairs), status)
    console.print(Panel(stats, title="[dim]trial record[/dim]", border_style="dim"))
    console.print(Text.from_markup(f"[dim]total wall clock: {trial.total_s:.2f}s[/dim]"))


async def show_models() -> int:
    providers = cfg.available_providers()
    if not providers:
        console.print("[red]No provider keys found.[/red] Copy .env.example to .env and add a key.")
        return 1
    catalog = await build_catalog(providers)
    for name, ids in catalog.items():
        console.print(Rule(f"[bold]{name}[/bold] — {len(ids)} models"))
        for i in sorted(ids):
            console.print(f"  {i}")
    if not catalog:
        console.print("[yellow]Keys are set but no catalog could be fetched.[/yellow]")
    console.print(Rule("[bold]role assignments[/bold]"))
    roster = await resolve()
    for role in ROLES:
        a = roster[role]
        console.print(f"  {ROLE_LABELS[role]:<20} {a.provider.name}/{a.model}")
    return 0


async def run(claim: str, as_json: bool, quiet: bool, ground: bool, verify: bool) -> int:
    roster = await resolve()
    stages = [s for s in cfg.STAGES
              if s in ROLES or (s == cfg.GROUNDING and ground) or (s == cfg.CITATIONS and verify)]
    states = {s: "pending" for s in stages}

    if as_json or quiet:
        trial = await try_claim(claim, roster, ground=ground, verify_citations=verify)
    else:
        console.print(Panel(Text(claim, style="bold"), title="[bold]CLAIM ON TRIAL[/bold]", border_style="white"))
        with Live(_progress_table(states, roster, stages), console=console, refresh_per_second=8) as live:

            def on_progress(role: str, state: str) -> None:
                if role in states:
                    states[role] = state
                    live.update(_progress_table(states, roster, stages))

            trial = await try_claim(claim, roster, on_progress, ground=ground, verify_citations=verify)

    if as_json:
        print(json.dumps(trial.to_dict() | {"verdict": trial.verdict}, indent=2))
        return 0

    if not quiet:
        _render_grounding(trial)
        _render_briefs(trial)
    _render_verdict(trial)
    _render_citations(trial)
    return 0 if any(n.ok for n in trial.nodes) else 2


def main() -> int:
    p = argparse.ArgumentParser(prog="veritas", description="Put a claim on trial before a panel of LLMs.")
    p.add_argument("claim", nargs="*", help="the claim to fact-check")
    p.add_argument("--json", action="store_true", help="emit the full trial record as JSON")
    p.add_argument("--quiet", "-q", action="store_true", help="verdict only, skip the briefs")
    p.add_argument("--models", action="store_true", help="list live models and role assignments, then exit")
    p.add_argument("--no-ground", dest="ground", action="store_false",
                   help="skip the live web search and argue from training data only")
    p.add_argument("--no-citations", dest="verify", action="store_false",
                   help="skip CrossRef verification of cited sources")
    args = p.parse_args()

    try:
        if args.models:
            return asyncio.run(show_models())
        claim = " ".join(args.claim).strip()
        if not claim:
            if sys.stdin.isatty():
                claim = console.input("[bold]Claim to put on trial:[/bold] ").strip()
            else:
                claim = sys.stdin.read().strip()
        if not claim:
            p.error("no claim given")
        return asyncio.run(run(claim, args.json, args.quiet, args.ground, args.verify))
    except NoProviderError as exc:
        console.print(f"[bold red]Setup incomplete.[/bold red] {exc}")
        return 1
    except KeyboardInterrupt:
        console.print("\n[dim]mistrial — interrupted[/dim]")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
