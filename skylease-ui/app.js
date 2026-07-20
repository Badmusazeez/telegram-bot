(() => {
  const nav = document.getElementById("screenNav");
  const frames = [...document.querySelectorAll(".frame-wrap[data-screen]")];

  function setActive(id) {
    frames.forEach((frame) => {
      frame.classList.toggle("highlight", frame.dataset.screen === id);
    });
    nav?.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.target === id);
    });
  }

  function goTo(id) {
    const target = document.getElementById(id);
    if (!target) return;
    setActive(id);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  nav?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-target]");
    if (!btn) return;
    goTo(btn.dataset.target);
  });

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-go]");
    if (!trigger) return;
    goTo(trigger.dataset.go);
  });

  document.querySelectorAll(".type-opt").forEach((opt) => {
    opt.addEventListener("click", () => {
      opt.parentElement?.querySelectorAll(".type-opt").forEach((el) => {
        el.classList.remove("active");
      });
      opt.classList.add("active");
    });
  });

  document.querySelectorAll(".slot").forEach((slot) => {
    slot.addEventListener("click", () => {
      slot.parentElement?.querySelectorAll(".slot").forEach((el) => {
        el.classList.remove("active");
      });
      slot.classList.add("active");
    });
  });

  setActive("splash");
})();
