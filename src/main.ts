import { api, events, type ScanStatus } from "./api";
import { fmtRelative } from "./format";
import { $, $$, errMsg, toast } from "./ui";
import { dealsView } from "./views/deals";
import { liveView } from "./views/live";
import { monitorView } from "./views/monitor";
import { searchView } from "./views/search";
import { settingsView } from "./views/settings";

export interface View {
  mount(root: HTMLElement): void | Promise<void>;
  unmount?(): void;
  /** Chamado quando dados globais mudam (varredura terminou, lista da live mudou). */
  refresh?(reason: string): void | Promise<void>;
}

const views: Record<string, View> = {
  deals: dealsView,
  search: searchView,
  monitor: monitorView,
  live: liveView,
  settings: settingsView,
};

let current: { name: string; view: View } | null = null;

async function show(name: string) {
  const view = views[name];
  if (!view) return;
  current?.view.unmount?.();
  const root = $("#content");
  root.innerHTML = "";
  root.scrollTop = 0;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  current = { name, view };
  try {
    await view.mount(root);
  } catch (e) {
    root.innerHTML = `<div class="alert alert-error">Erro ao abrir a tela: ${errMsg(e)}</div>`;
  }
}

export function navigate(name: string) {
  void show(name);
}

async function refreshStatus() {
  try {
    const s = await api.getStatus();
    const badge = $("#mode-badge");
    badge.textContent = s.mode === "live" ? "API REAL" : "DEMO";
    badge.className = `mode ${s.mode === "live" ? "mode-live" : "mode-mock"}`;
    badge.title =
      s.mode === "live"
        ? `Conectado com App ID ${s.appId}`
        : "Sem credenciais — usando dados de demonstração. Configure App ID e Secret em Configurações.";
    $("#version").textContent = `v${s.version} · ${s.productsTracked} produtos rastreados`;
    renderScan(s.scan);
  } catch (e) {
    console.error(e);
  }
}

function renderScan(s: ScanStatus) {
  const last = $("#scan-last");
  const next = $("#scan-next");
  const btn = $<HTMLButtonElement>("#scan-now");
  if (s.scanning) {
    last.innerHTML = `<span class="spinner"></span> Varrendo…`;
    last.classList.add("scanning");
    btn.disabled = true;
  } else {
    last.classList.remove("scanning");
    btn.disabled = false;
    last.textContent = s.lastRunAt ? `Última varredura: ${fmtRelative(s.lastRunAt)}` : "Nenhuma varredura ainda";
    last.title = s.lastError ? `Erro: ${s.lastError}` : (s.lastSummary ?? "");
  }
  next.textContent = s.nextRunAt ? `Próxima: ${fmtRelative(s.nextRunAt)}` : "Próxima: —";
}

async function refreshLiveCount() {
  try {
    const items = await api.listLive();
    const el = $("#live-count");
    el.textContent = String(items.length);
    el.classList.toggle("zero", items.length === 0);
  } catch (e) {
    console.error(e);
  }
}

async function boot() {
  $("#nav").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".nav-item");
    if (btn?.dataset.view) navigate(btn.dataset.view);
  });

  $("#scan-now").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("#scan-now");
    btn.disabled = true;
    try {
      const s = await api.runScanNow();
      if (s.errors.length && s.searchesRun === 0) toast(s.errors[0], "warn", 5000);
      else toast(`Varredura concluída: ${s.qualifyingDeals} achadinhos (${s.productsReceived} produtos)`, "success");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      btn.disabled = false;
      void refreshStatus();
    }
  });

  await events.onScanStatus((s) => renderScan(s));
  await events.onScanFinished((s) => {
    void refreshStatus();
    void refreshLiveCount();
    if (s.errors.length && s.searchesRun > 0) toast(`Varredura com ${s.errors.length} erro(s): ${s.errors[0]}`, "warn", 6000);
    void current?.view.refresh?.("scan");
  });
  await events.onLiveChanged(() => {
    void refreshLiveCount();
    void current?.view.refresh?.("live");
  });
  await events.onSettingsChanged(() => void refreshStatus());

  await refreshStatus();
  await refreshLiveCount();
  // "Próxima varredura em X" precisa andar com o relógio.
  setInterval(() => void refreshStatus(), 30_000);

  const status = await api.getStatus().catch(() => null);
  navigate(status && !status.hasCredentials && status.productsTracked === 0 ? "settings" : "deals");
}

void boot();
