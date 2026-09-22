"use strict";

const refreshBtn = document.getElementById("refresh");

function row(dl, label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  dl.append(dt, dd);
}

function since(ts) {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function list(ul, items, className) {
  for (const text of items) {
    const li = document.createElement("li");
    li.className = className;
    li.textContent = text;
    ul.append(li);
  }
}

async function render() {
  let s;
  try {
    s = await browser.runtime.sendMessage({ type: "getStatus" });
  } catch (e) {
    const ul = document.getElementById("messages");
    ul.textContent = "";
    list(ul, [`Background page not reachable: ${e.message}`], "error");
    return;
  }
  document.getElementById("perm").hidden = s.permissionsGranted;

  const dl = document.getElementById("status");
  dl.textContent = "";
  row(dl, "Steam", s.steam ? `${s.steam.apps} apps · ${since(s.steam.fetchedAt)}` : "not loaded");
  row(dl, "GOG", s.gog ? `${s.gog.ids} products · ${since(s.gog.fetchedAt)}` : "not loaded");
  if (s.maps && s.maps.stats) {
    row(dl, "On GOG too", `${s.maps.stats.steamItemsOwnedOnGog} Steam items`);
    row(dl, "On Steam too", `${s.maps.stats.gogItemsOwnedOnSteam} GOG items`);
  }
  row(dl, "Refresh", s.status.refreshing ? "running…" : since(s.status.finishedAt));

  const ul = document.getElementById("messages");
  ul.textContent = "";
  list(ul, s.status.errors || [], "error");
  list(ul, s.status.warnings || [], "warning");

  refreshBtn.disabled = !!s.status.refreshing;
}

// The background writes `status` when a refresh starts and when it ends, and `maps` when the
// match tables are rebuilt; re-rendering on those writes is all the popup needs (no polling).
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.status || changes.maps)) render();
});

refreshBtn.addEventListener("click", () => {
  refreshBtn.disabled = true;
  browser.runtime.sendMessage({ type: "refreshNow" }).catch(() => {});
});

document.getElementById("settings").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

document.getElementById("grant").addEventListener("click", async () => {
  const ok = await browser.permissions.request({ origins: CSO.HOST_ORIGINS });
  if (ok) browser.runtime.sendMessage({ type: "refreshNow" }).catch(() => {});
  render();
});

render();
