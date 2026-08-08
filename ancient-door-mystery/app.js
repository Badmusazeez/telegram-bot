const intro = document.querySelector('[data-panel="intro"]');
const videoPanel = document.querySelector("#videoPanel");
const sceneVideo = document.querySelector("#sceneVideo");
const watchBtn = document.querySelector("#watchBtn");
const backBtn = document.querySelector("#backBtn");
const hero = document.querySelector("#hero");

function showVideo() {
  intro.hidden = true;
  videoPanel.hidden = false;
  hero.classList.add("is-story");
  sceneVideo?.focus();
  sceneVideo?.play().catch(() => {
    /* Autoplay may be blocked until user hits play — controls remain. */
  });
}

function showIntro() {
  sceneVideo?.pause();
  videoPanel.hidden = true;
  intro.hidden = false;
  hero.classList.remove("is-story");
}

watchBtn?.addEventListener("click", showVideo);
backBtn?.addEventListener("click", showIntro);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !videoPanel.hidden) {
    showIntro();
  }
});
