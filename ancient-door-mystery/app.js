const script = [
  {
    speaker: "Narrator",
    line: "One massive ancient door slowly open.",
  },
  {
    speaker: "Narrator",
    line: "Bright golden light shine from inside.",
  },
  {
    speaker: "Young Explorer",
    line: "Wetin dey wait for us inside?",
  },
  {
    speaker: "Elderly Woman",
    line: "Only person wey get courage go know.",
  },
  {
    speaker: "Hooded Guide",
    line: "The biggest secret still dey front.",
  },
];

const hero = document.querySelector("#hero");
const intro = document.querySelector('[data-panel="intro"]');
const dialogue = document.querySelector("#dialogue");
const speakerEl = document.querySelector("#speaker");
const lineEl = document.querySelector("#line");
const beginBtn = document.querySelector("#beginBtn");
const nextBtn = document.querySelector("#nextBtn");
const replayBtn = document.querySelector("#replayBtn");

let index = 0;
let playing = false;

function showLine(entry) {
  speakerEl.textContent = entry.speaker;
  lineEl.textContent = entry.line;
  lineEl.classList.remove("is-entering");
  // Restart entrance animation
  void lineEl.offsetWidth;
  lineEl.classList.add("is-entering");
}

function enterStory() {
  if (playing) return;
  playing = true;
  index = 0;

  intro.classList.add("is-exiting");
  hero.classList.add("is-story");

  window.setTimeout(() => {
    intro.hidden = true;
    dialogue.hidden = false;
    dialogue.classList.add("is-visible");
    replayBtn.hidden = true;
    nextBtn.hidden = false;
    nextBtn.textContent = "Continue";
    showLine(script[index]);
  }, 450);
}

function advance() {
  if (!playing) return;

  if (index < script.length - 1) {
    index += 1;
    showLine(script[index]);

    if (index === script.length - 1) {
      nextBtn.hidden = true;
      replayBtn.hidden = false;
    }
    return;
  }

  nextBtn.hidden = true;
  replayBtn.hidden = false;
}

function replay() {
  index = 0;
  replayBtn.hidden = true;
  nextBtn.hidden = false;
  nextBtn.textContent = "Continue";
  showLine(script[index]);
}

beginBtn?.addEventListener("click", enterStory);
nextBtn?.addEventListener("click", advance);
replayBtn?.addEventListener("click", replay);

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    if (!playing && document.activeElement === document.body) {
      event.preventDefault();
      enterStory();
      return;
    }
    if (playing && !replayBtn.hidden) {
      event.preventDefault();
      replay();
      return;
    }
    if (playing && !nextBtn.hidden) {
      event.preventDefault();
      advance();
    }
  }
});
