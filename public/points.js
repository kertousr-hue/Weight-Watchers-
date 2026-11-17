// Système de points « Équilibre » (formule propre à cette application).
//
// Les points récompensent ce qui rassasie (protéines, fibres) et pénalisent
// ce qui est dense en énergie, en graisses saturées et en sucres ajoutés.
//
//   points = kcal/30 + graisses saturées/3 + sucres/8 − protéines/9 − fibres/10
//
// Arrondi à l'entier le plus proche, jamais négatif.
// Les fruits et légumes frais nature sont des « aliments libres » : 0 point.

export function computePoints({ kcal = 0, satFat = 0, sugar = 0, protein = 0, fiber = 0, free = false } = {}) {
  if (free) return 0;
  const raw = kcal / 30 + satFat / 3 + sugar / 8 - protein / 9 - fiber / 10;
  return Math.max(0, Math.round(raw));
}

// Valeurs nutritionnelles pour une portion donnée, à partir des valeurs pour 100 g.
export function scaleNutrition(per100, grams) {
  const f = grams / 100;
  return {
    kcal: per100.kcal * f,
    protein: per100.protein * f,
    satFat: per100.satFat * f,
    sugar: per100.sugar * f,
    fiber: per100.fiber * f,
  };
}

// Métabolisme de base (Mifflin-St Jeor) puis dépense totale selon l'activité.
const ACTIVITY = { sedentaire: 1.2, leger: 1.375, modere: 1.55, actif: 1.725 };

export function dailyBudget({ sex, age, heightCm, weightKg, activity = "leger", goal = "perdre" }) {
  if (!age || !heightCm || !weightKg) return 45;
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === "homme" ? 5 : -161);
  const tdee = bmr * (ACTIVITY[activity] ?? 1.375);
  const deficit = goal === "perdre" ? 500 : 0;
  const floor = sex === "homme" ? 1500 : 1200;
  const targetKcal = Math.max(floor, tdee - deficit);
  return Math.round(targetKcal / 30);
}

export function bmi(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  const m = heightCm / 100;
  return weightKg / (m * m);
}
