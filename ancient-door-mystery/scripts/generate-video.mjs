#!/usr/bin/env node
/**
 * Build a short Ancient Door Mystery video with TTS voiceover + captions.
 * Output: public/ancient-door-mystery.mp4
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public");
const workDir = path.join(root, ".video-work");
const imagePath = path.join(outDir, "scene-vertical.png");
const finalMp4 = path.join(outDir, "ancient-door-mystery.mp4");
const artifactMp4 = "/opt/cursor/artifacts/ancient-door-mystery.mp4";

const SCENE = [
  {
    speaker: "Narrator",
    text: "One massive ancient door slowly open.",
    voice: "en-NG-AbeoNeural",
    rate: "-5%",
  },
  {
    speaker: "Narrator",
    text: "Bright golden light shine from inside.",
    voice: "en-NG-AbeoNeural",
    rate: "-5%",
  },
  {
    speaker: "Young Explorer",
    text: "Wetin dey wait for us inside?",
    voice: "en-US-ChristopherNeural",
    rate: "+2%",
  },
  {
    speaker: "Elderly Woman",
    text: "Only person wey get courage go know.",
    voice: "en-NG-EzinneNeural",
    rate: "-8%",
  },
  {
    speaker: "Hooded Guide",
    text: "The biggest secret still dey front.",
    voice: "en-GB-RyanNeural",
    rate: "-10%",
  },
];

function ensureDirs() {
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
  }
}

function probeDuration(file) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${file}`);
  }
  return Math.max(0.8, Number(result.stdout.trim()));
}

async function synthesizeLine(line, index) {
  const out = path.join(workDir, `line-${index}.mp3`);
  // Use edge-tts CLI (installed via pip)
  const edgeBin = path.join(
    process.env.HOME || "/home/ubuntu",
    ".local/bin/edge-tts"
  );
  const args = [
    "--voice",
    line.voice,
    `--rate=${line.rate}`,
    "--text",
    line.text,
    "--write-media",
    out,
  ];
  console.log(`TTS [${line.speaker}] ${line.text}`);
  execFileSync(edgeBin, args, { stdio: "inherit" });
  return out;
}

function escapeDrawtext(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019")
    .replace(/%/g, "\\%")
}
function wrapCaption(text, max = 28) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > max) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

function buildAssSubtitles(timeline) {
  // ASS with soft shadow for readability over golden light
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,DejaVu Sans,60,&H00F5F0E6,&H000000FF,&H64000000,&H90000000,-1,0,0,0,100,100,0,0,1,4,3,2,70,70,220,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  function ts(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const whole = Math.floor(s);
    const cs = Math.floor((s - whole) * 100);
    return `${h}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  }

  const events = timeline
    .map((item) => {
      const start = ts(item.start);
      const end = ts(item.end);
      const speaker = item.speaker.replace(/,/g, "");
      const text = wrapCaption(item.text, 26).replace(/\n/g, "\\N");
      // Explicit positions: speaker above dialogue near bottom third
      return (
        `Dialogue: 0,${start},${end},Caption,,0,0,0,,{\\an2\\pos(540,1580)\\fs46\\c&H00D0F2&\\b1}${speaker}\n` +
        `Dialogue: 0,${start},${end},Caption,,0,0,0,,{\\an2\\pos(540,1720)\\fs58\\c&H00F5F0E6&\\b1}${text}`
      );
    })
    .join("\n");

  return header + events + "\n";
}

async function main() {
  ensureDirs();
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Missing scene image: ${imagePath}`);
  }

  // Fallback voices if Nigerian voices unavailable
  const voiceCheck = spawnSync(
    path.join(process.env.HOME || "/home/ubuntu", ".local/bin/edge-tts"),
    ["--list-voices"],
    { encoding: "utf8" }
  );
  const available = voiceCheck.stdout || "";
  for (const line of SCENE) {
    if (!available.includes(line.voice)) {
      if (line.speaker === "Narrator") line.voice = "en-US-GuyNeural";
      else if (line.speaker === "Young Explorer")
        line.voice = "en-US-ChristopherNeural";
      else if (line.speaker === "Elderly Woman") line.voice = "en-US-JennyNeural";
      else line.voice = "en-GB-RyanNeural";
      console.log(`Voice fallback for ${line.speaker}: ${line.voice}`);
    }
  }

  const audioFiles = [];
  for (let i = 0; i < SCENE.length; i++) {
    audioFiles.push(await synthesizeLine(SCENE[i], i));
  }

  // Build concat list with short pauses between lines
  const pausePath = path.join(workDir, "pause.mp3");
  run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=24000:cl=mono",
    "-t",
    "0.55",
    "-q:a",
    "9",
    "-acodec",
    "libmp3lame",
    pausePath,
  ]);

  const introPath = path.join(workDir, "intro.mp3");
  run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=24000:cl=mono",
    "-t",
    "1.2",
    "-q:a",
    "9",
    "-acodec",
    "libmp3lame",
    introPath,
  ]);

  const outroPath = path.join(workDir, "outro.mp3");
  run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=24000:cl=mono",
    "-t",
    "1.4",
    "-q:a",
    "9",
    "-acodec",
    "libmp3lame",
    outroPath,
  ]);

  // Normalize each line audio to consistent sample rate
  const normalized = [];
  for (let i = 0; i < audioFiles.length; i++) {
    const norm = path.join(workDir, `norm-${i}.mp3`);
    run("ffmpeg", [
      "-y",
      "-i",
      audioFiles[i],
      "-ar",
      "24000",
      "-ac",
      "1",
      "-codec:a",
      "libmp3lame",
      "-q:a",
      "4",
      norm,
    ]);
    normalized.push(norm);
  }

  const listPath = path.join(workDir, "concat.txt");
  const parts = [introPath];
  for (let i = 0; i < normalized.length; i++) {
    parts.push(normalized[i]);
    if (i < normalized.length - 1) parts.push(pausePath);
  }
  parts.push(outroPath);
  fs.writeFileSync(
    listPath,
    parts.map((p) => `file '${p}'`).join("\n") + "\n"
  );

  const voiceTrack = path.join(workDir, "voiceover.mp3");
  run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    voiceTrack,
  ]);

  // Timeline for subtitles
  let cursor = probeDuration(introPath);
  const timeline = [];
  for (let i = 0; i < normalized.length; i++) {
    const dur = probeDuration(normalized[i]);
    timeline.push({
      speaker: SCENE[i].speaker,
      text: SCENE[i].text,
      start: cursor,
      end: cursor + dur,
    });
    cursor += dur;
    if (i < normalized.length - 1) {
      cursor += probeDuration(pausePath);
    }
  }
  cursor += probeDuration(outroPath);

  const assPath = path.join(workDir, "captions.ass");
  fs.writeFileSync(assPath, buildAssSubtitles(timeline));

  const totalDuration = cursor;
  console.log(`Total duration ~ ${totalDuration.toFixed(2)}s`);

  // Ken Burns zoom on vertical image + ASS captions
  // Scale to 1080x1920 cover, slow zoom
  const filter = [
    `scale=1080:1920:force_original_aspect_ratio=increase`,
    `crop=1080:1920`,
    `zoompan=z='min(1.12,1.0+0.0015*on)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30`,
    `ass=${assPath.replace(/:/g, "\\:")}`,
    `format=yuv420p`,
  ].join(",");

  run("ffmpeg", [
    "-y",
    "-loop",
    "1",
    "-i",
    imagePath,
    "-i",
    voiceTrack,
    "-filter_complex",
    `[0:v]${filter}[v]`,
    "-map",
    "[v]",
    "-map",
    "1:a",
    "-t",
    String(totalDuration.toFixed(3)),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    finalMp4,
  ]);

  fs.copyFileSync(finalMp4, artifactMp4);
  console.log(`Wrote ${finalMp4}`);
  console.log(`Copied ${artifactMp4}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
