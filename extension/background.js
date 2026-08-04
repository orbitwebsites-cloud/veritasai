// Right-click a selection -> put it on trial.
// The extension never talks to a remote service. Every request goes to the
// VeritasAI server the user runs on their own machine, which is where the API
// keys live. Nothing leaves localhost except the retrieval the server itself
// performs.

const DEFAULT_SERVER = "http://127.0.0.1:8000";

async function serverUrl() {
  const { server } = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  return server.replace(/\/+$/, "");
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "veritas-try",
    title: 'Put "%s" on trial',
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "veritas-try" || !info.selectionText || !tab?.id) return;
  const claim = info.selectionText.trim().slice(0, 500);

  // Show the panel immediately so the user gets feedback while the trial runs.
  chrome.tabs.sendMessage(tab.id, { type: "veritas:pending", claim });

  try {
    const base = await serverUrl();
    const res = await fetch(`${base}/api/verdict?claim=${encodeURIComponent(claim)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `server returned ${res.status}`);
    chrome.tabs.sendMessage(tab.id, { type: "veritas:verdict", claim, data });
  } catch (err) {
    chrome.tabs.sendMessage(tab.id, {
      type: "veritas:error",
      claim,
      message:
        String(err.message || err) +
        " — is the VeritasAI server running? Start it with: python web.py",
    });
  }
});
