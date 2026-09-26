import { api, type AppSettings } from "../api";
import { parseDecimal } from "../format";
import { $, errMsg, esc, html, openLink, toast } from "../ui";
import type { View } from "../main";

let root: HTMLElement | null = null;

function fill(s: AppSettings) {
  const r = root!;
  $<HTMLInputElement>("#c-appid", r).value = s.appId;
  $<HTMLInputElement>("#c-secret", r).value = s.secret;
  $<HTMLInputElement>("#c-interval", r).value = String(s.intervalMinutes);
  $<HTMLInputElement>("#c-pages", r).value = String(s.maxPagesPerSearch);
  $<HTMLInputElement>("#c-pagesize", r).value = String(s.pageSize);
  $<HTMLInputElement>("#c-history", r).value = String(s.historyDays);
  $<HTMLInputElement>("#c-notif", r).checked = s.notifications;
  $<HTMLInputElement>("#t-disc", r).value = String(s.thresholds.minDiscountRate);
  $<HTMLInputElement>("#t-drop", r).value = String(s.thresholds.minDropVsAvg);
  $<HTMLInputElement>("#t-sales", r).value = String(s.thresholds.minSales);
  $<HTMLInputElement>("#t-samples", r).value = String(s.thresholds.minHistorySamples);
  $<HTMLInputElement>("#t-peer", r).value = String(Math.round((1 - (s.thresholds.maxPeerRatio ?? 0.35)) * 100));
  $<HTMLInputElement>("#t-peercount", r).value = String(s.thresholds.minPeerCount ?? 8);
}

function read(base: AppSettings): AppSettings {
  const r = root!;
  return {
    ...base,
    appId: $<HTMLInputElement>("#c-appid", r).value.trim(),
    secret: $<HTMLInputElement>("#c-secret", r).value.trim(),
    intervalMinutes: Math.round(parseDecimal($<HTMLInputElement>("#c-interval", r).value)) || 30,
    maxPagesPerSearch: Math.round(parseDecimal($<HTMLInputElement>("#c-pages", r).value)) || 2,
    pageSize: Math.round(parseDecimal($<HTMLInputElement>("#c-pagesize", r).value)) || 100,
    historyDays: Math.round(parseDecimal($<HTMLInputElement>("#c-history", r).value)) || 90,
    notifications: $<HTMLInputElement>("#c-notif", r).checked,
    thresholds: {
      minDiscountRate: parseDecimal($<HTMLInputElement>("#t-disc", r).value),
      minDropVsAvg: parseDecimal($<HTMLInputElement>("#t-drop", r).value),
      minSales: Math.round(parseDecimal($<HTMLInputElement>("#t-sales", r).value)),
      minHistorySamples: Math.max(1, Math.round(parseDecimal($<HTMLInputElement>("#t-samples", r).value)) || 3),
      // UI pede "% abaixo do normal"; backend guarda a razão preço/mediana.
      maxPeerRatio: Math.min(0.95, Math.max(0.05, 1 - parseDecimal($<HTMLInputElement>("#t-peer", r).value) / 100)),
      minPeerCount: Math.max(1, Math.round(parseDecimal($<HTMLInputElement>("#t-peercount", r).value)) || 8),
    },
  };
}

let current: AppSettings | null = null;

export const settingsView: View = {
  async mount(r) {
    root = r;
    r.innerHTML = html`
      <div class="view-head">
        <div>
          <h1>⚙️ Configurações</h1>
          <p>Credenciais da API de Afiliados, ritmo das varreduras e o que conta como achadinho.</p>
        </div>
        <div class="row"><button class="btn btn-accent" id="c-save">💾 Salvar</button></div>
      </div>

      <div id="c-mode"></div>

      <div class="settings-grid">
        <div class="card">
          <h3>🔑 Credenciais da API (Shopee Afiliados)</h3>
          <label class="field">App ID<input type="text" id="c-appid" placeholder="ex.: 18xxxxxx" autocomplete="off" /></label>
          <label class="field">Secret
            <span class="row" style="gap:6px"><input type="password" id="c-secret" style="flex:1" autocomplete="off" /><button class="btn btn-sm" id="c-eye" type="button">👁</button></span>
          </label>
          <div class="row">
            <button class="btn" id="c-test">Testar conexão</button>
            <span class="hint" id="c-test-msg"></span>
          </div>
          <div class="hint">
            As credenciais são pedidas no painel de afiliado (Central de Ajuda → “Quero ativar a API”) e chegam por e-mail; depois aparecem em
            <a href="#" id="c-link-openapi">affiliate.shopee.com.br → Open API</a>. Enquanto não chegam, o app roda em <b>modo DEMO</b> com produtos fictícios para você testar tudo.
            <br />Ficam salvas só neste computador (banco local do app).
          </div>
        </div>

        <div class="card">
          <h3>⏱ Varredura automática</h3>
          <label class="field">Intervalo entre varreduras (minutos, mín. 5)<input type="text" inputmode="numeric" id="c-interval" /></label>
          <label class="field">Páginas por busca (máx. 10)<input type="text" inputmode="numeric" id="c-pages" /></label>
          <label class="field">Produtos por página (10–500)<input type="text" inputmode="numeric" id="c-pagesize" /></label>
          <label class="field">Manter histórico por (dias)<input type="text" inputmode="numeric" id="c-history" /></label>
          <label class="check"><input type="checkbox" id="c-notif" /> Notificar novos achadinhos (notificação do Windows)</label>
          <div class="hint">Quanto mais buscas × páginas × frequência, mais chamadas à API. A Shopee limita requisições (erro 10030); se aparecer, aumente o intervalo.</div>
        </div>

        <div class="card">
          <h3>⚡ Preço fora da curva (bug de vendedor novo)</h3>
          <label class="field">Marcar quando estiver pelo menos X% abaixo do preço normal<input type="text" inputmode="decimal" id="t-peer" /></label>
          <label class="field">Mínimo de produtos parecidos para definir o “preço normal”<input type="text" inputmode="numeric" id="t-peercount" /></label>
          <div class="hint">O “preço normal” é a <b>mediana</b> dos produtos retornados pela mesma palavra-chave (ex.: “camiseta”). Um item a 65%+ abaixo dela entra como <b>fora da curva</b>, mesmo com 0 vendas — é o perfil de anúncio de vendedor novo buscando reputação. Quanto mais específica a palavra-chave no Monitoramento, mais precisa a comparação.</div>
        </div>

        <div class="card">
          <h3>🎯 Desconto / queda de preço</h3>
          <label class="field">Desconto Shopee mínimo (%)<input type="text" inputmode="decimal" id="t-disc" /></label>
          <label class="field">Queda mínima vs média histórica (%)<input type="text" inputmode="decimal" id="t-drop" /></label>
          <label class="field">Vendas mínimas<input type="text" inputmode="numeric" id="t-sales" /></label>
          <label class="field">Amostras mínimas de histórico para confiar na média<input type="text" inputmode="numeric" id="t-samples" /></label>
          <div class="hint">Qualifica quando tem <b>vendas ≥ mínimo</b> e (<b>desconto ≥ X%</b> <i>ou</i> <b>preço ≥ Y% abaixo da média</b> registrada pelo app). A média só vale depois de N capturas. (O tipo “fora da curva” acima ignora o mínimo de vendas.)</div>
        </div>
      </div>`;

    $("#c-eye", r).addEventListener("click", () => {
      const i = $<HTMLInputElement>("#c-secret", r);
      i.type = i.type === "password" ? "text" : "password";
    });
    $("#c-link-openapi", r).addEventListener("click", (e) => {
      e.preventDefault();
      void openLink("https://affiliate.shopee.com.br/open_api");
    });
    $("#c-save", r).addEventListener("click", async () => {
      if (!current) return;
      try {
        current = await api.saveSettings(read(current));
        fill(current);
        renderMode();
        toast("Configurações salvas", "success");
      } catch (e) {
        toast(errMsg(e), "error");
      }
    });
    $("#c-test", r).addEventListener("click", async () => {
      if (!current) return;
      const msg = $("#c-test-msg", r);
      const btn = $<HTMLButtonElement>("#c-test", r);
      btn.disabled = true;
      msg.innerHTML = `<span class="spinner"></span> testando…`;
      try {
        // salva antes para testar exatamente o que está na tela
        current = await api.saveSettings(read(current));
        const res = await api.testConnection();
        msg.innerHTML = res.ok
          ? `<span style="color:var(--ok)">✔ ${esc(res.message)}${res.sample ? ` — ex.: “${esc(res.sample)}”` : ""}</span>`
          : `<span style="color:var(--danger)">✖ ${esc(res.message)}</span>`;
        renderMode();
      } catch (e) {
        msg.innerHTML = `<span style="color:var(--danger)">✖ ${esc(errMsg(e))}</span>`;
      } finally {
        btn.disabled = false;
      }
    });

    try {
      current = await api.getSettings();
      fill(current);
      renderMode();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  },
  unmount() {
    root = null;
  },
};

async function renderMode() {
  if (!root) return;
  try {
    const s = await api.getStatus();
    $("#c-mode", root).innerHTML =
      s.mode === "live"
        ? `<div class="alert alert-ok" style="margin-bottom:14px">✔ Conectado à API real com o App ID <b>${esc(s.appId)}</b>.</div>`
        : `<div class="alert alert-warn" style="margin-bottom:14px">⚠ <b>Modo DEMO</b>: sem credenciais, os produtos exibidos são fictícios (servem para testar a interface, a lista da live e as regras). Assim que a Shopee enviar App ID e Secret, cole aqui, salve e clique em “Testar conexão”.</div>`;
  } catch {
    /* ignore */
  }
}
