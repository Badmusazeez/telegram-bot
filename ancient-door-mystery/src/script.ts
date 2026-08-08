export type Line = {
  speaker: "Narrator" | "Young Explorer" | "Elderly Woman" | "Hooded Guide";
  text: string;
};

/** Exact scene dialogue for Ancient Door Mystery. */
export const SCENE: Line[] = [
  {
    speaker: "Narrator",
    text: "One massive ancient door slowly open.",
  },
  {
    speaker: "Narrator",
    text: "Bright golden light shine from inside.",
  },
  {
    speaker: "Young Explorer",
    text: "Wetin dey wait for us inside?",
  },
  {
    speaker: "Elderly Woman",
    text: "Only person wey get courage go know.",
  },
  {
    speaker: "Hooded Guide",
    text: "The biggest secret still dey front.",
  },
];

export function formatLine(line: Line, index: number, total: number): string {
  return (
    `<b>${escapeHtml(line.speaker)}</b>\n` +
    `<i>“${escapeHtml(line.text)}”</i>\n\n` +
    `<code>${index + 1}/${total}</code>`
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
