const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STATUS = { pending: "na fila", working: "favoritando…", done: "✔ favoritado", already: "✔ já era", failed: "✖ falhou" };

/** Diagnóstico pode ser da PÁGINA (url/titulo/links) ou dos CLIQUES (r1/r2/r3). */
function fmtDiag(d) {
  if (!d) return "";
  if (d.url) {
    return `${d.url}\n${d.titulo || ""} · ${d.links ?? "?"} links (${d.linksProduto?.length || 0} de produto)\n${(d.texto || "").slice(0, 140)}`;
  }
  const partes = [];
  if (d.estadoInicial) partes.push(`estado inicial: ${d.estadoInicial}`);
  for (const k of ["off", "on"]) {
    if (!d[k]) continue;
    const rotulo = k === "off" ? "desfavoritar" : "favoritar";
    partes.push(`${rotulo}: ${d[k].ok ? "OK" : d[k].motivo} | alvos: ${(d[k].tentativas || []).join(" → ") || "—"}`);
  }
  for (const k of ["r1", "r2", "r3"]) {
    if (!d[k]) continue;
    partes.push(`${k}: ${d[k].estado} | clique recebido: ${d[k].clicado ? "SIM" : "NÃO"} | aviso: "${(d[k].toast || "—").slice(0, 40)}"`);
  }
  return partes.join("\n");
}

/** Painel de status do chat: diz claramente se está lendo, parado ou sem aba. */
/** Debug: mostra as últimas mensagens lidas e o que foi reconhecido em cada uma.
 *  É assim que se confirma se a extensão está mesmo na caixa de comentários. */
function renderDebug(ls, st) {
  const sel = $("#chat-sel");
  const ul = $("#chat-msgs");
  const ultimas = (ls && ls.ultimas) || [];
  sel.textContent = ls && ls.seletor ? `contêiner: ${ls.seletor}` : "contêiner: (ainda não definido)";
  const vig = $("#chat-vigia");
  const v = st && st.ultimoVigia;
  if (vig) {
    vig.textContent = v
      ? `${new Date(v.em).toLocaleTimeString("pt-BR")} — sacola inacessível (${v.motivo}): ${v.clicou ? "cliquei em Recarregar" : "NÃO achei o Recarregar"}` +
        (v.icone && v.icone.nota != null ? ` · ícone ${v.icone.nota} vs vizinhos ${v.icone.referencia}` : "")
      : "";
    vig.style.color = v && !v.clicou ? "#e74c3c" : "#f4b942";
  }
  const rep = $("#chat-rep");
  const repetidos = ((st && st.repetidosRecentes) || []).slice(-5);
  rep.textContent = repetidos.length
    ? `ignorados por repetição (já atendidos nesta sessão): ${repetidos.map((r) => r.code).join(", ")}`
    : "";
  if (!ultimas.length) {
    ul.innerHTML = `<li class="empty muted">Nada lido ainda. Se o chat tem mensagens novas e nada aparece aqui, a extensão está no contêiner errado — use <b>📍 marcar chat</b>.</li>`;
    return;
  }
  ul.innerHTML = ultimas
    .slice()
    .reverse()
    .map(
      (m) => `<li style="grid-template-columns:1fr">
        <div><span class="muted" style="font-size:10.5px">${esc(m.h || "")}</span>
        ${m.c && m.c.length ? `<b style="color:#2ecc71"> ✔ ${esc(m.c.join(", "))}</b>` : `<span class="muted" style="font-size:10.5px"> (sem código)</span>`}</div>
        <div style="font-size:11.5px;word-break:break-word">${esc(m.t || "")}</div>
      </li>`,
    )
    .join("");
}

const MOTIVOS = {
  selecaoVelha: "a janela \"Adicionar Produtos\" tem produtos antigos selecionados fora da vista — desmarque-os lá; não confirmei nada para não levá-los junto",
  naoAchado: "não achei esse produto nem no topo nem na busca de Meus Favoritos",
  filaOcupada: "ainda há produtos para favoritar — a sacola só entra depois que a fila zerar",
  loteVazio: "nenhum produto novo favoritado desde a última vez",
  semAba: "abra a live no Brave (e dê F5) para eu poder mexer na sacola",
  semResposta: "a página da live não respondeu — dê F5 nela",
  cheia: "sacola cheia: aguardando a dona liberar espaço (tento de novo sozinha)",
  naoEncontrados: "não achei esses produtos em Meus Favoritos",
  nadaNovo: "os produtos do lote já estavam na sacola",
  semConfirmar: "não achei o botão Confirmar",
  semContagem: "não consegui ler quantos produtos há na sacola — não arrisquei adicionar",
  semConfirmacao: "cliquei em Confirmar mas a sacola não aumentou — mantive os produtos no lote",
  ambiguos: "títulos parecidos demais: não dá para saber qual produto é o certo",
  parcial: "só parte entrou na sacola — mantive tudo no lote; rode de novo",
  gridVazio: "a lista de favoritos veio vazia na tela",
  abaFavoritos: "não consegui confirmar que estou na aba 'Meus Favoritos'",
  jaRodando: "já existe uma operação de sacola em andamento",
  tela: "não consegui abrir a janela de produtos",
  erro: "erro inesperado",
};

function renderBag(st, settings) {
  const box = $("#bag-status");
  const bag = st.bag || [];
  const last = st.bagLast;
  // Só reescreve o interruptor quando muda (senão um clique no meio do refresh "volta" sozinho).
  const chk = $("#autoBag");
  if (document.activeElement !== chk && chk.checked !== !!settings.autoBag) chk.checked = !!settings.autoBag;
  const pendentes = (st.queue || []).filter((q) => q.status === "pending" || q.status === "working").length;
  // Enquanto está rodando os botões continuam travados: o fluxo leva ~40 s e um segundo
  // clique dispararia duas execuções na mesma página (checkbox alternado, dois "Confirmar").
  const rodando = !!st.bagRunning;
  $("#bag-run").disabled = !bag.length || rodando;
  $("#bag-sim").disabled = !bag.length || rodando;
  if (rodando) {
    box.innerHTML = `<span style="color:#4da3ff">⏳ Trabalhando na sacola… acompanhe na aba da live.</span>`;
    return;
  }

  const nomes = bag.slice(0, 4).map((b) => esc((b.nome || b.codigo).slice(0, 34))).join("<br>");
  const desde = st.bagDesde ? new Date(st.bagDesde).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : null;
  box.innerHTML = bag.length
    ? `<b style="background:#ee4d2d;color:#fff;border-radius:999px;padding:1px 8px">${bag.length}</b>
       <span>produto(s) prontos para a sacola</span>
       ${desde ? `<div class="muted" style="width:100%;font-size:11px">favoritados desde ${desde} (o lote zera quando a live é recarregada)</div>` : ""}
       ${pendentes ? `<div class="muted" style="width:100%;color:#f4b942">aguardando favoritar ${pendentes} do chat antes de mexer na sacola</div>` : ""}
       <div class="muted" style="width:100%;font-size:11px">${nomes}${bag.length > 4 ? `<br>+${bag.length - 4}…` : ""}</div>`
    : `<span class="muted">Lote vazio${desde ? ` desde ${desde}` : ""}. Assim que o chat pedir códigos e eles forem favoritados, aparecem aqui.</span>`;

  const ul = $("#bag-log");
  if (!last) {
    ul.innerHTML = `<li class="empty muted">Nenhuma tentativa ainda. Use <b>👁 Simular</b> primeiro: ela abre as janelas, mostra o que marcaria e cancela sem confirmar.</li>`;
  } else {
    const cab = last.ok
      ? `<span style="color:#2ecc71">✔ ${last.simulado ? "simulação" : "adicionados"}: ${esc((last.adicionados || []).join(", ")) || "—"}</span>`
      : `<span style="color:${last.motivo === "cheia" ? "#f4b942" : "#e74c3c"}">${last.motivo === "cheia" ? "⏳" : "✖"} ${esc(MOTIVOS[last.motivo] || last.motivo || "falhou")}</span>`;
    const extra = [];
    if (last.atual != null) extra.push(`sacola: ${last.atual}`);
    if (last.cresceu != null) extra.push(`entraram: ${last.cresceu}`);
    if ((last.porBusca || []).length) extra.push(`achados pela busca em Meus Favoritos: ${last.porBusca.join(", ")}`);
    if ((last.importados || []).length) extra.push(`via Importar URL: ${last.importados.join(", ")}`);
    if ((last.jaEstavam || []).length) extra.push(`já estavam na sacola: ${last.jaEstavam.join(", ")}`);
    if ((last.pendentes || []).length) extra.push(`não achados: ${last.pendentes.join(", ")}`);
    if ((last.ambiguos || []).length) extra.push(`ambíguos (ignorados): ${last.ambiguos.join(", ")}`);
    ul.innerHTML =
      `<li style="grid-template-columns:1fr">${cab}${extra.length ? `<div class="muted" style="font-size:11px">${esc(extra.join(" · "))}</div>` : ""}</li>` +
      (last.log || []).map((l) => `<li style="grid-template-columns:1fr" class="muted"><div style="font-size:11px">${esc(l)}</div></li>`).join("");
  }
}

function renderChat(ls, st) {
  const box = $("#chat-status");
  const btn = $("#go-live");
  renderDebug(ls, st);
  const idade = ls ? (Date.now() - ls.at) / 1000 : Infinity;
  const vivo = ls && idade < 12;
  btn.style.display = ls?.tabId != null ? "" : "none";

  if (!ls) {
    box.innerHTML = `<span style="color:#f4b942">⚠ Nenhuma aba de live monitorada.</span>
      <div class="muted" style="width:100%">Abra a live no Brave e aperte <b>F5</b> nela (a extensão só entra em páginas carregadas depois de instalada).</div>`;
    return;
  }
  if (!vivo) {
    box.innerHTML = `<span style="color:#f4b942">⚠ Sem sinal há ${Math.round(idade)}s.</span>
      <div class="muted" style="width:100%">A aba da live foi fechada ou ficou "órfã" após recarregar a extensão. Vá até ela e aperte <b>F5</b>.</div>`;
    return;
  }
  if (ls.erro) {
    box.innerHTML = `<span style="color:#e74c3c">✖ Erro na página da live.</span>
      <div class="muted" style="width:100%;word-break:break-word">${esc(ls.erro)}</div>`;
    return;
  }
  const cand = (ls.candidatos || []).length ? `<div class="muted" style="width:100%">candidatos vistos: ${esc(ls.candidatos.join(" · "))}</div>` : "";
  if (ls.semPainel) {
    box.innerHTML = `<span style="color:#e74c3c">⚠ Chat não localizado automaticamente.</span>
      <div class="muted" style="width:100%">Na página da live, clique em <b>📍 marcar chat</b> (quadrinho no canto inferior esquerdo) e depois em <b>qualquer mensagem do chat</b>. Fica gravado para as próximas lives. Enquanto isso a extensão <b>não lê nada</b> (evita falso código).</div>${cand}`;
    return;
  }
  if (!ls.achouChat) {
    box.innerHTML = `<span style="color:#f4b942">⏳ Procurando o chat…</span>
      <div class="muted" style="width:100%">Se demorar mais de ~30 s, use <b>📍 marcar chat</b> no quadrinho da live e clique numa mensagem.</div>${cand}`;
    return;
  }
  if (ls.paused) {
    box.innerHTML = `<span style="color:#f4b942">⏸ Leitura pausada nesta live.</span>
      <div class="muted" style="width:100%">Clique em "retomar" no quadrinho do canto inferior esquerdo da live.</div>`;
    return;
  }
  const semMsg = !ls.msgs;
  const desdeLeitura = ls.ultimaLeitura ? Math.round((Date.now() - ls.ultimaLeitura) / 1000) : null;
  const alerta =
    desdeLeitura != null && desdeLeitura > 60 && !ls.oculto
      ? `<div style="width:100%;color:#f4b942">⚠ nenhuma mensagem nova há ${desdeLeitura}s — se o chat está andando, a leitura travou (dê F5 na live)</div>`
      : "";
  box.innerHTML = `<span style="color:${semMsg ? "#f4b942" : "#2ecc71"}">${semMsg ? "⏳ Chat localizado, aguardando mensagens" : "✔ Lendo o chat"}</span>
    <b style="background:#1e232c;border-radius:999px;padding:1px 8px">${ls.msgs || 0} msgs</b>
    <b style="background:#ee4d2d;color:#fff;border-radius:999px;padding:1px 8px">${ls.codes || 0} códigos</b>
    ${alerta}
    <div class="muted" style="width:100%">${ls.origem === "marcado" ? "chat marcado por você" : ls.origem === "gravado" ? "chat gravado da última vez" : "chat encontrado automaticamente"}${desdeLeitura != null ? ` · última leitura há ${desdeLeitura}s` : ""}</div>`;
}

/** Nome e selo da edição instalada (pessoal ou Pro), vindos de edicao.js. */
(function mostrarEdicao() {
  const ed = (typeof EDICAO !== "undefined" && EDICAO) || { nome: "Sacolinha Automática", edicao: "pessoal" };
  const nome = document.querySelector("#st-nome");
  if (nome) nome.textContent = ed.nome;
  const selo = document.querySelector("#st-edicao");
  if (selo) {
    selo.textContent = ed.edicao === "pro" ? "Pro" : "pessoal";
    selo.title = ed.edicao === "pro" ? "edição Pro (assinatura)" : "edição pessoal, sem cobrança";
  }
  if (document.title) document.title = ed.nome;
})();

async function render() {
  $("#st-version").textContent = "v" + chrome.runtime.getManifest().version;
  const st = await send({ type: "get-state" });
  if (!st) return;
  const { queue, settings, stats, appOnline } = st;
  $("#st-enabled").textContent = settings.enabled ? "ativo" : "pausado";
  $("#st-enabled").className = `pill ${settings.enabled ? "on" : "off"}`;
  $("#toggle").textContent = settings.enabled ? "⏸ Pausar" : "▶ Ativar";
  $("#st-app").className = `pill ${appOnline ? "on" : "off"}`;
  $("#st-app").textContent = appOnline ? "app conectado" : "app offline";
  const pending = queue.filter((q) => q.status === "pending").length;
  const travado = st.throttled && Date.now() - st.throttled.desde < 3600_000 ? st.throttled : null;
  $("#stats").textContent =
    `${pending} na fila · ${stats.done || 0} feitos · ${stats.failed || 0} falhas` +
    (travado ? ` · ⚠ parou no limite de ${travado.teto}/hora — aumente abaixo` : "");
  $("#stats").style.color = travado ? "#f4b942" : "";

  renderChat(st.liveStatus, st);
  renderBag(st, settings);

  const ul = $("#queue");
  ul.innerHTML = queue.length
    ? queue
        .slice()
        .reverse()
        .map(
          (q) => `<li data-key="${esc(q.key)}">
            <span class="s-${q.status}" title="${esc(q.note)}">${q.status === "working" ? "⏳" : q.status === "done" || q.status === "already" ? "✔" : q.status === "failed" ? "✖" : "•"}</span>
            <div><div class="name">${esc(q.name || q.raw)}</div><div class="id">${esc(q.code ? q.code : q.itemId ? "ID " + q.itemId : q.url || "")} · ${esc(q.source)} · <span class="muted" title="mensagem do chat de onde este código saiu">${q.origem ? "veio de: “" + esc(String(q.origem).slice(0, 60)) + "”" : "sem origem registrada"}</span> · <span class="s-${q.status}">${esc(STATUS[q.status] || q.status)}${q.note && q.status === "failed" ? " — " + esc(q.note) : ""}</span>${
              q.diag ? `<div class="muted" style="margin-top:2px;font-size:10.5px;word-break:break-all">🔎 ${esc(fmtDiag(q.diag))}</div>` : ""
            }</div></div>
            <button class="small" data-remove title="Remover">✕</button>
          </li>`,
        )
        .join("")
    : `<li class="empty muted">Nada na fila. Abra a live neste navegador (e dê F5 na aba dela) ou cole códigos acima.</li>`;

  $("#autoFromChat").checked = !!settings.autoFromChat;
  $("#openMode").value = settings.openMode || "window";
  $("#sendToApp").checked = !!settings.sendToApp;
  $("#minDelay").value = Math.round(settings.minDelayMs / 1000);
  $("#maxDelay").value = Math.round(settings.maxDelayMs / 1000);
  $("#maxPerHour").value = settings.maxPerHour;
  $("#maxParalelo").value = settings.maxParalelo ?? 4;
  if (document.activeElement !== $("#bagLimit")) $("#bagLimit").value = settings.bagLimit ?? 50;
  $("#bagLimitInfo").textContent = st.bagLimiteAprendido && st.bagLimiteAprendido < (settings.bagLimit ?? 50) ? `(a Shopee recusou com ${st.bagLimiteAprendido}: uso ${st.bagLimiteAprendido} até a sacola passar disso)` : "";
  $("#cal").textContent = settings.calibratedSelector ? `seletor: ${settings.calibratedSelector}` : "usando detecção automática";
}

$("#toggle").addEventListener("click", async () => {
  const st = await send({ type: "get-state" });
  await send({ type: "set-settings", settings: { enabled: !st.settings.enabled } });
  render();
});
$("#retry").addEventListener("click", async () => {
  await send({ type: "retry-failed" });
  render();
});
$("#clear").addEventListener("click", async () => {
  await send({ type: "clear-done" });
  render();
});
$("#add").addEventListener("click", async () => {
  const text = $("#paste").value;
  const r = await send({ type: "paste", text });
  $("#paste-msg").textContent = r
    ? `${r.parsed} referência(s) encontrada(s), ${r.added} nova(s) na fila` + ((r.repetidos || []).length ? `, ${r.repetidos.length} já estava(m)` : "")
    : "erro";
  if (r && r.added) $("#paste").value = "";
  render();
});
$("#copy").addEventListener("click", async () => {
  const st = await send({ type: "get-state" });
  const ids = st.queue.filter((q) => (q.status === "done" || q.status === "already") && (q.code || q.itemId)).map((q) => q.code || q.itemId);
  await navigator.clipboard.writeText(ids.join("\n"));
  $("#stats").textContent = `${ids.length} ID(s) copiado(s)`;
});
$("#save").addEventListener("click", async () => {
  await send({
    type: "set-settings",
    settings: {
      autoFromChat: $("#autoFromChat").checked,
      openMode: $("#openMode").value,
      sendToApp: $("#sendToApp").checked,
      minDelayMs: Math.max(2, Number($("#minDelay").value) || 6) * 1000,
      maxDelayMs: Math.max(2, Number($("#maxDelay").value) || 12) * 1000,
      maxPerHour: Math.max(1, Number($("#maxPerHour").value) || 120),
      maxParalelo: Math.min(6, Math.max(1, Number($("#maxParalelo").value) || 4)),
      bagLimit: Math.min(500, Math.max(1, Number($("#bagLimit").value) || 50)),
    },
  });
  render();
});
$("#calibrate").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/shopee\.com\.br/.test(tab.url || "")) {
    $("#cal").textContent = "abra uma página de produto da Shopee nesta aba primeiro";
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: "start-calibration" }, () => {
    $("#cal").textContent = chrome.runtime.lastError ? "recarregue a página do produto e tente de novo" : "clique no Curtir na página…";
  });
});
$("#go-live").addEventListener("click", async () => {
  await send({ type: "focus-live" });
  window.close();
});
async function rodarSacola(modo) {
  const btns = [$("#bag-sim"), $("#bag-run")];
  btns.forEach((b) => (b.disabled = true));
  $("#bag-status").innerHTML = `<span class="muted">${modo === "simular" ? "Simulando" : "Adicionando"}… acompanhe na aba da live.</span>`;
  $("#bag-debug").open = true;
  try {
    const r = await send({ type: "bag-run", modo });
    if (!r) $("#bag-status").innerHTML = `<span style="color:#e74c3c">✖ O serviço da extensão não respondeu. Recarregue a extensão.</span>`;
  } finally {
    render();
  }
}
$("#bag-sim").addEventListener("click", () => rodarSacola("simular"));
$("#bag-run").addEventListener("click", () => rodarSacola("real"));
$("#bag-clear").addEventListener("click", async () => {
  await send({ type: "bag-clear" });
  render();
});
$("#autoBag").addEventListener("change", async (e) => {
  await send({ type: "set-settings", settings: { autoBag: e.target.checked } });
  render();
});

$("#queue").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-remove]");
  if (!btn) return;
  await send({ type: "remove", key: btn.closest("li").dataset.key });
  render();
});

render();
setInterval(render, 2000);
