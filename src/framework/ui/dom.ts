/**
 * Minimal DOM builder. Text is always inserted as text nodes (never parsed as
 * HTML) and inline styles / inline event attributes are refused, so the UI runs
 * under a strict Content-Security-Policy without 'unsafe-inline'.
 */
export type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (name === "style" || name.toLowerCase().startsWith("on")) throw new Error(`refused attribute: ${name}`);
    if (value === null || value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? "" : String(value));
  }
  for (const [type, handler] of Object.entries(props.on ?? {})) {
    element.addEventListener(type, handler as EventListener);
  }
  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
}

export function clear(element: Element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

export function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}秒`;
  return `${Math.round(ms / 60_000)}分`;
}

/** Random identifier for idempotency keys (signalId / attemptId); matches ^[A-Za-z0-9-]{8,64}$. */
export function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = h("a", { attrs: { href: url, download: filename } });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
