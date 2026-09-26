// Lê o chat da live (painel do PC) e manda os códigos para a fila.
//
// MODELO (duas camadas, para NUNCA perder código):
//   1. Captura na INSERÇÃO: cada mensagem é lida no instante em que entra na tela. Numa live
//      movimentada a Shopee remove as mensagens antigas do DOM conforme rola — quem depende
//      só de varredura periódica perde essas. (Testado: ~50 msgs/s, zero perdas.)
//   2. Varredura periódica (1,5 s) da lista: pega texto que mudou DEPOIS de inserido
//      (a Shopee às vezes renderiza em duas etapas) e cobre re-render da lista.
// Cada mensagem é identificada pelo texto completo, então nada é processado duas vezes.
//
// Como achamos a lista (nesta ordem):
//   1. Seletor gravado ("📍 marcar chat" ou descoberta anterior) — revalidado a cada uso.
//   2. Descoberta automática: conta onde a página insere itens curtos (barato) e trava no vencedor.
// Se a lista for recriada pela página (referência morre), reacha sozinho.
// Fora da lista NADA é lido.
(() => {
  const { parseProductRefs } = globalThis.SacolinhaParse;
  const PANEL_ID = "achadinhos-live-panel";
  const STORE_KEY = "chatSelector:" + location.host;

  const MAX_TEXTO = 600; // acima disso não é mensagem (é um bloco da página)
  const MAX_ITENS = 250; // itens lidos por releitura (os mais recentes)
  const POLL_MS = 1500;
  const ROLAGEM_MS = 2000; // de quanto em quanto tempo conferimos se o chat está preso
  // Quanto tempo esperamos com o chat parado antes de devolvê-lo ao fim.
  // Curto de propósito: cada segundo com a lista presa é mensagem que a Shopee não coloca na
  // página, e o que não está na página não tem como ser lido. Para segurar a tela por mais
  // tempo existe o botão "pausar" no painel, que desliga a leitura inteira.
  const ROLAGEM_ESPERA_MS = 4000;
  const FUNDO_TOLERANCIA = 40; // px: abaixo disso já contamos como "está no fim"
  const DESCOBERTA_MS = 2000;
  const MAX_VISTOS = 3000;

  // ---- estado (tudo declarado ANTES de qualquer função rodar) ----
  const isTop = window.top === window;
  let paused = false;
  let codes = 0;
  let rolagens = 0; // quantas vezes devolvemos o chat ao fim sozinhos
  let naoEntregues = 0; // envios que não chegaram ao service worker (serão relidos)
  let presoDesde = 0;
  let msgs = 0;
  let chatRoot = null;
  let seletorConhecido = "";
  let origem = ""; // "gravado" | "descoberta" | "marcado"
  let erro = "";
  let calibrando = false;
  let candidatosDiag = [];
  let descobridor = null;
  let observer = null;
  let vigiaPai = null;
  let promocoes = 0;
  let rodadasSemChat = 0;
  let ultimaLeitura = 0; // quando a última mensagem foi lida (mostra se o leitor está vivo)
  let assinaturaRaiz = ""; // tag+classes do contêiner do chat, para reachá-lo após re-render
  const seenKeys = new Set();
  const vistos = new Set();
  const ordemVistos = [];
  const ultimas = []; // amostra do que foi lido, para o debug do popup
  const MAX_ULTIMAS = 15;

  // ---- sinal de vida primeiro: se algo abaixo falhar, o popup mostra o erro ----
  function heartbeat() {
    chrome.runtime.sendMessage(
      {
        type: "live-status",
        msgs,
        codes,
        paused,
        url: location.href,
        topo: isTop,
        achouChat: !!chatRoot,
        semPainel: !chatRoot && rodadasSemChat > 45,
        origem,
        candidatos: candidatosDiag,
        seletor: seletorConhecido,
        ultimaLeitura,
        oculto: !!document.hidden,
        ultimas: ultimas.slice(-MAX_ULTIMAS),
        erro,
      },
      () => void chrome.runtime.lastError,
    );
  }
  heartbeat();
  setInterval(heartbeat, 3000);
  // Avisa que a página da live foi (re)carregada: o lote da sacola recomeça do zero, senão
  // sobrariam produtos de antes — que a dona já tratou ou que são de outra live.
  if (isTop) {
    let sessao = "";
    try {
      sessao = new URL(location.href).searchParams.get("session") || "";
    } catch {
      sessao = "";
    }
    chrome.runtime.sendMessage({ type: "live-loaded", sessao, url: location.href }, () => void chrome.runtime.lastError);
  }
  window.addEventListener("error", (e) => {
    if (!erro) erro = String(e.message || "erro desconhecido");
  });

  // Nome e versão da edição, para dar para conferir na tela qual build está rodando.
  const VERSAO = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return "?";
    }
  })();
  const NOME_CURTO = (globalThis.EDICAO && globalThis.EDICAO.nome) || "Sacolinha";

  // ---- painel flutuante (só na janela principal) ----
  let panel = null;
  if (isTop) {
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText =
      "position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#161a21;color:#e8eaf0;border:1px solid #ee4d2d;border-radius:10px;padding:8px 10px;font:12px/1.4 Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5);display:flex;gap:8px;align-items:center;opacity:.95";
    panel.innerHTML =
      `<span style="color:#ee4d2d;font-weight:700">🛍️ ${NOME_CURTO}</span>` +
      `<span style="opacity:.55">v${VERSAO}</span>` +
      '<span id="alh-status">iniciando…</span>' +
      '<b id="alh-count" style="background:#ee4d2d;color:#fff;border-radius:999px;padding:0 7px">0</b>' +
      '<button id="alh-mark" title="Clique aqui e depois em uma mensagem do chat para marcar onde ele fica" style="background:#ee4d2d;color:#fff;border:0;border-radius:6px;padding:2px 8px;cursor:pointer">📍 marcar chat</button>' +
      '<button id="alh-toggle" style="background:#1e232c;color:#e8eaf0;border:1px solid #2a303b;border-radius:6px;padding:2px 8px;cursor:pointer">pausar</button>';
    const attach = () => {
      try {
        if (!document.body) return setTimeout(attach, 300);
        document.body.appendChild(panel);
        const botao = panel.querySelector("#alh-toggle");
        if (botao) {
          botao.addEventListener("click", () => {
            paused = !paused;
            botao.textContent = paused ? "retomar" : "pausar";
            if (!paused) lerLista();
            status();
          });
        }
        const marcar = panel.querySelector("#alh-mark");
        if (marcar) marcar.addEventListener("click", iniciarCalibracao);
        status();
      } catch (e) {
        console.log("[Sacolinha] painel não pôde ser exibido:", e && e.message);
      }
    };
    attach();
  }

  function status() {
    if (!panel || !panel.querySelector) return;
    const el = panel.querySelector("#alh-status");
    const contador = panel.querySelector("#alh-count");
    if (!el || !contador) return;
    el.textContent = erro
      ? "⚠ erro: " + erro.slice(0, 40)
      : calibrando
        ? "👉 clique em uma mensagem do chat (Esc cancela)"
        : paused
          ? "pausado"
          : !chatRoot
            ? rodadasSemChat > 45
              ? `⚠ chat não localizado${motivoRecusa ? ` (${motivoRecusa})` : ""} — use 📍 marcar chat`
              : `procurando o chat…${motivoRecusa ? ` (último candidato: ${motivoRecusa})` : ""}`
            : presoDesde
              ? `chat rolado para cima — devolvo ao fim em ${Math.max(0, Math.ceil((ROLAGEM_ESPERA_MS - (Date.now() - presoDesde)) / 1000))}s (mensagens novas ficam retidas enquanto isso)`
              : msgs > 0
                ? `lendo o chat (${msgs} msgs)${rolagens ? ` · voltei ao fim ${rolagens}×` : ""}${naoEntregues ? ` · ${naoEntregues} reenvio(s)` : ""}`
                : "chat localizado, aguardando mensagens…";
    contador.textContent = String(codes);
  }

  // ---- utilidades ----
  function pareceLista(el) {
    const filhos = el && el.children;
    if (!filhos || filhos.length < 2) return false;
    let curtos = 0;
    for (let i = Math.max(0, filhos.length - 8); i < filhos.length; i++) {
      const t = (filhos[i].textContent || "").trim();
      if (t && t.length <= 250) curtos++;
    }
    return curtos >= 2;
  }

  /** Lugares que NUNCA são o chat: janelas de produto, favoritos, sacola.
   *  A extensão abre essas janelas sozinha para mexer na sacola, então este caso acontece
   *  o tempo todo — e era por aqui que títulos de produto viravam "mensagem". */
  /** Rótulos EXATOS e curtos da janela "Adicionar Produtos". Exigimos dois deles juntos:
   *  uma mensagem do chat pode conter uma dessas frases, mas não duas como rótulos isolados. */
  // ---- cache por rodada ----
  // As buscas de painel e de janela varrem milhares de nós e, numa mesma rodada de descoberta,
  // repetem-se dezenas de vezes (uma por candidato; dentro de cada uma, uma por elemento
  // examinado). Medido sem cache: 3,5 s por rodada numa página de 2 mil nós — a página trava.
  const MEMO_MS = 400;
  const memoPorChave = new Map();
  function lembrar(chave, calcular) {
    const agora = Date.now();
    const c = memoPorChave.get(chave);
    if (c && agora - c.em < MEMO_MS) return c.valor;
    const valor = calcular();
    memoPorChave.set(chave, { em: agora, valor });
    return valor;
  }
  const memoMarcas = new WeakMap();

  /** A caixa de escrever do chat ("Diga algo..."). */
  function campoEscrever() {
    return lembrar("escrever", () => {
      try {
        return document.querySelector('[placeholder*="Diga algo" i], [placeholder*="oment" i], textarea[maxlength="150"]');
      } catch {
        return null;
      }
    });
  }

  const ROTULOS_JANELA = ["meus favoritos", "adicionar produtos", "importar via url", "minha loja", "adicionar produtos relacionados", "lista de produtos", "recarregar"];
  // cabeçalho da sacola: "Produtos(41)" — só existe na Lista de produtos
  const RE_CABECALHO_SACOLA = /^produtos\s*\(\s*\d+\s*\)$/;
  function marcasDeJanelaDeProduto(bloco) {
    if (!bloco || !bloco.querySelectorAll) return 0;
    const c = memoMarcas.get(bloco);
    if (c && Date.now() - c.em < MEMO_MS) return c.n;
    const n = contarMarcasDeJanela(bloco);
    memoMarcas.set(bloco, { em: Date.now(), n });
    return n;
  }
  function contarMarcasDeJanela(bloco) {
    const achados = new Set();
    const alvos = bloco.querySelectorAll("div,span,li,button,a");
    for (let i = 0; i < alvos.length && i < 1500; i++) {
      const e = alvos[i];
      if (e.childElementCount > 1) continue; // rótulo é folha, não um bloco inteiro
      const t = (e.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (t.length > 34) continue;
      for (const r of ROTULOS_JANELA) if (t === r) achados.add(r);
      if (RE_CABECALHO_SACOLA.test(t)) achados.add("produtos(n)");
      if (achados.size >= 2) return achados.size;
    }
    return achados.size;
  }

  /** É a janela de produtos/favoritos (que a própria extensão abre para mexer na sacola)?
   *
   *  Só devolve `true` com CERTEZA. Um chat recusado por engano para a extensão inteira —
   *  foi o que aconteceu na 1.7.0 — enquanto um grid lido por engano custa uma aba à toa. */
  function regiaoDeProduto(el) {
    if (!el) return false;
    // REGRA PRECISA, sem contar níveis. Contar ancestrais é frágil: o número certo depende da
    // profundidade do DOM, e quando a subida ia longe demais ela alcançava um bloco que contém
    // a página inteira (chat E janela juntos) e passava a recusar o CHAT — parando a extensão.
    //
    // 1) o elemento está dentro de uma janela declarada como tal; ou
    // 2) o próprio elemento é a janela (traz dois rótulos exatos dela no seu conteúdo).
    //
    // Nada aqui consulta acharPainelComentarios: ele chama melhorListaDentro, que chamaria de
    // volta esta validação, e a recursão derrubava a leitura.
    try {
      if (el.closest && el.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return true;
    } catch {
      /* seletor não suportado */
    }
    // O elemento, ou um ancestral MUITO próximo (o grid fica 1–2 níveis dentro da janela).
    // Dois níveis não alcançam a raiz da página nem no DOM mais raso, então isto não corre o
    // risco de recusar o chat.
    const escrever = campoEscrever();
    for (let a = el, i = 0; a && i < 3; a = a.parentElement, i++) {
      if (escrever && a.contains && a.contains(escrever)) break; // é a página, não uma janela
      if (marcasDeJanelaDeProduto(a) >= 2) return true;
    }
    return false;
  }

  /** Serve como lista de mensagens? Precisa parecer lista, estar fora de qualquer janela de
   *  produtos e — quando o painel de comentários é localizado com segurança — dentro dele.
   *  O "📍 marcar chat" não passa por aqui: travar() aceita o que a dona marcou. */
  let motivoRecusa = ""; // aparece no painel, para saber POR QUE o chat não foi aceito
  function ehChatValido(el) {
    if (!el || !el.isConnected) return false;
    let ok = false;
    try {
      ok = pareceLista(el);
    } catch {
      ok = false;
    }
    if (!ok) {
      motivoRecusa = "não parece uma lista de mensagens";
      return false;
    }
    if (regiaoDeProduto(el)) {
      motivoRecusa = "está dentro da janela de produtos";
      return false;
    }
    // Dentro do painel de comentários — mas só quando o painel é CONFIÁVEL, isto é, foi achado
    // E tem alguma lista de mensagens dentro dele. Exigir um painel mal localizado recusava o
    // chat inteiro; não exigir nada deixava travar em qualquer lista da página.
    let painelConfiavel = null;
    try {
      // calculado UMA vez por rodada: é a parte cara (varre o painel inteiro)
      painelConfiavel = lembrar("painelConfiavel", () => {
        const p = acharPainelComentarios();
        return p && p.contains && melhorListaDentro(p) ? p : null;
      });
    } catch {
      painelConfiavel = null;
    }
    if (painelConfiavel && !painelConfiavel.contains(el)) {
      motivoRecusa = "fora do painel de comentários";
      return false;
    }
    motivoRecusa = "";
    return true;
  }

  function irmaosSemelhantes(el) {
    const pai = el && el.parentElement;
    if (!pai) return 0;
    const cls = el.classList && el.classList.length ? el.classList[0] : "";
    let n = 0;
    const filhos = pai.children;
    for (let i = 0; i < filhos.length && i < 500; i++) {
      const f = filhos[i];
      if (f === el || f.tagName !== el.tagName) continue;
      if (cls && !(f.classList && f.classList.contains(cls))) continue;
      n++;
    }
    return n;
  }

  /** Dado um elemento dentro de UMA mensagem, acha a LISTA (pai com mais filhos semelhantes). */
  function listaAPartirDe(alvo) {
    let melhorPai = null;
    let melhorN = 1;
    let el = alvo;
    for (let i = 0; i < 14 && el && el !== document.body && el !== document.documentElement; i++) {
      const n = irmaosSemelhantes(el);
      const pai = el.parentElement;
      if (pai && n > melhorN && pareceLista(pai)) {
        melhorN = n;
        melhorPai = pai;
      }
      el = pai;
    }
    return melhorPai;
  }

  function descreve(el) {
    if (!el || !el.tagName) return "?";
    const cls = el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + cls;
  }

  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 7) {
      let part = el.tagName.toLowerCase();
      if (el.id) {
        parts.unshift(`#${CSS.escape(el.id)}`);
        break;
      }
      const cls = Array.from(el.classList || []).filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
      const parent = el.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(" > ");
  }

  /** Texto do elemento com SEPARADOR entre nós filhos.
   *  `textContent` cola tudo: o nome do autor gruda no código ("fulana369FKL-HUB-MDF")
   *  e o código deixa de ser reconhecido. */
  function textoDe(el, prof = 0) {
    if (!el) return "";
    if (el.nodeType === Node.TEXT_NODE) return el.nodeValue || "";
    if (el.nodeType !== Node.ELEMENT_NODE) return "";
    const kids = el.childNodes;
    if (!kids || !kids.length || prof >= 6) return el.textContent || "";
    let out = "";
    for (let i = 0; i < kids.length && i < 60; i++) {
      const t = textoDe(kids[i], prof + 1).trim();
      if (t) out += (out ? " " : "") + t;
    }
    return out;
  }

  function marcarVisto(t) {
    vistos.add(t);
    ordemVistos.push(t);
    if (ordemVistos.length > MAX_VISTOS) vistos.delete(ordemVistos.shift());
  }

  // ---- LEITURA: o chat como lista ----

  /** Os itens (mensagens) da lista. Se um filho for um sub-contêiner grande, desce um nível. */
  function itensDaLista(root) {
    const out = [];
    const filhos = Array.from(root.children || []);
    for (const f of filhos) {
      if (f.id === PANEL_ID) continue;
      const t = f.textContent || "";
      if (t.length <= MAX_TEXTO) out.push(f);
      else if (f.childElementCount >= 2) {
        const netos = Array.from(f.children);
        for (const n of netos.slice(-MAX_ITENS)) {
          if ((n.textContent || "").length <= MAX_TEXTO) out.push(n);
        }
      }
    }
    return out.length > MAX_ITENS ? out.slice(-MAX_ITENS) : out;
  }

  /** Relê a lista inteira; processa itens novos ou cujo texto mudou. NUNCA descarta. */
  /** Processa UMA mensagem (texto já extraído). Devolve true se era inédita. */
  function processarTexto(t) {
    if (!t || t.length > MAX_TEXTO || vistos.has(t)) return false;
    marcarVisto(t);
    msgs++;
    let achadosNoTexto = [];
    try {
      achadosNoTexto = parseProductRefs(t).filter((r) => r.kind === "code").map((r) => r.code);
    } catch {
      achadosNoTexto = [];
    }
    ultimas.push({
      t: t.slice(0, 90),
      c: achadosNoTexto,
      h: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    });
    if (ultimas.length > MAX_ULTIMAS) ultimas.shift();
    ultimaLeitura = Date.now();

    let refs = [];
    try {
      refs = parseProductRefs(t)
        .filter((r) => r.kind !== "id") // números soltos nunca são código aqui
        .filter((r) => {
          const key = r.kind === "code" ? `code:${r.code}` : `url:${r.url}`;
          if (seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        });
    } catch {
      refs = [];
    }
    if (refs.length) {
      const chaves = refs.map((r) => (r.kind === "code" ? `code:${r.code}` : `url:${r.url}`));
      // a mensagem de onde o código saiu: revalidação futura e "veio de:" no popup
      for (const r of refs) r.origem = t.slice(0, 160);
      try {
        chrome.runtime.sendMessage({ type: "chat-refs", refs }, (resp) => {
          if (chrome.runtime.lastError || !resp) {
            // NÃO chegou ao service worker (dormindo, erro passageiro). Desfazemos as marcas
            // para a próxima leitura tentar de novo — antes o código sumia em silêncio.
            for (const k of chaves) seenKeys.delete(k);
            vistos.delete(t);
            naoEntregues++;
            status();
            return;
          }
          codes += resp.added || 0;
          status();
        });
      } catch {
        for (const k of chaves) seenKeys.delete(k);
        vistos.delete(t);
        naoEntregues++;
      }
    }
    return true;
  }

  /** Captura NO INSTANTE em que a mensagem entra na tela. É o que garante que um chat muito
   *  rápido — onde a Shopee remove as mensagens antigas do DOM conforme rola — não perca
   *  nenhum código: o texto é lido na inserção, não na varredura seguinte. */
  function processarNoInserido(node, prof = 0) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE || prof > 2) return;
    if (node.id === PANEL_ID) return;
    if (node.childElementCount > MAX_FILHOS) {
      const filhos = node.children;
      for (let i = Math.max(0, filhos.length - 40); i < filhos.length; i++) processarNoInserido(filhos[i], prof + 1);
      return;
    }
    let t = "";
    try {
      t = textoDe(node).replace(/\s+/g, " ").trim();
    } catch {
      return;
    }
    if (t.length > MAX_TEXTO && node.childElementCount) {
      for (const f of node.children) processarNoInserido(f, prof + 1);
      return;
    }
    if (processarTexto(t)) status();
  }

  /** Varredura periódica: pega mensagens cujo TEXTO mudou depois de inseridas (a Shopee às
   *  vezes renderiza em duas etapas). A captura na inserção cobre todo o resto. */
  let vezesDerivado = 0;
  function lerLista() {
    if (paused) return;
    // O contêiner pode ter DERIVADO para uma janela de produto depois de um re-render.
    // Exigimos DUAS leituras seguidas acusando, porque soltar o chat por engano é grave:
    // sem contêiner, as mensagens já na tela deixam de ser lidas.
    if (chatRoot && chatRoot.isConnected && regiaoDeProduto(chatRoot)) {
      if (++vezesDerivado >= 2) {
        vezesDerivado = 0;
        erro = "";
        chatRoot = null;
        seletorConhecido = "";
        assinaturaRaiz = "";
        status();
      }
    } else {
      vezesDerivado = 0;
    }
    const root = resolverLista();
    if (!root) return;
    lerDoContainer(root);
  }

  /** Lê todas as mensagens que estão AGORA neste contêiner. */
  function lerDoContainer(root) {
    if (!root) return;
    let novos = 0;
    let itens;
    try {
      itens = itensDaLista(root);
    } catch {
      return;
    }
    for (const el of itens) {
      let t = "";
      try {
        t = textoDe(el).replace(/\s+/g, " ").trim();
      } catch {
        continue;
      }
      if (processarTexto(t)) novos++;
    }
    if (novos) status();
  }

  /** Devolve a lista válida; se a referência morreu (re-render), tenta reachar.
   *  Ordem: seletor gravado → ASSINATURA (tag + classes) do contêiner anterior.
   *  A assinatura é o caminho confiável: abrir uma janela na página desloca as posições e
   *  quebra seletores com :nth-of-type, e era aí que a leitura ficava cega. */
  function resolverLista() {
    if (chatRoot && chatRoot.isConnected) return chatRoot;
    if (chatRoot && !chatRoot.isConnected) {
      chatRoot = null;
      status();
    }
    if (seletorConhecido) {
      let el = null;
      try {
        el = document.querySelector(seletorConhecido);
      } catch {
        el = null;
      }
      if (ehChatValido(el)) {
        travar(el, origem || "gravado", false);
        return el;
      }
    }
    if (assinaturaRaiz) {
      let cands = [];
      try {
        cands = Array.from(document.querySelectorAll(assinaturaRaiz));
      } catch {
        cands = [];
      }
      // entre os candidatos, o que mais parece a lista de mensagens (mais filhos curtos)
      let melhor = null;
      for (const el of cands) {
        if (!ehChatValido(el)) continue;
        if (!melhor || el.childElementCount > melhor.childElementCount) melhor = el;
      }
      if (melhor) {
        travar(melhor, origem || "descoberta", false);
        return melhor;
      }
    }
    return null; // a descoberta chamará travar() quando achar
  }

  let leituraAgendada = false;
  function agendarLeitura() {
    if (leituraAgendada) return;
    leituraAgendada = true;
    setTimeout(() => {
      leituraAgendada = false;
      lerLista();
    }, 150);
  }

  function travar(el, comoAchou, gravar = true) {
    chatRoot = el;
    origem = comoAchou;
    rodadasSemChat = 0;
    try {
      const cls = Array.from(el.classList || [])
        .filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c))
        .slice(0, 2);
      assinaturaRaiz = el.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : "");
    } catch {
      assinaturaRaiz = "";
    }
    try {
      seletorConhecido = cssPath(el);
      if (gravar) chrome.storage.local.set({ [STORE_KEY]: seletorConhecido });
    } catch {
      /* ignore */
    }
    // Caminho rápido: mutações dentro da lista disparam uma releitura imediata (a releitura
    // periódica continua sendo a garantia de que nada escapa).
    if (observer) observer.disconnect();
    observer = new MutationObserver((muts) => {
      if (paused) return;
      // 1) captura imediata do que acabou de entrar (mensagem pode sumir do DOM ao rolar)
      for (let i = 0; i < muts.length && i < 80; i++) {
        const added = muts[i].addedNodes;
        for (let j = 0; j < added.length && j < 30; j++) {
          try {
            processarNoInserido(added[j]);
          } catch {
            /* um nó problemático não pode derrubar a leitura */
          }
        }
      }
      // 2) varredura logo em seguida, para textos atualizados no lugar
      agendarLeitura();
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    vigiarPai(el);
    status();
    // Lê JÁ o que está na tela, direto deste contêiner. Antes isto passava por lerLista(), que
    // podia soltar o contêiner na mesma hora — e aí os códigos que já estavam no chat quando a
    // dona marcou nunca eram lidos; só apareciam os que chegassem depois.
    lerDoContainer(el);
  }

  /** Auto-adaptação: se mensagens novas chegam como IRMÃS do contêiner (travamos no wrapper de
   *  UMA mensagem), sobe um nível. Limitado para nunca chegar ao body. */
  function vigiarPai(alvo) {
    if (vigiaPai) vigiaPai.disconnect();
    vigiaPai = null;
    const pai = alvo && alvo.parentElement;
    if (!pai || pai === document.body || pai === document.documentElement || promocoes >= 3) return;
    let irmaosNovos = 0;
    vigiaPai = new MutationObserver((muts) => {
      if (paused || chatRoot !== alvo) return;
      for (let i = 0; i < muts.length && i < 60; i++) {
        if (muts[i].target !== pai) continue;
        const added = muts[i].addedNodes;
        for (let j = 0; j < added.length && j < 20; j++) {
          const n = added[j];
          if (!n || n.nodeType !== Node.ELEMENT_NODE || n === alvo) continue;
          const t = (n.textContent || "").trim();
          if (t && t.length <= MAX_TEXTO && n.tagName === alvo.tagName) irmaosNovos++;
        }
      }
      if (irmaosNovos >= 2 && pareceLista(pai)) {
        promocoes++;
        travar(pai, origem || "descoberta");
      }
    });
    vigiaPai.observe(pai, { childList: true });
  }

  // ---- caixas de "rascunho" que aparecem sozinhas e travam a tela ----
  // A Shopee às vezes empilha várias janelinhas perguntando sobre rascunho; enquanto estiverem
  // abertas, nada mais funciona (nem o chat, nem a sacola). Clicamos em "Não" — só nelas.
  const RE_RASCUNHO = /rascunho|draft/i;
  let dialogosFechados = 0;

  /** Filtro barato: sem a palavra "rascunho" na página, nem vale varrer os botões.
   *  (textContent não força cálculo de layout; innerText forçaria.) */
  function temCaixaDeRascunho() {
    try {
      return RE_RASCUNHO.test(document.body.textContent || "");
    } catch {
      return false;
    }
  }

  function botaoNaoDaCaixa() {
    const alvos = document.querySelectorAll("button,[role=button]");
    for (let i = 0; i < alvos.length && i < 1200; i++) {
      const el = alvos[i];
      if (!el.getBoundingClientRect) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (t !== "não" && t !== "nao" && t !== "no") continue;
      // sobe até achar a janelinha e confere que ela fala de rascunho
      for (let a = el, k = 0; a && k < 8; a = a.parentElement, k++) {
        const texto = (a.textContent || "").slice(0, 600);
        if (texto.length > 20 && RE_RASCUNHO.test(texto)) return el;
      }
    }
    return null;
  }

  async function fecharCaixasDeRascunho() {
    if (!temCaixaDeRascunho()) return;
    for (let i = 0; i < 10; i++) {
      const nao = botaoNaoDaCaixa();
      if (!nao) break;
      try {
        nao.click();
      } catch {
        /* ignore */
      }
      dialogosFechados++;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (dialogosFechados) {
      try {
        chrome.runtime.sendMessage({ type: "dialogos-fechados", n: dialogosFechados }, () => void chrome.runtime.lastError);
      } catch {
        /* ignore */
      }
      dialogosFechados = 0;
    }
  }
  setInterval(() => {
    if (paused || document.hidden) return;
    void fecharCaixasDeRascunho();
  }, 4000);

  // ---- calibração: a usuária clica numa mensagem do chat ----
  function iniciarCalibracao() {
    if (calibrando) return;
    calibrando = true;
    status();
    const onClick = (e) => {
      if (panel && panel.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      limpar();
      const lista = listaAPartirDe(e.target) || e.target.parentElement || e.target;
      // A marcação manual respeita as mesmas barreiras da descoberta: um clique por engano na
      // sacola ou numa janela de produto NÃO pode transformar aquilo em "chat".
      if (regiaoDeProduto(lista)) {
        erro = "isso é uma janela de produtos, não o chat — clique numa mensagem do chat";
        status();
        setTimeout(() => { erro = ""; status(); }, 6000);
        return;
      }
      travar(lista, "marcado");
    };
    const onKey = (e) => {
      if (e.key === "Escape") limpar();
    };
    const limpar = () => {
      calibrando = false;
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      status();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  // ---- 1) seletor gravado ----
  try {
    chrome.storage.local.get(STORE_KEY, (r) => {
      const sel = r && r[STORE_KEY];
      if (!sel) return;
      seletorConhecido = sel; // resolverLista() passa a tentar este seletor a cada releitura
      agendarLeitura();
    });
  } catch {
    /* ignore */
  }

  // ---- 2) descoberta automática (fica ligada; só age enquanto não há lista) ----
  const contagem = new Map();
  descobridor = new MutationObserver((muts) => {
    // Com a lista travada e lendo normalmente, não gastamos nada aqui. Mas se faz mais de
    // 1 min que nada é lido, voltamos a contar: pode ser que estejamos no contêiner errado
    // (a Shopee re-renderiza o painel) e é assim que a extensão se conserta sozinha.
    if (chatRoot && Date.now() - (ultimaLeitura || 0) < 60000) return;
    for (let i = 0; i < muts.length && i < 80; i++) {
      const m = muts[i];
      if (!m.addedNodes.length) continue;
      const p = m.target;
      if (!p || p.nodeType !== Node.ELEMENT_NODE || p.id === PANEL_ID) continue;
      contagem.set(p, (contagem.get(p) || 0) + m.addedNodes.length);
    }
  });
  descobridor.observe(document.documentElement, { childList: true, subtree: true });
  try {
    const todos = document.querySelectorAll("*");
    for (let i = 0; i < todos.length && i < 5000; i++) {
      if (todos[i].shadowRoot) descobridor.observe(todos[i].shadowRoot, { childList: true, subtree: true });
    }
  } catch {
    /* ignore */
  }

  function acharPainelComentarios() {
    return lembrar("painel", acharPainelComentariosAgora);
  }
  function acharPainelComentariosAgora() {
    const input = campoEscrever();
    let header = null;
    const cands = document.querySelectorAll("div,span,h1,h2,h3,p");
    for (let i = 0; i < cands.length && i < 4000; i++) {
      const e = cands[i];
      if (e.childElementCount === 0 && /^coment[áa]rios$/i.test((e.textContent || "").trim())) {
        header = e;
        break;
      }
    }
    if (input && header) {
      const anc = new Set();
      for (let a = input; a; a = a.parentElement) anc.add(a);
      for (let b = header; b; b = b.parentElement) if (anc.has(b)) return b;
    }
    if (input) {
      // Sem o título "Comentários": sobe do campo de escrever até um bloco que contenha
      // algo com cara de lista — é a coluna do chat.
      for (let a = input.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {
        if (melhorListaDentro(a)) return a;
      }
    }
    return header ? header.parentElement : null;
  }

  /** Dentro de uma região, o elemento que mais parece a lista de mensagens: o que tem mais
   *  filhos curtos. Empate → o mais interno (o de fora costuma ser a coluna inteira).
   *  É o que permite achar o chat ANTES da primeira mensagem nova — sem isso, a extensão
   *  dependia de ver duas inserções, e a primeira mensagem da live servia só de amostra. */
  function melhorListaDentro(raiz) {
    if (!raiz || !raiz.querySelectorAll) return null;
    const curtos = (el) => {
      const filhos = el.children;
      let n = 0;
      for (let i = Math.max(0, filhos.length - 30); i < filhos.length; i++) {
        const t = (filhos[i].textContent || "").trim();
        if (t && t.length <= 250) n++;
      }
      return n;
    };
    let melhor = null;
    let melhorN = 0;
    const els = raiz.querySelectorAll("div,ul,ol,section");
    for (let i = 0; i < els.length && i < 1500; i++) {
      const el = els[i];
      if (el.id === PANEL_ID || (el.closest && el.closest("#" + PANEL_ID))) continue;
      // checagem SEM painel: ehChatValido consulta o painel e voltaria para cá em recursão
      let serve = false;
      try {
        serve = pareceLista(el) && !regiaoDeProduto(el);
      } catch {
        serve = false;
      }
      if (!serve) continue;
      const n = curtos(el);
      const maisInterno = melhor && melhor.contains && melhor.contains(el);
      if (n > melhorN || (n === melhorN && maisInterno)) {
        melhor = el;
        melhorN = n;
      }
    }
    return melhorN >= 2 ? melhor : null;
  }

  setInterval(() => {
    const cego = chatRoot && chatRoot.isConnected && Date.now() - (ultimaLeitura || 0) > 90000;
    if (chatRoot && chatRoot.isConnected && !cego) return;
    if (cego) {
      // Alguém está recebendo mensagens e não somos nós: troca para o contêiner mais ativo.
      let melhorCego = null;
      for (const [el, n] of contagem) {
        if (!el.isConnected || el === chatRoot || n < 3) continue;
        // a mesma validação dos outros caminhos: só pareceLista deixava travar no grid de favoritos
        if (ehChatValido(el) && (!melhorCego || n > melhorCego.n)) melhorCego = { el, n };
      }
      if (melhorCego) {
        contagem.clear();
        travar(melhorCego.el, "reencontrado sozinho");
        return;
      }
      contagem.clear();
      return status();
    }
    rodadasSemChat++;
    // limpa candidatos mortos
    for (const [el] of contagem) if (!el.isConnected) contagem.delete(el);
    const painel = acharPainelComentarios();
    const ranking = [];
    for (const [el, n] of contagem) {
      if (el.id === PANEL_ID || (el.closest && el.closest("#" + PANEL_ID))) continue;
      const noPainel = !!(painel && painel.contains(el));
      // fora do painel exigimos 2 inserções (evita travar em banner/carrossel); dentro dele,
      // esperar a 2ª mensagem era o que atrasava o reconhecimento do 1º código da live
      if (n < (noPainel ? 1 : 2)) continue;
      if (!ehChatValido(el)) continue;
      ranking.push({ el, n, noPainel });
    }
    ranking.sort((a, b) => b.noPainel - a.noPainel || b.n - a.n);
    candidatosDiag = ranking.slice(0, 4).map((c) => `${descreve(c.el)}×${c.n}${c.noPainel ? "★" : ""}`);
    const melhor = ranking[0];
    if (melhor && (melhor.noPainel || rodadasSemChat >= 3)) return travar(melhor.el, "descoberta");
    // Ninguém escreveu nada ainda: dá para achar o chat pela ESTRUTURA do painel de
    // comentários, sem esperar mensagem nova. É isso que torna o "📍 marcar chat" dispensável.
    if (painel) {
      const porEstrutura = melhorListaDentro(painel);
      if (porEstrutura) return travar(porEstrutura, "painel de comentários");
    }
    status();
  }, DESCOBERTA_MS);

  // Rechecagem sob demanda: o service worker pede isto quando a sacola termina, porque
  // abrir/fechar a janela de produtos costuma re-renderizar o painel e derrubar a referência.
  // Pedido vindo da sacola: achar e clicar no "Recarregar" (fica sobre o vídeo da live).
  chrome.runtime.onMessage.addListener((msg, _s, resposta) => {
    if (!msg || msg.type !== "clicar-recarregar") return false;
    let clicou = false;
    try {
      const alvos = document.querySelectorAll("button,[role=button],div,span,a");
      const achados = [];
      for (let i = 0; i < alvos.length && i < 4000; i++) {
        const el = alvos[i];
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (!r || r.width <= 0 || r.height <= 0) continue;
        const t = ((el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "") + "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (t.length > 40) continue;
        if (!/^recarregar|^atualizar|^reload/.test(t)) continue;
        let prof = 0;
        for (let a = el; a; a = a.parentElement) prof++;
        achados.push({ el, prof });
      }
      achados.sort((a, b) => b.prof - a.prof); // o mais interno é o clicável
      if (achados[0]) {
        const el = achados[0].el;
        const alvo = el.closest("button,[role=button],a") || el;
        for (const tipo of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          try {
            alvo.dispatchEvent(new MouseEvent(tipo, { bubbles: true, cancelable: true, view: window }));
          } catch {
            /* ignore */
          }
        }
        try {
          alvo.click();
        } catch {
          /* ignore */
        }
        clicou = true;
      }
    } catch {
      clicou = false;
    }
    resposta({ clicou });
    return true;
  });

  chrome.runtime.onMessage.addListener((msg, _s, resposta) => {
    if (!msg || msg.type !== "chat-rescan") return false;
    try {
      if (chatRoot && !chatRoot.isConnected) chatRoot = null;
      resolverLista();
      lerLista();
    } catch {
      /* ignore */
    }
    resposta({ ok: true, achouChat: !!chatRoot });
    return true;
  });

  // ---- 4) chat preso: devolver ao fim ----
  //
  // Quando a lista é rolada para cima (para ler um comentário), a Shopee para de trazer as
  // mensagens novas para a tela. A leitura morre em silêncio: nenhum código novo aparece e
  // nada avisa. Depois de ROLAGEM_ESPERA_MS parado, voltamos o chat para o fim sozinhos.

  /** O elemento que realmente rola: o contêiner do chat ou o ancestral com barra de rolagem. */
  function rolavelDoChat() {
    const perto = (el) => el && el.scrollHeight > el.clientHeight + FUNDO_TOLERANCIA;
    for (let a = chatRoot, i = 0; a && i < 6 && a !== document.body; a = a.parentElement, i++) {
      if (regiaoDeProduto(a)) return null; // subiu demais e caiu numa janela de produto
      if (!perto(a)) continue;
      try {
        const cs = getComputedStyle(a);
        // o rolável em si também não pode ser (nem conter) uma janela de produto: a sacola
        // fica ao lado do chat e um ancestral comum contém as duas
        if (/(auto|scroll)/.test(cs.overflowY || "")) return regiaoDeProduto(a) || marcasDeJanelaDeProduto(a) >= 2 ? null : a;
      } catch {
        /* ignore */
      }
    }
    return perto(chatRoot) ? chatRoot : null;
  }

  const distanciaDoFim = (el) => el.scrollHeight - el.scrollTop - el.clientHeight;

  /** A Shopee às vezes mostra um aviso de "novas mensagens" quando o chat está preso.
   *  Clicar nele é mais educado que forçar o scrollTop, então tentamos primeiro. */
  function avisoNovasMensagens() {
    const alvos = document.querySelectorAll("div,span,button,a");
    for (let i = 0; i < alvos.length && i < 3000; i++) {
      const el = alvos[i];
      if (el.id === PANEL_ID || (el.closest && el.closest("#" + PANEL_ID))) continue;
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r || r.width <= 0 || r.height <= 0) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (t.length > 40) continue;
      if (/nova(s)? mensage(m|ns)|new message|mensagens novas|ver novas/.test(t)) return el;
    }
    return null;
  }

  function devolverAoFim(el) {
    const aviso = avisoNovasMensagens();
    if (aviso) {
      try {
        for (const tipo of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          aviso.dispatchEvent(new MouseEvent(tipo, { bubbles: true, cancelable: true, view: window }));
        }
        if (aviso.click) aviso.click();
      } catch {
        /* ignore */
      }
    }
    try {
      el.scrollTop = el.scrollHeight;
    } catch {
      /* ignore */
    }
  }

  // Onde o mouse está. Se está sobre o elemento que iríamos rolar, a dona está usando aquela
  // lista AGORA — e rolar debaixo do mouse dela é exatamente o que não pode acontecer.
  let mouseSobre = null;
  document.addEventListener("mousemove", (e) => { mouseSobre = e.target; }, { passive: true, capture: true });
  document.addEventListener("mouseleave", () => { mouseSobre = null; }, { passive: true, capture: true });
  const donaEstaUsando = (el) => !!(mouseSobre && el && el.contains && el.contains(mouseSobre));

  function vigiarRolagem() {
    if (paused || calibrando) return; // se a dona pediu pausa, não mexemos na tela dela
    // Só rolamos o CHAT. Se o contêiner travado for uma janela de produto (favoritos, sacola),
    // rolar ali arrastaria a lista que a dona está olhando — foi o que aconteceu.
    if (!chatRoot || !chatRoot.isConnected || regiaoDeProduto(chatRoot)) {
      presoDesde = 0;
      return;
    }
    const el = rolavelDoChat();
    if (!el) {
      presoDesde = 0;
      return;
    }
    if (donaEstaUsando(el)) {
      presoDesde = 0; // ela rolou de propósito e está lendo: zera a contagem, não devolve ao fim
      return;
    }
    let d;
    try {
      d = distanciaDoFim(el);
    } catch {
      return;
    }
    if (d <= FUNDO_TOLERANCIA) {
      presoDesde = 0;
      return;
    }
    if (!presoDesde) presoDesde = Date.now();
    // O aviso de "novas mensagens" quer dizer que a Shopee está SEGURANDO mensagens fora da
    // página. Nesse caso não existe espera segura: cada segundo é código que se perde.
    const espera = avisoNovasMensagens() ? 0 : ROLAGEM_ESPERA_MS;
    if (Date.now() - presoDesde < espera) {
      status();
      return;
    }
    presoDesde = 0;
    devolverAoFim(el);
    rolagens++;
    // O que a Shopee renderizar ao voltar ao fim precisa ser lido. Relemos algumas vezes
    // porque a lista costuma aparecer em etapas, e a última leitura é a garantia.
    for (const atraso of [300, 900, 2000]) {
      setTimeout(() => {
        try {
          lerLista();
        } catch {
          /* ignore */
        }
        status();
      }, atraso);
    }
    status();
  }
  setInterval(vigiarRolagem, ROLAGEM_MS);

  // ---- 3) releitura periódica: a garantia de que nada fica de fora ----
  setInterval(lerLista, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) agendarLeitura();
  });
})();
