import { api, type Deal, type DealFilter } from "../api";
import { fmtBRL, fmtCommission, fmtDateTime, fmtInt, fmtPct, parseDecimal } from "../format";
import { $, $$, confirmDialog, copyText, debounce, errMsg, esc, html, modal, openLink, sparkline, toast } from "../ui";
import type { View } from "../main";

const FILTER_KEY = "achadinhos.dealsFilter";

const defaultFilter: DealFilter = {
  keyword: "",
  onlyQualifying: true,
  minScore: 0,
  maxPrice: 0,
  minSales: 0,
  excludeInLive: false,
  sort: "score",
  limit: 300,
  seenWithinHours: 0,
  kind: "",
};

function loadFilter(): DealFilter {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    return raw ? { ...defaultFilter, ...JSON.parse(raw) } : { ...defaultFilter };
  } catch {
    return { ...defaultFilter };
  }
}

let filter = loadFilter();
let deals: Deal[] = [];
let totalTracked = 0;
const selected = new Set<number>();
let root: HTMLElement | null = null;
let loading = false;

function saveFilter() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filter));
  } catch {
    /* ignore */
  }
}

function originalPrice(d: Deal): { value: number; label: string } | null {
  if (d.discountRate > 0 && d.discountRate < 100) {
    return { value: d.priceMin / (1 - d.discountRate / 100), label: "de" };
  }
  if (d.history.avgPrice && d.history.avgPrice > d.priceMin * 1.02) {
    return { value: d.history.avgPrice, label: "média" };
  }
  return null;
}

function card(d: Deal): string {
  const orig = originalPrice(d);
  const drop = d.eval.dropVsAvgPct;
  const anomaly = d.eval.isPriceAnomaly;
  const ratio = d.eval.peerRatio;
  return html`
    <article class="deal ${d.inLive ? "in-live" : ""} ${anomaly ? "anomaly" : ""}" data-id="${d.itemId}">
      <div class="img">
        <label class="select"><input type="checkbox" data-sel ${selected.has(d.itemId) ? "checked" : ""} /></label>
        ${d.imageUrl ? html`<img src="${esc(d.imageUrl)}" alt="" loading="lazy" />` : ""}
        ${anomaly && ratio != null
          ? html`<span class="disc disc-anomaly" title="preço ÷ mediana dos pares = ${ratio.toFixed(2)}">⚡ -${Math.round((1 - ratio) * 100)}% vs normal</span>`
          : d.discountRate > 0
            ? html`<span class="disc">-${Math.round(d.discountRate)}%</span>`
            : ""}
        <div class="tags">
          ${anomaly ? `<span class="tag tag-anomaly">preço fora da curva</span>` : ""}
          ${anomaly && d.eval.newSellerHint ? `<span class="tag tag-new">vendedor novo?</span>` : ""}
          ${d.eval.isLowestEver ? `<span class="tag tag-low">menor preço</span>` : ""}
          ${drop != null && drop >= 10 ? `<span class="tag tag-drop">-${Math.round(drop)}% vs média</span>` : ""}
        </div>
      </div>
      <div class="body">
        <div class="title" title="${esc(d.productName)}">${esc(d.productName)}</div>
        <div class="shop">${esc(d.shopName || "—")}${d.rating ? ` · ⭐ ${d.rating.toFixed(1)}` : " · sem avaliações"}</div>
        <div class="price">
          <span class="now">${fmtBRL(d.priceMin)}</span>
          ${anomaly && d.eval.peerMedian
            ? html`<span class="old" title="mediana de “${esc(d.eval.peerKeyword ?? "")}” (${d.eval.peerCount} itens)">normal ${fmtBRL(d.eval.peerMedian)}</span>`
            : orig
              ? html`<span class="old" title="${orig.label}">${fmtBRL(orig.value)}</span>`
              : ""}
        </div>
        <div class="meta"><span>${fmtInt(d.sales)} vendas</span><span>comissão ${fmtCommission(d.commissionRate)}</span></div>
        <div class="meta">
          <span title="${d.eval.peerMedian ? `mediana de “${esc(d.eval.peerKeyword ?? "")}”: ${fmtBRL(d.eval.peerMedian)} (${d.eval.peerCount} itens)` : `amostras de histórico: ${d.history.samples}`}">
            ${d.eval.peerMedian && !anomaly
              ? `${Math.round((ratio ?? 1) * 100)}% do normal`
              : d.history.avgPrice
                ? `média ${fmtBRL(d.history.avgPrice)}`
                : "sem histórico"}
          </span>
          <span>score ${d.eval.score.toFixed(0)}</span>
        </div>
        <div class="score" title="${esc(d.eval.reasons.join(" · ") || "não qualifica")}"><i style="width:${Math.min(100, d.eval.score)}%"></i></div>
        <div class="id">ID <b data-copy-id title="Copiar ID">${d.itemId}</b> · loja ${d.shopId}</div>
        <div class="actions">
          <button class="btn ${d.inLive ? "btn-ok" : "btn-accent"}" data-act="live" title="${d.inLive ? "Remover da lista da live" : "Adicionar à lista da live"}">${d.inLive ? "✓ Na live" : "+ Live"}</button>
          <button class="btn" data-act="copy" title="Copiar link de afiliado">Link</button>
          <button class="btn" data-act="open" title="Abrir na Shopee">Abrir</button>
          <button class="btn" data-act="hist" title="Histórico de preço">Hist.</button>
        </div>
      </div>
    </article>`;
}

function renderGrid() {
  if (!root) return;
  const grid = $("#deals-grid", root);
  const info = $("#deals-info", root);
  if (loading) {
    grid.innerHTML = `<div class="empty"><span class="spinner"></span> Carregando…</div>`;
    return;
  }
  if (deals.length === 0) {
    grid.innerHTML = html`<div class="empty">
      <p><b>Nenhum achadinho com esses filtros.</b></p>
      <p class="muted">${totalTracked === 0
        ? "Ainda não há produtos rastreados. Cadastre buscas em <b>Monitoramento</b> e rode uma varredura, ou use <b>Buscar</b>."
        : "Tente desmarcar “só achadinhos”, diminuir o score mínimo ou limpar a palavra-chave."}</p>
    </div>`;
  } else {
    grid.innerHTML = deals.map(card).join("");
  }
  info.textContent = `${deals.length} resultado(s) · ${totalTracked} produtos rastreados`;
  renderSelBar();
}

function renderSelBar() {
  if (!root) return;
  const bar = $("#sel-bar", root);
  bar.classList.toggle("hidden", selected.size === 0);
  $("#sel-count", root).textContent = `${selected.size} selecionado(s)`;
}

async function load() {
  if (!root) return;
  loading = true;
  renderGrid();
  try {
    const [list, status] = await Promise.all([api.listDeals(filter), api.getStatus()]);
    deals = list;
    totalTracked = status.productsTracked;
    // Remove seleções de itens que saíram da lista.
    const ids = new Set(deals.map((d) => d.itemId));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  } catch (e) {
    toast(`Erro ao carregar achadinhos: ${errMsg(e)}`, "error");
    deals = [];
  } finally {
    loading = false;
    renderGrid();
  }
}

async function showHistory(d: Deal) {
  const m = modal(`<div class="muted"><span class="spinner"></span> Carregando histórico…</div>`, { title: d.productName, wide: true });
  try {
    const pts = await api.getProductHistory(d.itemId);
    const values = pts.map((p) => p.priceMin);
    const body = m.el.querySelector(".modal-body")!;
    body.innerHTML = html`
      ${sparkline(values)}
      <div class="row" style="margin-top:12px; justify-content:space-between">
        <dl class="kv">
          <dt>Preço atual</dt><dd><b>${fmtBRL(d.priceMin)}</b> ${d.discountRate > 0 ? `(-${Math.round(d.discountRate)}% Shopee)` : ""}</dd>
          <dt>Preço normal (pares)</dt><dd>${d.eval.peerMedian
            ? `${fmtBRL(d.eval.peerMedian)} — mediana de “${esc(d.eval.peerKeyword ?? "")}” (${d.eval.peerCount} itens) → este está a ${Math.round((d.eval.peerRatio ?? 1) * 100)}% do normal`
            : d.peers
              ? `poucos pares ainda (${d.peers.count}) em “${esc(d.peers.keyword)}”`
              : "— (sem grupo de pares)"}</dd>
          <dt>Média histórica</dt><dd>${fmtBRL(d.history.avgPrice)} (${d.history.samples} amostras)</dd>
          <dt>Mínimo / máximo</dt><dd>${fmtBRL(d.history.minPrice)} / ${fmtBRL(d.history.maxPrice)}</dd>
          <dt>Queda vs média</dt><dd>${fmtPct(d.eval.dropVsAvgPct, 1)}</dd>
          <dt>Queda vs anterior</dt><dd>${fmtPct(d.eval.dropVsPrevPct, 1)}</dd>
          <dt>Visto pela 1ª vez</dt><dd>${fmtDateTime(d.firstSeen)}</dd>
          <dt>Última captura</dt><dd>${fmtDateTime(d.lastSeen)}</dd>
          <dt>Motivos</dt><dd>${esc(d.eval.reasons.join(" · ") || "—")}</dd>
        </dl>
        <div class="row-end" style="margin:0; flex-direction:column; align-items:stretch">
          <button class="btn btn-accent" data-h="live">${d.inLive ? "✓ Já na live" : "+ Adicionar à live"}</button>
          <button class="btn" data-h="copy">Copiar link afiliado</button>
          <button class="btn" data-h="open">Abrir na Shopee</button>
        </div>
      </div>
      <details style="margin-top:12px"><summary class="muted small">Capturas (${pts.length})</summary>
        <div class="table-wrap" style="margin-top:8px; max-height:220px"><table>
          <thead><tr><th>Quando</th><th class="right">Preço</th><th class="right">Desc.</th><th class="right">Vendas</th></tr></thead>
          <tbody>${pts
            .slice()
            .reverse()
            .map((p) => html`<tr><td>${fmtDateTime(p.capturedAt)}</td><td class="right">${fmtBRL(p.priceMin)}</td><td class="right">${fmtPct(p.discountRate)}</td><td class="right">${fmtInt(p.sales)}</td></tr>`)
            .join("")}</tbody>
        </table></div>
      </details>`;
    body.querySelector("[data-h=live]")!.addEventListener("click", async () => {
      await toggleLive(d);
      m.close();
    });
    body.querySelector("[data-h=copy]")!.addEventListener("click", () => void copyText(d.offerLink || d.productLink, "Link copiado!"));
    body.querySelector("[data-h=open]")!.addEventListener("click", () => void openLink(d.productLink || d.offerLink));
  } catch (e) {
    m.el.querySelector(".modal-body")!.innerHTML = `<div class="alert alert-error">${esc(errMsg(e))}</div>`;
  }
}

async function toggleLive(d: Deal) {
  try {
    if (d.inLive) {
      await api.removeFromLive(d.itemId);
      toast("Removido da lista da live", "info", 1500);
    } else {
      await api.addToLive([d.itemId]);
      toast("Adicionado à lista da live", "success", 1500);
    }
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

function bindToolbar() {
  if (!root) return;
  const kw = $<HTMLInputElement>("#f-kw", root);
  kw.addEventListener(
    "input",
    debounce(() => {
      filter.keyword = kw.value;
      saveFilter();
      void load();
    }, 300),
  );
  $<HTMLSelectElement>("#f-sort", root).addEventListener("change", (e) => {
    filter.sort = (e.target as HTMLSelectElement).value as DealFilter["sort"];
    saveFilter();
    void load();
  });
  $<HTMLSelectElement>("#f-kind", root).addEventListener("change", (e) => {
    filter.kind = (e.target as HTMLSelectElement).value as DealFilter["kind"];
    saveFilter();
    void load();
  });
  $<HTMLInputElement>("#f-only", root).addEventListener("change", (e) => {
    filter.onlyQualifying = (e.target as HTMLInputElement).checked;
    saveFilter();
    void load();
  });
  $<HTMLInputElement>("#f-exlive", root).addEventListener("change", (e) => {
    filter.excludeInLive = (e.target as HTMLInputElement).checked;
    saveFilter();
    void load();
  });
  $<HTMLInputElement>("#f-score", root).addEventListener(
    "input",
    debounce((e: Event) => {
      filter.minScore = parseDecimal((e.target as HTMLInputElement).value);
      saveFilter();
      void load();
    }, 300),
  );
  $<HTMLInputElement>("#f-price", root).addEventListener(
    "input",
    debounce((e: Event) => {
      filter.maxPrice = parseDecimal((e.target as HTMLInputElement).value);
      saveFilter();
      void load();
    }, 300),
  );
  $<HTMLSelectElement>("#f-seen", root).addEventListener("change", (e) => {
    filter.seenWithinHours = Number((e.target as HTMLSelectElement).value);
    saveFilter();
    void load();
  });
  $("#f-reset", root).addEventListener("click", () => {
    filter = { ...defaultFilter };
    saveFilter();
    mountToolbarValues();
    void load();
  });
}

function mountToolbarValues() {
  if (!root) return;
  $<HTMLInputElement>("#f-kw", root).value = filter.keyword;
  $<HTMLSelectElement>("#f-sort", root).value = filter.sort;
  $<HTMLSelectElement>("#f-kind", root).value = filter.kind ?? "";
  $<HTMLInputElement>("#f-only", root).checked = filter.onlyQualifying;
  $<HTMLInputElement>("#f-exlive", root).checked = filter.excludeInLive;
  $<HTMLInputElement>("#f-score", root).value = filter.minScore ? String(filter.minScore) : "";
  $<HTMLInputElement>("#f-price", root).value = filter.maxPrice ? String(filter.maxPrice) : "";
  $<HTMLSelectElement>("#f-seen", root).value = String(filter.seenWithinHours);
}

function bindGrid() {
  if (!root) return;
  const grid = $("#deals-grid", root);
  // imagens quebradas → esconde (sem handler inline por causa do CSP)
  grid.addEventListener(
    "error",
    (e) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "IMG") t.remove();
    },
    true,
  );
  grid.addEventListener("change", (e) => {
    const cb = e.target as HTMLInputElement;
    if (!cb.matches("[data-sel]")) return;
    const id = Number(cb.closest<HTMLElement>(".deal")!.dataset.id);
    if (cb.checked) selected.add(id);
    else selected.delete(id);
    renderSelBar();
  });
  grid.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const cardEl = t.closest<HTMLElement>(".deal");
    if (!cardEl) return;
    const id = Number(cardEl.dataset.id);
    const d = deals.find((x) => x.itemId === id);
    if (!d) return;
    if (t.closest("[data-copy-id]")) return void copyText(String(id), `ID ${id} copiado`);
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "live") await toggleLive(d);
    else if (act === "copy") await copyText(d.offerLink || d.productLink, "Link de afiliado copiado!");
    else if (act === "open") await openLink(d.productLink || d.offerLink);
    else if (act === "hist") await showHistory(d);
  });

  $("#sel-add", root).addEventListener("click", async () => {
    const ids = [...selected];
    try {
      const n = await api.addToLive(ids);
      toast(`${n} produto(s) adicionado(s) à live${n < ids.length ? ` (${ids.length - n} já estavam)` : ""}`, "success");
      selected.clear();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  });
  $("#sel-copy", root).addEventListener("click", () => void copyText([...selected].join("\n"), `${selected.size} ID(s) copiado(s)`));
  $("#sel-clear", root).addEventListener("click", () => {
    selected.clear();
    $$<HTMLInputElement>("[data-sel]", root!).forEach((c) => (c.checked = false));
    renderSelBar();
  });
  $("#sel-all", root).addEventListener("click", () => {
    deals.forEach((d) => selected.add(d.itemId));
    $$<HTMLInputElement>("[data-sel]", root!).forEach((c) => (c.checked = true));
    renderSelBar();
  });
  $("#btn-autofill", root).addEventListener("click", async () => {
    const ok = await confirmDialog(
      "Preencher a lista da live com os melhores achadinhos (segundo as regras salvas em Lista da Live)? Itens já presentes são mantidos.",
      { title: "Preencher lista da live", okLabel: "Preencher" },
    );
    if (!ok) return;
    try {
      const n = await api.autoFillLive(undefined, false);
      toast(n > 0 ? `${n} produto(s) adicionado(s) à live` : "Nenhum produto novo atendeu às regras (ou a lista já está cheia)", n > 0 ? "success" : "warn");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  });
}

export const dealsView: View = {
  async mount(r) {
    root = r;
    r.innerHTML = html`
      <div class="view-head">
        <div>
          <h1>🔥 Achadinhos</h1>
          <p>Preços fora da curva (bem abaixo do normal dos produtos parecidos — os “bugs” de vendedor novo), quedas vs histórico e descontos altos.</p>
        </div>
        <div class="row">
          <button class="btn" id="btn-autofill" title="Usa as regras de preenchimento automático da Lista da Live">⚡ Preencher live com os melhores</button>
        </div>
      </div>
      <div class="toolbar">
        <label class="field grow">Palavra-chave<input type="search" id="f-kw" placeholder="nome do produto ou loja…" /></label>
        <label class="field">Tipo
          <select id="f-kind">
            <option value="">Todos</option>
            <option value="anomaly">⚡ Preço fora da curva (bug)</option>
            <option value="discount">Desconto / queda de preço</option>
          </select>
        </label>
        <label class="field">Ordenar por
          <select id="f-sort">
            <option value="score">Melhor achadinho (score)</option>
            <option value="peer">Mais abaixo do preço normal</option>
            <option value="discount">Maior desconto Shopee</option>
            <option value="drop">Maior queda vs média</option>
            <option value="price">Menor preço</option>
            <option value="sales">Mais vendidos</option>
            <option value="commission">Maior comissão</option>
            <option value="recent">Capturados recentemente</option>
          </select>
        </label>
        <label class="field">Score mín.<input type="text" inputmode="numeric" id="f-score" placeholder="0" style="width:70px" /></label>
        <label class="field">Preço máx. (R$)<input type="text" inputmode="decimal" id="f-price" placeholder="—" style="width:90px" /></label>
        <label class="field">Vistos em
          <select id="f-seen">
            <option value="0">qualquer momento</option>
            <option value="24">últimas 24h</option>
            <option value="72">últimos 3 dias</option>
            <option value="168">últimos 7 dias</option>
          </select>
        </label>
        <label class="check" title="Mostrar só o que atende às regras de achadinho (Configurações)"><input type="checkbox" id="f-only" /> Só achadinhos</label>
        <label class="check"><input type="checkbox" id="f-exlive" /> Ocultar já na live</label>
        <button class="btn btn-sm" id="f-reset">Limpar filtros</button>
      </div>
      <div class="sel-bar hidden" id="sel-bar">
        <b id="sel-count"></b>
        <button class="btn btn-sm btn-accent" id="sel-add">+ Adicionar à live</button>
        <button class="btn btn-sm" id="sel-copy">Copiar IDs</button>
        <button class="btn btn-sm btn-ghost" id="sel-all">Selecionar todos</button>
        <button class="btn btn-sm btn-ghost" id="sel-clear">Limpar seleção</button>
      </div>
      <div class="muted small" id="deals-info" style="margin-bottom:10px"></div>
      <div class="deals-grid" id="deals-grid"></div>`;
    mountToolbarValues();
    bindToolbar();
    bindGrid();
    await load();
  },
  unmount() {
    root = null;
  },
  refresh() {
    if (root) void load();
  },
};
