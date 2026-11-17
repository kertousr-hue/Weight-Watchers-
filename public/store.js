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
  LS.set("entries", []);
  LS.set("weights", []);
  return entries.length + weights.length;
}

export function hasLocalData() {
  return LS.get("entries", []).length > 0 || LS.get("weights", []).length > 0;
}

export const prefs = LS;
