export type OutputFormat = "16:9" | "1:1" | "9:16";
export type RuntimePreset = "15s" | "30s" | "60s" | "180s";
export type VoiceOption = {
  id: string;
  label: string;
  gender: "female" | "male";
  description: string;
};

export const outputFormats: { id: OutputFormat; label: string; description: string }[] = [
  { id: "16:9", label: "Widescreen 16:9", description: "YouTube, decks, broadcast" },
  { id: "1:1", label: "Square 1:1", description: "Feed posts, carousels" },
  { id: "9:16", label: "Vertical 9:16", description: "Shorts, Reels, TikTok" },
];

export const runtimeOptions: { id: RuntimePreset; label: string; seconds: number }[] = [
  { id: "15s", label: "15 seconds", seconds: 15 },
  { id: "30s", label: "30 seconds", seconds: 30 },
  { id: "60s", label: "1 minute", seconds: 60 },
  { id: "180s", label: "3 minutes", seconds: 180 },
];

export const voiceOptions: VoiceOption[] = [
  { id: "aurora", label: "Aurora · Female", gender: "female", description: "Warm RP, confident and calm" },
  { id: "isla", label: "Isla · Female", gender: "female", description: "Crisp consulting cadence" },
  { id: "carys", label: "Carys · Female", gender: "female", description: "Energetic London edge" },
  { id: "henry", label: "Henry · Male", gender: "male", description: "Measured boardroom tone" },
  { id: "owen", label: "Owen · Male", gender: "male", description: "Upbeat narrative pacing" },
  { id: "rhett", label: "Rhett · Male", gender: "male", description: "Gravitas with warmth" },
];
