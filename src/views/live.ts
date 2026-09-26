import { api, type AutoLiveRules, type ExportFormat, type LiveItem } from "../api";
import { fmtBRL, fmtCommission, fmtInt, parseDecimal } from "../format";
import { $, confirmDialog, copyText, errMsg, esc, html, openLink, toast } from "../ui";
import type { View } from "../main";

let root: HTMLElement | null = null;
let items: LiveItem[] = [];
let rules: AutoLiveRules | null = null;

function readRules(): AutoLiveRules {
  return {
    enabled: $<HTMLInputElement>("#al-enabled", root!).checked,
    maxItems: Math.max(1, Math.round(parseDecimal($<HTMLInputElement>("#al-max", root!).value) || 20)),
    minScore: parseDecimal($<HTMLInputElement>("#al-score", root!).value),
    keyword: $<HTMLInputElement>("#al-kw", root!).value.trim(),
    maxPrice: parseDecimal($<HTMLInputElement>("#al-price", root!).value),
    replace: $<HTMLInputElement>("#al-replace", root!).checked,
    kind: $<HTMLSelectElement>("#al-kind", root!).value as AutoLiveRules["kind"],
  };
}

function writeRules(r: AutoLiveRules) {
  $<HTMLInputElement>("#al-enabled", root!).checked = r.enabled;
  $<HTMLInputElement>("#al-max", root!).value = String(r.maxItems);
  $<HTMLInputElement>("#al-score", root!).value = String(r.minScore);
  $<HTMLInputElement>("#al-kw", root!).value = r.keyword;
  $<HTMLInputElement>("#al-price", root!).value = r.maxPrice ? String(r.maxPrice) : "";
  $<HTMLInputElement>("#al-replace", root!).checked = r.replace;
  $<HTMLSelectElement>("#al-kind", root!).value = r.kind ?? "";
}

async function saveRules(): Promise<AutoLiveRules> {
  const settings = await api.getSettings();
  settings.autoLive = readRules();
  const saved = await api.saveSettings(settings);
  rules = saved.autoLive;
  return rules;
}

async function load() {
  if (!root) return;
  try {
    const [list, settings] = await Promise.all([api.listLive(), api.getSettings()]);
    items = list;
    rules = settings.autoLive;
    writeRules(rules);
    render();
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

function render() {
  if (!root) return;
  $("#lv-count", root).textContent = `${items.length} produto(s)`;
  const box = $("#lv-list", root);
  const empty = items.length === 0;
  root.querySelectorAll<HTMLButtonElement>("[data-needs-items]").forEach((b) => (b.disabled = empty));
  if (empty) {
    box.innerHTML = `<div class="empty">
      <p><b>Lista vazia.</b></p>
      <p class="muted">Adicione produtos pelos botões <b>+ Live</b> em Achadinhos/Buscar, ou use <b>Preencher automaticamente</b> acima.</p>
    </div>`;
    return;
  }
  box.innerHTML = items
    .map(
      (it, i) => html`<div class="live-item" data-id="${it.itemId}">
        <div class="pos">${i + 1}</div>
        <div class="thumb">${it.imageUrl ? html`<img src="${esc(it.imageUrl)}" alt="" loading="lazy" />` : `<div style="width:44px;height:44px;border-radius:6px;background:var(--bg-3)"></div>`}</div>
        <div class="info">
          <div class="t" title="${esc(it.productName)}">${esc(it.productName || "(produto sem dados — rode uma varredura)")}</div>
          <div class="muted small">
            <b style="color:var(--text)">${fmtBRL(it.priceMin)}</b>
            ${it.discountRate > 0 ? ` · -${Math.round(it.discountRate)}%` : ""} · ${fmtInt(it.sales)} vendas · comissão ${fmtCommission(it.commissionRate)}
            <span class="src ${it.source === "auto" ? "auto" : it.source === "chat" ? "chat" : ""}">${it.source === "auto" ? "automático" : it.source === "chat" ? "💬 pedido no chat" : "manual"}</span>
          </div>
        </div>
        <div class="idbox" data-copy-id title="Clique para copiar o ID">${it.itemId}</div>
        <div class="ops">
          <button class="btn btn-xs" data-act="up" title="Subir" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="btn btn-xs" data-act="down" title="Descer" ${i === items.length - 1 ? "disabled" : ""}>↓</button>
          <button class="btn btn-xs" data-act="link" title="Copiar link de afiliado">Link</button>
          <button class="btn btn-xs" data-act="open" title="Abrir na Shopee">Abrir</button>
          <button class="btn btn-xs btn-danger" data-act="del" title="Remover">✕</button>
        </div>
      </div>`,
    )
    .join("");
}

async function exportCopy(format: ExportFormat, label: string) {
  try {
    const text = await api.exportLive(format);
    if (!text) return toast("Lista vazia", "warn");
    await copyText(text, label);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export const liveView: View = {
  async mount(r) {
    root = r;
    r.innerHTML = html`
      <div class="view-head">
        <div>
          <h1>🎥 Lista da Live <span class="muted" id="lv-count" style="font-size:14px;font-weight:400"></span></h1>
          <p>IDs dos produtos prontos para colar na sacolinha da Shopee Live. Clique no ID para copiar um, ou use os botões para copiar todos.</p>
        </div>
        <div class="row">
          <button class="btn btn-accent" id="lv-copy-ids" data-needs-items title="Um ID por linha">📋 Copiar IDs</button>
          <button class="btn" id="lv-copy-comma" data-needs-items title="IDs separados por vírgula">IDs com vírgula</button>
          <button class="btn" id="lv-copy-links" data-needs-items title="Links de afiliado, um por linha">Copiar links afiliado</button>
          <button class="btn" id="lv-csv" data-needs-items title="Salva um .csv na pasta Downloads">⬇ CSV</button>
          <button class="btn btn-danger" id="lv-clear" data-needs-items>Limpar lista</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="row" style="justify-content:space-between; align-items:flex-start">
          <div>
            <h3>⚡ Preenchimento automático</h3>
            <p class="hint">Seleciona os melhores achadinhos (por score) e adiciona à lista. Pode rodar agora ou automaticamente ao fim de cada varredura.</p>
          </div>
          <label class="check" title="Ao terminar cada varredura, completa a lista com os melhores achadinhos até o máximo"><input type="checkbox" id="al-enabled" /> Preencher a cada varredura</label>
        </div>
        <div class="row" style="margin-top:8px">
          <label class="field">Tipo
            <select id="al-kind">
              <option value="">Todos os achadinhos</option>
              <option value="anomaly">⚡ Só preço fora da curva</option>
              <option value="discount">Só desconto / queda</option>
            </select>
          </label>
          <label class="field">Máx. de itens na lista<input type="text" inputmode="numeric" id="al-max" style="width:90px" /></label>
          <label class="field">Score mínimo<input type="text" inputmode="numeric" id="al-score" style="width:90px" /></label>
          <label class="field">Preço máximo (R$)<input type="text" inputmode="decimal" id="al-price" placeholder="sem limite" style="width:110px" /></label>
          <label class="field grow">Palavra-chave (opcional)<input type="text" id="al-kw" placeholder="ex.: cozinha, beleza…" /></label>
          <label class="check" title="Esvazia a lista antes de preencher"><input type="checkbox" id="al-replace" /> Substituir lista</label>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn btn-accent" id="al-run">⚡ Preencher agora</button>
          <button class="btn" id="al-save">Salvar regras</button>
          <span class="hint" id="al-msg"></span>
        </div>
      </div>

      <div class="live-list" id="lv-list"></div>`;

    $("#lv-copy-ids", r).addEventListener("click", () => void exportCopy("ids", `${items.length} ID(s) copiado(s) — um por linha`));
    $("#lv-copy-comma", r).addEventListener("click", () => void exportCopy("ids_comma", `${items.length} ID(s) copiado(s) com vírgula`));
    $("#lv-copy-links", r).addEventListener("click", () => void exportCopy("offer_links", "Links de afiliado copiados"));
    $("#lv-csv", r).addEventListener("click", async () => {
      try {
        const path = await api.exportLiveFile("csv");
        toast(`CSV salvo em: ${path}`, "success", 7000);
      } catch (e) {
        toast(errMsg(e), "error");
      }
    });
    $("#lv-clear", r).addEventListener("click", async () => {
      if (!(await confirmDialog(`Limpar todos os ${items.length} produtos da lista da live?`, { danger: true, okLabel: "Limpar" }))) return;
      try {
        await api.clearLive();
      } catch (e) {
        toast(errMsg(e), "error");
      }
    });

    $("#al-save", r).addEventListener("click", async () => {
      try {
        await saveRules();
        toast("Regras salvas", "success", 1500);
      } catch (e) {
        toast(errMsg(e), "error");
      }
    });
    $("#al-run", r).addEventListener("click", async () => {
      const btn = $<HTMLButtonElement>("#al-run", r);
      btn.disabled = true;
      try {
        const rl = await saveRules();
        if (rl.replace && items.length > 0) {
          const ok = await confirmDialog(`"Substituir lista" está marcado: os ${items.length} produtos atuais serão removidos antes de preencher. Continuar?`, { okLabel: "Substituir", danger: true });
          if (!ok) return;
        }
        const n = await api.autoFillLive(rl, rl.replace);
        $("#al-msg", r).textContent = n > 0 ? `${n} produto(s) adicionado(s).` : "Nada adicionado: nenhum achadinho novo atende às regras ou a lista já atingiu o máximo.";
        toast(n > 0 ? `${n} produto(s) adicionado(s) à live` : "Nenhum produto novo atendeu às regras", n > 0 ? "success" : "warn");
      } catch (e) {
        toast(errMsg(e), "error");
      } finally {
        btn.disabled = false;
      }
    });

    const list = $("#lv-list", r);
    list.addEventListener("error", (e) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "IMG") t.remove();
    }, true);
    list.addEventListener("click", async (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>(".live-item");
      if (!row) return;
      const id = Number(row.dataset.id);
      const it = items.find((x) => x.itemId === id);
      if (!it) return;
      if (t.closest("[data-copy-id]")) return void copyText(String(id), `ID ${id} copiado`);
      const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
      try {
        if (act === "up") await api.moveLiveItem(id, -1);
        else if (act === "down") await api.moveLiveItem(id, 1);
        else if (act === "del") await api.removeFromLive(id);
        else if (act === "link") await copyText(it.offerLink || it.productLink, "Link de afiliado copiado!");
        else if (act === "open") await openLink(it.productLink || it.offerLink);
      } catch (err) {
        toast(errMsg(err), "error");
      }
    });

    await load();
  },
  unmount() {
    root = null;
  },
  refresh() {
    if (root) void load();
  },
};
