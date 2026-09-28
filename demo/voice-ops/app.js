const screens = [...document.querySelectorAll(".screen")];
const steps = [...document.querySelectorAll(".step")];
const counter = document.getElementById("counter");
let current = 0;

function show(index) {
  current = Math.max(0, Math.min(index, screens.length - 1));
  screens.forEach((screen, i) => {
    screen.classList.toggle("active", i === current);
  });
  steps.forEach((step, i) => {
    step.classList.toggle("active", i === current);
  });
  counter.textContent = `0${current + 1} / 05`;
}

steps.forEach((step, index) => {
  step.addEventListener("click", () => show(index));
});

document.querySelectorAll(".next").forEach((button) => {
  button.addEventListener("click", () => show(current + 1));
});

document.getElementById("approve").addEventListener("click", () => {
  document.getElementById("result").hidden = false;
});

document.getElementById("reset").addEventListener("click", () => {
  document.getElementById("result").hidden = true;
  show(0);
});

show(0);
