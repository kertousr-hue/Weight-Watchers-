import { test } from "node:test";
import assert from "node:assert/strict";
import { computePoints, scaleNutrition, dailyBudget } from "../public/points.js";
import { FOODS, LABEL_MAP, findFood } from "../public/foods.js";

test("les aliments libres valent 0 point", () => {
  assert.equal(computePoints({ kcal: 300, sugar: 50, free: true }), 0);
});

test("les points ne sont jamais négatifs", () => {
  assert.equal(computePoints({ kcal: 50, protein: 40, fiber: 10 }), 0);
});

test("un croissant coûte plus qu'un blanc de poulet de même énergie", () => {
  const croissant = computePoints(scaleNutrition(findFood("Croissant"), 60));
  const poulet = computePoints(scaleNutrition(findFood("Blanc de poulet"), 200));
  assert.ok(croissant > poulet, `${croissant} vs ${poulet}`);
});

test("budget quotidien plausible", () => {
  const b = dailyBudget({ sex: "femme", age: 35, heightCm: 165, weightKg: 75, activity: "leger", goal: "perdre" });
  assert.ok(b >= 40 && b <= 70, String(b));
  const maintien = dailyBudget({ sex: "femme", age: 35, heightCm: 165, weightKg: 75, activity: "leger", goal: "maintenir" });
  assert.ok(maintien > b);
});

test("chaque catégorie reconnue pointe vers un aliment existant", () => {
  for (const [, name] of LABEL_MAP) assert.ok(findFood(name), name);
  assert.equal(new Set(FOODS.map((f) => f.name)).size, FOODS.length, "noms en double");
});

import { activityPoints } from "../public/points.js";
test("30 min de marche rapide à 80 kg rapportent quelques points", () => {
  const r = activityPoints({ met: 4.8, minutes: 30, weightKg: 80 });
  assert.equal(r.kcal, 192);
  assert.equal(r.points, 3);
});
