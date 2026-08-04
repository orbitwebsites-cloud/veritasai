const DEFAULT_SERVER = "http://127.0.0.1:8000";
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get({ server: DEFAULT_SERVER }, ({ server }) => {
  $("server").value = server;
});

$("save").addEventListener("click", async () => {
  const server = ($("server").value.trim() || DEFAULT_SERVER).replace(/\/+$/, "");
  await chrome.storage.sync.set({ server });

  $("status").textContent = "testing…";
  $("status").className = "";
  try {
    const res = await fetch(`${server}/api/roster`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `server returned ${res.status}`);
    const judge = data.roster.find((r) => r.role === "judge");
    $("status").textContent = `connected · judge: ${judge ? judge.model : "?"}`;
    $("status").className = "ok";
  } catch (err) {
    $("status").textContent = `not reachable — run: python web.py`;
    $("status").className = "bad";
  }
});
