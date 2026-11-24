export type ModelKey = "Miss";

export const MODEL_CONFIG: Record<ModelKey, {
  reading: string;
  path: string;
  expressions: string[];
  background: string;
}> = {
  "Miss": { reading: "Miss", path: "/live2d/Miss/Miss.model3.json", expressions: ["#", "M ###", "M ##", "M QAQ", "M lianhong", "M love", "M miyan", "M nu", "M wenhao", "M xingxing", "M xingxing2", "S chabei", "S shouji", "T faxing", "X shetou"], background: "witch-bg" },
};

export const PERSONALITIES = {
  shy: { label: "นิ่งขี้อาย", description: "ขี้อาย เก็บอาการเก่ง พูดน้อยแต่แอบเขิน" },
  playful: { label: "ขี้แกล้ง", description: "ขี้เล่น กวนนิด ๆ แซวเก่งแต่เขินง่าย" },
  elegant: { label: "คูล ๆ", description: "นิ่ง ๆ คูล ๆ สุภาพแต่มีเสน่ห์" },
  custom: { label: "ตัวแม่ซึน", description: "ซึนเดเระตัวแม่ ปากแข็งแต่ใส่ใจ" },
} as const;

export type PersonalityKey = keyof typeof PERSONALITIES;

export function isModelKey(value: string | null): value is ModelKey {
  return value === "Miss";
}

export function isPersonalityKey(value: string | null): value is PersonalityKey {
  return value === "shy" || value === "playful" || value === "elegant" || value === "custom";
}
