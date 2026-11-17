import { FOODS } from "./foods.js";
import { computePoints, scaleNutrition, dailyBudget, bmi } from "./points.js";
import { store, initStore, supabase, uploadLocalData, hasLocalData, prefs } from "./store.js";
import { classifyImage, loadModel, barcodeSupported, detectBarcode, lookupBarcode } from "./recognize.js";

const $ = (s) => document.querySelector(s);
const MEALS = [
  ["petit-dejeuner", "Petit-déjeuner"],
  ["dejeuner", "Déjeuner"],
  ["diner", "Dîner"],
  ["collation", "Collations"],
];

const iso = (d) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};
const today = () => iso(new Date());
const addDays = (day, n) => {
  const d = new Date(day + "T12:00:00");
  d.setDate(d.getDate() + n);
  return iso(d);
};
const fmtDay = (day) =>
  day === today()
    ? "Aujourd'hui"
    : day === addDays(today(), -1)
      ? "Hier"
      : new Date(day + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const r1 = (n) => Math.round(n * 10) / 10;

const state = { day: today(), profile: null, latestWeight: null, budget: 45 };

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

function guessMeal() {
  const h = new Date().getHours();
  if (h < 10) return "petit-dejeuner";
  if (h < 15) return "dejeuner";
  if (h >= 18) return "diner";
  return "collation";
}

// ---------- Navigation ----------
function go(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.go === view));
  if (view !== "scan") stopCamera();
  if (view === "today") renderToday();
  if (view === "weight") renderWeight();
  if (view === "profile") renderProfile();
  window.scrollTo(0, 0);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (b) go(b.dataset.go);
});

// ---------- Profil & budget ----------
async function loadProfile() {
  state.profile = await store.getProfile();
  const weights = await store.listWeights();
  state.latestWeight = weights.at(-1)?.kg ?? state.profile?.weightKg ?? null;
  state.budget = state.profile ? dailyBudget({ ...state.profile, weightKg: state.latestWeight }) : 45;
}

function renderProfile() {
  const f = $("#profile-form");
  const p = state.profile ?? {};
  f.sex.value = p.sex ?? "femme";
  f.age.value = p.age ?? "";
  f.heightCm.value = p.heightCm ?? "";
  f.weightKg.value = state.latestWeight ?? "";
  f.goalWeight.value = p.goalWeight ?? "";
  f.activity.value = p.activity ?? "leger";
  f.goal.value = p.goal ?? "perdre";
  updateBudgetPreview();
  renderAccount();
}

function readProfileForm() {
  const f = $("#profile-form");
  const num = (v) => (v === "" ? null : Number(v));
  return {
    sex: f.sex.value,
    age: num(f.age.value),
    heightCm: num(f.heightCm.value),
    weightKg: num(f.weightKg.value),
    goalWeight: num(f.goalWeight.value),
    activity: f.activity.value,
    goal: f.goal.value,
  };
}

function updateBudgetPreview() {
  const p = readProfileForm();
  $("#budget-preview").textContent =
    p.age && p.heightCm && p.weightKg ? `Votre budget : ${dailyBudget(p)} points par jour.` : "Remplissez le profil pour calculer votre budget quotidien.";
}
$("#profile-form").addEventListener("input", updateBudgetPreview);
$("#profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = readProfileForm();
  try {
    await store.saveProfile(p);
    if (p.weightKg && p.weightKg !== state.latestWeight) await store.saveWeight(today(), p.weightKg);
    await loadProfile();
    toast(`Profil enregistré · ${state.budget} points par jour`);
    go("today");
  } catch (err) {
    toast("Erreur : " + err.message);
  }
});

// ---------- Compte Supabase ----------
function renderAccount() {
  const badge = $("#sync-badge");
  if (!supabase) {
    $("#account-off").hidden = true;
    $("#account-on").hidden = true;
    $("#account-disabled").hidden = false;
    badge.textContent = "Local";
    return;
  }
  const user = store.mode === "cloud" ? store.user : null;
  $("#account-off").hidden = !!user;
  $("#account-on").hidden = !user;
  $("#account-disabled").hidden = true;
  if (user) {
    $("#account-email").textContent = user.email;
    $("#upload-local").hidden = !hasLocalData();
  }
  badge.textContent = user ? "☁︎ Synchronisé" : "Local";
}

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const action = e.submitter?.value ?? "login";
  const email = e.target.email.value.trim();
  const password = e.target.password.value;
  const status = $("#account-status");
  status.textContent = "Patientez…";
  const { data, error } =
    action === "signup"
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    status.textContent = error.message;
    return;
  }
  status.textContent =
    action === "signup" && !data.session ? "Compte créé : confirmez votre adresse via l'e-mail reçu, puis connectez-vous." : "";
});
$("#logout").addEventListener("click", () => supabase.auth.signOut());
$("#upload-local").addEventListener("click", async () => {
  try {
    const n = await uploadLocalData();
    toast(`${n} éléments envoyés vers votre compte`);
    await refreshAll();
  } catch (err) {
    toast("Erreur : " + err.message);
  }
});

async function refreshAll() {
  await loadProfile();
  renderAccount();
  const active = document.querySelector(".view.active")?.id.replace("view-", "") ?? "today";
  go(active);
}

// ---------- Journal ----------
async function renderToday() {
  $("#day-label").textContent = fmtDay(state.day);
  $("#next-day").disabled = state.day >= today();
  let entries = [];
  try {
    entries = await store.listEntries(state.day);
  } catch (err) {
    toast("Erreur de chargement : " + err.message);
  }
  const used = entries.reduce((s, e) => s + e.points, 0);
  const kcal = entries.reduce((s, e) => s + e.kcal, 0);
  const left = state.budget - used;

  $("#points-left").textContent = Math.abs(left);
  $("#points-left-label").textContent = left >= 0 ? "points restants" : "points en trop";
  $("#stat-budget").textContent = state.budget;
  $("#stat-used").textContent = used;
  $("#stat-kcal").textContent = Math.round(kcal);
  const C = 2 * Math.PI * 52;
  const ring = $("#ring-fg");
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - Math.min(1, used / state.budget));
  ring.classList.toggle("over", left < 0);

  $("#meals").innerHTML = MEALS.map(([key, label]) => {
    const items = entries.filter((e) => e.meal === key);
    const pts = items.reduce((s, e) => s + e.points, 0);
    return `<div class="meal"><h3>${label}<small>${pts} pts</small></h3>${
      items.length
        ? `<ul class="list">${items
            .map(
              (e) => `<li><div class="grow"><div>${esc(e.name)}</div><div class="sub">${Math.round(e.grams)} g · ${Math.round(e.kcal)} kcal</div></div>
              <span class="pts ${e.points === 0 ? "free" : ""}">${e.points}</span>
              <button class="del" data-del="${e.id}" aria-label="Supprimer ${esc(e.name)}">✕</button></li>`
            )
            .join("")}</ul>`
        : `<p class="empty">Rien pour l'instant.</p>`
    }</div>`;
  }).join("");

  renderWeek();
  if (!state.profile) toast("Commencez par remplir votre profil (onglet Profil).");
}

async function renderWeek() {
  const from = addDays(today(), -6);
  let rows = [];
  try {
    rows = await store.listEntriesRange(from, today());
  } catch {
    /* ignore */
  }
  const html = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(from, i);
    const pts = rows.filter((r) => r.eaten_on === day).reduce((s, r) => s + r.points, 0);
    const h = Math.min(100, (pts / state.budget) * 100);
    const label = new Date(day + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "narrow" });
    html.push(`<button data-day="${day}" class="${day === state.day ? "sel" : ""}" aria-label="${fmtDay(day)} : ${pts} points">
      <span class="bar"><i class="${pts > state.budget ? "over" : ""}" style="height:${h}%"></i></span>${label}</button>`);
  }
  $("#week").innerHTML = html.join("");
}

$("#week").addEventListener("click", (e) => {
  const b = e.target.closest("[data-day]");
  if (b) {
    state.day = b.dataset.day;
    renderToday();
  }
});
$("#prev-day").addEventListener("click", () => {
  state.day = addDays(state.day, -1);
  renderToday();
});
$("#next-day").addEventListener("click", () => {
  if (state.day < today()) state.day = addDays(state.day, 1);
  renderToday();
});
$("#meals").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-del]");
  if (!b) return;
  await store.deleteEntry(b.dataset.del);
  renderToday();
});

// ---------- Fenêtre d'ajout ----------
let current = null; // aliment en cours d'ajout (valeurs pour 100 g)

function openAdd(food, grams) {
  current = food;
  $("#add-name").textContent = food.name;
  $("#add-grams").value = Math.round(grams ?? food.portion ?? 100);
  $("#add-meal").value = guessMeal();
  updateAddPoints();
  $("#add-dialog").showModal();
}
function updateAddPoints() {
  const g = Number($("#add-grams").value) || 0;
  const n = scaleNutrition(current, g);
  const pts = computePoints({ ...n, free: current.free });
  $("#add-points").textContent = pts;
  $("#add-details").textContent =
    `${Math.round(n.kcal)} kcal · protéines ${r1(n.protein)} g · gras saturés ${r1(n.satFat)} g · sucres ${r1(n.sugar)} g · fibres ${r1(n.fiber)} g` +
    (current.free ? " · aliment libre" : "");
}
$("#add-grams").addEventListener("input", updateAddPoints);
$("#add-dialog").addEventListener("click", (e) => {
  const step = e.target.closest("[data-step]");
  if (!step) return;
  const input = $("#add-grams");
  input.value = Math.max(1, (Number(input.value) || 0) + Number(step.dataset.step));
  updateAddPoints();
});
$("#add-dialog").addEventListener("close", async () => {
  if ($("#add-dialog").returnValue !== "ok" || !current) return;
  const grams = Number($("#add-grams").value);
  if (!grams) return;
  const n = scaleNutrition(current, grams);
  try {
    await store.addEntry({
      eaten_on: state.day,
      meal: $("#add-meal").value,
      name: current.name,
      grams,
      kcal: r1(n.kcal),
      protein: r1(n.protein),
      sat_fat: r1(n.satFat),
      sugar: r1(n.sugar),
      fiber: r1(n.fiber),
      points: computePoints({ ...n, free: current.free }),
    });
    remember(current);
    toast(`${current.name} ajouté`);
    go("today");
  } catch (err) {
    toast("Erreur : " + err.message);
  }
});

// Aliments récents / personnalisés, mémorisés sur le téléphone
function remember(food) {
  const recent = prefs.get("recent", []).filter((f) => f.name !== food.name);
  recent.unshift(food);
  prefs.set("recent", recent.slice(0, 30));
}

// ---------- Recherche ----------
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function foodItem(food, extra = "") {
  const pts = computePoints({ ...scaleNutrition(food, food.portion), free: food.free });
  return `<li data-food="${esc(food.name)}"><div class="grow"><div>${esc(food.name)}</div>
    <div class="sub">${food.portion} g · ${Math.round((food.kcal * food.portion) / 100)} kcal ${extra}</div></div>
    <span class="pts ${pts === 0 ? "free" : ""}">${pts}</span></li>`;
}
function allFoods() {
  const recent = prefs.get("recent", []);
  const names = new Set(recent.map((f) => f.name));
  return [...recent, ...FOODS.filter((f) => !names.has(f.name))];
}
function renderSearch() {
  const q = norm($("#search").value.trim());
  const list = q ? allFoods().filter((f) => norm(f.name).includes(q)) : prefs.get("recent", []).slice(0, 6);
  $("#search-results").innerHTML = list.slice(0, 20).map((f) => foodItem(f)).join("") ||
    (q ? `<p class="empty">Aucun résultat. Créez un aliment personnalisé ci-dessous.</p>` : "");
}
$("#search").addEventListener("input", renderSearch);
function pickFrom(listEl, foods) {
  listEl.addEventListener("click", (e) => {
    const li = e.target.closest("[data-food]");
    if (!li) return;
    const food = foods().find((f) => f.name === li.dataset.food);
    if (food) openAdd(food);
  });
}
pickFrom($("#search-results"), allFoods);
let scanFoods = [];
pickFrom($("#scan-results"), () => scanFoods);

$("#custom-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  const food = {
    name: f.name.value.trim(),
    portion: Number(f.portion.value) || 100,
    kcal: Number(f.kcal.value) || 0,
    protein: Number(f.protein.value) || 0,
    satFat: Number(f.satFat.value) || 0,
    sugar: Number(f.sugar.value) || 0,
    fiber: Number(f.fiber.value) || 0,
    free: false,
  };
  openAdd(food);
});

$("#barcode-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#barcode-input").value.replace(/\D/g, "");
  if (code.length >= 8) await handleBarcode(code);
});

// ---------- Caméra & reconnaissance ----------
let stream = null;
let barcodeLoop = null;

async function startCamera() {
  const status = $("#scan-status");
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = "Caméra en direct indisponible ici : utilisez « Importer » pour prendre une photo.";
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
      audio: false,
    });
    const video = $("#video");
    video.srcObject = stream;
    await video.play();
    $("#cam-placeholder").hidden = true;
    $("#snapshot").hidden = true;
    video.hidden = false;
    $("#btn-photo").disabled = false;
    $("#btn-barcode").disabled = !barcodeSupported;
    status.textContent = barcodeSupported ? "" : "Lecture de code-barres non prise en charge par ce navigateur : tapez le code à la main.";
    loadModel().catch(() => {}); // préchargement
  } catch (err) {
    status.textContent = "Accès à la caméra refusé ou impossible (" + err.name + "). Utilisez « Importer ».";
  }
}
function stopCamera() {
  clearInterval(barcodeLoop);
  barcodeLoop = null;
  $("#scan-overlay").hidden = true;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $("#video").srcObject = null;
  $("#cam-placeholder").hidden = false;
  $("#btn-photo").disabled = true;
  $("#btn-barcode").disabled = true;
}
$("#start-cam").addEventListener("click", startCamera);

async function recognize(imgSource) {
  const status = $("#scan-status");
  status.textContent = "Analyse en cours dans votre téléphone…";
  $("#scan-results").innerHTML = "";
  try {
    const { matches, raw } = await classifyImage(imgSource);
    scanFoods = matches.map((m) => m.food);
    if (!matches.length) {
      status.textContent = "Aliment non reconnu. Recherchez-le ci-dessous ou scannez son code-barres.";
      console.info("Prédictions brutes :", raw);
      $("#search").focus();
      return;
    }
    status.textContent = "Touchez l'aliment correspondant pour l'ajouter :";
    $("#scan-results").innerHTML = matches
      .slice(0, 5)
      .map((m) => foodItem(m.food, `<span class="prob">· ${Math.round(m.probability * 100)} % sûr</span>`))
      .join("");
  } catch (err) {
    status.textContent = "La reconnaissance a échoué : " + err.message + ". Vérifiez la connexion au premier lancement (téléchargement du modèle).";
  }
}

$("#btn-photo").addEventListener("click", async () => {
  const video = $("#video");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const img = $("#snapshot");
  img.src = canvas.toDataURL("image/jpeg", 0.85);
  img.hidden = false;
  video.hidden = true;
  stopCamera();
  $("#cam-placeholder").hidden = true;
  await img.decode();
  $("#retake").hidden = false;
  await recognize(img);
});
$("#retake").addEventListener("click", () => {
  $("#retake").hidden = true;
  $("#snapshot").hidden = true;
  startCamera();
});

$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  stopCamera();
  const img = $("#snapshot");
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  $("#video").hidden = true;
  $("#cam-placeholder").hidden = true;
  $("#retake").hidden = false;
  await img.decode();
  const code = await detectBarcode(img).catch(() => null);
  if (code) await handleBarcode(code);
  else await recognize(img);
  e.target.value = "";
});

$("#btn-barcode").addEventListener("click", () => {
  if (barcodeLoop) return;
  $("#scan-overlay").hidden = false;
  $("#scan-status").textContent = "Placez le code-barres dans le cadre…";
  barcodeLoop = setInterval(async () => {
    const code = await detectBarcode($("#video")).catch(() => null);
    if (code) {
      clearInterval(barcodeLoop);
      barcodeLoop = null;
      navigator.vibrate?.(80);
      stopCamera();
      await handleBarcode(code);
    }
  }, 300);
});

async function handleBarcode(code) {
  const status = $("#scan-status");
  status.textContent = `Code ${code} : recherche du produit…`;
  try {
    const food = await lookupBarcode(code);
    status.textContent = "";
    openAdd(food);
  } catch (err) {
    status.textContent = err.message + " Vous pouvez créer l'aliment à la main.";
  }
}

// ---------- Poids ----------
async function renderWeight() {
  const weights = await store.listWeights();
  const goal = state.profile?.goalWeight;
  const last = weights.at(-1)?.kg;
  const first = weights[0]?.kg;
  const b = bmi(last, state.profile?.heightCm);
  $("#weight-summary").innerHTML = last
    ? `<div><b>${last} kg</b><span>actuel</span></div>
       <div><b>${r1(first - last) === 0 ? "" : first > last ? "−" : "+"}${r1(Math.abs(first - last))} kg</b><span>depuis le début</span></div>
       <div><b>${goal ? r1(Math.max(0, last - goal)) + " kg" : b ? r1(b) : "–"}</b><span>${goal ? "restant" : "IMC"}</span></div>`
    : `<p class="empty full">Enregistrez votre premier poids.</p>`;
  $("#weight-chart").innerHTML = chart(weights, goal);
  $("#weight-list").innerHTML = [...weights]
    .reverse()
    .slice(0, 30)
    .map(
      (w) => `<li><div class="grow">${new Date(w.measured_on + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}</div>
      <strong>${w.kg} kg</strong><button class="del" data-wdel="${w.id}" aria-label="Supprimer">✕</button></li>`
    )
    .join("");
}
function chart(weights, goal) {
  if (weights.length < 2) return `<p class="empty">La courbe s'affichera après deux pesées.</p>`;
  const W = 320, H = 160, P = 28;
  const vals = weights.map((w) => w.kg).concat(goal ? [goal] : []);
  const min = Math.floor(Math.min(...vals) - 1), max = Math.ceil(Math.max(...vals) + 1);
  const t0 = new Date(weights[0].measured_on).getTime(), t1 = new Date(weights.at(-1).measured_on).getTime() || t0 + 1;
  const x = (d) => P + ((new Date(d).getTime() - t0) / (t1 - t0 || 1)) * (W - P - 8);
  const y = (v) => 8 + (1 - (v - min) / (max - min)) * (H - P);
  const pts = weights.map((w) => `${x(w.measured_on).toFixed(1)},${y(w.kg).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du poids">
    <line class="axis" x1="${P}" y1="${H - P + 8}" x2="${W}" y2="${H - P + 8}" />
    <text x="0" y="${y(max) + 4}">${max}</text><text x="0" y="${y(min) + 4}">${min}</text>
    ${goal ? `<line class="goal" x1="${P}" x2="${W - 8}" y1="${y(goal)}" y2="${y(goal)}" /><text x="${W - 60}" y="${y(goal) - 4}">objectif</text>` : ""}
    <polyline class="line" points="${pts}" />
    ${weights.map((w) => `<circle r="3" cx="${x(w.measured_on).toFixed(1)}" cy="${y(w.kg).toFixed(1)}" />`).join("")}
  </svg>`;
}
$("#weight-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const kg = Number($("#weight-input").value);
  try {
    await store.saveWeight(today(), kg);
    $("#weight-input").value = "";
    await loadProfile();
    toast("Poids enregistré");
    renderWeight();
  } catch (err) {
    toast("Erreur : " + err.message);
  }
});
$("#weight-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-wdel]");
  if (!b) return;
  await store.deleteWeight(b.dataset.wdel);
  await loadProfile();
  renderWeight();
});

// ---------- Démarrage ----------
(async function start() {
  await initStore(refreshAll);
  await loadProfile();
  renderAccount();
  renderSearch();
  if (!state.profile) go("profile");
  else go("today");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
