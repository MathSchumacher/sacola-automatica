import { api, LIST_TYPES, SORT_TYPES, type PeerStats, type ProductOffer, type ProductQuery } from "../api";
import { fmtBRL, fmtCommission, fmtInt } from "../format";
import { $, $$, copyText, errMsg, esc, html, openLink, selectOptions, toast } from "../ui";
import type { View } from "../main";

let root: HTMLElement | null = null;
let results: ProductOffer[] = [];
let peers: PeerStats | null = null;
let hasNext = false;
/** Limiar usado no badge "fora da curva" desta tela (mesmo padrão do backend). */
let maxPeerRatio = 0.35;
let minPeerCount = 8;
let query: ProductQuery = { keyword: "", page: 1, limit: 50 };
const selected = new Set<number>();
let busy = false;

function readForm(): ProductQuery {
  const lt = $<HTMLSelectElement>("#s-list", root!).value;
  const st = $<HTMLSelectElement>("#s-sort", root!).value;
  return {
    keyword: $<HTMLInputElement>("#s-kw", root!).value.trim(),
    listType: lt === "" ? undefined : Number(lt),
    sortType: st === "" ? undefined : Number(st),
    limit: Number($<HTMLSelectElement>("#s-limit", root!).value),
    page: 1,
  };
}

async function run(page = 1) {
  if (!root || busy) return;
  busy = true;
  query = { ...query, page };
  const btn = $<HTMLButtonElement>("#s-go", root);
  btn.disabled = true;
  $("#s-results", root).innerHTML = `<div class="empty"><span class="spinner"></span> Consultando a API…</div>`;
  try {
    const pg = await api.searchProducts(query);
    results = pg.nodes;
    peers = pg.peers;
    hasNext = pg.pageInfo.hasNextPage;
    selected.clear();
    renderResults();
  } catch (e) {
    $("#s-results", root).innerHTML = `<div class="alert alert-error">${esc(errMsg(e))}</div>`;
  } finally {
    busy = false;
    btn.disabled = false;
  }
}

function renderResults() {
  if (!root) return;
  const box = $("#s-results", root);
  if (results.length === 0) {
    box.innerHTML = `<div class="empty">Nenhum produto retornado para essa busca.</div>`;
    return;
  }
  const peerOk = peers && peers.count >= minPeerCount && peers.median > 0;
  const isAnomaly = (p: ProductOffer) => !!peerOk && p.priceMin > 0 && p.priceMin / peers!.median <= maxPeerRatio;
  const anomalies = results.filter(isAnomaly).length;
  box.innerHTML = html`
    ${peers
      ? html`<div class="alert ${peerOk ? "alert-info" : "alert-warn"}" style="margin-bottom:8px">
          Preço normal de “${esc(peers.keyword)}”: <b>${fmtBRL(peers.median)}</b> (mediana de ${peers.count} itens).
          ${peerOk
            ? anomalies > 0
              ? `<b>${anomalies} produto(s) ⚡ fora da curva</b> nesta página (≤ ${Math.round(maxPeerRatio * 100)}% do normal).`
              : "Nenhum preço fora da curva nesta página."
            : `Poucos itens para confiar (mín. ${minPeerCount}) — busque de novo com ordenação Relevância/Mais vendidos para calibrar.`}
        </div>`
      : ""}
    <div class="row" style="justify-content:space-between; margin-bottom:8px">
      <div class="row">
        <label class="check"><input type="checkbox" id="s-selall" /> Selecionar todos (${results.length})</label>
        <button class="btn btn-sm btn-accent" id="s-addsel" disabled>+ Adicionar selecionados à live</button>
        <button class="btn btn-sm" id="s-copysel" disabled>Copiar IDs selecionados</button>
      </div>
      <div class="row">
        <button class="btn btn-sm" id="s-prev" ${query.page <= 1 ? "disabled" : ""}>‹ Anterior</button>
        <span class="muted small">página ${query.page}</span>
        <button class="btn btn-sm" id="s-next" ${hasNext ? "" : "disabled"}>Próxima ›</button>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th></th><th></th><th>Produto</th><th class="right">Preço</th><th class="right">Desc.</th><th class="right">Vendas</th><th class="right">Comissão</th><th>ID</th><th></th>
      </tr></thead>
      <tbody>
        ${results
          .map(
            (p) => html`<tr data-id="${p.itemId}">
              <td><input type="checkbox" data-sel /></td>
              <td class="thumb">${p.imageUrl ? html`<img src="${esc(p.imageUrl)}" alt="" loading="lazy" />` : ""}</td>
              <td class="name-cell"><div class="title" title="${esc(p.productName)}">${isAnomaly(p) ? `<span class="badge badge-anomaly" title="bem abaixo do preço normal de “${esc(peers!.keyword)}”">⚡ fora da curva</span> ` : ""}${esc(p.productName)}</div><div class="muted small">${esc(p.shopName)}${p.ratingStar ? ` · ⭐ ${p.ratingStar.toFixed(1)}` : " · sem avaliações"}</div></td>
              <td class="right nowrap"><b>${fmtBRL(p.priceMin)}</b>${p.priceMax > p.priceMin ? `<div class="muted small">até ${fmtBRL(p.priceMax)}</div>` : ""}${peerOk ? `<div class="muted small">${Math.round((p.priceMin / peers!.median) * 100)}% do normal</div>` : ""}</td>
              <td class="right">${p.priceDiscountRate > 0 ? `<span class="badge">-${Math.round(p.priceDiscountRate)}%</span>` : "—"}</td>
              <td class="right">${fmtInt(p.sales)}</td>
              <td class="right">${fmtCommission(p.commissionRate)}</td>
              <td><span class="mono" data-copy-id style="cursor:pointer" title="Copiar ID">${p.itemId}</span></td>
              <td class="nowrap">
                <button class="btn btn-xs btn-accent" data-act="live">+ Live</button>
                <button class="btn btn-xs" data-act="copy" title="Copiar link de afiliado">Link</button>
                <button class="btn btn-xs" data-act="open">Abrir</button>
              </td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table></div>`;

  const updateSel = () => {
    $<HTMLButtonElement>("#s-addsel", box).disabled = selected.size === 0;
    $<HTMLButtonElement>("#s-copysel", box).disabled = selected.size === 0;
  };
  box.addEventListener("error", (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "IMG") t.remove();
  }, true);
  $("#s-selall", box).addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    selected.clear();
    if (on) results.forEach((p) => selected.add(p.itemId));
    $$<HTMLInputElement>("[data-sel]", box).forEach((c) => (c.checked = on));
    updateSel();
  });
  box.addEventListener("change", (e) => {
    const cb = e.target as HTMLInputElement;
    if (!cb.matches("[data-sel]")) return;
    const id = Number(cb.closest("tr")!.dataset.id);
    if (cb.checked) selected.add(id);
    else selected.delete(id);
    updateSel();
  });
  $("#s-addsel", box).addEventListener("click", async () => {
    try {
      const n = await api.addToLive([...selected]);
      toast(`${n} produto(s) adicionado(s) à live`, "success");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  });
  $("#s-copysel", box).addEventListener("click", () => void copyText([...selected].join("\n"), `${selected.size} ID(s) copiado(s)`));
  $("#s-prev", box).addEventListener("click", () => void run(query.page - 1));
  $("#s-next", box).addEventListener("click", () => void run(query.page + 1));
  box.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const tr = t.closest<HTMLElement>("tr[data-id]");
    if (!tr) return;
    const id = Number(tr.dataset.id);
    const p = results.find((x) => x.itemId === id);
    if (!p) return;
    if (t.closest("[data-copy-id]")) return void copyText(String(id), `ID ${id} copiado`);
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "live") {
      try {
        const n = await api.addToLive([id]);
        toast(n ? "Adicionado à lista da live" : "Já estava na lista da live", n ? "success" : "info", 1500);
      } catch (err) {
        toast(errMsg(err), "error");
      }
    } else if (act === "copy") await copyText(p.offerLink || p.productLink, "Link de afiliado copiado!");
    else if (act === "open") await openLink(p.productLink || p.offerLink);
  });
}

export const searchView: View = {
  async mount(r) {
    root = r;
    try {
      const s = await api.getSettings();
      maxPeerRatio = s.thresholds.maxPeerRatio || 0.35;
      minPeerCount = s.thresholds.minPeerCount || 8;
    } catch {
      /* usa padrão */
    }
    r.innerHTML = html`
      <div class="view-head">
        <div>
          <h1>🔎 Buscar produtos</h1>
          <p>Consulta direta ao <code>productOfferV2</code> da API de Afiliados. Tudo entra no histórico e calibra o “preço normal” da palavra-chave. Dica: ordene por <b>Menor preço</b> para caçar os bugs.</p>
        </div>
      </div>
      <form class="toolbar" id="s-form">
        <label class="field grow">Palavra-chave<input type="search" id="s-kw" placeholder="ex.: air fryer, fone bluetooth… (vazio = geral)" value="${esc(query.keyword ?? "")}" /></label>
        <label class="field">Lista<select id="s-list">${selectOptions(LIST_TYPES, query.listType ?? "")}</select></label>
        <label class="field">Ordenação<select id="s-sort">${selectOptions(SORT_TYPES, query.sortType ?? "")}</select></label>
        <label class="field">Por página<select id="s-limit">${selectOptions(
          [
            { value: 20, label: "20" },
            { value: 50, label: "50" },
            { value: 100, label: "100" },
            { value: 200, label: "200" },
          ],
          query.limit,
        )}</select></label>
        <button class="btn btn-accent" id="s-go" type="submit">Buscar</button>
        <button class="btn" id="s-monitor" type="button" title="Salva esta busca para rodar automaticamente a cada varredura">📡 Monitorar esta busca</button>
      </form>
      <div id="s-results">${results.length ? "" : `<div class="empty">Digite uma palavra-chave e clique em Buscar.</div>`}</div>`;
    $("#s-form", r).addEventListener("submit", (e) => {
      e.preventDefault();
      query = readForm();
      void run(1);
    });
    $("#s-monitor", r).addEventListener("click", async () => {
      const q = readForm();
      try {
        const s = await api.addSearch({ keyword: q.keyword ?? "", listType: q.listType, sortType: q.sortType, pages: 1, huntLowPrice: true });
        toast(`Busca "${s.keyword || "(geral)"}" adicionada ao monitoramento`, "success");
      } catch (e) {
        toast(errMsg(e), "error");
      }
    });
    if (results.length) renderResults();
  },
  unmount() {
    root = null;
  },
};
