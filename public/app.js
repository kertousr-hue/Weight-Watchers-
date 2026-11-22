import { FOODS } from "./foods.js";
import { computePoints, scaleNutrition, dailyBudget, bmi, ACTIVITIES, activityPoints } from "./points.js";
import { store, initStore, supabase, uploadLocalData, hasLocalData, prefs, importAll, loadCatalog, cachedCatalog, saveFood, findFoodByBarcode } from "./store.js";
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
  renderStats();
}

async function renderStats() {
  const from = addDays(today(), -59);
  let rows = [], weights = [];
  try {
    [rows, weights] = await Promise.all([store.listEntriesRange(from, today()), store.listWeights()]);
  } catch {
    return;
  }
  const byDay = new Map();
  for (const r of rows) byDay.set(r.eaten_on, (byDay.get(r.eaten_on) ?? 0) + r.points);
  // Série : jours consécutifs notés jusqu'à aujourd'hui (ou hier si rien aujourd'hui)
  let streak = 0;
  let d = byDay.has(today()) ? today() : addDays(today(), -1);
  while (byDay.has(d)) {
    streak++;
    d = addDays(d, -1);
  }
  const last7 = [...byDay.entries()].filter(([day]) => day > addDays(today(), -7));
  const avg = last7.length ? Math.round(last7.reduce((a, [, p]) => a + p, 0) / last7.length) : null;
  const lost = weights.length > 1 ? r1(weights[0].kg - weights.at(-1).kg) : null;
  $("#stats").innerHTML = `
    <div><b>${streak} 🔥</b><span>jour${streak > 1 ? "s" : ""} d'affilée</span></div>
    <div><b>${avg ?? "–"}</b><span>points / jour (7 j)</span></div>
    <div><b>${lost == null ? "–" : (lost >= 0 ? "−" : "+") + Math.abs(lost) + " kg"}</b><span>depuis le début</span></div>`;
}

// Sauvegarde
$("#export-btn").addEventListener("click", async () => {
  try {
    const data = { app: "equilibre", version: 1, exported_at: new Date().toISOString(), ...(await store.exportAll()) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `equilibre-sauvegarde-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    toast("Erreur : " + err.message);
  }
});
$("#import-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "equilibre") throw new Error("ce fichier n'est pas une sauvegarde Équilibre");
    if (!confirm("Ajouter le contenu de cette sauvegarde à vos données actuelles ?")) return;
    const n = await importAll(data);
    await loadProfile();
    toast(`${n} éléments restaurés`);
    renderProfile();
  } catch (err) {
    toast("Import impossible : " + err.message);
  }
});

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
    $("#account-on").hidden = true;
    $("#account-disabled").hidden = false;
    badge.textContent = "Local";
    return;
  }
  const user = store.mode === "cloud" ? store.user : null;
  $("#account-on").hidden = !user;
  $("#account-disabled").hidden = true;
  if (user) $("#account-email").textContent = user.email;
  badge.textContent = !user ? "Non connecté" : navigator.onLine ? "☁︎ En ligne" : "Hors-ligne";
}

// ---------- Connexion obligatoire ----------
// Avec Supabase configuré, l'application n'est utilisable qu'une fois connecté :
// toutes les données sont alors enregistrées en ligne.
async function applyAuthState() {
  const loggedIn = !supabase || store.mode === "cloud";
  document.body.classList.toggle("locked", !loggedIn);
  $("#auth-gate").hidden = loggedIn;
  renderAccount();
  if (!loggedIn) return false;
  // Données notées avant la connexion sur ce téléphone : on les envoie en ligne.
  if (supabase && hasLocalData()) {
    try {
      const n = await uploadLocalData();
      if (n) toast(`${n} éléments de ce téléphone enregistrés en ligne`);
    } catch (err) {
      toast("Envoi des anciennes données impossible : " + err.message);
    }
  }
  return true;
}

// Messages d'erreur de connexion en français
function authMessage(error) {
  const m = error?.message ?? "";
  const map = [
    [/invalid login credentials/i, "E-mail ou mot de passe incorrect."],
    [/email not confirmed/i, "Adresse e-mail pas encore confirmée : ouvrez le lien reçu par e-mail."],
    [/already registered|already exists/i, "Un compte existe déjà avec cet e-mail : connectez-vous."],
    [/password should be at least|weak password/i, "Mot de passe trop court (6 caractères minimum)."],
    [/invalid.*email|unable to validate email/i, "Adresse e-mail invalide."],
    [/rate limit|too many/i, "Trop de tentatives : réessayez dans quelques minutes."],
    [/failed to fetch|network/i, "Pas de connexion Internet."],
  ];
  return map.find(([re]) => re.test(m))?.[1] ?? m;
}

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const action = e.submitter?.value ?? "login";
  const email = e.target.email.value.trim();
  const password = e.target.password.value;
  const status = $("#account-status");
  if (action === "reset") {
    if (!email) return (status.textContent = "Saisissez votre e-mail d'abord.");
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    status.textContent = error ? authMessage(error) : "E-mail envoyé : suivez le lien pour choisir un nouveau mot de passe.";
    return;
  }
  status.textContent = "Patientez…";
  const { data, error } =
    action === "signup"
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    status.textContent = authMessage(error);
    return;
  }
  status.textContent =
    action === "signup" && !data.session ? "Compte créé : confirmez votre adresse via l'e-mail reçu, puis connectez-vous." : "";
});
$("#logout").addEventListener("click", () => supabase.auth.signOut());


// ---------- Journal ----------
const WATER_GOAL = 8;
// Lundi de la semaine qui contient `day`
const weekStart = (day) => {
  const d = new Date(day + "T12:00:00");
  return addDays(day, -((d.getDay() + 6) % 7));
};

async function renderToday() {
  $("#day-label").textContent = fmtDay(state.day);
  $("#next-day").disabled = state.day >= today();
  let entries = [], activities = [], water = 0;
  try {
    [entries, activities, water] = await Promise.all([
      store.listEntries(state.day),
      store.listActivities(state.day),
      store.getWater(state.day),
    ]);
  } catch (err) {
    toast("Erreur de chargement : " + err.message);
  }
  const used = entries.reduce((s, e) => s + e.points, 0);
  const kcal = entries.reduce((s, e) => s + e.kcal, 0);
  const bonus = activities.reduce((s, a) => s + a.points, 0);
  const budget = state.budget + bonus;
  const left = budget - used;

  $("#points-left").textContent = Math.abs(left);
  $("#points-left-label").textContent = left >= 0 ? "points restants" : "points en trop";
  $("#stat-budget").textContent = bonus ? `${state.budget} + ${bonus}` : state.budget;
  $("#stat-used").textContent = used;
  $("#stat-kcal").textContent = Math.round(kcal);
  const C = 2 * Math.PI * 52;
  const ring = $("#ring-fg");
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - Math.min(1, used / budget));
  ring.classList.toggle("over", left < 0);

  state.entries = entries;
  $("#meals").innerHTML = MEALS.map(([key, label]) => {
    const items = entries.filter((e) => e.meal === key);
    const pts = items.reduce((s, e) => s + e.points, 0);
    return `<div class="meal"><h3>${label}<small>${pts} pts</small></h3>${
      items.length
        ? `<ul class="list">${items
            .map(
              (e) => `<li data-edit="${e.id}" class="tap"><div class="grow"><div>${esc(e.name)}</div><div class="sub">${Math.round(e.grams)} g · ${Math.round(e.kcal)} kcal</div></div>
              <span class="pts ${e.points === 0 ? "free" : ""}">${e.points}</span>
              <button class="del" data-del="${e.id}" aria-label="Supprimer ${esc(e.name)}">✕</button></li>`
            )
            .join("")}</ul>`
        : ""
    }<div class="meal-actions"><button class="link" data-add-meal="${key}">+ Ajouter</button>${
      items.length ? "" : `<button class="link" data-copy-meal="${key}">↺ Comme la veille</button>`
    }</div></div>`;
  }).join("");

  // Eau
  $("#water-count").textContent = `${water} / ${WATER_GOAL} verres`;
  $("#glasses").innerHTML = Array.from({ length: Math.max(WATER_GOAL, water) }, (_, i) =>
    `<button class="glass ${i < water ? "full" : ""}" data-water="${i + 1}" aria-label="${i + 1} verre${i ? "s" : ""}"></button>`
  ).join("");
  state.water = water;

  // Activités
  $("#activity-list").innerHTML =
    activities
      .map(
        (a) => `<li><div class="grow"><div>${esc(a.name)}</div><div class="sub">${a.minutes} min · ${Math.round(a.kcal)} kcal</div></div>
        <span class="pts free">+${a.points}</span><button class="del" data-adel="${a.id}" aria-label="Supprimer">✕</button></li>`
      )
      .join("") || `<p class="empty">Bouger rapporte des points bonus pour la journée.</p>`;

  renderWeek();
  if (!state.profile) toast("Commencez par remplir votre profil (onglet Profil).");
}

async function renderWeek() {
  const from = addDays(today(), -6);
  const monday = weekStart(today());
  const start = monday < from ? monday : from;
  let rows = [], acts = [];
  try {
    [rows, acts] = await Promise.all([store.listEntriesRange(start, today()), store.listActivitiesRange(start, today())]);
  } catch {
    /* ignore */
  }
  const sumDay = (list, key, day) => list.filter((r) => r[key] === day).reduce((s, r) => s + r.points, 0);
  const html = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(from, i);
    const pts = sumDay(rows, "eaten_on", day);
    const budget = state.budget + sumDay(acts, "done_on", day);
    const h = Math.min(100, (pts / budget) * 100);
    const label = new Date(day + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "narrow" });
    html.push(`<button data-day="${day}" class="${day === state.day ? "sel" : ""}" aria-label="${fmtDay(day)} : ${pts} points">
      <span class="bar"><i class="${pts > budget ? "over" : ""}" style="height:${h}%"></i></span>${label}</button>`);
  }
  $("#week").innerHTML = html.join("");

  // Bilan depuis lundi (jours où quelque chose a été noté)
  let balance = 0, tracked = 0;
  for (let d = monday; d <= today(); d = addDays(d, 1)) {
    const pts = sumDay(rows, "eaten_on", d);
    if (!pts) continue;
    tracked++;
    balance += state.budget + sumDay(acts, "done_on", d) - pts;
  }
  $("#week-balance").innerHTML = tracked
    ? `Bilan de la semaine (${tracked} jour${tracked > 1 ? "s" : ""}) : <strong class="${balance < 0 ? "neg" : "pos"}">${balance >= 0 ? "+" : "−"}${Math.abs(balance)} points</strong> ${balance >= 0 ? "d'avance" : "de dépassement"}`
    : "";
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
  const del = e.target.closest("[data-del]");
  if (del) {
    await store.deleteEntry(del.dataset.del);
    return renderToday();
  }
  const add = e.target.closest("[data-add-meal]");
  if (add) {
    state.pendingMeal = add.dataset.addMeal;
    return go("scan");
  }
  const copy = e.target.closest("[data-copy-meal]");
  if (copy) {
    const meal = copy.dataset.copyMeal;
    const prev = (await store.listEntries(addDays(state.day, -1))).filter((x) => x.meal === meal);
    if (!prev.length) return toast("Rien à copier : ce repas était vide la veille.");
    for (const { id, user_id, created_at, ...x } of prev) await store.addEntry({ ...x, eaten_on: state.day });
    toast(`${prev.length} aliment${prev.length > 1 ? "s" : ""} copié${prev.length > 1 ? "s" : ""}`);
    return renderToday();
  }
  const edit = e.target.closest("[data-edit]");
  if (edit) openEdit(state.entries.find((x) => x.id === edit.dataset.edit));
});

$("#glasses").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-water]");
  if (!b) return;
  const n = Number(b.dataset.water);
  const value = n === state.water ? n - 1 : n; // toucher le dernier verre plein le vide
  await store.setWater(state.day, value);
  renderToday();
});

$("#activity-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-adel]");
  if (!b) return;
  await store.deleteActivity(b.dataset.adel);
  renderToday();
});

// ---------- Activités ----------
$("#act-type").innerHTML = ACTIVITIES.map((a, i) => `<option value="${i}">${a.name}</option>`).join("");
function updateActPreview() {
  const a = ACTIVITIES[$("#act-type").value];
  const r = activityPoints({ met: a.met, minutes: Number($("#act-minutes").value) || 0, weightKg: state.latestWeight });
  $("#act-preview").textContent = `≈ ${r.kcal} kcal dépensées · +${r.points} points bonus`;
}
$("#add-activity").addEventListener("click", () => {
  updateActPreview();
  $("#act-dialog").showModal();
});
$("#act-dialog").addEventListener("input", updateActPreview);
$("#act-dialog").addEventListener("close", async () => {
  if ($("#act-dialog").returnValue !== "ok") return;
  const a = ACTIVITIES[$("#act-type").value];
  const minutes = Number($("#act-minutes").value);
  if (!minutes) return;
  const r = activityPoints({ met: a.met, minutes, weightKg: state.latestWeight });
  try {
    await store.addActivity({ done_on: state.day, name: a.name, minutes, kcal: r.kcal, points: r.points });
    toast(`${a.name} : +${r.points} points`);
    renderToday();
  } catch (err) {
    toast("Erreur : " + err.message);
  }
});

// ---------- Fenêtre d'ajout / modification ----------
let current = null; // aliment en cours (valeurs pour 100 g)
let editing = null; // entrée du journal en cours de modification

function openAdd(food, grams) {
  current = food;
  editing = null;
  $("#add-name").textContent = food.name;
  $("#add-grams").value = Math.round(grams ?? food.portion ?? 100);
  $("#add-meal").value = state.pendingMeal ?? guessMeal();
  $("#add-ok").textContent = "Ajouter";
  $("#add-delete").hidden = true;
  updateAddPoints();
  $("#add-dialog").showModal();
}

// Modifier une entrée : on retrouve les valeurs pour 100 g à partir des totaux.
function openEdit(entry) {
  if (!entry) return;
  const f = 100 / entry.grams;
  const food = {
    name: entry.name,
    portion: entry.grams,
    kcal: entry.kcal * f,
    protein: entry.protein * f,
    satFat: entry.sat_fat * f,
    sugar: entry.sugar * f,
    fiber: entry.fiber * f,
  };
  food.free = entry.is_free ?? (entry.points === 0 && computePoints(scaleNutrition(food, entry.grams)) > 0);
  openAdd(food, entry.grams);
  editing = entry;
  $("#add-meal").value = entry.meal;
  $("#add-ok").textContent = "Enregistrer";
  $("#add-delete").hidden = false;
}

function updateAddPoints() {
  const g = Number($("#add-grams").value) || 0;
  const n = scaleNutrition(current, g);
  const pts = computePoints({ ...n, free: current.free });
  $("#add-points").textContent = pts;
  const f = g / 100;
  const extra = (k, label) => (current[k] != null ? ` · ${label} ${r1(current[k] * f)} g` : "");
  $("#add-details").textContent =
    `${Math.round(n.kcal)} kcal · protéines ${r1(n.protein)} g` + extra("fat", "lipides") +
    ` · dont saturés ${r1(n.satFat)} g` + extra("carbs", "glucides") +
    ` · dont sucres ${r1(n.sugar)} g · fibres ${r1(n.fiber)} g` + extra("salt", "sel") +
    (current.free ? " · aliment libre (0 point)" : "");
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
  const action = $("#add-dialog").returnValue;
  state.pendingMeal = null;
  if (!current || (action !== "ok" && action !== "delete")) return;
  try {
    if (action === "delete") {
      await store.deleteEntry(editing.id);
      toast(`${editing.name} supprimé`);
      return renderToday();
    }
    const grams = Number($("#add-grams").value);
    if (!grams) return;
    const n = scaleNutrition(current, grams);
    const row = {
      meal: $("#add-meal").value,
      grams,
      kcal: r1(n.kcal),
      protein: r1(n.protein),
      sat_fat: r1(n.satFat),
      sugar: r1(n.sugar),
      fiber: r1(n.fiber),
      points: computePoints({ ...n, free: current.free }),
      is_free: !!current.free,
    };
    if (editing) {
      await store.updateEntry(editing.id, row);
      toast("Modifié");
      return renderToday();
    }
    await store.addEntry({ ...row, eaten_on: state.day, name: current.name });
    remember(current);
    toast(`${current.name} ajouté`);
    go("today");
  } catch (err) {
    toast("Erreur : " + err.message);
  }
});

// Aliments récents / personnalisés, mémorisés sur le téléphone
function remember(food, toFront = true) {
  const recent = prefs.get("recent", []).filter((f) => f.name !== food.name);
  if (toFront) recent.unshift(food);
  else recent.push(food);
  prefs.set("recent", recent.slice(0, 30));
}

// ---------- Recherche ----------
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const favs = () => prefs.get("favs", []);
let remoteFoods = null;
const catalog = () => remoteFoods ?? cachedCatalog() ?? FOODS;
async function refreshCatalog() {
  const foods = await loadCatalog().catch(() => null);
  if (foods?.length) {
    remoteFoods = foods;
    renderSearch();
  }
}
function foodItem(food, extra = "") {
  const pts = computePoints({ ...scaleNutrition(food, food.portion), free: food.free });
  const fav = favs().includes(food.name);
  return `<li data-food="${esc(food.name)}"><div class="grow"><div>${esc(food.name)}</div>
    <div class="sub">${food.portion} g · ${Math.round((food.kcal * food.portion) / 100)} kcal ${extra}</div></div>
    <span class="pts ${pts === 0 ? "free" : ""}">${pts}</span>
    <button class="star ${fav ? "on" : ""}" data-fav="${esc(food.name)}" aria-label="${fav ? "Retirer des" : "Ajouter aux"} favoris">${fav ? "★" : "☆"}</button></li>`;
}
function allFoods() {
  const seen = new Set();
  const out = [];
  for (const f of [...prefs.get("recent", []), ...catalog()]) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    out.push(f);
  }
  return out;
}
function renderSearch() {
  const q = norm($("#search").value.trim());
  const all = allFoods();
  let list;
  if (q) {
    list = all.filter((f) => norm(f.name).includes(q));
    list.sort((a, b) => norm(a.name).indexOf(q) - norm(b.name).indexOf(q));
  } else {
    const fav = favs();
    list = [...all.filter((f) => fav.includes(f.name)), ...prefs.get("recent", []).filter((f) => !fav.includes(f.name)).slice(0, 6)];
  }
  $("#search-results").innerHTML = list.slice(0, 25).map((f) => foodItem(f)).join("") ||
    (q ? `<p class="empty">Aucun résultat. Créez un aliment personnalisé ci-dessous.</p>` : `<p class="empty">Vos favoris ★ et aliments récents apparaîtront ici.</p>`);
}
$("#search").addEventListener("input", renderSearch);
function pickFrom(listEl, foods) {
  listEl.addEventListener("click", (e) => {
    const star = e.target.closest("[data-fav]");
    if (star) {
      const name = star.dataset.fav;
      const list = favs();
      prefs.set("favs", list.includes(name) ? list.filter((n) => n !== name) : [name, ...list]);
      const food = foods().find((f) => f.name === name);
      if (food) remember(food, false);
      renderSearch();
      return;
    }
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
  saveFood(food)
    .then((saved) => saved && (toast("Aliment enregistré dans votre base"), refreshCatalog()))
    .catch((err) => toast("Non enregistré : " + err.message));
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
    let food = await findFoodByBarcode(code).catch(() => null);
    if (!food) {
      food = { ...(await lookupBarcode(code)), barcode: code, category: "Produits scannés" };
      saveFood(food).then((saved) => saved && refreshCatalog()).catch(() => {});
    }
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
  // Retour depuis le lien « mot de passe oublié »
  supabase?.auth.onAuthStateChange(async (event) => {
    if (event !== "PASSWORD_RECOVERY") return;
    const password = prompt("Choisissez un nouveau mot de passe (6 caractères minimum) :");
    if (!password) return;
    const { error } = await supabase.auth.updateUser({ password });
    toast(error ? "Erreur : " + error.message : "Mot de passe modifié");
  });
  const wanted = new URLSearchParams(location.search).get("view"); // raccourcis de l'icône
  const enter = async (view) => {
    if (!(await applyAuthState())) return;
    refreshCatalog();
    await loadProfile();
    renderAccount();
    renderSearch();
    if (!state.profile) go("profile");
    else go(["today", "scan", "weight", "profile"].includes(view) ? view : "today");
  };
  await initStore(() => enter("today"));
  await enter(wanted);
  setupPwa();
})();

// ---------- Application installable (PWA) ----------
function setupPwa() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  // Bouton « Installer » (Android / Chrome / Edge)
  let installEvent = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e;
    $("#install-btn").hidden = false;
  });
  $("#install-btn").addEventListener("click", async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    $("#install-btn").hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    $("#install-btn").hidden = true;
    toast("Application installée sur l'écran d'accueil 🎉");
  });

  // iPhone / iPad : pas de bouton automatique, on explique la marche à suivre
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios && !standalone && !prefs.get("iosHintClosed", false)) $("#ios-hint").hidden = false;
  $("#ios-hint-close").addEventListener("click", () => {
    $("#ios-hint").hidden = true;
    prefs.set("iosHintClosed", true);
  });

  // Hors-ligne
  const net = () => {
    $("#offline-bar").hidden = navigator.onLine;
    renderAccount();
  };
  window.addEventListener("online", () => (net(), refreshCatalog()));
  window.addEventListener("offline", net);
  net();

  // Service worker + mise à jour
  if (!("serviceWorker" in navigator)) return;
  let updateRequested = false;
  navigator.serviceWorker.register("sw.js").then((reg) => {
    const offer = (worker) => {
      $("#update-bar").hidden = false;
      $("#update-btn").onclick = () => {
        updateRequested = true;
        worker.postMessage("skipWaiting");
      };
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) offer(w);
      });
    });
    // Vérifie les mises à jour quand l'application revient au premier plan
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reg.update().catch(() => {}));
  }).catch(() => {});
  // Recharger uniquement après un clic sur « Mettre à jour » (pas à la première installation)
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !updateRequested) return;
    reloading = true;
    location.reload();
  });
}
