// DOM helpers. All dynamic text goes through textContent / attributes;
// no HTML string interpolation anywhere in the CareOps UI.

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "on") {
      for (const [event, handler] of Object.entries(value)) element.addEventListener(event, handler);
    } else if (key === "dataset") {
      for (const [name, data] of Object.entries(value)) element.dataset[name] = data;
    } else if (key === "value" && "value" in element) element.value = value;
    else if (key === "checked" && "checked" in element) element.checked = Boolean(value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(element) {
  while (element.firstChild) element.firstChild.remove();
  return element;
}

let liveRegion = null;
let toastTimer = null;

export function announce(message, kind = "info") {
  liveRegion ??= document.getElementById("live-region");
  if (!liveRegion) return;
  clear(liveRegion);
  liveRegion.className = `toast toast-${kind}`;
  liveRegion.append(document.createTextNode(message));
  liveRegion.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { liveRegion.hidden = true; }, kind === "error" ? 9000 : 5000);
}

export function field(labelText, control, hint) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 10)}`;
  control.id = id;
  return h("div", { class: "field" },
    h("label", { for: id }, labelText),
    hint ? h("p", { class: "hint", id: `${id}-hint` }, hint) : null,
    control,
  );
}

export function select(name, options, { value, required, includeEmpty } = {}) {
  return h("select", { name, required },
    includeEmpty ? h("option", { value: "" }, includeEmpty) : null,
    options.map(([optionValue, label]) => h("option", { value: optionValue, selected: optionValue === value }, label)),
  );
}

/**
 * Modal form dialog with an explicit confirm step.
 * Resolves with FormData values, or null when cancelled.
 */
export function formDialog({ title, description, fields, confirmLabel = "確定する", danger = false, warning }) {
  return new Promise((resolve) => {
    const form = h("form", { method: "dialog", class: "dialog-form" },
      h("h2", {}, title),
      description ? h("p", { class: "dialog-desc" }, description) : null,
      warning ? h("p", { class: "callout callout-warn", role: "note" }, warning) : null,
      ...fields,
      h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "btn btn-secondary", value: "cancel", on: { click: () => close(null) } }, "キャンセル"),
        h("button", { type: "submit", class: danger ? "btn btn-danger" : "btn btn-primary", value: "confirm" }, confirmLabel),
      ),
    );
    const dialog = h("dialog", { class: "dialog", "aria-label": title }, form);
    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (settled || !form.reportValidity()) return;
      // Prevent double submission from repeated taps.
      for (const button of form.querySelectorAll("button")) button.disabled = true;
      const values = {};
      for (const element of form.elements) {
        if (!element.name) continue;
        if (element.type === "checkbox") values[element.name] = element.checked;
        else values[element.name] = element.value;
      }
      close(values);
    });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(null); });
    document.body.append(dialog);
    dialog.showModal();
    const first = form.querySelector("input, select, textarea");
    (first ?? form.querySelector("button[type=submit]"))?.focus();
  });
}

export function confirmDialog(title, message, { confirmLabel = "はい", danger = false } = {}) {
  return formDialog({ title, description: message, fields: [], confirmLabel, danger }).then((value) => value !== null);
}

export function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function minutesSince(value, now = Date.now()) {
  if (!value) return null;
  return Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
}

export function formatMinutes(value) {
  if (value === null || value === undefined) return "—";
  if (value < 60) return `${value}分`;
  const hours = Math.floor(value / 60);
  const minutes = Math.round(value % 60);
  return minutes ? `${hours}時間${minutes}分` : `${hours}時間`;
}
