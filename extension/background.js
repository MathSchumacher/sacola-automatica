// Service worker: fila de produtos a favoritar, ritmo humano, integração com o app desktop.
importScripts("edicao.js", "shared/pt-modelo.js", "shared/parse.js");
const { parseProductRefs, productUrl, idsFromUrl, codigoAindaValido } = globalThis.SacolinhaParse;
// Um pendente ganha 1 nova tentativa (ao FIM da fila) e na 2ª falha é descartado — é o que
// trabalhar() faz. Esta rede só existe para o caso de um item voltar a "pending" por outro
// caminho (destravarItens, versão antiga): com 2 tentativas registradas, sai sem trabalhar.
const MAX_TENTATIVAS_PENDENTE = 2;
// Nome da edição instalada. Com valor de reserva: se edicao.js não carregar, a extensão
// continua funcionando — o nome é só rótulo, não pode derrubar a fila no meio da live.
const NOME_EDICAO = (globalThis.EDICAO && globalThis.EDICAO.nome) || "Sacolinha Automática";

const APP_BASE = "http://127.0.0.1:47831";
const DEFAULTS = {
  enabled: true,          // processa a fila automaticamente
  autoFromChat: true,     // aceita referências vindas do chat da live
  minDelayMs: 3000,       // ritmo humano entre favoritos
  maxDelayMs: 6000,
  maxPerHour: 600,
  maxParalelo: 4, // janelas favoritando ao mesmo tempo quando a fila acumula
  sendToApp: true,        // registra no app desktop (lista da live, origem "chat")
  calibratedSelector: "", // seletor do botão "curtir" gravado pela calibração
  // Sacola da live: juntar os favoritados e adicioná-los em lote.
  autoBag: false, // adicionar à sacola sozinha quando a fila de favoritos zerar
  bagLimit: 50, // limite de produtos na sacola
  // "activeTab" = aba normal em primeiro plano. Ao terminar, o foco volta para a aba anterior.
  //               Rouba o foco a cada código: atrapalha quem está trabalhando em outra coisa.
  // "window"    = janela separada, visível, SEM foco: não interrompe a dona. As esperas do
  //               content script não são desaceleradas mesmo com a janela coberta (ver sleep
  //               em content-product.js), e ninguém dá foco à janela para "destravar".
  // "tab"       = aba de fundo na mesma janela (discreto, mas o Brave pode congelar a página)
  openMode: "activeTab",
};

let seqFila = Date.now(); // contador de chegada (cresce sempre, sobrevive a reinícios)
let processing = false;
let sacolaRodando = false; // sacola em andamento (favoritar continua em paralelo)
let ativos = 0; // favoritos abertos neste momento

async function getState() {
  const { queue = [], settings = {}, stats = {} } = await chrome.storage.local.get(["queue", "settings", "stats"]);
  return { queue, settings: { ...DEFAULTS, ...settings }, stats: { done: 0, failed: 0, hourWindow: [], ...stats } };
}
async function setState(patch) {
  await chrome.storage.local.set(patch);
}
async function updateBadge() {
  const { queue } = await getState();
  const pending = queue.filter((q) => q.status === "pending" || q.status === "working").length;
  await chrome.action.setBadgeText({ text: pending ? String(pending) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#ee4d2d" });
}

/** Adiciona referências à fila (dedupe por itemId/url). */
async function enqueue(refs, source) {
  const { queue, settings } = await getState();
  let added = 0;
  const repetidos = [];
  for (const ref of refs) {
    const key = ref.kind === "code" ? `code:${ref.code}` : ref.itemId ? `item:${ref.itemId}` : `url:${ref.url}`;
    if (queue.some((q) => q.key === key)) {
      repetidos.push(ref.code || ref.url || String(ref.itemId));
      continue;
    }
    queue.push({
      key,
      // Número de chegada: garante "do mais antigo para o mais recente" mesmo com vários
      // favoritos em paralelo (sem isto a ordem dependia da posição no array).
      seq: ++seqFila,
      kind: ref.kind,
      code: ref.code || null,
      itemId: ref.itemId || null,
      shopId: ref.shopId || null,
      url: ref.url || null,
      raw: ref.raw,
      origem: ref.origem || "",
      source,
      status: "pending",
      note: "",
      addedAt: Date.now(),
    });
    added++;
  }
  if (repetidos.length) {
    // Silêncio aqui já custou caro: um código que a extensão "ignorou" parecia código não lido.
    log(`repetido(s), já na lista desta sessão: ${repetidos.join(", ")}`);
    const { repetidosRecentes = [] } = await chrome.storage.local.get("repetidosRecentes");
    await setState({
      repetidosRecentes: [...repetidosRecentes, ...repetidos.map((c) => ({ code: c, at: Date.now() }))].slice(-10),
    });
  }
  if (added) {
    await setState({ queue });
    await updateBadge();
    if (settings.enabled) void processQueue();
  }
  return { added, repetidos };
}

async function appFetch(path, init) {
  try {
    const r = await fetch(APP_BASE + path, { ...init, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Resolve uma referência até uma URL de produto (shopId + itemId). */
async function resolve(item, settings) {
  if (item.kind === "code") {
    // Código de live (XXX-XXX-XXX): abrimos a home e o content script DIGITA o código na
    // barra de busca (igual ao que a usuária faz na mão) — a Shopee redireciona para o produto.
    return "https://shopee.com.br/";
  }
  if (item.kind === "full" && item.url) return item.url;
  if (item.kind === "id") {
    if (settings.sendToApp) {
      const r = await appFetch(`/resolve?itemId=${encodeURIComponent(item.itemId)}`);
      if (r && r.productLink) {
        const ids = idsFromUrl(r.productLink);
        if (ids) {
          item.shopId = ids.shopId;
          item.name = r.productName || "";
          return productUrl(ids.shopId, ids.itemId);
        }
        return r.productLink;
      }
    }
    // Sem o app (ou sem credenciais) tentamos a URL com loja 0 — a Shopee costuma redirecionar para a loja certa.
    return productUrl(0, item.itemId);
  }
  if (item.kind === "short" && item.url) {
    // Abre o link curto numa aba: a página final é a do produto (o content script identifica).
    return item.url;
  }
  return null;
}

function randomDelay(settings) {
  const min = Math.max(1500, Number(settings.minDelayMs) || DEFAULTS.minDelayMs);
  const max = Math.max(min, Number(settings.maxDelayMs) || DEFAULTS.maxDelayMs);
  return min + Math.random() * (max - min);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Abre a página numa janelinha visível (sem roubar o foco) ou numa aba, e espera o content script favoritar.
 *  Abas ocultas são congeladas pelo navegador e a página da Shopee não termina de carregar —
 *  por isso o padrão é "window": janela pequena, visível, porém sem foco. */
function likeInTab(url, settings, item) {
  return new Promise(async (resolve) => {
    let tabId = null;
    let windowId = null;
    let previousTabId = null;
    let done = false;
    let focoAnterior = null; // janela que tinha o foco quando precisamos trazer a nossa à frente
    const finish = (result) => {
      if (done) return;
      done = true;
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (windowId != null) chrome.windows.remove(windowId).catch(() => {});
      else if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
      // Trouxemos a janela à frente para destravar: devolve o foco para onde a dona estava.
      if (focoAnterior != null) chrome.windows.update(focoAnterior, { focused: true }).catch(() => {});
      // devolve o foco para onde a usuária estava (a aba da live)
      if (previousTabId != null) chrome.tabs.update(previousTabId, { active: true }).catch(() => {});
      if (tabId != null) void chrome.storage.local.remove("pl:" + tabId);
      resolve(result);
    };
    const onMsg = (msg, sender, sendResponse) => {
      if (!sender.tab || sender.tab.id !== tabId || !msg) return;
      if (msg.type === "like-result") finish(msg.result);
      if (msg.type === "preciso-de-tela") {
        // A página está coberta e travou. Traz a janela à frente (isso rouba o foco por alguns
        // segundos — é o mal menor: sem isso o código falha) e anota para devolver depois.
        (async () => {
          try {
            const atual = await chrome.windows.getLastFocused();
            if (atual && atual.id !== windowId && atual.id !== sender.tab.windowId) focoAnterior = atual.id;
            await trazerJanela(sender.tab.windowId);
            await chrome.tabs.update(tabId, { active: true });
            log(`janela da Shopee estava coberta (${msg.motivo}): trouxe à frente para destravar (${item?.code || url})`);
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, erro: String(e) });
          }
        })();
        return true;
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    // Aba fechada (pela dona, ou pelo navegador): não há mais quem responda — falha na hora.
    const onRemoved = (id) => {
      if (id === tabId) finish({ ok: false, code: "tab", message: "a aba foi fechada antes de terminar" });
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
    try {
      const semFoco = settings.openMode !== "activeTab"; // a dona pediu para não ser interrompida
      if (sacolaRodando || ativos > 1) {
        // Em paralelo (ou com a sacola em andamento): cada favorito abre em JANELA separada.
        // Abas na mesma janela deixariam a aba da live oculta, o navegador congelaria a página
        // e o chat/sacola quebrariam no meio. Assim a live segue sendo a aba ativa da janela dela.
        const win = await chrome.windows.create({ url, focused: !semFoco, type: semFoco ? "popup" : "normal", width: 1100, height: 800, left: 60, top: 60 });
        windowId = win.id;
        tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
      } else if (settings.openMode === "activeTab") {
        const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
        previousTabId = current ? current.id : null;
        const tab = await chrome.tabs.create({ url, active: true });
        tabId = tab.id;
      } else if (settings.openMode === "tab") {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
      } else {
        const win = await chrome.windows.create({ url, focused: false, type: "popup", width: 1000, height: 760, left: 40, top: 40 });
        windowId = win.id;
        tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
      }
      // O content script pede instruções quando a página carrega (ver content-product.js).
      // Chave POR ABA: com vários favoritos em paralelo, uma única chave faria uma janela
      // apagar o trabalho da outra.
      await setState({
        ["pl:" + tabId]: { tabId, code: item?.code || null, calibratedSelector: settings.calibratedSelector, startedAt: Date.now() },
      });
    } catch (e) {
      finish({ ok: false, code: "tab", message: String(e) });
    }
    // Aba em segundo plano pode ficar congelada pelo navegador e a página não termina de
    // carregar. Se em 20 s nada voltou, ativamos a aba (é o que a dona fazia na mão) e
    // seguimos esperando. Duas cutucadas antes de desistir.
    for (const espera of [20000, 35000]) {
      setTimeout(async () => {
        if (done || tabId == null) return;
        if (settings.openMode !== "activeTab") return; // sem foco é sem foco: não "destrava" roubando a tela
        try {
          await chrome.tabs.update(tabId, { active: true });
          if (windowId != null) await trazerJanela(windowId);
          log(`aba demorou: dei foco para destravar (${item?.code || url})`);
        } catch {
          /* aba já fechada */
        }
      }, espera);
    }
    // Um código válido resolve em poucos segundos (busca → produto → coração). 50 s é folga
    // de sobra; 120 s era uma eternidade com a fila parada e o item "favoritando…".
    setTimeout(() => finish({ ok: false, code: "timeout", message: "página não respondeu em 50s" }), 50000);
  });
}

/** Traz uma janela à frente SEM mudar o tamanho dela. `state: "normal"` aqui tirava a janela do
 *  maximizado — a dona via a janela do navegador "encolher sozinha". Só restaura se estiver
 *  minimizada (aí não há como mostrar de outro jeito). */
async function trazerJanela(windowId) {
  let estado = null;
  try {
    estado = (await chrome.windows.get(windowId)).state;
  } catch {
    /* janela já fechada */
  }
  const mudanca = { focused: true };
  if (estado === "minimized") mudanca.state = "normal";
  await chrome.windows.update(windowId, mudanca);
}

/** Itens presos em "working" (o service worker pode ser morto no meio) voltam para a fila.
 *  Sem isto, `rodarSacola` vê "fila ocupada" para sempre e a sacola nunca mais roda. */
async function destravarItens() {
  const { queue } = await getState();
  const limite = Date.now() - 90_000; // acima do prazo de 50 s + cutucadas: é sobra, não trabalho
  let mudou = false;
  for (const q of queue) {
    if (q.status === "working" && (q.startedAt || q.addedAt || 0) < limite) {
      q.status = "pending";
      q.note = "retomado (interrompido antes de terminar)";
      mudou = true;
    }
  }
  if (mudou) {
    await setState({ queue });
    await updateBadge();
    log("itens presos em 'working' devolvidos à fila");
  }
}

/** Serializa leitura+escrita da fila: com vários favoritos em paralelo, dois trabalhadores
 *  gravando ao mesmo tempo sobrescreveriam o resultado um do outro. */
let filaMutex = Promise.resolve();
function comFila(fn) {
  const proximo = filaMutex.then(fn, fn);
  filaMutex = proximo.then(
    () => {},
    () => {},
  );
  return proximo;
}

/** Quantas janelas favoritando ao mesmo tempo. Cresce com o acúmulo da fila para o chat
 *  não correr mais rápido que a extensão; volta a 1 quando a fila esvazia. */
function concorrenciaAlvo(pendentes, settings) {
  const teto = Math.max(1, Math.min(6, Number(settings.maxParalelo) || DEFAULTS.maxParalelo));
  if (pendentes <= 4) return 1;
  if (pendentes <= 8) return Math.min(2, teto);
  if (pendentes <= 15) return Math.min(3, teto);
  return teto;
}

/** Pega o próximo item e já o marca como "working" — atômico, para dois trabalhadores
 *  nunca pegarem o mesmo código. */
function pegarProximo() {
  return comFila(async () => {
    const { queue } = await getState();
    // o mais antigo primeiro: menor número de chegada (itens antigos, sem número, vêm antes)
    let item = null;
    let mudou = false;
    for (const q of queue) {
      if (q.status !== "pending") continue;
      // Quarentena: falhou/reiniciou MAX vezes → não é código, sai da fila (e do caminho).
      if ((q.tentativas || 0) >= MAX_TENTATIVAS_PENDENTE) {
        q.status = "failed";
        q.note = `descartado: falhou ${q.tentativas} vezes seguidas — não é um código válido`;
        mudou = true;
        log(`descartado da fila após ${q.tentativas} falhas: ${q.code || q.url || q.itemId}`);
        continue;
      }
      if (!item || (q.seq || 0) < (item.seq || 0)) item = q;
    }
    if (mudou) await setState({ queue });
    if (!item) return null;
    item.status = "working";
    item.startedAt = Date.now();
    await setState({ queue });
    await updateBadge();
    return { ...item };
  });
}

/** Executa UM item da fila (abrir página, favoritar, gravar resultado). */
async function trabalhar(item, settings) {
  const url = await resolve(item, settings);
  let result;
  if (!url) result = { ok: false, code: "unresolved", message: "não foi possível montar o link do produto" };
  else result = await likeInTab(url, settings, item);

  let pausar = false;
  await comFila(async () => {
    const fresh = await getState();
    const cur = fresh.queue.find((q) => q.key === item.key);
    if (!cur) return;
    // O shopId vem do RESULTADO (lido da URL do produto). Sem guardá-lo, o lote podia ficar
    // sem link — e sem link o produto pula o "Importar via URL" e cai na busca por nome.
    cur.shopId = result.shopId || item.shopId || cur.shopId;
    cur.itemId = result.itemId || cur.itemId;
    cur.name = result.name || item.name || cur.name || "";
    cur.nomeAba = result.nomeAba || cur.nomeAba || "";
    cur.preco = result.preco ?? cur.preco ?? null;
    cur.precoMax = result.precoMax ?? cur.precoMax ?? null;
    cur.finalUrl = result.url || url;
    if (result.ok) {
      cur.status = result.already ? "already" : "done";
      cur.note = result.refavorited
        ? "refavoritado (era favorito — removido e adicionado de novo)"
        : result.already
          ? "já estava favoritado"
          : "favoritado";
      if (result.busca) cur.note += ` · ${result.busca}`;
      if (result.precisouDeTela) cur.note += " · a janela estava coberta: precisei trazê-la à frente";
      fresh.stats.done = (fresh.stats.done || 0) + 1;
      fresh.stats.hourWindow.push(Date.now());
      try {
        const { bag = [] } = await chrome.storage.local.get("bag");
        const jaTem = bag.some((b) => (cur.itemId && b.itemId === cur.itemId) || (cur.code && b.codigo === cur.code));
        // Sem NOME não há como casar com o card em "Meus Favoritos": ficaria preso no lote.
        if (!cur.name) {
          cur.note = (cur.note ? cur.note + " · " : "") + "sem nome: adicione à sacola manualmente";
        } else if (!jaTem && (cur.code || cur.itemId)) {
          const urlProduto =
            (cur.finalUrl && /i\.\d+\.\d+|product\/\d+\/\d+/.test(cur.finalUrl) && cur.finalUrl.split("?")[0]) ||
            (cur.shopId && cur.itemId ? `https://shopee.com.br/product/${cur.shopId}/${cur.itemId}` : null);
          if (!urlProduto) {
            log(`${cur.code || cur.itemId}: entrou no lote SEM link (a conversão por URL não vai poder ser usada; só a busca por nome)`);
          }
          bag.push({
            codigo: cur.code || String(cur.itemId),
            itemId: cur.itemId || null,
            shopId: cur.shopId || null,
            url: urlProduto,
            nome: cur.name || "",
            nomeAba: cur.nomeAba || "",
            preco: cur.preco ?? null,
            precoMax: cur.precoMax ?? null,
            at: Date.now(),
          });
          await setState({ bag });
        }
      } catch {
        /* ignore */
      }
      if (fresh.settings.sendToApp && cur.itemId) {
        void appFetch("/favorited", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemIds: [Number(cur.itemId)], source: "chat" }),
        });
      }
    } else if (!["login", "captcha", "unresolved", "noresult", "nosearchbox", "digitacao", "erro"].includes(result.code) && (cur.tentativas || 0) < 1) {
      // "noresult" NÃO ganha nova tentativa: a Shopee já respondeu que o código não é produto.
      // Repetir a busca era a "insistência no produto que não existe". O mesmo vale para o que
      // não é problema passageiro da página (barra de busca ausente, código que não cola, erro):
      // insistir só segura a fila; se for código de verdade, o chat pede de novo.
      // Falha esporádica (página que não carregou, clique que não pegou): tenta mais uma vez
      // sozinha antes de marcar como falha — evita a dona ter que favoritar na mão.
      cur.tentativas = (cur.tentativas || 0) + 1;
      cur.status = "pending";
      cur.note = `nova tentativa (${result.message || result.code || "falhou"})`;
      cur.diag = result.diag || null;
      // vai para o FIM da fila: um código real entra de primeira; o que insiste em falhar não
      // pode segurar os códigos de verdade do chat atrás dele
      cur.seq = ++seqFila;
    } else {
      cur.status = "failed";
      cur.note = result.message || result.code || "falhou";
      cur.diag = result.diag || null;
      fresh.stats.failed = (fresh.stats.failed || 0) + 1;
      if (result.code === "login" || result.code === "captcha") {
        fresh.settings.enabled = false;
        pausar = true;
        cur.status = "pending";
        cur.note = result.code === "login" ? "faça login na Shopee e reative" : "captcha/verificação — resolva no navegador e reative";
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/128.png",
          title: `${NOME_EDICAO} pausada`,
          message: cur.note,
        });
      }
    }
    await setState({ queue: fresh.queue, stats: fresh.stats, settings: fresh.settings });
    await updateBadge();
  });
  return pausar;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  let processouAlgo = false;
  let pausado = false;
  try {
    await destravarItens();
    for (;;) {
      const { queue, settings, stats } = await getState();
      if (!settings.enabled || pausado) break;
      // Favoritar NUNCA para, nem enquanto a sacola é montada: numa live movimentada, minutos
      // parados perderiam códigos. Os dois fluxos correm juntos (ver likeInTab: durante a
      // sacola o produto abre em JANELA separada, para a aba da live continuar visível).
      const now = Date.now();
      stats.hourWindow = (stats.hourWindow || []).filter((t) => now - t < 3600_000);
      if (stats.hourWindow.length >= settings.maxPerHour) {
        await setState({ stats, throttled: { desde: Date.now(), teto: settings.maxPerHour, fila: queue.filter((q) => q.status === "pending").length } });
        log(`limite de ${settings.maxPerHour}/hora atingido: ${queue.filter((q) => q.status === "pending").length} código(s) esperando. Aumente em Ajustes se a live estiver movimentada.`);
        try {
          chrome.notifications.create({
            type: "basic",
            iconUrl: "icons/128.png",
            title: `${NOME_EDICAO}: limite por hora atingido`,
            message: `A fila parou com ${queue.filter((q) => q.status === "pending").length} código(s). Aumente o limite em Ajustes.`,
          });
        } catch {
          /* ignore */
        }
        break;
      }
      if (stats.hourWindow.length < settings.maxPerHour) await chrome.storage.local.remove("throttled");
      const pendentes = queue.filter((q) => q.status === "pending").length;
      if (!pendentes) {
        if (ativos > 0) {
          await sleep(500);
          continue;
        }
        break;
      }
      const alvo = concorrenciaAlvo(pendentes, settings);
      if (ativos >= alvo) {
        await sleep(400);
        continue;
      }
      const item = await pegarProximo();
      if (!item) continue;
      processouAlgo = true;
      ativos++;
      void trabalhar(item, settings)
        .then((p) => {
          if (p) pausado = true;
        })
        .catch(() => {})
        .finally(() => {
          ativos--;
        });
      // Escalona a abertura das janelas (nem todas de uma vez) e mantém o ritmo humano.
      await sleep(alvo > 1 ? 900 : randomDelay(settings));
    }
    while (ativos > 0) await sleep(400); // espera os trabalhadores em voo
    // Só depois de REALMENTE favoritar algo nesta rodada. Chamar a cada tick do alarme faria
    // a extensão reabrir as janelas da sacola na live a cada minuto, indefinidamente.
    if (processouAlgo) void talvezRodarSacolaAutomatica();
  } finally {
    processing = false;
    // Corrida real: um código pode ter entrado na fila JUSTO quando o laço estava saindo.
    // Nesse instante `processing` ainda era true, então o enqueue não iniciou nada e o item
    // ficaria esperando o alarme (até 1 min). Aqui reconferimos e retomamos na hora.
    try {
      const { queue, settings } = await getState();
      if (settings.enabled && queue.some((q) => q.status === "pending")) setTimeout(() => void processQueue(), 300);
    } catch {
      /* ignore */
    }
  }
}

// ----- mensagens dos content scripts / popup -----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;
    if (msg.type === "chat-refs") {
      const { settings } = await getState();
      if (!settings.autoFromChat) return sendResponse({ added: 0 });
      const r = await enqueue(msg.refs || [], "chat");
      sendResponse({ added: r.added, repetidos: r.repetidos });
    } else if (msg.type === "paste") {
      // colagem manual: não é linha de chat, não há apelido na frente
      const refs = parseProductRefs(msg.text || "", { linhaDeChat: false });
      const r = await enqueue(refs, "manual");
      sendResponse({ added: r.added, parsed: refs.length, repetidos: r.repetidos });
    } else if (msg.type === "get-like-job") {
      // content-product pergunta se esta aba tem um trabalho pendente
      const chave = sender.tab ? "pl:" + sender.tab.id : null;
      const armazenado = chave ? await chrome.storage.local.get(chave) : {};
      const pendingLike = chave ? armazenado[chave] : null;
      const isJob = !!pendingLike;
      sendResponse(
        isJob ? { job: true, code: pendingLike.code || null, calibratedSelector: pendingLike.calibratedSelector || "" } : { job: false },
      );
    } else if (msg.type === "set-settings") {
      const { settings } = await getState();
      const next = { ...settings, ...msg.settings };
      await setState({ settings: next });
      if (msg.settings && msg.settings.bagLimit && msg.settings.bagLimit !== settings.bagLimit) await chrome.storage.local.remove("bagLimiteAprendido");
      if (next.enabled) void processQueue();
      sendResponse({ settings: next });
    } else if (msg.type === "live-status") {
      const now = Date.now();
      const { liveStatus } = await chrome.storage.local.get("liveStatus");
      // Várias abas/iframes podem reportar: fica com quem ACHOU o chat e/ou lê mais mensagens.
      const anterior = liveStatus && now - liveStatus.at < 10000 ? liveStatus : null;
      const score = (s) => (s.achouChat ? 1000 : 0) + (s.msgs || 0);
      if (!anterior || score(msg) >= score(anterior)) {
        await setState({
          liveStatus: {
            tabId: sender.tab?.id ?? null,
            url: msg.url,
            msgs: msg.msgs,
            codes: msg.codes,
            paused: msg.paused,
            achouChat: msg.achouChat,
            semPainel: msg.semPainel,
            origem: msg.origem || "",
            candidatos: Array.isArray(msg.candidatos) ? msg.candidatos.slice(0, 4) : [],
            seletor: msg.seletor || "",
            ultimaLeitura: msg.ultimaLeitura || 0,
            oculto: !!msg.oculto,
            ultimas: Array.isArray(msg.ultimas) ? msg.ultimas.slice(-15) : [],
            erro: msg.erro || "",
            at: now,
          },
        });
      }
      sendResponse({ ok: true });
    } else if (msg.type === "focus-live") {
      const { liveStatus } = await chrome.storage.local.get("liveStatus");
      if (liveStatus?.tabId != null) {
        await chrome.tabs.update(liveStatus.tabId, { active: true }).catch(() => {});
        const t = await chrome.tabs.get(liveStatus.tabId).catch(() => null);
        if (t) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      }
      sendResponse({ ok: true });
    } else if (msg.type === "live-loaded") {
      // Página da live recarregada = começo de sessão: o lote da sacola volta a zero.
      const { bag = [] } = await chrome.storage.local.get("bag");
      // ...e os códigos JÁ ATENDIDOS saem da fila. Eles só existem para não repetir dentro da
      // mesma live; mantê-los para sempre fazia um produto anunciado de novo (em outra live,
      // ou depois de um F5) ser descartado sem aviso — parecia que o chat não tinha sido lido.
      const { queue } = await getState();
      // Revalida cada pendente com o parser ATUAL: o que uma regra velha enfileirou e a regra
      // de hoje recusa ("tra-nsm-iss" de "transmissao") sai aqui — era o fantasma que voltava
      // toda live e ficava na frente dos códigos reais.
      const revalidada = revalidarPendentes(queue, { novaSessao: true });
      const emAndamento = revalidada.mantidos;
      if (revalidada.removidos.length) log(`removidos ao abrir a live (o parser atual não os reconhece como código): ${revalidada.removidos.join(", ")}`);
      const liberados = queue.length - emAndamento.length;
      await setState({
        bag: [],
        bagSession: msg.sessao || "",
        bagDesde: Date.now(),
        bagTentativas: 0,
        queue: emAndamento,
        repetidosRecentes: [],
      });
      await updateBadge();
      if (bag.length) log(`live recarregada: lote da sacola zerado (${bag.length} produto(s) descartados)`);
      if (liberados) log(`live recarregada: ${liberados} código(s) já atendidos saíram da fila (podem ser pedidos de novo)`);
      sendResponse({ ok: true, descartados: bag.length, liberados });
    } else if (msg.type === "recarregou-sozinho") {
      // o vigia da página viu a sacola cinza e tentou o "Recarregar" por conta própria
      log(`sacola inacessível (${msg.motivo}) — ${msg.clicou ? "cliquei em 'Recarregar'" : "NÃO achei o 'Recarregar'"}`);
      await setState({
        ultimoVigia: { em: Date.now(), motivo: msg.motivo, clicou: !!msg.clicou, detalhe: msg.detalhe || [], icone: msg.icone || null },
      });
      sendResponse({ ok: true });
    } else if (msg.type === "recarregar-frames") {
      // O "Recarregar" fica sobre o vídeo e pode estar dentro de um quadro (iframe) do player,
      // onde o script da sacola (que só roda na janela principal) não alcança.
      const { liveStatus } = await chrome.storage.local.get("liveStatus");
      const tabId = (sender.tab && sender.tab.id) ?? (liveStatus && liveStatus.tabId);
      if (tabId == null) return sendResponse({ clicou: false });
      let clicou = false;
      try {
        const frames = await chrome.webNavigation?.getAllFrames?.({ tabId });
        const ids = frames ? frames.map((f) => f.frameId) : [0];
        for (const frameId of ids) {
          const r = await chrome.tabs.sendMessage(tabId, { type: "clicar-recarregar" }, { frameId }).catch(() => null);
          if (r && r.clicou) {
            clicou = true;
            break;
          }
        }
      } catch {
        /* sem permissão de webNavigation: tenta a janela principal mesmo */
        const r = await chrome.tabs.sendMessage(tabId, { type: "clicar-recarregar" }).catch(() => null);
        clicou = !!(r && r.clicou);
      }
      if (clicou) log("cliquei em 'Recarregar' da live (a lista de produtos estava inacessível)");
      sendResponse({ clicou });
    } else if (msg.type === "dialogos-fechados") {
      log(`fechei ${msg.n} caixa(s) de rascunho que estavam travando a tela`);
      sendResponse({ ok: true });
    } else if (msg.type === "bag-run") {
      sendResponse(await rodarSacola(msg.modo || "simular"));
    } else if (msg.type === "bag-clear") {
      await setState({ bag: [] });
      sendResponse({ ok: true });
    } else if (msg.type === "get-state") {
      const st = await getState();
      st.appOnline = !!(await appFetch("/health"));
      const { liveStatus, bag = [], bagLast = null, bagRunning = false, bagDesde = null, repetidosRecentes = [] } = await chrome.storage.local.get([
        "liveStatus",
        "bag",
        "bagLast",
        "bagRunning",
        "bagDesde",
        "repetidosRecentes",
      ]);
      st.repetidosRecentes = repetidosRecentes;
      st.throttled = (await chrome.storage.local.get("throttled")).throttled || null;
      st.ultimoVigia = (await chrome.storage.local.get("ultimoVigia")).ultimoVigia || null;
      st.bagDesde = bagDesde;
      st.bagLimiteAprendido = (await chrome.storage.local.get("bagLimiteAprendido")).bagLimiteAprendido || null;
      st.liveStatus = liveStatus || null;
      st.bag = bag;
      st.bagLast = bagLast;
      st.bagRunning = sacolaRodando || bagRunning;
      sendResponse(st);
    } else if (msg.type === "clear-done") {
      const { queue } = await getState();
      await setState({ queue: queue.filter((q) => q.status === "pending" || q.status === "working") });
      await updateBadge();
      sendResponse({ ok: true });
    } else if (msg.type === "retry-failed") {
      const { queue } = await getState();
      queue.forEach((q) => {
        if (q.status === "failed") q.status = "pending";
      });
      await setState({ queue });
      await updateBadge();
      void processQueue();
      sendResponse({ ok: true });
    } else if (msg.type === "remove") {
      const { queue } = await getState();
      await setState({ queue: queue.filter((q) => q.key !== msg.key) });
      await updateBadge();
      sendResponse({ ok: true });
    } else if (msg.type === "calibrated") {
      const { settings } = await getState();
      await setState({ settings: { ...settings, calibratedSelector: msg.selector || "" } });
      sendResponse({ ok: true });
    } else if (msg.type === "process") {
      void processQueue();
      sendResponse({ ok: true });
    }
  })();
  return true; // resposta assíncrona
});

// ---- sacola da live ----

/** Separa os pendentes que o parser ATUAL ainda aceita dos que ele recusa.
 *  Itens em andamento ("working") são mantidos: alguém está trabalhando neles agora. */
function revalidarPendentes(queue, opcoes) {
  const mantidos = [];
  const removidos = [];
  const novaSessao = !!(opcoes && opcoes.novaSessao);
  for (const q of queue) {
    // Nova live = nova sessão. Um pendente que já FALHOU antes (ganhou retry) veio da live
    // anterior: a busca não achou produto lá, e o chat de agora não o pediu. Atendê-lo faz um
    // ID "nunca digitado" aparecer com o chat vazio — foi o KHM-PVN-TFQ. Sai.
    if (novaSessao && q.status === "pending" && (q.tentativas || 0) > 0) {
      removidos.push((q.code || q.url || String(q.itemId)) + " (falhou na live anterior)");
      continue;
    }
    if (q.status === "working") {
      // 'working' ao abrir a live é sobra de live anterior (o worker morreu no meio):
      // destravarItens() o devolveria à fila e ele seria atendido do nada.
      if (novaSessao) {
        removidos.push((q.code || q.url || String(q.itemId)) + " (interrompido em live anterior)");
        continue;
      }
      mantidos.push(q);
      continue;
    }
    if (q.status !== "pending") continue;
    if (q.kind === "code" && !codigoAindaValido(q.code, q.origem)) {
      removidos.push(q.code);
      continue;
    }
    mantidos.push(q);
  }
  return { mantidos, removidos };
}

/** Só mexe na sacola quando NÃO há nada pendente para favoritar (regra pedida:
 *  primeiro todos os IDs do chat, só então abrir a sacola). */
async function rodarSacola(modo) {
  if (sacolaRodando) return { ok: false, motivo: "jaRodando" };
  await destravarItens();
  const { queue, settings } = await getState();
  const { bag = [], liveStatus } = await chrome.storage.local.get(["bag", "liveStatus"]);
  const faltando = queue.filter((q) => q.status === "pending" || q.status === "working").length;
  if (faltando) return { ok: false, motivo: "filaOcupada", faltando };
  if (!bag.length) return { ok: false, motivo: "loteVazio" };
  if (!liveStatus || liveStatus.tabId == null) return { ok: false, motivo: "semAba" };

  sacolaRodando = true;
  await setState({ bagRunning: true });
  let r;
  try {
    // frameId 0 = janela principal. Sem isto, um iframe responderia primeiro (e com erro),
    // enquanto o frame principal seguiria clicando em Confirmar.
    // Prazo máximo: se a página travar, a sacola NÃO pode segurar a fila de favoritos.
    // O limite REAL da Shopee pode ser menor que o configurado (30 numa conta que ainda não subiu
    // de nível, com o padrão em 50): usa o menor dos dois. O aprendido vem de uma recusa da
    // própria Shopee e é descartado assim que a contagem passar dele (a conta subiu de nível).
    const { bagLimiteAprendido = null } = await chrome.storage.local.get("bagLimiteAprendido");
    const limiteConfigurado = settings.bagLimit || DEFAULTS.bagLimit;
    const limite = bagLimiteAprendido && bagLimiteAprendido < limiteConfigurado ? bagLimiteAprendido : limiteConfigurado;
    r = await Promise.race([
      chrome.tabs.sendMessage(
        liveStatus.tabId,
        { type: "bag-run", lote: bag, modo, limite },
        { frameId: 0 },
      ),
      new Promise((res) => setTimeout(() => res({ ok: false, motivo: "demorou", log: ["a página da live não respondeu em 3 min"] }), 180000)),
    ]);
  } catch (e) {
    sacolaRodando = false;
    await setState({ bagRunning: false });
    const err = { ok: false, motivo: "semResposta", erro: String((e && e.message) || e), modo, at: Date.now() };
    await setState({ bagLast: err });
    void processQueue(); // a fila de favoritos não pode ficar parada por causa da sacola
    return err;
  } finally {
    sacolaRodando = false;
    await setState({ bagRunning: false });
  }
  if (!r) {
    const err = { ok: false, motivo: "semResposta", modo, at: Date.now() };
    await setState({ bagLast: err });
    void processQueue();
    return err;
  }

  const resultado = { ...r, modo, at: Date.now() };
  if (r.motivo === "cheia" && Number.isFinite(r.limiteReal) && r.limiteReal > 0 && r.limiteReal < limiteConfigurado) {
    if (r.limiteReal !== bagLimiteAprendido) log(`a Shopee recusou com ${r.limiteReal} produtos: passo a considerar esse o limite da sacola (o configurado é ${limiteConfigurado})`);
    await setState({ bagLimiteAprendido: r.limiteReal });
  } else if (bagLimiteAprendido && Number.isFinite(r.atual) && r.atual > bagLimiteAprendido) {
    log(`a sacola passou de ${bagLimiteAprendido} produtos: o limite aprendido não vale mais (a conta subiu de nível?)`);
    await chrome.storage.local.remove("bagLimiteAprendido");
  }
  if (modo === "real") {
    // Relê o lote: produtos favoritados DURANTE a execução não podem ser apagados por um
    // snapshot velho. "nadaNovo" também sai do lote — o objetivo (estar na sacola) foi cumprido.
    const { bag: atual = [] } = await chrome.storage.local.get("bag");
    await setState({ bag: loteAposSacola(atual, bag, r) });
  }
  await setState({ bagLast: resultado, bagTentativas: 0 });
  // Abrir/fechar a janela de produtos costuma re-renderizar o painel e derrubar a referência
  // do chat. Pedimos uma rechecagem imediata para não ficar cego esperando a redescoberta.
  if (liveStatus.tabId != null) {
    chrome.tabs.sendMessage(liveStatus.tabId, { type: "chat-rescan" }, { frameId: 0 }).catch(() => {});
  }
  log(`sacola (${modo}): ${r.ok ? "ok" : r.motivo} — ${(r.adicionados || []).length} produto(s)`);
  // Favoritar volta imediatamente: códigos que chegaram no chat durante a sacola não esperam.
  void processQueue();
  return resultado;
}

/** Depois de uma rodada REAL, o lote perde: o que entrou, o que já estava e — para não ficar
 *  tentando o mesmo produto para sempre — o que já foi procurado várias vezes sem entrar
 *  (quase sempre é produto que já está na sacola por outro caminho). Uma importação via URL
 *  que falhou pesa 2; uma rodada em que o item só não apareceu no topo pesa 1. */
const LIMITE_TENTATIVAS_LOTE = 4;
function loteAposSacola(atual, snapshot, r) {
  const entraram = new Set([...(r.adicionados || []), ...(r.jaEstavam || [])]);
  if (r.motivo === "nadaNovo") for (const b of snapshot) entraram.add(b.codigo);
  const ficaram = new Set(r.examinou ? r.pendentes || [] : []);
  const importFalhou = new Set(r.examinou ? r.importTentados || [] : []);
  // Converteu o link, confirmou e a sacola NÃO cresceu: o produto já está lá. Insistir só
  // reabriria a janela "Importar via URL" no mesmo produto a cada rodada.
  const jaEstavaNaSacola = new Set(r.examinou ? r.importNaoCresceu || [] : []);
  return atual.filter((b) => {
    if (entraram.has(b.codigo)) return false;
    if (jaEstavaNaSacola.has(b.codigo)) {
      log(`sacola: ${b.codigo} não fez a contagem subir ao importar — considero que já está na sacola`);
      return false;
    }
    if (!ficaram.has(b.codigo)) return true;
    b.tentativas = (b.tentativas || 0) + (importFalhou.has(b.codigo) ? 2 : 1);
    if (b.tentativas < LIMITE_TENTATIVAS_LOTE) return true;
    log(`sacola: desisti de ${b.codigo} — tentei várias vezes e não entrou (provavelmente já está na sacola; se não estiver, adicione na mão)`);
    return false;
  });
}

/** Motivos em que insistir sozinha só geraria janelas abrindo à toa na live. */
const NAO_INSISTIR = new Set(["naoEncontrados", "ambiguos", "gridVazio", "semContagem", "tela", "semAba", "erro", "semConfirmacao", "parcial"]);

/** Depois de favoritar, tenta a sacola sozinha (se ligado).
 *  Sacola cheia não é erro: espera a dona liberar espaço e tenta de novo — via alarme,
 *  porque `setTimeout` longo não sobrevive à hibernação do service worker. */
async function talvezRodarSacolaAutomatica() {
  const { settings } = await getState();
  if (!settings.autoBag) return;
  const { bag = [] } = await chrome.storage.local.get("bag");
  if (!bag.length) return;
  const r = await rodarSacola("real");
  if (!r || r.ok) return;
  if (r.motivo === "cheia") {
    // Sacola no limite: não adianta insistir sozinha (cada tentativa reabre a lista na live).
    // O lote fica guardado; o próximo produto favoritado dispara uma nova tentativa, e a dona
    // pode usar o botão do popup depois de liberar espaço. Favoritar continua normalmente.
    log("sacola cheia — o lote fica guardado; tento de novo quando favoritar o próximo produto (ou pelo popup)");
    return;
  }
  if (r.motivo === "filaOcupada") {
    const { bagTentativas = 0 } = await chrome.storage.local.get("bagTentativas");
    if (bagTentativas >= 30) return log("sacola: desisto de tentar sozinha (avise a dona)");
    await setState({ bagTentativas: bagTentativas + 1 });
    chrome.alarms.create("bag-retry", { delayInMinutes: 1 });
    log(`sacola ${r.motivo} — nova tentativa em 1 min`);
  } else if (NAO_INSISTIR.has(r.motivo)) {
    log(`sacola: ${r.motivo} — não insisto sozinha, resolva pelo popup`);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  // Ao instalar/atualizar: volta ao modo de abertura padrão e limpa da fila os "códigos"
  // inválidos gravados por versões antigas (código da Shopee é SÓ LETRAS).
  const { settings = {}, queue = [] } = await chrome.storage.local.get(["settings", "queue"]);
  // Além do formato, passa cada pendente pelo parser ATUAL (uma versão nova pode ter
  // aprendido que "tra-nsm-iss" não é código): é o que impede lixo de uma regra velha de
  // sobreviver à atualização.
  const r = revalidarPendentes(queue);
  const limpa = queue.filter((q) => q.status !== "pending" || r.mantidos.includes(q));
  const removidos = queue.length - limpa.length;
  if (r.removidos.length) log(`removidos na atualização (o parser atual não os reconhece como código): ${r.removidos.join(", ")}`);
  if (removidos) log(`removidos ${removidos} código(s) inválido(s) da fila`);
  // Ritmo entre itens: adota o padrão novo se ainda estiver no antigo (6–12 s era lento demais).
  const lento = (settings.minDelayMs || 0) >= 6000 && (settings.maxDelayMs || 0) >= 12000;
  // 120/h era o padrão antigo e virou gargalo em live cheia; sobe para o novo padrão.
  const tetoAntigo = !settings.maxPerHour || settings.maxPerHour <= 120;
  // O modo de abertura é escolha da dona (sem foco, para trabalhar em outra coisa): só volta ao
  // padrão se o valor gravado não existir mais.
  const modoValido = ["activeTab", "window", "tab"].includes(settings.openMode);
  await setState({
    settings: {
      ...settings,
      openMode: modoValido ? settings.openMode : DEFAULTS.openMode,
      ...(lento ? { minDelayMs: DEFAULTS.minDelayMs, maxDelayMs: DEFAULTS.maxDelayMs } : {}),
      ...(tetoAntigo ? { maxPerHour: DEFAULTS.maxPerHour } : {}),
    },
    queue: limpa,
  });
  await updateBadge();
});

function log(msg) {
  try {
    console.log(`[${NOME_EDICAO}]`, msg);
  } catch {
    /* ignore */
  }
}
chrome.runtime.onStartup.addListener(() => void processQueue());
// Service worker pode dormir: um alarme periódico garante que a fila continue.
chrome.alarms.create("tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "tick") void processQueue();
  if (a.name === "bag-retry") void talvezRodarSacolaAutomatica();
});
