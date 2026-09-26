import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
}

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`elemento não encontrado: ${sel}`);
  return el;
}

export function $$<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

// ---------- toasts ----------

export type ToastKind = "info" | "success" | "error" | "warn";

export function toast(message: string, kind: ToastKind = "info", ms = 3500) {
  const root = document.getElementById("toasts");
  if (!root) return;
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

// ---------- modal ----------

export function modal(contentHtml: string, opts: { title?: string; wide?: boolean } = {}): { el: HTMLElement; close: () => void } {
  const root = document.getElementById("modal-root")!;
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.innerHTML = html`
    <div class="modal ${opts.wide ? "modal-wide" : ""}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3>${esc(opts.title ?? "")}</h3>
        <button class="btn btn-ghost btn-sm" data-close aria-label="Fechar">✕</button>
      </div>
      <div class="modal-body">${contentHtml}</div>
    </div>`;
  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t === wrap || t.closest("[data-close]")) close();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);
  root.appendChild(wrap);
  return { el: wrap, close };
}

/** Confirmação in-app (evita diálogos nativos que roubam o foco do teclado no Windows). */
export function confirmDialog(message: string, opts: { title?: string; okLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const m = modal(
      html`<p class="confirm-msg">${esc(message)}</p>
        <div class="row-end">
          <button class="btn" data-cancel>Cancelar</button>
          <button class="btn ${opts.danger ? "btn-danger" : "btn-accent"}" data-ok>${esc(opts.okLabel ?? "Confirmar")}</button>
        </div>`,
      { title: opts.title ?? "Confirmar" },
    );
    m.el.querySelector("[data-ok]")!.addEventListener("click", () => {
      m.close();
      resolve(true);
    });
    m.el.querySelector("[data-cancel]")!.addEventListener("click", () => {
      m.close();
      resolve(false);
    });
    m.el.addEventListener("click", (e) => {
      if (e.target === m.el) resolve(false);
    });
  });
}

// ---------- clipboard / links ----------

export async function copyText(text: string, label = "Copiado!") {
  try {
    await writeText(text);
    toast(label, "success", 1800);
  } catch (e) {
    toast(`Falha ao copiar: ${errMsg(e)}`, "error");
  }
}

export async function openLink(url: string) {
  if (!url) return toast("Link indisponível", "warn");
  try {
    await openUrl(url);
  } catch (e) {
    toast(`Não foi possível abrir: ${errMsg(e)}`, "error");
  }
}

/** Debounce simples para inputs de filtro. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: number | undefined;
  return (...a: A) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

export function selectOptions(options: { value: number | string; label: string }[], selected: number | string | null | undefined): string {
  return options
    .map((o) => html`<option value="${esc(o.value)}" ${String(o.value) === String(selected ?? "") ? "selected" : ""}>${esc(o.label)}</option>`)
    .join("");
}

/** Pequeno gráfico SVG de linha para histórico de preço. */
export function sparkline(values: number[], width = 560, height = 160): string {
  if (values.length === 0) return `<div class="muted">Sem histórico ainda.</div>`;
  if (values.length === 1)
    return `<div class="muted" style="padding:18px;border:1px dashed var(--border);border-radius:8px">Apenas 1 captura até agora — o gráfico aparece a partir da 2ª varredura.</div>`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 10;
  const span = max - min || 1;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => {
    const x = pad + i * step;
    const y = pad + (height - pad * 2) * (1 - (v - min) / span);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(",");
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">
    <polyline fill="none" stroke="var(--accent)" stroke-width="2.5" points="${pts.join(" ")}" />
    <circle cx="${last[0]}" cy="${last[1]}" r="4" fill="var(--accent)" />
  </svg>`;
}
