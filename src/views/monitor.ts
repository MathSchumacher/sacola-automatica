import { api, LIST_TYPES, SORT_TYPES, type SavedSearch } from "../api";
import { fmtDateTime } from "../format";
import { $, confirmDialog, errMsg, esc, html, selectOptions, toast } from "../ui";
import type { View } from "../main";

let root: HTMLElement | null = null;

const label = (opts: { value: number | ""; label: string }[], v: number | null) =>
  opts.find((o) => String(o.value) === String(v ?? ""))?.label ?? "Padrão";

async function load() {
  if (!root) return;
  const box = $("#m-list", root);
  try {
    const [list, settings, status] = await Promise.all([api.listSearches(), api.getSettings(), api.getStatus()]);
    $("#m-interval", root).textContent = `${settings.intervalMinutes} min`;
    $("#m-pages", root).textContent = String(settings.maxPagesPerSearch);
    $("#m-last", root).textContent = status.scan.lastSummary ?? "—";
    if (list.length === 0) {
      box.innerHTML = `<div class="empty">Nenhuma busca monitorada. Adicione acima — ex.: <b>air fryer</b>, <b>fone bluetooth</b>, ou deixe vazio para a lista geral de ofertas.</div>`;
      return;
    }
    box.innerHTML = html`<div class="table-wrap"><table>
      <thead><tr><th>Ativa</th><th>Palavra-chave</th><th>Lista</th><th>Ordenação</th><th class="right">Páginas</th><th>Caça menor preço</th><th>Última execução</th><th>Resultado</th><th></th></tr></thead>
      <tbody>${list.map(row).join("")}</tbody></table></div>`;
  } catch (e) {
    box.innerHTML = `<div class="alert alert-error">${esc(errMsg(e))}</div>`;
  }
}

function row(s: SavedSearch): string {
  const err = (s.lastResult ?? "").startsWith("erro");
  return html`<tr data-id="${s.id}">
    <td><input type="checkbox" data-toggle ${s.enabled ? "checked" : ""} /></td>
    <td><b>${esc(s.keyword || "(geral)")}</b></td>
    <td>${esc(label(LIST_TYPES, s.listType))}</td>
    <td>${esc(label(SORT_TYPES, s.sortType))}</td>
    <td class="right">${s.pages}</td>
    <td>${s.keyword ? (s.huntLowPrice ? "⚡ sim" : "não") : `<span class="muted">n/a (geral)</span>`}</td>
    <td class="nowrap">${fmtDateTime(s.lastRunAt)}</td>
    <td class="${err ? "" : "muted"}" style="${err ? "color:var(--danger)" : ""}">${esc(s.lastResult ?? "—")}</td>
    <td class="right"><button class="btn btn-xs btn-danger" data-del>Remover</button></td>
  </tr>`;
}

export const monitorView: View = {
  async mount(r) {
    root = r;
    r.innerHTML = html`
      <div class="view-head">
        <div>
          <h1>📡 Monitoramento</h1>
          <p>Buscas que o app repete sozinho a cada <b id="m-interval">—</b> (até <b id="m-pages">—</b> página(s) por busca) para montar o histórico e detectar achadinhos.</p>
        </div>
      </div>
      <form class="toolbar" id="m-form">
        <label class="field grow">Palavra-chave<input type="search" id="m-kw" placeholder="ex.: air fryer (vazio = ofertas gerais)" /></label>
        <label class="field">Lista<select id="m-list-type">${selectOptions(LIST_TYPES, "")}</select></label>
        <label class="field">Ordenação<select id="m-sort">${selectOptions(SORT_TYPES, 2)}</select></label>
        <label class="field">Páginas<select id="m-pg">${selectOptions(
          [1, 2, 3, 5].map((n) => ({ value: n, label: String(n) })),
          1,
        )}</select></label>
        <label class="check" title="Além da busca normal (que define o preço “normal”), consulta também ordenado por menor preço — é onde aparecem os bugs de vendedor novo"><input type="checkbox" id="m-hunt" checked /> ⚡ Caçar menor preço</label>
        <button class="btn btn-accent" type="submit">+ Adicionar</button>
      </form>
      <div class="alert alert-info" style="margin-bottom:12px">
        Como funciona: a busca <b>base</b> (ex.: “camiseta”, Mais vendidos) define o <b>preço normal</b> da palavra-chave (mediana); com <b>⚡ Caçar menor preço</b> o app consulta a mesma palavra ordenada por menor preço e marca o que estiver muito abaixo da mediana (camiseta a R$ 2, tênis a R$ 8). Use palavras-chave de <b>tipo de produto</b> (“tênis masculino”, “camiseta”, “vestido”) — quanto mais específica, melhor a comparação. Mais páginas = mais chamadas à API.
        <div class="small muted" style="margin-top:4px">Última varredura: <span id="m-last">—</span></div>
      </div>
      <div id="m-list"></div>`;

    $("#m-form", r).addEventListener("submit", async (e) => {
      e.preventDefault();
      const lt = $<HTMLSelectElement>("#m-list-type", r).value;
      const st = $<HTMLSelectElement>("#m-sort", r).value;
      try {
        await api.addSearch({
          keyword: $<HTMLInputElement>("#m-kw", r).value,
          listType: lt === "" ? undefined : Number(lt),
          sortType: st === "" ? undefined : Number(st),
          pages: Number($<HTMLSelectElement>("#m-pg", r).value),
          huntLowPrice: $<HTMLInputElement>("#m-hunt", r).checked,
        });
        $<HTMLInputElement>("#m-kw", r).value = "";
        toast("Busca adicionada — será incluída na próxima varredura", "success");
        await load();
      } catch (err) {
        toast(errMsg(err), "error");
      }
    });

    $("#m-list", r).addEventListener("change", async (e) => {
      const cb = e.target as HTMLInputElement;
      if (!cb.matches("[data-toggle]")) return;
      const id = Number(cb.closest("tr")!.dataset.id);
      try {
        await api.setSearchEnabled(id, cb.checked);
      } catch (err) {
        toast(errMsg(err), "error");
        cb.checked = !cb.checked;
      }
    });
    $("#m-list", r).addEventListener("click", async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-del]");
      if (!btn) return;
      const tr = btn.closest("tr")!;
      const kw = tr.querySelector("b")?.textContent ?? "";
      if (!(await confirmDialog(`Remover a busca "${kw}" do monitoramento? O histórico dos produtos é mantido.`, { danger: true, okLabel: "Remover" }))) return;
      try {
        await api.deleteSearch(Number(tr.dataset.id));
        await load();
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
