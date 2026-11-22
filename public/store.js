// Stockage des données : localement sur le téléphone, ou dans Supabase si
// l'utilisateur est connecté. L'interface est la même dans les deux cas.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const LS = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("eq:" + key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("eq:" + key, JSON.stringify(value));
    } catch {
      /* stockage indisponible (navigation privée) */
    }
  },
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

// ---------- Stockage local ----------
const local = {
  mode: "local",
  async getProfile() {
    return LS.get("profile", null);
  },
  async saveProfile(p) {
    LS.set("profile", p);
  },
  async listEntries(day) {
    return LS.get("entries", []).filter((e) => e.eaten_on === day);
  },
  async listEntriesRange(from, to) {
    return LS.get("entries", []).filter((e) => e.eaten_on >= from && e.eaten_on <= to);
  },
  async addEntry(entry) {
    const all = LS.get("entries", []);
    const row = { ...entry, id: uid() };
    all.push(row);
    LS.set("entries", all);
    return row;
  },
  async deleteEntry(id) {
    LS.set("entries", LS.get("entries", []).filter((e) => e.id !== id));
  },
  async listWeights() {
    return LS.get("weights", []).sort((a, b) => a.measured_on.localeCompare(b.measured_on));
  },
  async saveWeight(measured_on, kg) {
    const all = LS.get("weights", []).filter((w) => w.measured_on !== measured_on);
    all.push({ id: uid(), measured_on, kg });
    LS.set("weights", all);
  },
  async deleteWeight(id) {
    LS.set("weights", LS.get("weights", []).filter((w) => w.id !== id));
  },
  async updateEntry(id, patch) {
    LS.set("entries", LS.get("entries", []).map((e) => (e.id === id ? { ...e, ...patch } : e)));
  },
  async getWater(day) {
    return LS.get("water", {})[day] ?? 0;
  },
  async setWater(day, n) {
    const all = LS.get("water", {});
    all[day] = n;
    LS.set("water", all);
  },
  async listActivities(day) {
    return LS.get("activities", []).filter((a) => a.done_on === day);
  },
  async listActivitiesRange(from, to) {
    return LS.get("activities", []).filter((a) => a.done_on >= from && a.done_on <= to);
  },
  async addActivity(a) {
    const all = LS.get("activities", []);
    all.push({ ...a, id: uid() });
    LS.set("activities", all);
  },
  async deleteActivity(id) {
    LS.set("activities", LS.get("activities", []).filter((a) => a.id !== id));
  },
  async exportAll() {
    return {
      profile: LS.get("profile", null),
      entries: LS.get("entries", []),
      weights: LS.get("weights", []),
      activities: LS.get("activities", []),
      water: LS.get("water", {}),
    };
  },
};

// ---------- Supabase ----------
export const supabase =
  SUPABASE_URL && SUPABASE_KEY && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

const remote = {
  mode: "cloud",
  user: null,
  async getProfile() {
    const row = check(await supabase.from("profiles").select("*").eq("id", this.user.id).maybeSingle());
    if (!row) return null;
    return {
      sex: row.sex,
      age: row.age,
      heightCm: Number(row.height_cm),
      goalWeight: row.goal_weight == null ? null : Number(row.goal_weight),
      activity: row.activity,
      goal: row.goal,
    };
  },
  async saveProfile(p) {
    check(
      await supabase.from("profiles").upsert({
        id: this.user.id,
        sex: p.sex,
        age: p.age,
        height_cm: p.heightCm,
        goal_weight: p.goalWeight,
        activity: p.activity,
        goal: p.goal,
        updated_at: new Date().toISOString(),
      })
    );
  },
  async listEntries(day) {
    return check(await supabase.from("food_entries").select("*").eq("eaten_on", day).order("created_at")).map(numify);
  },
  async listEntriesRange(from, to) {
    return check(
      await supabase.from("food_entries").select("eaten_on, points").gte("eaten_on", from).lte("eaten_on", to)
    );
  },
  async addEntry(e) {
    return numify(check(await supabase.from("food_entries").insert(e).select().single()));
  },
  async deleteEntry(id) {
    check(await supabase.from("food_entries").delete().eq("id", id));
  },
  async listWeights() {
    return check(await supabase.from("weights").select("*").order("measured_on")).map((w) => ({ ...w, kg: Number(w.kg) }));
  },
  async saveWeight(measured_on, kg) {
    check(await supabase.from("weights").upsert({ measured_on, kg }, { onConflict: "user_id,measured_on" }));
  },
  async deleteWeight(id) {
    check(await supabase.from("weights").delete().eq("id", id));
  },
  async updateEntry(id, patch) {
    check(await supabase.from("food_entries").update(patch).eq("id", id));
  },
  async getWater(day) {
    const row = check(await supabase.from("day_logs").select("water").eq("day", day).maybeSingle());
    return row?.water ?? 0;
  },
  async setWater(day, n) {
    check(await supabase.from("day_logs").upsert({ user_id: this.user.id, day, water: n }));
  },
  async listActivities(day) {
    return check(await supabase.from("activities").select("*").eq("done_on", day).order("created_at"));
  },
  async listActivitiesRange(from, to) {
    return check(await supabase.from("activities").select("done_on, points").gte("done_on", from).lte("done_on", to));
  },
  async addActivity(a) {
    check(await supabase.from("activities").insert(a));
  },
  async deleteActivity(id) {
    check(await supabase.from("activities").delete().eq("id", id));
  },
  async exportAll() {
    const [entries, weights, activities, days] = await Promise.all([
      supabase.from("food_entries").select("*").order("eaten_on").then(check),
      supabase.from("weights").select("*").order("measured_on").then(check),
      supabase.from("activities").select("*").order("done_on").then(check),
      supabase.from("day_logs").select("day, water").then(check),
    ]);
    return {
      profile: await this.getProfile(),
      entries: entries.map(numify),
      weights: weights.map((w) => ({ ...w, kg: Number(w.kg) })),
      activities,
      water: Object.fromEntries(days.map((d) => [d.day, d.water])),
    };
  },
};

function numify(e) {
  for (const k of ["grams", "kcal", "protein", "sat_fat", "sugar", "fiber"]) e[k] = Number(e[k]);
  return e;
}

// Le stockage actif : Supabase si une session est ouverte, sinon local.
export let store = local;

export async function initStore(onChange) {
  if (!supabase) return store;
  const { data } = await supabase.auth.getSession();
  apply(data.session);
  supabase.auth.onAuthStateChange((_evt, session) => {
    const before = store;
    apply(session);
    if (before !== store || (session && remote.user?.id !== session.user.id)) onChange?.();
  });
  return store;

  function apply(session) {
    if (session?.user) {
      remote.user = session.user;
      store = remote;
    } else {
      remote.user = null;
      store = local;
    }
  }
}

// Copie les données locales vers le compte (après la première connexion).
export async function uploadLocalData() {
  if (store !== remote) return 0;
  const entries = LS.get("entries", []);
  const weights = LS.get("weights", []);
  const profile = LS.get("profile", null);
  if (profile) await remote.saveProfile(profile);
  if (entries.length) {
    const rows = entries.map(({ id, ...e }) => e);
    check(await supabase.from("food_entries").insert(rows));
  }
  for (const w of weights) await remote.saveWeight(w.measured_on, w.kg);
  const activities = LS.get("activities", []);
  if (activities.length) check(await supabase.from("activities").insert(activities.map(({ id, ...a }) => a)));
  for (const [day, water] of Object.entries(LS.get("water", {}))) await remote.setWater(day, water);
  LS.set("entries", []);
  LS.set("weights", []);
  LS.set("activities", []);
  LS.set("water", {});
  return entries.length + weights.length + activities.length;
}

// Restaure une sauvegarde (fichier exporté) dans le stockage actif.
export async function importAll(data) {
  if (data.profile) await store.saveProfile(data.profile);
  let n = 0;
  for (const { id, user_id, created_at, ...e } of data.entries ?? []) {
    await store.addEntry(e);
    n++;
  }
  for (const w of data.weights ?? []) {
    await store.saveWeight(w.measured_on, w.kg);
    n++;
  }
  for (const { id, user_id, created_at, ...a } of data.activities ?? []) {
    await store.addActivity(a);
    n++;
  }
  for (const [day, water] of Object.entries(data.water ?? {})) await store.setWater(day, water);
  return n;
}

// ---------- Catalogue de nutriments (table « foods ») ----------
const toFood = (r) => ({
  id: r.id,
  name: r.name,
  category: r.category,
  portion: Number(r.portion_g),
  kcal: Number(r.kcal),
  protein: Number(r.protein),
  fat: Number(r.fat),
  satFat: Number(r.sat_fat),
  carbs: Number(r.carbs),
  sugar: Number(r.sugar),
  fiber: Number(r.fiber),
  salt: Number(r.salt),
  free: r.is_free,
  barcode: r.barcode,
  mine: !!r.owner,
});

// Catalogue commun + aliments personnels (si connecté). null si hors-ligne.
export async function loadCatalog() {
  if (!supabase) return null;
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("foods").select("*").order("name").range(from, from + 999);
    if (error) return null;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const foods = rows.map(toFood);
  prefs.set("catalog", foods); // copie pour le mode hors-ligne
  return foods;
}
export function cachedCatalog() {
  return prefs.get("catalog", null);
}

// Enregistre un aliment personnel dans la base (compte connecté uniquement).
export async function saveFood(food) {
  if (store.mode !== "cloud") return null;
  const row = {
    owner: store.user.id,
    name: food.name.slice(0, 120),
    category: food.category ?? "Mes aliments",
    barcode: food.barcode ?? null,
    portion_g: food.portion || 100,
    kcal: food.kcal || 0,
    protein: food.protein || 0,
    fat: food.fat || 0,
    sat_fat: food.satFat || 0,
    carbs: food.carbs || 0,
    sugar: food.sugar || 0,
    fiber: food.fiber || 0,
    salt: food.salt || 0,
    is_free: !!food.free,
  };
  const data = check(await supabase.from("foods").upsert(row, { onConflict: "owner,name" }).select().single());
  return toFood(data);
}

export async function findFoodByBarcode(code) {
  if (!supabase) return null;
  const { data } = await supabase.from("foods").select("*").eq("barcode", code).limit(1).maybeSingle();
  return data ? toFood(data) : null;
}

export function hasLocalData() {
  return ["entries", "weights", "activities"].some((k) => LS.get(k, []).length > 0);
}

export const prefs = LS;
