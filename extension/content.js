// Renders the verdict as an overlay panel on whatever page the user is reading.

const VERDICT_COLOR = {
  "TRUE": "#4caf7d", "MOSTLY TRUE": "#7fb98a", "MIXED": "#c9a227",
  "MOSTLY FALSE": "#d9764f", "FALSE": "#e0574f",
};
const CITE_MARK = {
  verified: "✓", partial: "~", unverified: "✗", unchecked: "?",
  journal_only: "·", institutional: "·", unsourced: "·",
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function panel() {
  let el = document.getElementById("veritas-panel");
  if (el) return el;
  el = document.createElement("div");
  el.id = "veritas-panel";
  el.addEventListener("click", (e) => {
    if (e.target.classList.contains("veritas-close")) el.remove();
  });
  document.body.appendChild(el);
  return el;
}

function shell(claim, body) {
  return `<div class="veritas-head">
      <span class="veritas-brand">Veritas<b>AI</b></span>
      <button class="veritas-close" aria-label="Close">×</button>
    </div>
    <div class="veritas-claim">${esc(claim)}</div>
    ${body}`;
}

function advocate(p, cls, title, side) {
  if (!p) return "";
  const ev = (p.evidence || []).slice(0, 3)
    .map((e) => `<li>${esc(e.point)}<span class="veritas-src">${esc(e.source)}</span></li>`)
    .join("");
  return `<div class="veritas-brief ${cls}">
      <div class="veritas-brief-h">${title}<span>${p.confidence}<small>/100 ${side}</small></span></div>
      <ul>${ev}</ul>
    </div>`;
}

function verdictHtml(claim, t) {
  const v = t.verdict || {}, b = v._briefs || {}, cites = v._citations || {};
  const color = VERDICT_COLOR[v.verdict] || "#c9a227";

  const flagged = (cites.checks || []).filter((c) => c.status === "unverified");
  const auditLine = flagged.length
    ? `<div class="veritas-audit dirty">✗ ${flagged.length} cited source${
        flagged.length > 1 ? "s" : ""} could not be found in CrossRef${
        flagged.length ? ": " + esc(flagged.map((c) => c.source.slice(0, 60)).join("; ")) : ""}</div>`
    : cites.checked
    ? `<div class="veritas-audit clean">✓ all ${cites.checked} checkable citations matched a real record</div>`
    : "";

  return shell(claim, `
    <div class="veritas-verdict" style="color:${color}">${esc(v.verdict)}</div>
    <div class="veritas-meter"><i style="width:${v.truth_score}%;background:${color}"></i></div>
    <div class="veritas-score">
      <span>truth score <b style="color:${color}">${v.truth_score}</b>/100</span>
      <span>confidence: ${esc(v.confidence)} · ${t.total_s}s</span>
    </div>
    ${v.reasoning ? `<p class="veritas-reason">${esc(v.reasoning)}</p>` : ""}
    ${auditLine}
    ${advocate(b.prosecution, "pro", "Prosecution", "false")}
    ${advocate(b.defense, "def", "Defense", "true")}
    ${(v.nuances || []).length
      ? `<div class="veritas-nuance"><b>Nuances</b><ul>${
          v.nuances.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`
      : ""}
  `);
}

chrome.runtime.onMessage.addListener((msg) => {
  const el = panel();
  if (msg.type === "veritas:pending") {
    el.innerHTML = shell(msg.claim, `<div class="veritas-wait">
      <span class="veritas-spin"></span> Convening the tribunal…
      <div class="veritas-sub">retrieving evidence · five models · ~10s</div></div>`);
  } else if (msg.type === "veritas:verdict") {
    el.innerHTML = verdictHtml(msg.claim, msg.data);
  } else if (msg.type === "veritas:error") {
    el.innerHTML = shell(msg.claim, `<div class="veritas-err">${esc(msg.message)}</div>`);
  }
});
