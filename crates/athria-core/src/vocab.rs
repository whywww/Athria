//! Static taxonomy vocabularies and profile defaults, ported from
//! `packages/schemas/src/index.ts` and exposed to every runtime crate.
//!
//! The TypeScript taxonomy is a hardcoded, versioned vocabulary (see
//! `TAXONOMY_VERSION`), so the Rust runtime keeps the same literals instead of
//! reading them from the database.

use serde_json::{Value, json};

use crate::DEFAULT_OWNER_ID;

/// `athleteProfileSchema` default `timezone`.
pub const DEFAULT_TIMEZONE: &str = "Asia/Hong_Kong";

pub const DOMAIN_IDS: [&str; 5] = [
    "strength",
    "endurance",
    "sport_skill",
    "mind_body",
    "recovery",
];

pub const MOVEMENT_PATTERN_IDS: [&str; 33] = [
    "squat",
    "hinge",
    "lunge",
    "step",
    "bridge_hip_thrust",
    "horizontal_push",
    "vertical_push",
    "horizontal_pull",
    "vertical_pull",
    "shoulder_abduction",
    "shoulder_external_rotation",
    "elbow_flexion",
    "elbow_extension",
    "knee_extension",
    "knee_flexion",
    "hip_abduction",
    "hip_adduction",
    "calf_raise",
    "dorsiflexion",
    "carry",
    "rotation",
    "anti_rotation",
    "trunk_flexion",
    "trunk_extension",
    "lateral_flexion",
    "anti_extension",
    "anti_lateral_flexion",
    "jump",
    "throw",
    "locomotion",
    "olympic_lift",
    "isolation",
    "other",
];

/// The `factSources` list `getTrainingTaxonomy` returns; `factSourceSchema`
/// also accepts the internal `catalog` and `migration` sources.
pub const FACT_SOURCES: [&str; 4] = [
    "structured_source",
    "exact_alias",
    "ai_inferred",
    "user_confirmed",
];

pub const MUSCLE_GROUP_IDS: [&str; 47] = [
    "chest",
    "upper_back",
    "back",
    "lats",
    "shoulders",
    "arms",
    "biceps",
    "triceps",
    "forearms",
    "quadriceps",
    "hamstrings",
    "thighs",
    "hips",
    "glutes",
    "calves",
    "lower_legs",
    "core",
    "spinal_erectors",
    "hip_flexors",
    "adductors",
    "abductors",
    "full_body",
    "other",
    "pectoralis_major_clavicular",
    "pectoralis_major_sternal",
    "latissimus_dorsi",
    "trapezius_upper",
    "trapezius_middle_lower",
    "rhomboids",
    "anterior_deltoid",
    "lateral_deltoid",
    "posterior_deltoid",
    "rotator_cuff",
    "biceps_brachii",
    "brachialis",
    "triceps_brachii",
    "forearm_flexors",
    "forearm_extensors",
    "gluteus_maximus",
    "gluteus_medius",
    "gluteus_minimus",
    "gastrocnemius",
    "soleus",
    "tibialis_anterior",
    "rectus_abdominis",
    "obliques",
    "transverse_abdominis",
];

/// `muscleParents` from `packages/schemas/src/index.ts`.
fn muscle_parent(id: &str) -> Option<&'static str> {
    Some(match id {
        "pectoralis_major_clavicular" | "pectoralis_major_sternal" => "chest",
        "latissimus_dorsi"
        | "trapezius_upper"
        | "trapezius_middle_lower"
        | "rhomboids"
        | "spinal_erectors" => "back",
        "anterior_deltoid" | "lateral_deltoid" | "posterior_deltoid" | "rotator_cuff" => {
            "shoulders"
        }
        "biceps_brachii" | "brachialis" | "triceps_brachii" | "forearm_flexors"
        | "forearm_extensors" => "arms",
        "gluteus_maximus" | "gluteus_medius" | "gluteus_minimus" => "glutes",
        "quadriceps" | "hamstrings" | "adductors" => "thighs",
        "hip_flexors" => "hips",
        "gastrocnemius" | "soleus" | "tibialis_anterior" => "lower_legs",
        "rectus_abdominis" | "obliques" | "transverse_abdominis" => "core",
        _ => return None,
    })
}

/// `title()` from `packages/schemas/src/index.ts`: `snake_case` to Title Case,
/// upper-casing only the first character of each segment.
fn title(id: &str) -> String {
    id.split('_')
        .map(|part| {
            let mut characters = part.chars();
            match characters.next() {
                Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn muscle_taxonomy() -> Value {
    Value::Array(MUSCLE_GROUP_IDS.iter().map(|id| json!({ "id": id, "label": title(id), "parentId": muscle_parent(id), "selectable": true })).collect())
}

pub fn movement_pattern_taxonomy() -> Value {
    Value::Array(MOVEMENT_PATTERN_IDS.iter().map(|id| json!({ "id": id, "label": title(id), "parentId": Value::Null, "selectable": true })).collect())
}

pub struct EquipmentGroup {
    pub id: &'static str,
    pub label: &'static str,
    pub items: &'static [(&'static str, &'static str)],
}

pub struct EquipmentCategory {
    pub id: &'static str,
    pub label: &'static str,
    pub groups: &'static [EquipmentGroup],
}

pub const EQUIPMENT_CATEGORIES: &[EquipmentCategory] = &[
    EquipmentCategory {
        id: "strength_resistance",
        label: "Strength & Resistance",
        groups: &[
            EquipmentGroup {
                id: "free_weights",
                label: "Free Weights",
                items: &[
                    ("dumbbell", "Dumbbells"),
                    ("barbell", "Barbell"),
                    ("kettlebell", "Kettlebell"),
                ],
            },
            EquipmentGroup {
                id: "machines_cable",
                label: "Machines & Cable",
                items: &[
                    ("cable", "Cable Machine"),
                    ("smith_machine", "Smith Machine"),
                    ("machine", "Fixed Machines"),
                    ("landmine", "Landmine"),
                ],
            },
            EquipmentGroup {
                id: "bodyweight_gymnastics",
                label: "Bodyweight & Gymnastics",
                items: &[
                    ("pull_up_bar", "Pull-Up Bar"),
                    ("trx", "TRX"),
                    ("bench", "Bench"),
                    ("plyo_box", "Plyo Box"),
                ],
            },
            EquipmentGroup {
                id: "functional_gear",
                label: "Functional Gear",
                items: &[
                    ("resistance_band", "Resistance Bands"),
                    ("medicine_ball", "Medicine Ball"),
                    ("sandbag", "Sandbag"),
                    ("sled", "Sled / Prowler"),
                ],
            },
        ],
    },
    EquipmentCategory {
        id: "cardio_endurance",
        label: "Cardio & Endurance",
        groups: &[EquipmentGroup {
            id: "indoor_cardio",
            label: "Indoor Cardio Machines",
            items: &[
                ("treadmill", "Treadmill"),
                ("exercise_bike", "Exercise Bike"),
                ("rowing_machine", "Rowing Machine"),
                ("elliptical", "Elliptical"),
                ("stepper", "Stepper"),
                ("ski_erg", "SkiErg"),
                ("jump_rope", "Jump Rope"),
                ("battle_rope", "Battle Rope"),
            ],
        }],
    },
    EquipmentCategory {
        id: "mobility_recovery",
        label: "Mobility, Pilates & Recovery",
        groups: &[
            EquipmentGroup {
                id: "mobility_tools",
                label: "Mobility Tools",
                items: &[
                    ("yoga_mat", "Yoga Mat"),
                    ("foam_roller", "Foam Roller"),
                    ("massage_ball", "Massage Ball"),
                ],
            },
            EquipmentGroup {
                id: "pilates_core",
                label: "Pilates & Core",
                items: &[
                    ("reformer", "Reformer"),
                    ("pilates_ring", "Pilates Ring"),
                    ("mini_stability_ball", "Mini Stability Ball"),
                ],
            },
        ],
    },
    EquipmentCategory {
        id: "ball_sport",
        label: "Ball & Sport-Specific Tools",
        groups: &[EquipmentGroup {
            id: "ball_sport_tools",
            label: "Ball & Sport-Specific Tools",
            items: &[("ball_machine", "Ball Machine")],
        }],
    },
];

/// `equipmentTypeIds`: every item id in category order.
pub fn equipment_type_ids() -> Vec<&'static str> {
    EQUIPMENT_CATEGORIES
        .iter()
        .flat_map(|category| category.groups.iter())
        .flat_map(|group| group.items.iter())
        .map(|(id, _)| *id)
        .collect()
}

pub fn equipment_categories() -> Value {
    Value::Array(
        EQUIPMENT_CATEGORIES
            .iter()
            .map(|category| {
                json!({
                    "id": category.id,
                    "label": category.label,
                    "groups": category.groups.iter().map(|group| json!({
                        "id": group.id,
                        "label": group.label,
                        "items": group.items.iter().map(|(id, label)| json!({ "id": id, "label": label })).collect::<Vec<_>>(),
                    })).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

/// `defaultProfile()`: `athleteProfileSchema.parse({})`.
pub fn default_profile() -> Value {
    json!({
        "ownerId": DEFAULT_OWNER_ID,
        "preferredName": "Athlete",
        "gender": null,
        "heightCm": null,
        "birthDate": null,
        "timezone": DEFAULT_TIMEZONE,
        "goals": ["general_fitness"],
        "preference": "",
        "maxSessionMinutes": 60,
        "trainingRhythm": { "kind": "flexible_week", "targetDaysPerWeek": 4, "minDaysPerWeek": 3, "maxDaysPerWeek": 5 },
        "equipment": equipment_type_ids(),
        "injuries": [],
        "constraintNotes": [],
        "explicitRecoveryDays": null,
        "unitSystem": "metric",
        "mesocycleDurationWeeks": 8,
        "raceDays": [],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taxonomy_labels_match_the_typescript_title_case() {
        assert_eq!(title("bridge_hip_thrust"), "Bridge Hip Thrust");
        assert_eq!(title("upper_back"), "Upper Back");
        assert_eq!(title("vo2"), "Vo2");
    }

    #[test]
    fn default_profile_uses_the_schema_defaults() {
        let profile = default_profile();
        assert_eq!(profile["preferredName"], json!("Athlete"));
        assert_eq!(profile["timezone"], json!("Asia/Hong_Kong"));
        assert_eq!(
            profile["equipment"].as_array().unwrap().len(),
            equipment_type_ids().len()
        );
        assert_eq!(profile["equipment"][0], json!("dumbbell"));
        assert_eq!(profile["trainingRhythm"]["kind"], json!("flexible_week"));
        assert_eq!(profile["mesocycleDurationWeeks"], json!(8));
    }

    #[test]
    fn muscle_taxonomy_exposes_parents_for_specific_muscles() {
        let taxonomy = muscle_taxonomy();
        let entries = taxonomy.as_array().unwrap();
        assert_eq!(entries.len(), MUSCLE_GROUP_IDS.len());
        let latissimus = entries
            .iter()
            .find(|entry| entry["id"] == json!("latissimus_dorsi"))
            .unwrap();
        assert_eq!(latissimus["parentId"], json!("back"));
        assert_eq!(latissimus["label"], json!("Latissimus Dorsi"));
        let glutes = entries
            .iter()
            .find(|entry| entry["id"] == json!("glutes"))
            .unwrap();
        assert_eq!(glutes["parentId"], json!(null));
    }
}
