"use strict";

const form = document.getElementById("form");
const apiFields = document.getElementById("apiFields");
const permCard = document.getElementById("permissions");
const savedNote = document.getElementById("saved");

// The form feeds two storage keys: "settings" (read everywhere, including store pages)
// and "credentials" (background and this page only). See lib/common.js.
function readForm() {
  const data = new FormData(form);
  const text = (name) => String(data.get(name) || "").trim();
  return {
    settings: {
      steamMethod: data.get("steamMethod") === "api" ? "api" : "session",
      refreshHours: CSO.refreshHours({ refreshHours: data.get("refreshHours") }),
      matchByTitle: form.elements.matchByTitle.checked,
      gogColor: String(data.get("gogColor") || CSO.DEFAULT_SETTINGS.gogColor),
      steamColor: String(data.get("steamColor") || CSO.DEFAULT_SETTINGS.steamColor)
    },
    credentials: {
      steamApiKey: text("steamApiKey"),
      steamId64: text("steamId64"),
      itadApiKey: text("itadApiKey")
    }
  };
}

function fillForm(settings, credentials) {
  form.elements.steamMethod.value = settings.steamMethod;
  form.elements.refreshHours.value = settings.refreshHours;
  form.elements.matchByTitle.checked = !!settings.matchByTitle;
  form.elements.gogColor.value = settings.gogColor;
  form.elements.steamColor.value = settings.steamColor;
  form.elements.steamApiKey.value = credentials.steamApiKey;
  form.elements.steamId64.value = credentials.steamId64;
  form.elements.itadApiKey.value = credentials.itadApiKey;
  toggleApiFields();
}

function toggleApiFields() {
  apiFields.hidden = form.elements.steamMethod.value !== "api";
}

async function save() {
  await browser.storage.local.set(readForm());
  savedNote.hidden = false;
  setTimeout(() => { savedNote.hidden = true; }, 2000);
}

function row(dl, label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  dl.append(dt, dd);
}

function list(ul, items, className) {
  for (const text of items) {
    const li = document.createElement("li");
    li.className = className;
    li.textContent = text;
    ul.append(li);
  }
}

async function renderStatus() {
  let s;
  try {
    s = await browser.runtime.sendMessage({ type: "getStatus" });
  } catch (e) {
    const ul = document.getElementById("messages");
    ul.textContent = "";
    list(ul, [`Background page not reachable: ${e.message}`], "error");
    return;
  }
  permCard.hidden = s.permissionsGranted;

  const dl = document.getElementById("status");
  dl.textContent = "";
  if (s.steam) {
    const who = s.steam.steamId ? ` (SteamID ${s.steam.steamId})` : "";
    row(dl, "Steam", `${s.steam.apps} apps, ${s.steam.subs} packages, ${s.steam.named} with names — via ${s.steam.method === "api" ? "Web API" : "browser login"}${who}, ${CSO.formatTime(s.steam.fetchedAt)}`);
  } else {
    row(dl, "Steam", "not loaded yet");
  }
  if (s.gog) {
    row(dl, "GOG", `${s.gog.ids} products, ${s.gog.titled} with titles — ${CSO.formatTime(s.gog.fetchedAt)}`);
  } else {
    row(dl, "GOG", "not loaded yet");
  }
  if (s.maps && s.maps.stats) {
    const st = s.maps.stats;
    row(dl, "Matched", `${st.steamItemsOwnedOnGog} Steam items are owned on GOG · ${st.gogItemsOwnedOnSteam} GOG items are owned on Steam — built ${CSO.formatTime(s.maps.builtAt)}`);
  } else {
    row(dl, "Matched", "nothing yet");
  }
  row(dl, "Refresh", s.status.refreshing ? "running…" : `last finished ${CSO.formatTime(s.status.finishedAt)}`);

  const ul = document.getElementById("messages");
  ul.textContent = "";
  list(ul, s.status.errors || [], "error");
  list(ul, s.status.warnings || [], "warning");
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  await save();
});

for (const r of form.elements.steamMethod) r.addEventListener("change", toggleApiFields);

document.getElementById("refresh").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    await save();
    await browser.runtime.sendMessage({ type: "refreshNow" });
  } finally {
    btn.disabled = false;
    renderStatus();
  }
});

document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Clear the cached libraries and matches? Settings are kept.")) return;
  await browser.runtime.sendMessage({ type: "clearCache" });
  renderStatus();
});

document.getElementById("grant").addEventListener("click", async () => {
  const ok = await browser.permissions.request({ origins: CSO.HOST_ORIGINS });
  if (ok) {
    await browser.runtime.sendMessage({ type: "refreshNow" });
  }
  renderStatus();
});

// The background writes `status` at the start and end of every refresh and `maps` when the
// match tables change; those writes drive the status card (no polling).
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.status || changes.maps)) renderStatus();
});

(async () => {
  fillForm(await CSO.getSettings(), await CSO.getCredentials());
  renderStatus();
})();
