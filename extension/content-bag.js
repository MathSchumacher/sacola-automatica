// Adiciona à SACOLA da live os produtos recém-favoritados (e somente eles).
//
// Fluxo replicado da tela: Produtos (barra lateral) → "Lista de produtos" →
// "+ Adicionar produtos relacionados" → aba "Meus Favoritos" → marcar SÓ os nossos → "Confirmar".
//
// Regras de segurança (a sacola é visível para os clientes):
//   - só marca cards cujo título casa com um produto do lote recém-favoritado;
//   - nunca desmarca nada nem mexe no que já está na sacola;
//   - respeita o limite (padrão 50): se não há espaço, NÃO tenta e devolve "cheia";
//   - modo "simular" percorre tudo e relata o que faria, sem marcar nem confirmar.
(() => {
  // Só a janela principal opera a sacola. Sem isto, um iframe (player, anúncio) responderia
  // primeiro ao pedido "não achei a tela" e o resultado real do frame principal seria descartado.
  if (window.top !== window) return;
  if (window.__achadinhosBag) return;
  window.__achadinhosBag = true;

  let rodando = false; // trava contra duas execuções simultâneas na mesma página
  let cancelado = false; // o worker desistiu desta rodada (prazo): parar de mexer na tela
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const reg = (msg) => {
    log.push(msg);
    if (log.length > 60) log.shift();
  };

  function visivel(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  const txt = (el) => ((el && (el.getAttribute?.("title") || el.getAttribute?.("aria-label") || el.textContent)) || "").replace(/\s+/g, " ").trim();

  /** Normaliza para comparar títulos: sem acento, minúsculo, sem pontuação/reticências. */
  function norm(s) {
    return (s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[.…]+$/g, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const MIN_PREFIXO = 14; // prefixo menor que isso é ambíguo por natureza

  // Palavras que aparecem em quase todo título e não distinguem produto nenhum.
  const PALAVRAS_VAZIAS = new Set([
    "de", "da", "do", "das", "dos", "e", "com", "para", "em", "a", "o", "as", "os", "um", "uma",
    "kit", "promocao", "oferta", "novo", "nova", "original", "top", "frete", "gratis", "envio",
    "imediato", "pronta", "entrega", "unidade", "unidades", "peca", "pecas", "cor", "tamanho", "modelo", "tipo",
  ]);
  /** Palavras "de conteúdo" de um título: sem as vazias, sem tokens curtos. Mantém a ordem. */
  function palavrasDeConteudo(texto) {
    const out = [];
    for (const p of norm(texto).split(" ")) {
      if (p.length < 3 || PALAVRAS_VAZIAS.has(p)) continue;
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  /** Pontua o casamento entre o título do card e o nome guardado ao favoritar.
   *
   *  A comparação é por PALAVRAS, não por prefixo. O nome vem do <h1> da página do produto e
   *  o título vem do grid de favoritos; a Shopee os monta de jeitos diferentes ("Promoção" na
   *  frente, emoji, caixa, um espaço a mais, truncamento "..."). Um único caractere de
   *  diferença no início derrubava o prefixo, o produto "não estava no topo" e caía na busca
   *  por nome — que reusava o mesmo nome e filtrava para o vazio. Era a cadeia inteira do bug.
   *
   *  Regra: as palavras de conteúdo do lado MAIS CURTO (o card costuma vir truncado) precisam
   *  aparecer no outro lado — todas, ou todas menos uma quando há 4 ou mais. A última palavra
   *  de um card truncado ("plást") casa como prefixo de uma palavra do nome ("plastica"). */
  function pontuaTitulo(cardTitulo, nomeProduto, nomeAlternativo) {
    // nomeAlternativo: o título que a própria aba mostrou (document.title, em pt-BR) quando o
    // <h1> veio traduzido — a Shopee em "English" traduz o h1 mas não o card de Meus Favoritos.
    if (nomeAlternativo && nomeAlternativo !== nomeProduto) {
      const alt = pontuaTitulo(cardTitulo, nomeAlternativo);
      if (alt) return alt;
    }
    const a = norm(cardTitulo);
    const b = norm(nomeProduto);
    if (!a || !b) return null;
    if (a === b) return { p: 1000, exato: true };
    // o prefixo ainda vale: é o casamento mais forte quando bate
    const min = Math.min(a.length, b.length);
    if (min >= MIN_PREFIXO && (a.startsWith(b.slice(0, min)) || b.startsWith(a.slice(0, min)))) return { p: min, exato: false };

    const pa = palavrasDeConteudo(cardTitulo);
    const pb = palavrasDeConteudo(nomeProduto);
    if (pa.length < 2 || pb.length < 2) return null;
    const [curto, longo] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
    const truncadoNoFim = /(\.\.\.|…)\s*$/.test(String(cardTitulo || ""));
    let acertos = 0;
    curto.forEach((w, i) => {
      const ultima = i === curto.length - 1;
      const bate = longo.includes(w) || (truncadoNoFim && ultima && w.length >= 3 && longo.some((x) => x.startsWith(w)));
      if (bate) acertos++;
    });
    const faltas = curto.length - acertos;
    const tolerancia = curto.length >= 4 ? 1 : 0;
    if (faltas > tolerancia) return null;
    return { p: 10 + acertos, exato: false };
  }

  /** Todos os preços do texto, em número. */
  function precosDoTexto(texto) {
    return [...String(texto || "").matchAll(/r\$\s*([\d.]{1,9},\d{2})/gi)]
      .map((m) => Number(m[1].replace(/\./g, "").replace(",", ".")))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  /** Preço mostrado no card ("R$17,12 R$14,56" → pega o menor, que é o com desconto). */
  function precoDoCard(texto) {
    const validos = precosDoTexto(texto);
    return validos.length ? Math.min(...validos) : null;
  }

  /** Faixa de preços do card. O card pode trazer variações ("R$14,90 - R$24,90") e o preço
   *  cheio riscado ao lado do promocional: comparar só com o menor descartava o produto certo. */
  function faixaDoCard(texto) {
    const validos = precosDoTexto(texto);
    if (!validos.length) return { precoMin: null, precoMax: null };
    return { precoMin: Math.min(...validos), precoMax: Math.max(...validos) };
  }

  /** O preço da página do produto precisa caber na faixa do card. Sem preço de um dos lados,
   *  não bloqueia (o título continua mandando). */
  function precoCasa(card, item) {
    if (item.preco == null) return true;
    const min = card.precoMin != null ? card.precoMin : card.preco;
    const max = card.precoMax != null ? card.precoMax : card.preco;
    if (min == null || max == null) return true;
    const iMin = item.preco;
    const iMax = item.precoMax != null ? item.precoMax : item.preco;
    return iMax >= min - 0.011 && iMin <= max + 0.011; // as duas faixas se tocam
  }

  /** Casamento 1:1 entre o lote e os cards, SEM adivinhar:
   *  - preço confirma/descarta quando os dois lados têm;
   *  - se um item casa com vários cards (ou um card serve a vários itens), marca AMBÍGUO e ignora.
   *  A sacola é visível para os clientes: preferimos deixar de fora a arriscar o produto errado. */
  function casarLoteComCards(lote, cards) {
    const pares = [];
    for (const item of lote) {
      let cands = [];
      for (const card of cards) {
        const s = pontuaTitulo(card.titulo, item.nome, item.nomeAba);
        if (!s) continue;
        cands.push({ card, ...s, precoOk: precoCasa(card, item) });
      }
      if (!cands.length) {
        pares.push({ item, status: "naoAchado" });
        continue;
      }
      // O preço só DESEMPATA. Com um único card de título compatível, ele é o produto (acabou
      // de ser favoritado e está no topo). Vetar pelo preço só perdia o produto quando a leitura
      // do preço na página vinha errada (frete, parcela, variação) — e o produto ia para
      // "Importar via URL" mesmo estando ali na tela.
      if (cands.length > 1 && cands.some((c) => c.precoOk)) cands = cands.filter((c) => c.precoOk);
      cands.sort((x, y) => y.p - x.p);
      const exatos = cands.filter((c) => c.exato);
      const melhores = exatos.length ? exatos : cands.filter((c) => c.p === cands[0].p);
      if (melhores.length > 1) {
        pares.push({ item, status: "ambiguo", quantos: melhores.length });
        continue;
      }
      pares.push({ item, card: melhores[0].card, status: "ok", precoDivergente: !melhores[0].precoOk });
    }
    const usos = new Map();
    for (const p of pares) if (p.status === "ok") usos.set(p.card, (usos.get(p.card) || 0) + 1);
    for (const p of pares) {
      if (p.status === "ok" && usos.get(p.card) > 1) {
        p.status = "ambiguo";
        p.quantos = usos.get(p.card);
        delete p.card;
      }
    }
    return pares;
  }

  /** Acha um elemento pelo texto. Prefere o MAIS PROFUNDO e clicável: varrendo em ordem de
   *  documento, um wrapper vem antes do botão, e clicar no wrapper é um no-op silencioso.
   *  `exato` evita casar "Confirmar cancelamento" quando queremos "Confirmar". */
  function acharPorTexto(padroes, seletor = "button,div,span,a,li", exato = false) {
    const alvos = document.querySelectorAll(seletor);
    const achados = [];
    for (let i = 0; i < alvos.length && i < 6000; i++) {
      const el = alvos[i];
      if (!visivel(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const t = norm(txt(el));
      if (!t || t.length > 60) continue;
      for (const p of padroes) {
        if (t === p || (!exato && t.startsWith(p))) {
          achados.push({ el, prof: profundidade(el), botao: /^(BUTTON|A)$/.test(el.tagName) || el.getAttribute("role") === "button" });
          break;
        }
      }
    }
    if (!achados.length) return null;
    achados.sort((a, b) => b.botao - a.botao || b.prof - a.prof);
    return achados[0].el;
  }

  function profundidade(el) {
    let n = 0;
    for (let p = el; p; p = p.parentElement) n++;
    return n;
  }

  /** (x, y) opcionais: o ponto da tela onde a pessoa clicaria; sem eles, o centro do elemento. */
  function realClick(el, x, y) {
    const r = el.getBoundingClientRect();
    const cx = x != null ? x : Math.round(r.left + r.width / 2);
    const cy = y != null ? y : Math.round(r.top + r.height / 2);
    const o = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, view: window };
    try {
      el.dispatchEvent(new PointerEvent("pointerover", o));
      el.dispatchEvent(new MouseEvent("mouseover", o));
      el.dispatchEvent(new PointerEvent("pointerdown", { ...o, button: 0, isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...o, button: 0 }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...o, button: 0, isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...o, button: 0 }));
    } catch {
      /* ignore */
    }
    el.click();
  }

  function hover(el, tipos = ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2), view: window };
    for (const t of tipos) {
      try {
        el.dispatchEvent(t.startsWith("pointer") ? new PointerEvent(t, o) : new MouseEvent(t, o));
      } catch {
        /* ignore */
      }
    }
  }
  /** Tira o mouse de cima: sem isto o card fica "com hover" e muda de aparência sozinho depois. */
  const sairDoHover = (el) => hover(el, ["pointerout", "mouseout", "pointerleave", "mouseleave"]);

  async function esperar(cond, ms, passo = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (cond()) return true;
      } catch {
        /* ignore */
      }
      await sleep(passo);
    }
    return false;
  }

  // ---- leitura de estado da tela ----

  /** Quantos produtos há na sacola — SOMENTE pelo título "Produtos(21)", que é inequívoco.
   *  O selo da barra lateral não serve para decidir: ali convivem outros números
   *  ("1 Mostrando"), e ler o errado faria a extensão achar que há vagas de sobra. */
  function contarSacola() {
    const alvos = document.querySelectorAll("div,span,h1,h2,h3,p");
    for (let i = 0; i < alvos.length && i < 6000; i++) {
      const el = alvos[i];
      if (!visivel(el) || el.childElementCount > 2) continue;
      const m = /^produtos\s*\(\s*(\d+)\s*\)/i.exec(txt(el));
      if (m) return Number(m[1]);
    }
    return null;
  }

  const modalProdutosAberto = () => !!acharPorTexto(["adicionar produtos relacionados", "adicionar produtos relacionado"]);
  const abaFavoritos = () => acharPorTexto(["meus favoritos"], "div,span,li,button,a", true);
  /** A janela de favoritos só conta como aberta se houver a aba E o campo de busca de produtos
   *  (senão um item de menu com o mesmo texto faria a extensão operar no grid errado). */
  const modalFavoritosAberto = () => !!abaFavoritos() && !!document.querySelector('input[placeholder*="rodut" i], input[placeholder*="usca" i]');

  /** Confirma que a aba "Meus Favoritos" está SELECIONADA. Operar no grid de "Minha Loja"/
   *  "Recente" casaria títulos parecidos e adicionaria produto errado.
   *  Nem toda UI usa aria/classe: o último recurso compara a APARÊNCIA com as abas vizinhas
   *  (a selecionada tem cor/fundo diferente — no print, texto laranja com fundo claro). */
  function favoritosSelecionada() {
    const aba = abaFavoritos();
    if (!aba) return false;
    for (let el = aba, i = 0; el && i < 3; el = el.parentElement, i++) {
      if (el.getAttribute?.("aria-selected") === "true") return true;
      if (el.getAttribute?.("aria-current") === "true" || el.getAttribute?.("data-active") === "true") return true;
      const cls = String(el.className || "");
      if (/(active|selected|ativo|selecionad|current|checked|highlight)/i.test(cls)) return true;
    }
    return destaqueDiferenteDasIrmas(aba);
  }

  /** A aba selecionada se destaca visualmente das outras opções do menu lateral. */
  function destaqueDiferenteDasIrmas(aba) {
    try {
      const rotulos = ["minha loja", "recente", "importar via url", "adicionar conjunto de prod"];
      const irmas = [];
      for (const r of rotulos) {
        const el = acharPorTexto([r], "div,span,li,button,a");
        if (el) irmas.push(el);
      }
      if (irmas.length < 2) return false;
      const estilo = (el) => {
        const cs = getComputedStyle(el);
        return `${cs.color}|${cs.backgroundColor}|${cs.fontWeight}`;
      };
      const meu = estilo(aba);
      return irmas.every((el) => estilo(el) !== meu);
    } catch {
      return false;
    }
  }

  /** O elemento que envolve a janela "Adicionar Produtos" — tudo é procurado DENTRO dele. */
  function containerModalFavoritos() {
    const aba = abaFavoritos();
    if (!aba) return null;
    let melhor = aba;
    for (let el = aba, i = 0; el && i < 8; el = el.parentElement, i++) {
      if (el.querySelector && el.querySelector('input[type="checkbox"], [role="checkbox"]')) {
        melhor = el;
        break;
      }
      melhor = el;
    }
    return melhor;
  }

  /** Título do card: prefere o nó específico (atributo title) a pegar o texto inteiro do
   *  container, que traz preço, "Frete Grátis", "Ad" etc. e estragaria o casamento. */
  function tituloDoCard(container) {
    const comTitle = container.querySelector?.("[title]");
    const t1 = comTitle && txt(comTitle);
    if (t1 && t1.length >= 8 && !/^r\$/i.test(t1)) return t1;
    let melhor = "";
    const filhos = container.querySelectorAll ? container.querySelectorAll("div,span,p,a") : [];
    for (let i = 0; i < filhos.length && i < 60; i++) {
      const f = filhos[i];
      if (f.childElementCount > 0) continue;
      const t = (f.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || /^r\$/i.test(t) || /frete|comiss|mais vendido|^ad$|^anúncio$/i.test(t)) continue;
      if (t.length > melhor.length) melhor = t;
    }
    return melhor || txt(container);
  }

  /** Cards do grid de favoritos. O checkbox pode ser invisível (UI custom): basta o card ser visível. */
  function cardsFavoritos() {
    const raiz = containerModalFavoritos() || document;
    const inputs = Array.from(raiz.querySelectorAll('input[type="checkbox"], [role="checkbox"], [aria-checked]'));
    const cards = [];
    const vistos = new Set();
    for (const inp of inputs) {
      let el = inp;
      for (let i = 0; i < 6 && el; i++) {
        el = el.parentElement;
        if (!el || vistos.has(el)) break;
        // Um card tem UM checkbox. Um ancestral com mais de um é a grade (ou o corpo da janela):
        // subindo a partir de um checkbox fora dos cards ("Selecionar todos"), a busca parava
        // nele e o primeiro título lá dentro — o do produto MAIS RECENTE — virava um card
        // fantasma com o checkbox errado. Era o "ignora sempre o do topo": o clique ia num
        // checkbox inerte e o produto acabava no Importar via URL.
        if (el.querySelectorAll(SEL_CHECKBOX).length > 1) break;
        if (!visivel(el)) continue;
        const titulo = tituloDoCard(el);
        if (titulo && titulo.length >= 12 && titulo.length <= 200) {
          if (/^selecionar/i.test(norm(titulo))) break; // "selecionar todos os produtos" não é card
          vistos.add(el);
          cards.push({ input: inp, container: el, titulo, preco: precoDoCard(el.textContent || ""), ...faixaDoCard(el.textContent || "") });
          break;
        }
      }
    }
    if (cards.length) return cards;
    // Sem checkbox reconhecível (marcador desenhado com div/svg): monta os cards a partir do
    // preço — todo card de produto tem um — e usa o próprio card como alvo do clique.
    return cardsPorPreco(raiz);
  }

  function cardsPorPreco(raiz) {
    const candidatos = [];
    const alvos = raiz.querySelectorAll ? raiz.querySelectorAll("div,li,a") : [];
    for (let i = 0; i < alvos.length && i < 3000; i++) {
      const el = alvos[i];
      if (!visivel(el)) continue;
      const texto = el.textContent || "";
      if (!/r\$\s*[\d.]{1,9},\d{2}/i.test(texto)) continue;
      if (texto.length > 400 || el.childElementCount > 8) continue;
      const titulo = tituloDoCard(el);
      if (!titulo || titulo.length < 12 || titulo.length > 200) continue;
      if (/^selecionar/i.test(norm(titulo))) continue;
      candidatos.push({ el, titulo, texto });
    }
    // A "Lista de produtos" (janela de trás) também mostra título+preço por linha: fora,
    // a menos que a janela de favoritos esteja aninhada nela.
    const lista = containerListaProdutos();
    const aba = abaFavoritos();
    const listaSeparada = lista && aba && lista.contains && !lista.contains(aba) ? lista : null;
    for (let i = candidatos.length - 1; i >= 0; i--) {
      if (listaSeparada && listaSeparada.contains(candidatos[i].el)) candidatos.splice(i, 1);
    }
    // Quem engloba DOIS ou mais candidatos é a grade (ou uma fileira), não um produto.
    // Contar preços não serve: um card sozinho já mostra faixa de variações + preço riscado.
    const ehGrade = (c) => candidatos.filter((o) => o !== c && c.el.contains && c.el.contains(o.el)).length >= 2;
    const cards = [];
    for (const c of candidatos) {
      if (ehGrade(c)) continue;
      // em ordem de documento o card vem antes dos seus filhos: fica o de fora, que é o clicável
      if (cards.some((j) => j.container.contains && j.container.contains(c.el))) continue;
      cards.push({ input: null, container: c.el, titulo: c.titulo, preco: precoDoCard(c.texto), ...faixaDoCard(c.texto), semCheckbox: true });
    }
    // Uma vez por rodada: esta função roda em laço (grid estável, conferência da marcação) e
    // repetir a linha empurrava para fora do log de 60 linhas justo o que explica a falha.
    if (cards.length && !avisouSemCheckbox) {
      avisouSemCheckbox = true;
      reg(`sem checkbox reconhecível: usando ${cards.length} card(s) identificados pelo preço`);
    }
    return cards;
  }
  let avisouSemCheckbox = false;

  // ---- marcar um card de "Meus Favoritos" ----
  //
  // O que deu errado aqui — e por que cada peça abaixo existe. Falhas da 1.9.1 medidas num
  // Chromium de verdade, com a extensão carregada (tests/sacola-navegador.cjs):
  //  - marcador DESENHADO, sem <input>: procurava "check" nas classes e achava a palavra
  //    "checkbox" num card DESMARCADO → "já estava na sacola", nenhum clique, e o item ainda
  //    saía do lote como se tivesse entrado;
  //  - grade que se redesenha ao selecionar: do 2º produto em diante o clique ia para um nó que
  //    já tinha saído da página — o input solto alternava e parecia "marcado";
  //  - seleção que passa pelo servidor: a cascata esperava 0,7 s e clicava o alvo seguinte, que
  //    DESMARCAVA o que o primeiro tinha marcado (cada produto alternado duas vezes);
  //  - marcador dentro de um web component (shadow DOM): só o card inteiro era clicado e nada
  //    acontecia ("marcação incerta", sacola +0 — o sintoma da 1.9.0, que persistiu na 1.9.1).
  // Agora: o clique vai no label do checkbox ou no PONTO onde a dona clicaria (o elemento que
  // está de fato sobre o quadradinho), o card é relido da página a cada conferência, e outro
  // alvo só é tentado quando o anterior comprovadamente não mudou NADA — clicar de novo depois
  // de pegar desmarca.

  const SEL_CHECKBOX = 'input[type="checkbox"], [role="checkbox"], [aria-checked]';
  const classeDe = (el) => (el && el.getAttribute ? el.getAttribute("class") || "" : "");

  /** querySelectorAll que também entra em shadow roots abertos (web components). */
  function acharProfundo(raiz, seletor, limite = 200) {
    const out = [];
    const pilha = [raiz];
    let vistos = 0;
    while (pilha.length && out.length < limite && vistos < 4000) {
      const r = pilha.pop();
      if (!r || !r.querySelectorAll) continue;
      for (const el of r.querySelectorAll(seletor)) {
        if (out.length >= limite) break;
        out.push(el);
      }
      for (const el of r.querySelectorAll("*")) {
        if (++vistos > 4000) break;
        if (el.shadowRoot) pilha.push(el.shadowRoot);
      }
    }
    return out;
  }

  /** Pai "de verdade", atravessando a fronteira do shadow DOM (de dentro para o host). */
  function paiComposto(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    const raiz = el.getRootNode ? el.getRootNode() : null;
    return raiz && raiz.host ? raiz.host : null;
  }
  function contemComposto(anc, el) {
    for (let p = el, i = 0; p && i < 80; p = paiComposto(p), i++) if (p === anc) return true;
    return false;
  }

  /** O elemento que está de fato no ponto (x, y) — é ele que recebe o clique de uma pessoa.
   *  Desce por shadow roots abertos. */
  function elementoNoPonto(x, y) {
    try {
      let el = document.elementFromPoint(x, y);
      for (let i = 0; el && el.shadowRoot && i < 6; i++) {
        const dentro = el.shadowRoot.elementFromPoint(x, y);
        if (!dentro || dentro === el) break;
        el = dentro;
      }
      return el;
    } catch {
      return null;
    }
  }

  /** O estado vem num PEDAÇO inteiro da classe, separado por - ou _: "ant-checkbox-checked",
   *  "shp-checkbox--checked", "fav-card--selected", "is-checked", "isChecked", "chk--on".
   *  Nunca "checkbox" nem "unchecked" — foi essa confusão que deu "já estava na sacola". */
  function classeIndicaMarcado(el) {
    return classeDe(el)
      .split(/\s+/)
      .some((t) => t && (/(^|[-_])(is-?)?(checked|selected)($|[-_])/i.test(t) || /[-_]on$/i.test(t)));
  }
  const classeIndicaDesabilitado = (el) => classeDe(el).split(/\s+/).some((t) => /(^|[-_])(is-?)?disabled($|[-_])/i.test(t));

  /** O checkbox do card — no DOM normal ou dentro de um web component. Sempre da página ATUAL:
   *  referência a um nó que saiu da página não serve para nada. */
  function inputDoCard(card) {
    const i = card.input;
    if (i && i.isConnected !== false && contemComposto(card.container, i)) return i;
    return acharProfundo(card.container, SEL_CHECKBOX, 1)[0] || null;
  }

  function tamanhoDeMarcador(el) {
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8 && r.width <= 44 && r.height <= 44;
  }

  /** O label que controla ESTE input. Um label que engloba vários cards controla só o primeiro
   *  input dele — clicá-lo marcaria outro produto. */
  function labelDo(inp) {
    const deste = (l) => (l && (l.control === undefined || l.control === inp) ? l : null);
    const l = inp.closest ? inp.closest("label") : null;
    if (l) return deste(l);
    try {
      if (inp.id) return deste((inp.getRootNode ? inp.getRootNode() : document).querySelector(`label[for="${CSS.escape(inp.id)}"]`));
    } catch {
      /* ignore */
    }
    return null;
  }

  /** Marcador desenhado (sem <input>): pequeno, quase quadrado, perto de um canto de cima do
   *  card. Nome de classe ajuda mas não é exigido — a Shopee pode usar classes embaralhadas. */
  function marcadorDesenhado(container) {
    if (!container || !container.getBoundingClientRect) return null;
    const rc = container.getBoundingClientRect();
    let melhor = null;
    let melhorNota = 0;
    for (const el of acharProfundo(container, "*", 400)) {
      if (!visivel(el) || !tamanhoDeMarcador(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) continue;
      if (Math.abs(r.width - r.height) > Math.max(4, 0.25 * Math.max(r.width, r.height))) continue;
      if (/^(img|picture|video|canvas|path|g|use|circle|rect|line|polyline)$/i.test(el.tagName)) continue;
      if ((el.textContent || "").trim().length > 2) continue;
      const rotulo = `${classeDe(el)} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
      if (/heart|like|favorit|curtir|cora[cç]|play|video/i.test(rotulo)) continue; // coração, vídeo
      const temPapel = el.getAttribute("role") === "checkbox" || el.hasAttribute("aria-checked");
      const temNome = /check|select|tick|mark/i.test(rotulo);
      let temBorda = false;
      let apontavel = false;
      try {
        const cs = getComputedStyle(el);
        temBorda = parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderLeftWidth) > 0 && parseFloat(cs.borderBottomWidth) > 0;
        apontavel = cs.cursor === "pointer";
      } catch {
        /* ignore */
      }
      // Precisa de ALGO de checkbox. Só "ícone pequeno no canto" pode ser o botão de
      // pré-visualização ou um selo — clicar nisso abriria outra coisa por cima da janela.
      if (!temPapel && !temNome && !temBorda) continue;
      let nota = (temPapel ? 6 : 0) + (temNome ? 3 : 0) + (temBorda ? 2 : 0) + (apontavel ? 1 : 0);
      const noTopo = r.top - rc.top < rc.height * 0.4;
      const noCanto = r.left - rc.left < rc.width * 0.4 || rc.right - r.right < rc.width * 0.4;
      if (noTopo && noCanto) nota += 2;
      if (nota > melhorNota) {
        melhorNota = nota;
        melhor = el;
      }
    }
    return melhorNota >= 3 ? melhor : null;
  }

  /** O quadradinho que a dona vê e clica. Com <input>: o próprio input quando ele cobre o
   *  quadrado (Ant Design), senão o irmão/pai desenhado ou o label. Sem <input>: o desenhado. */
  function quadradoDoCard(card) {
    const inp = inputDoCard(card);
    if (inp) {
      for (const el of [inp, inp.nextElementSibling, inp.previousElementSibling, inp.parentElement]) {
        if (el && visivel(el) && tamanhoDeMarcador(el)) return el;
      }
      const label = labelDo(inp);
      if (label && visivel(label)) return label;
    }
    return marcadorDesenhado(card.container);
  }

  /** true = marcado, false = desmarcado, null = não dá para ler (marcador desenhado sem
   *  classe de estado). Nunca ADIVINHA "marcado". */
  function estadoDoCard(card) {
    const inp = inputDoCard(card);
    if (inp) {
      if (inp.tagName === "INPUT" ? inp.checked === true : inp.getAttribute("aria-checked") === "true") return true;
    }
    const q = quadradoDoCard(card);
    for (let el = q || card.container, i = 0; el && i < 8; el = paiComposto(el), i++) {
      if (el.getAttribute?.("aria-checked") === "true" || el.getAttribute?.("aria-selected") === "true" || classeIndicaMarcado(el)) return true;
      if (el === card.container) break;
    }
    return inp ? false : null;
  }

  /** Marcador desenhado PREENCHIDO de cor forte (o laranja da Shopee) — não branco, cinza,
   *  transparente nem um tom claro. Só vale quando o estado não é legível (estadoDoCard null). */
  function quadradinhoCheio(card) {
    const q = quadradoDoCard(card);
    if (!q) return false;
    const cheio = (el) => {
      try {
        const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(getComputedStyle(el).backgroundColor || "");
        if (!m) return false;
        const [r, g, b, a] = [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
        const luz = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return a >= 0.5 && (Math.max(r, g, b) - Math.min(r, g, b)) / 255 >= 0.45 && luz <= 0.8;
      } catch {
        return false;
      }
    };
    return cheio(q) || [...(q.children || [])].some(cheio);
  }

  /** Desabilitado ≠ "já está na sacola": costuma ser produto indisponível/inelegível.
   *  Tratar como "já está" faria o item sumir do lote sem nunca ter entrado. */
  function cardDesabilitado(card) {
    const inp = inputDoCard(card);
    if (inp && (inp.disabled === true || inp.getAttribute("aria-disabled") === "true")) return true;
    const q = quadradoDoCard(card);
    for (let el = q, i = 0; el && el !== card.container && i < 6; el = paiComposto(el), i++) {
      if (el.getAttribute?.("aria-disabled") === "true" || classeIndicaDesabilitado(el)) return true;
    }
    return false;
  }

  /** O nó ainda mostra ESTE produto? Uma grade com chave por posição reaproveita o mesmo nó
   *  para outro produto quando um favorito novo entra no topo (a dona favoritando na mão). */
  function aindaEhOMesmo(card) {
    const titulo = norm(card.titulo);
    if (!titulo) return true;
    const c = card.container;
    if (norm(c.textContent || "").includes(titulo)) return true;
    for (const el of c.querySelectorAll ? c.querySelectorAll("[title]") : []) if (norm(el.getAttribute("title")).includes(titulo)) return true;
    return false;
  }

  /** O mesmo card, lido da página AGORA. A grade pode se redesenhar a cada seleção (nós novos);
   *  a referência antiga fica solta e clicar nela não faz nada na tela. Reacha pelo título —
   *  e só se ele for único, para nunca trocar de produto. */
  function cardVivo(card) {
    // Janela de favoritos fechada (a dona confirmou na mão, por exemplo): não há card nenhum.
    // Sem isto, a busca pelo título caía nas linhas da "Lista de produtos" atrás da janela.
    if (!modalFavoritosAberto()) return null;
    if (card.container && card.container.isConnected !== false && visivel(card.container) && aindaEhOMesmo(card)) return card;
    const alvo = norm(card.titulo);
    const iguais = cardsFavoritos().filter((c) => norm(c.titulo) === alvo);
    return iguais.length === 1 ? iguais[0] : null;
  }

  function descrever(el) {
    if (!el || !el.tagName) return "?";
    const cls = classeDe(el).trim().split(/\s+/)[0] || "";
    let extra = "";
    if (el.tagName === "INPUT") extra = `[${el.type || "?"}${el.checked ? ",marcado" : ""}${el.disabled ? ",desabilitado" : ""}]`;
    else if (el.getAttribute?.("role")) extra = `[role=${el.getAttribute("role")}]`;
    if (el.getAttribute?.("aria-checked") != null) extra += `[aria-checked=${el.getAttribute("aria-checked")}]`;
    let tam = "";
    try {
      const r = el.getBoundingClientRect();
      tam = ` ${Math.round(r.width)}×${Math.round(r.height)}`;
    } catch {
      /* ignore */
    }
    return `${el.tagName.toLowerCase()}${cls ? "." + cls.slice(0, 32) : ""}${extra}${tam}`;
  }

  /** Estrutura do card em uma linha (vai para o log). Quando a marcação falha na tela real,
   *  é isto que diz como a Shopee desenhou o checkbox — sem isto, "não marcou" não diz nada. */
  function resumoDoCard(card) {
    // Primeiro o caminho até o checkbox (o que importa), depois o resto do card.
    const alvo = inputDoCard(card) || quadradoDoCard(card);
    const caminho = [];
    for (let el = alvo, i = 0; el && i < 10; el = paiComposto(el), i++) {
      caminho.unshift(descrever(el));
      if (el === card.container) break;
    }
    const partes = [];
    const visitar = (el, prof) => {
      if (!el || partes.length >= 30 || prof > 6) return;
      partes.push(`${prof}:${descrever(el)}`);
      if (/^(svg|img|picture|video)$/i.test(el.tagName)) return;
      const filhos = [...(el.shadowRoot ? el.shadowRoot.children : []), ...(el.children || [])];
      for (const f of filhos) visitar(f, prof + 1);
    };
    visitar(card.container, 0);
    return `checkbox: ${caminho.length ? caminho.join(" > ") : "(nenhum encontrado)"} || card: ${partes.join(" ")}`.slice(0, 1200);
  }

  /** Aparência do quadradinho e do card: classes, atributos e cores — inclusive ::before/::after,
   *  onde o Ant Design desenha o "✓". Só a região do marcador, não o card todo (imagem
   *  carregando ou selo animado não podem parecer seleção). */
  function assinaturaDoMarcador(card) {
    const q = quadradoDoCard(card);
    const nos = [card.container];
    for (let el = q, i = 0; el && el !== card.container && i < 6; el = paiComposto(el), i++) nos.push(el);
    if (q) nos.push(...acharProfundo(q, "*", 12));
    const partes = [];
    for (const el of nos) {
      partes.push(el.tagName, classeDe(el), el.getAttribute?.("aria-checked") || "", el.getAttribute?.("aria-selected") || "");
      if (el.tagName === "INPUT") partes.push(el.checked ? "on" : "off");
      try {
        const cs = getComputedStyle(el);
        partes.push(cs.backgroundColor, cs.borderColor, cs.color, cs.opacity);
        for (const pseudo of ["::before", "::after"]) {
          const ps = getComputedStyle(el, pseudo);
          partes.push(ps.content, ps.opacity, ps.transform, ps.backgroundColor, ps.borderColor);
        }
      } catch {
        /* fora do navegador */
      }
    }
    if (q) partes.push("f" + (q.childElementCount || 0));
    return partes.join("|");
  }

  /** "2 produto(s) selecionado(s)", "Selecionados: 2", "2/50 selecionados" → 2. Sem contador → null.
   *  Só no rodapé, perto do "Confirmar": sem marcador <input>, a raiz da janela pode subir até a
   *  página inteira — e uma mensagem do chat com "2 selecionados" viraria um falso sinal. */
  function contadorDeSelecionados(confirmar, raiz) {
    let area = confirmar;
    for (let i = 0; area && i < 3 && area.parentElement && !(raiz && area === raiz); i++) area = area.parentElement;
    const els = area && area.querySelectorAll ? area.querySelectorAll("div,span,p,strong,b,label") : [];
    for (let i = 0; i < els.length && i < 400; i++) {
      const el = els[i];
      if (el.childElementCount > 3) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 60 || !/selecion|selected/i.test(t)) continue;
      const m =
        /(\d+)\s*(?:\/\s*\d+\s*)?(?:produtos?|itens?|items?)?\s*(?:\(s\))?\s*(?:selecionad|selected)/i.exec(t) ||
        /(?:selecion(?:ad[oa]s?|ou)|selected)\s*:?\s*\(?\s*(\d+)/i.exec(t);
      if (m && visivel(el)) return Number(m[1]);
    }
    return null;
  }

  /** O que a JANELA diz sobre a seleção, independente de qual nó é o card. Roda a cada 100 ms
   *  enquanto espera o clique pegar: a raiz da janela (que varre o documento) é guardada
   *  enquanto continuar na página. */
  let raizDaJanela = null;
  function sinaisGlobais() {
    if (!raizDaJanela || raizDaJanela.isConnected === false || !visivel(raizDaJanela)) raizDaJanela = containerModalFavoritos();
    const raiz = raizDaJanela || document;
    let marcados = 0;
    for (const el of acharProfundo(raiz, SEL_CHECKBOX, 300)) {
      if (el.checked === true || el.getAttribute?.("aria-checked") === "true") marcados++;
    }
    const btn = botaoConfirmar(raizDaJanela);
    return { marcados, contador: contadorDeSelecionados(btn, raizDaJanela), confirmar: confirmarHabilitado(raizDaJanela, btn) };
  }

  /** Alvos do clique, do mais certeiro ao mais amplo.
   *  Com <input>, o LABEL vem primeiro: o navegador repassa o clique dele ao input como clique
   *  CONFIÁVEL (isTrusted) — funciona com input escondido e até em tela que ignora clique
   *  sintético (medido: o clique direto no input falha ali, o do label passa).
   *  Depois o PONTO: o elemento que está de fato sobre o quadradinho (o <input> transparente do
   *  Ant Design, o desenho, ou o card por baixo dele) — exatamente o que a dona clicaria.
   *  O card inteiro só entra quando não há quadradinho nenhum para mirar. */
  function alvosDeMarcacao(card) {
    const lista = [];
    const inp = inputDoCard(card);
    const label = inp ? labelDo(inp) : null;
    if (label && visivel(label)) lista.push({ chave: "label", el: label, nome: `label (${descrever(label)})` });
    const q = quadradoDoCard(card);
    if (q) {
      const r = q.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const noPonto = elementoNoPonto(x, y);
      if (noPonto && contemComposto(card.container, noPonto)) lista.push({ chave: "ponto", el: noPonto, x, y, nome: `ponto do quadradinho (${descrever(noPonto)})` });
      lista.push({ chave: "quadrado", el: q, x, y, nome: `quadradinho (${descrever(q)})` });
    }
    if (inp) lista.push({ chave: "input", el: inp, nome: `input (${descrever(inp)})` });
    if (!q) lista.push({ chave: "card", el: card.container, nome: `card (${descrever(card.container)})` });
    const vistos = new Set();
    // Nada dentro de link: o clique abriria a página do produto NA ABA DA LIVE.
    return lista.filter((a) => a.el && a.el.isConnected !== false && !vistos.has(a.el) && vistos.add(a.el) && !dentroDeLink(a.el));
  }

  function dentroDeLink(el) {
    for (let p = el, i = 0; p && i < 60; p = paiComposto(p), i++) {
      if (p.tagName === "A" && p.getAttribute?.("href") && !/^\s*(#|javascript:)/i.test(p.getAttribute("href"))) return true;
    }
    return false;
  }

  /** A janela passou a mostrar mais seleção do que em `antes`? */
  const janelaRegistrou = (antes, g) =>
    g.marcados > antes.marcados || (g.contador != null && antes.contador != null && g.contador > antes.contador) || (!antes.confirmar && g.confirmar);

  /** O card mostra que está processando (spinner, aria-busy)? Seleção que passa pelo servidor. */
  function cardOcupado(card) {
    try {
      return [...card.container.querySelectorAll('[aria-busy="true"], [class*="loading" i], [class*="spin" i]')].some(visivel);
    } catch {
      return false;
    }
  }

  /** Espera a aparência parar de mudar (hover, transição) antes de fotografar o "antes". */
  async function linhaDeBase(cardOrig) {
    let card = cardVivo(cardOrig);
    let a = card ? assinaturaDoMarcador(card) : "";
    for (let i = 0; i < 8; i++) {
      await sleep(100);
      card = cardVivo(cardOrig);
      const b = card ? assinaturaDoMarcador(card) : "";
      if (b === a) break;
      a = b;
    }
    return { a, g: sinaisGlobais(), ocupado: !!card && cardOcupado(card) };
  }

  /** Depois do clique: o produto ficou marcado? Lê SEMPRE a página atual (o card é relido).
   *  Sinais fortes: o checkbox do card, o contador da janela, o Confirmar acendendo, mais um
   *  checkbox marcado na janela. Sinal fraco: o quadradinho mudou de aparência — vale sozinho
   *  quando não há checkbox para ler. Espera o suficiente para seleção que passa pelo servidor. */
  async function esperarEfeito(cardOrig, base, ms) {
    const t0 = Date.now();
    let mudouDesde = 0;
    let globalMudou = false;
    let card = null;
    let estado = null;
    let prazo = ms;
    while (Date.now() - t0 < prazo) {
      await sleep(100);
      card = cardVivo(cardOrig);
      estado = card ? estadoDoCard(card) : null;
      // Carregando DEPOIS do clique: a resposta ainda vem. Clicar outro alvo agora desmarcaria
      // quando ela chegar. (Um "carregando" que já estava lá — imagem, selo — não conta.)
      if (card && !base.ocupado && cardOcupado(card)) prazo = Math.min(6000, Math.max(prazo, Date.now() - t0 + 1000));
      if (estado === true) return { marcado: true, txt: `marcou em ${Date.now() - t0}ms` };
      const global = janelaRegistrou(base.g, sinaisGlobais());
      // Se o checkbox DESTE card diz "desmarcado", o sinal global não é dele (ou ainda não
      // chegou): espera mais, em vez de dar como marcado.
      if (global && estado !== false) return { marcado: true, txt: `a janela registrou a seleção em ${Date.now() - t0}ms` };
      if (global) globalMudou = true;
      const mudou = card ? assinaturaDoMarcador(card) !== base.a : false;
      if (!mudou) mudouDesde = 0;
      else if (!mudouDesde) mudouDesde = Date.now();
      if (mudou && estado === null && quadradinhoCheio(card)) return { marcado: true, fraco: true, txt: `o quadradinho ficou preenchido em ${Date.now() - t0}ms` };
      if (mudou && estado === null && Date.now() - mudouDesde >= 400) return { marcado: true, fraco: true, txt: `o quadradinho mudou de aparência em ${mudouDesde - t0}ms` };
    }
    // Mudança que PERMANECEU (não um efeito passageiro) e estado ilegível: não arrisco outro
    // clique — se tiver pegado, clicar de novo desmarcaria. A contagem da sacola decide.
    const mudouNoFim = !!card && assinaturaDoMarcador(card) !== base.a;
    if (globalMudou || mudouNoFim) return { marcado: false, mudou: true, txt: "algo mudou, mas o checkbox não confirma" };
    return { marcado: false, mudou: false, txt: "nada mudou" };
  }

  let alvoQueFuncionou = null; // tipo de alvo que marcou o card anterior: vai primeiro no próximo

  /** Marca UM card. status:
   *   marcado        há sinal de que o produto ficou selecionado
   *   jaMarcado      já estava marcado antes de qualquer clique (checkbox, atributo ou classe)
   *   pareceMarcado  quadradinho já preenchido, sem estado legível: não clico (desmarcaria) e
   *                  também não afirmo que está na sacola — o item segue pelo link
   *   indisponivel   desabilitado (produto indisponível — NÃO é "já está na sacola")
   *   incerto        algo mudou mas não dá para confirmar; não clico de novo (desmarcaria)
   *   semEfeito      nenhum alvo mudou nada: o produto NÃO está selecionado
   *   sumiu          o card saiu da tela */
  async function marcarCard(cardOrig) {
    const t0 = Date.now();
    raizDaJanela = null; // a memória da raiz vale só durante a marcação de um card
    let card = cardVivo(cardOrig);
    if (!card) return { status: "sumiu", tentativas: [] };
    const estado0 = estadoDoCard(card);
    if (estado0 === true) return { status: "jaMarcado", tentativas: [] };
    if (estado0 === null && quadradinhoCheio(card)) return { status: "pareceMarcado", tentativas: [] };
    if (cardDesabilitado(card)) return { status: "indisponivel", tentativas: [] };
    const tentativas = [];
    const usados = new Set();
    let redesenhos = 0;
    const antesDeTudo = sinaisGlobais(); // a janela antes do 1º clique
    try {
      for (let rodada = 0; rodada < 8; rodada++) {
        card = cardVivo(cardOrig);
        if (!card) return { status: "sumiu", tentativas };
        if (estadoDoCard(card) === true) return { status: "marcado", via: "(marcou com atraso)", ms: Date.now() - t0, tentativas };
        // Mouse sobre o card primeiro: há grade que só mostra o quadradinho no hover, e o
        // efeito de hover não pode ser confundido com a seleção.
        hover(card.container);
        await sleep(120);
        // Relê: o hover pode ter redesenhado o card, e a grade pode ter recarregado nesse meio
        // tempo. Alvos calculados no card antigo apontariam para nós fora da página.
        card = cardVivo(cardOrig);
        if (!card) return { status: "sumiu", tentativas };
        const alvos = alvosDeMarcacao(card).filter((a) => !usados.has(a.chave));
        alvos.sort((a, b) => (b.chave === alvoQueFuncionou) - (a.chave === alvoQueFuncionou));
        const alvo = alvos[0];
        if (!alvo) break;
        hover(alvo.el);
        const base = await linhaDeBase(cardOrig);
        const agora = cardVivo(cardOrig);
        if (alvo.el.isConnected === false || !agora || !contemComposto(agora.container, alvo.el)) {
          // A grade mudou durante a espera: o clique iria para o vazio — ou para OUTRO produto,
          // se o nó foi reaproveitado. Recalcula no card de agora.
          if (++redesenhos > 3) break;
          continue;
        }
        // Última conferência, colada no clique: a resposta atrasada de um clique anterior pode
        // ter acabado de marcar o produto — clicar de novo agora desmarcaria.
        const estadoAgora = estadoDoCard(agora);
        if (tentativas.length && (estadoAgora === true || (estadoAgora !== false && janelaRegistrou(antesDeTudo, sinaisGlobais())))) {
          return { status: "marcado", via: "(o clique anterior pegou com atraso)", ms: Date.now() - t0, tentativas };
        }
        usados.add(alvo.chave);
        realClick(alvo.el, alvo.x, alvo.y);
        const r = await esperarEfeito(cardOrig, base, 1500);
        tentativas.push(`${alvo.nome} → ${r.txt}`);
        if (r.marcado) {
          alvoQueFuncionou = alvo.chave;
          return { status: "marcado", via: alvo.nome, fraco: !!r.fraco, ms: Date.now() - t0, tentativas };
        }
        if (r.mudou) return { status: "incerto", via: alvo.nome, ms: Date.now() - t0, tentativas };
        // nada mudou: é seguro tentar o próximo alvo
      }
      return { status: "semEfeito", ms: Date.now() - t0, tentativas };
    } finally {
      const vivo = cardVivo(cardOrig);
      if (vivo) sairDoHover(vivo.container);
    }
  }

  function containerRolavel() {
    const raiz = containerModalFavoritos();
    const base = raiz && raiz.querySelectorAll ? Array.from(raiz.querySelectorAll("div")) : [];
    const cands = base.filter((d) => visivel(d) && d.scrollHeight > d.clientHeight + 60);
    cands.sort((a, b) => b.clientHeight - a.clientHeight);
    return cands[0] || null;
  }

  // ---- fluxo principal ----

  /** Amostra dos textos clicáveis visíveis — sem isto, "não achei o botão" não diz nada. */
  function amostraDaTela(filtro) {
    const vistos = new Set();
    const alvos = document.querySelectorAll("button,div,span,a,li");
    for (let i = 0; i < alvos.length && i < 4000 && vistos.size < 14; i++) {
      const el = alvos[i];
      if (!visivel(el) || el.childElementCount > 1) continue;
      const t = txt(el);
      if (!t || t.length > 40) continue;
      if (filtro && !filtro.test(t)) continue;
      vistos.add(t);
    }
    return [...vistos];
  }

  /** Passo 1: abre a janela "Produtos(N)" — é ela que informa a contagem confiável.
   *  O botão "Lista de produtos" só aparece ao passar o mouse sobre o card "Produtos"; o alvo
   *  do hover costuma ser um ANCESTRAL do texto, por isso passamos o mouse na cadeia toda. */
  /** Elemento que parece DESABILITADO (cinza, sem clique): atributo, classe ou estilo. */
  function pareceDesabilitado(el) {
    if (!el) return false;
    if (el.disabled === true || el.getAttribute?.("aria-disabled") === "true") return true;
    if (/disabled|desabilit|inactive|inativo/i.test(String(el.className || ""))) return true;
    try {
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === "none" || Number(cs.opacity) < 0.6) return true;
      const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(cs.color || "");
      if (m) {
        const [r, g, b] = [+m[1], +m[2], +m[3]];
        const cinza = Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && r > 140 && r < 215;
        if (cinza && cs.cursor === "not-allowed") return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /** Igual a acharPorTexto, mas SEM pular desabilitados (para detectar o botão cinza). */
  function acharPorTextoInclusive(padroes, seletor = "button,div,span,a,li") {
    const alvos = document.querySelectorAll(seletor);
    let melhor = null;
    for (let i = 0; i < alvos.length && i < 6000; i++) {
      const el = alvos[i];
      if (!visivel(el)) continue;
      const t = norm(txt(el));
      if (!t || t.length > 60) continue;
      if (padroes.some((p) => t === p || t.startsWith(p))) {
        if (!melhor || profundidade(el) > profundidade(melhor)) melhor = el;
      }
    }
    return melhor;
  }

  /** Live pausada deixa "Lista de produtos" cinza; o botão "Recarregar" (abaixo do vídeo)
   *  reativa. Devolve true se clicou em Recarregar. */
  /** O "Recarregar" fica sobre o vídeo da live e é o que devolve o acesso à lista de produtos.
   *  Procuramos por texto, por rótulo e, se ele estiver dentro de um quadro (iframe) do player,
   *  pedimos aos outros quadros da página que cliquem. */
  function acharRecarregar() {
    return (
      acharPorTexto(["recarregar"], "button,div,span,a", true) ||
      acharPorTexto(["recarregar pagina", "recarregar página", "recarregar transmissao", "atualizar"], "button,div,span,a") ||
      acharPorTextoInclusive(["recarregar"], "button,div,span,a")
    );
  }

  let ultimoRecarregar = 0;
  async function tentarRecarregar(motivo) {
    // Recarregar reinicia o player: no máximo uma vez a cada 20 s, para nunca virar um laço.
    const espera = String(motivo || "").startsWith("vigia") ? 60000 : 20000;
    if (Date.now() - ultimoRecarregar < espera) {
      reg("já cliquei em 'Recarregar' há pouco; espero antes de tentar de novo");
      return false;
    }
    const rec = acharRecarregar();
    if (rec) {
      ultimoRecarregar = Date.now();
      reg(`${motivo}: clicando em 'Recarregar'`);
      realClick(rec);
      await sleep(4000);
      return true;
    }
    // Não está nesta janela: pode estar num quadro do player.
    try {
      const r = await chrome.runtime.sendMessage({ type: "recarregar-frames" });
      if (r && r.clicou) {
        ultimoRecarregar = Date.now();
        reg(`${motivo}: cliquei em 'Recarregar' (estava num quadro do player)`);
        await sleep(4000);
        return true;
      }
    } catch {
      /* service worker dormindo */
    }
    reg(`${motivo}: não achei o botão 'Recarregar' na tela`);
    return false;
  }

  /** Quanto um card "parece vivo": opacidade acumulada × (escuridão + cor) do ícone e do texto.
   *  Um ícone apagado tem opacidade baixa, ou fica cinza-claro, ou perde a cor — os três casos
   *  derrubam esta nota. */
  function vivacidade(el) {
    if (!el) return null;
    let opac = 1;
    for (let a = el, i = 0; a && i < 6; a = a.parentElement, i++) {
      try {
        const o = Number(getComputedStyle(a).opacity);
        if (Number.isFinite(o)) opac *= o;
      } catch {
        /* ignore */
      }
    }
    let soma = 0;
    let n = 0;
    const alvos = [el];
    if (el.querySelectorAll) alvos.push(...Array.from(el.querySelectorAll("span,div,svg,path,i,img")).slice(0, 30));
    for (const t of alvos) {
      let cs;
      try {
        cs = getComputedStyle(t);
      } catch {
        continue;
      }
      for (const prop of ["color", "fill", "stroke"]) {
        const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(cs[prop] || "");
        if (!m) continue;
        const alfa = m[4] === undefined ? 1 : +m[4];
        if (alfa < 0.05) continue;
        const r = +m[1];
        const g = +m[2];
        const b = +m[3];
        const luz = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const cor = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        soma += ((1 - luz) + cor) * alfa; // escuro OU colorido = vivo
        n++;
      }
    }
    return n ? opac * (soma / n) : null;
  }

  /** O card de uma ferramenta da barra lateral, pelo rótulo. */
  function cardDaFerramenta(rotulo) {
    const el = acharPorTexto([rotulo], "div,span,button,li,a", true);
    if (!el) return null;
    for (let a = el, i = 0; a && i < 3; a = a.parentElement, i++) {
      const r = a.getBoundingClientRect ? a.getBoundingClientRect() : null;
      if (r && r.height >= 56) return a;
    }
    return el.parentElement || el;
  }

  /** O ícone da sacola está apagado? Comparado com os cards VIZINHOS, que não travam junto.
   *  Comparar em vez de usar um limiar fixo evita depender de tema, zoom ou versão da tela.
   *  Devolve { apagado, nota, referencia } — os números vão para o popup, para poder ajustar. */
  function iconeDaSacolaApagado() {
    const prod = cardDaFerramenta("produtos");
    if (!prod) return { apagado: false, motivo: "card 'Produtos' não encontrado" };
    const notaProd = vivacidade(prod);
    if (notaProd == null) return { apagado: false, motivo: "sem cor legível no card" };
    const refs = [];
    for (const nome of ["atividade", "pedidos de intro", "pedidos de intro >"]) {
      const c = cardDaFerramenta(nome);
      const v = c ? vivacidade(c) : null;
      if (v != null) refs.push(v);
    }
    if (!refs.length) return { apagado: false, nota: notaProd, motivo: "sem card vizinho para comparar" };
    const referencia = refs.reduce((a, b) => a + b, 0) / refs.length;
    // Bem abaixo dos vizinhos = apagado. A margem é larga de propósito: clicar em "Recarregar"
    // sem precisar reinicia o player no meio da live.
    const apagado = referencia > 0 && notaProd < referencia * 0.6;
    return { apagado, nota: Number(notaProd.toFixed(3)), referencia: Number(referencia.toFixed(3)) };
  }

  /** A sacola está fora de alcance? Devolve o motivo (ou null se está tudo bem).
   *  Faz o MESMO caminho de abrirListaProdutos, só que sem clicar em nada: procura o botão,
   *  passa o mouse no card "Produtos" como faríamos para abri-lo, e olha de novo. É o mesmo
   *  código que já sabemos que funciona na tela real — heurística nova aqui só traria erro.
   *  Conservador de propósito: clicar em "Recarregar" reinicia o player da live. */
  let ultimoIcone = null; // guardado para o diagnóstico do popup
  async function sacolaInacessivel() {
    if (modalProdutosAberto() || modalFavoritosAberto()) return null; // já está aberta

    // Sinal mais direto, e o mesmo que a dona vê: o ícone da sacola perde a cor quando trava,
    // enquanto os cards vizinhos ("Atividade", "Pedidos de Intro") continuam normais.
    ultimoIcone = iconeDaSacolaApagado();
    if (ultimoIcone.apagado) return "ícone da sacola apagado";

    if (acharPorTexto(["lista de produtos"])) return null; // o botão está lá e clicável
    const cinza = acharPorTextoInclusive(["lista de produtos"]);
    if (cinza && pareceDesabilitado(cinza)) return "'Lista de produtos' cinza";

    // O botão só aparece com o mouse sobre o card. Sem passar o mouse não dá para saber.
    const prod = acharPorTexto(["produtos"], "div,span,button", true) || acharPorTexto(["produtos"], "div,span,button");
    if (!prod) return null; // nem o card existe: não é hora de chutar
    for (let el = prod, i = 0; el && i < 4; el = el.parentElement, i++) hover(el);
    await sleep(1200);

    if (acharPorTexto(["lista de produtos"])) return null; // apareceu: está tudo bem
    const cinza2 = acharPorTextoInclusive(["lista de produtos"]);
    if (cinza2 && pareceDesabilitado(cinza2)) return "'Lista de produtos' cinza";
    if (pareceDesabilitado(prod)) return "card 'Produtos' cinza";
    return "'Lista de produtos' não aparece";
  }

  /** Vigia independente: a sacola pode ficar inacessível SEM que haja uma rodada em curso
   *  (fila ainda favoritando, ou lote vazio). Antes, o "Recarregar" só era tentado dentro de
   *  abrirListaProdutos, então nessas horas ninguém clicava nele. */
  let vezesSeguidasCinza = 0;
  let vigiando = false;
  async function vigiarSacola() {
    if (rodando || vigiando) return; // uma rodada em curso já cuida disso
    vigiando = true;
    let motivo = null;
    try {
      motivo = await sacolaInacessivel();
    } catch {
      motivo = null;
    } finally {
      vigiando = false;
    }
    if (!motivo) {
      vezesSeguidasCinza = 0;
      return;
    }
    vezesSeguidasCinza++;
    // duas leituras seguidas antes de agir: estado passageiro não vale um reinício do player
    if (vezesSeguidasCinza < 2) return;
    vezesSeguidasCinza = 0;
    log.length = 0;
    const clicou = await tentarRecarregar(`vigia: ${motivo}`);
    try {
      chrome.runtime.sendMessage(
        { type: "recarregou-sozinho", motivo, clicou, detalhe: log.slice(-3), icone: ultimoIcone },
        () => void chrome.runtime.lastError,
      );
    } catch {
      /* service worker dormindo */
    }
  }
  setInterval(vigiarSacola, 15000);

  async function abrirListaProdutos() {
    if (modalProdutosAberto()) return true;
    for (let tentativa = 0; tentativa < 4; tentativa++) {
      let btn = acharPorTexto(["lista de produtos"]);
      // Desabilitada (live pausada/caída) → "Recarregar" e tenta de novo.
      if (!btn) {
        const cinza = acharPorTextoInclusive(["lista de produtos"]);
        if (cinza && pareceDesabilitado(cinza)) {
          if (await tentarRecarregar("'Lista de produtos' desabilitada")) continue;
          return false;
        }
      }
      if (!btn) {
        const prod = acharPorTexto(["produtos"], "div,span,button", true) || acharPorTexto(["produtos"], "div,span,button");
        if (prod) {
          for (let el = prod, i = 0; el && i < 4; el = el.parentElement, i++) hover(el);
          await sleep(1200);
          btn = acharPorTexto(["lista de produtos"]);
        } else if (tentativa === 0) {
          reg(`não achei o card 'Produtos'. Visíveis: ${amostraDaTela(/produt|sacol|lista/i).join(" | ") || "(nenhum texto parecido)"}`);
        }
      }
      if (btn) {
        realClick(btn);
        if (await esperar(modalProdutosAberto, 10000)) {
          reg("janela de produtos aberta");
          return true;
        }
        // Clicou e nada abriu: é o mesmo sintoma da live travada. Recarrega e tenta de novo,
        // em vez de desistir (era aqui que a extensão parava sem nunca clicar em 'Recarregar').
        reg("cliquei em 'Lista de produtos' e a janela não abriu");
        if (await tentarRecarregar("janela não abriu")) continue;
        return false;
      }
      // Nem o botão nem o card apareceram: idem, pode ser a live travada.
      if (tentativa >= 1 && (await tentarRecarregar("'Lista de produtos' não apareceu"))) continue;
      await sleep(1000);
    }
    reg(`não achei 'Lista de produtos' após passar o mouse em 'Produtos'. Visíveis: ${amostraDaTela().join(" | ")}`);
    return false;
  }

  /** Passo 2: dentro dela, abre "Adicionar Produtos" na aba "Meus Favoritos". */
  /** Espera o grid de favoritos aparecer E parar de mudar.
   *  Ler cedo demais era o que fazia o produto recém-favoritado passar batido: ele está no
   *  topo, mas o card ainda não tinha sido desenhado quando olhamos. Devolve quantos cards
   *  havia e quanto tempo levou, para o log poder mostrar. */
  async function esperarGridEstavel(ms = 5000) {
    const t0 = Date.now();
    let anterior = -1;
    let iguais = 0;
    while (Date.now() - t0 < ms) {
      let n = 0;
      try {
        n = cardsFavoritos().length;
      } catch {
        n = 0;
      }
      if (n > 0 && n === anterior) {
        iguais++;
        if (iguais >= 2) return { cards: n, ms: Date.now() - t0 };
      } else {
        iguais = 0;
      }
      anterior = n;
      await sleep(180);
    }
    let n = 0;
    try {
      n = cardsFavoritos().length;
    } catch {
      n = 0;
    }
    return { cards: n, ms: Date.now() - t0, estourou: true };
  }

  async function abrirGridFavoritos() {
    if (modalFavoritosAberto()) return true;
    const add = acharPorTexto(["adicionar produtos relacionados", "adicionar produtos relacionado"]);
    if (!add) {
      reg("não achei '+ Adicionar produtos relacionados'");
      return false;
    }
    realClick(add);
    if (!(await esperar(modalFavoritosAberto, 10000))) {
      reg("a janela 'Adicionar Produtos' não abriu");
      return false;
    }
    const aba = abaFavoritos();
    if (aba) {
      realClick(aba);
      await sleep(350);
    }
    // "Meus Favoritos" é a aba padrão ao abrir e nós acabamos de clicar nela. Se não der para
    // CONFIRMAR isso, seguimos assim mesmo (antes eu abortava e voltava sem fazer nada), mas
    // deixamos registrado — a conferência final da contagem da sacola continua protegendo.
    if (favoritosSelecionada() || (await esperar(favoritosSelecionada, 1200))) {
      reg("aba 'Meus Favoritos' selecionada");
    } else {
      reg(`aba 'Meus Favoritos': cliquei mas não deu para confirmar visualmente (sigo mesmo assim)${aba ? "" : " — aba não encontrada"}`);
    }
    await esperarGridEstavel(2500);
    const limpeza = await limparMarcacoesVelhas();
    if (limpeza.restantes != null && limpeza.restantes > 0) {
      // Ainda há seleção que não vemos (card fora da tela): confirmar levaria produto antigo
      // junto. Não confirmo nada nesta janela — melhor ficar sem adicionar do que adicionar errado.
      reg(`ATENÇÃO: a janela ainda mostra ${limpeza.restantes} produto(s) selecionado(s) que não são desta rodada e não estão à vista — não confirmo nada; desmarque-os na janela "Adicionar Produtos"`);
      selecaoVelhaRestante = limpeza.restantes;
    }
    return true;
  }
  let selecaoVelhaRestante = 0;

  /** Marcações que NÃO são nossas e NÃO estão na sacola: a Shopee guarda a seleção da janela
   *  entre aberturas (rodada fechada sem confirmar, produto que a dona tirou da sacola e ficou
   *  marcado). O "Confirmar" adiciona TUDO o que está marcado — era assim que um ID novo fazia
   *  subir vários produtos antigos. Desmarca o que está marcado, habilitado e fora da "Lista de
   *  produtos"; o que está na lista fica (a Shopee mostra esses como marcados e desabilitados).
   *  Devolve quantos ainda constam marcados no contador da janela depois disso. */
  async function limparMarcacoesVelhas() {
    const naSacola = titulosNaSacola();
    const estaNaSacola = (titulo) => naSacola.some((t) => {
      const r = pontuaTitulo(t.titulo, titulo);
      return !!r && (r.exato || r.p >= PREFIXO_JA_NA_SACOLA);
    });
    let desmarcados = 0;
    for (const c of cardsFavoritos()) {
      const estado = estadoDoCard(c);
      const marcado = estado === true || (estado === null && quadradinhoCheio(c));
      if (!marcado || cardDesabilitado(c)) continue;
      if (estaNaSacola(c.titulo)) continue;
      const alvos = alvosDeMarcacao(c);
      for (const alvo of alvos) {
        realClick(alvo.el, alvo.x, alvo.y);
        const aindaMarcado = () => {
          const v = cardVivo(c) || c;
          const e = estadoDoCard(v);
          return e === true || (e === null && quadradinhoCheio(v));
        };
        if (await esperar(() => !aindaMarcado(), 1200, 100)) break;
      }
      const vivo = cardVivo(c) || c;
      const eFinal = estadoDoCard(vivo);
      if (eFinal === true || (eFinal === null && quadradinhoCheio(vivo))) reg(`marcação antiga que NÃO consegui desmarcar: "${c.titulo.slice(0, 40)}"`);
      else {
        desmarcados++;
        reg(`desmarquei marcação antiga (não está na sacola): "${c.titulo.slice(0, 40)}"`);
      }
    }
    const raiz = containerModalFavoritos();
    const contador = contadorDeSelecionados(botaoConfirmar(raiz), raiz);
    return { desmarcados, restantes: contador };
  }

  /** Fecha as janelas SEM sair clicando em qualquer "Cancelar" da página (poderia cancelar
   *  a transmissão ou um pedido). Só age dentro da modal e prefere Esc / botão de fechar. */
  /** Depois de um Confirmar: espera a contagem "Produtos(N)" mudar (ou a janela fechar) em
   *  vez de um tempo fixo — rápido quando a Shopee responde rápido. */
  async function esperarContagemMudar(antes, ms) {
    const t0 = Date.now();
    await esperar(() => !modalFavoritosAberto(), ms);
    // a contagem costuma subir logo depois de a janela fechar
    await esperar(() => antes == null || contarSacola() !== antes, Math.max(400, ms - (Date.now() - t0)), 120);
    await sleep(150);
  }

  async function fecharModais() {
    for (let i = 0; i < 3; i++) {
      const raiz = containerModalFavoritos();
      const alvo =
        (raiz && raiz.querySelector?.('[aria-label*="fechar" i], [aria-label*="close" i]')) ||
        (raiz ? acharDentro(raiz, ["cancelar"]) : null);
      if (alvo && visivel(alvo)) {
        realClick(alvo);
        await sleep(400);
        continue;
      }
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      } catch {
        /* ignore */
      }
      await sleep(300);
      break;
    }
  }

  /** O botão "Confirmar" fica apagado enquanto nada está selecionado — é um bom termômetro. */
  const botaoConfirmar = (raiz) => (raiz && acharDentro(raiz, ["confirmar"])) || acharPorTexto(["confirmar"], "button,div,span", true);
  function confirmarHabilitado(raiz = containerModalFavoritos(), btn = botaoConfirmar(raiz)) {
    if (!btn) return false;
    if (btn.disabled === true || btn.getAttribute?.("aria-disabled") === "true") return false;
    const cls = String(btn.className || "");
    if (/disabled|desabilit/i.test(cls)) return false;
    try {
      const cs = getComputedStyle(btn);
      if (cs.pointerEvents === "none" || Number(cs.opacity) < 0.6) return false;
    } catch {
      /* ignore */
    }
    return true;
  }

  function acharDentro(raiz, padroes) {
    if (!raiz || !raiz.querySelectorAll) return null;
    const alvos = raiz.querySelectorAll("button,div,span,a");
    for (let i = 0; i < alvos.length && i < 2000; i++) {
      const el = alvos[i];
      if (!visivel(el)) continue;
      const t = norm(txt(el));
      if (padroes.includes(t)) return el;
    }
    return null;
  }

  /** A janela "Lista de produtos" (a que mostra "Produtos(N)"): ancestral do título com a
   *  contagem que também contém o botão "+ Adicionar produtos relacionados". */
  function containerListaProdutos() {
    const add = acharPorTexto(["adicionar produtos relacionados", "adicionar produtos relacionado"]);
    const alvos = document.querySelectorAll("div,span,h1,h2,h3,p");
    let titulo = null;
    for (let i = 0; i < alvos.length && i < 6000; i++) {
      const el = alvos[i];
      if (!visivel(el) || el.childElementCount > 2) continue;
      if (/^produtos\s*\(\s*\d+\s*\)/i.test(txt(el))) {
        titulo = el;
        break;
      }
    }
    if (!titulo) return null;
    for (let el = titulo, i = 0; el && i < 10; el = el.parentElement, i++) {
      if (!add || (el.contains && el.contains(add))) return el;
    }
    return titulo.parentElement || titulo;
  }

  /** Títulos (e preços) dos produtos que JÁ estão na sacola, lidos da "Lista de produtos". */
  function titulosNaSacola() {
    const raiz = containerListaProdutos();
    if (!raiz || !raiz.querySelectorAll) return [];
    // Se a janela "Adicionar Produtos" ficou aberta de uma rodada anterior, seus cards NÃO são
    // a sacola — ficam de fora.
    const excluir = modalFavoritosAberto() ? containerModalFavoritos() : null;
    const out = [];
    const vistos = new Set(); // o mesmo produto aparece como atributo title E como texto do nó
    const guardar = (titulo, preco) => {
      const chave = `${norm(titulo)}|${preco == null ? "" : preco}`;
      if (vistos.has(chave)) return;
      vistos.add(chave);
      out.push({ titulo, preco });
    };
    const els = raiz.querySelectorAll("div,span,p,a,h3,h4");
    for (let i = 0; i < els.length && i < 4000; i++) {
      const el = els[i];
      if (!visivel(el)) continue;
      if (excluir && excluir !== raiz && excluir.contains && excluir.contains(el)) continue;
      const tAttr = (el.getAttribute?.("title") || "").replace(/\s+/g, " ").trim();
      const tLeaf = el.childElementCount === 0 ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
      const pai = el.parentElement;
      const avo = pai && pai.parentElement;
      const preco = precoDoCard((pai && pai.textContent) || "") ?? precoDoCard((avo && avo.textContent) || "");
      for (const t of [tAttr, tLeaf]) {
        if (t && t.length >= 8 && t.length <= 200 && !/^r\$/i.test(t) && !/^produtos\s*\(/i.test(t)) guardar(t, preco);
      }
    }
    return out;
  }

  /** Itens do lote que JÁ aparecem na "Lista de produtos". Critério ESTRITO, porque o efeito é
   *  tirar o item do lote sem nunca tentar adicioná-lo: título igual (ou truncado com prefixo
   *  longo), preço batendo quando os dois lados têm, e casamento ÚNICO nos dois sentidos —
   *  se o título servir a dois produtos, ou o produto casar com duas linhas, não afirmamos nada. */
  const PREFIXO_JA_NA_SACOLA = 24;
  function jaNaSacolaPorTitulo(lote) {
    const titulos = titulosNaSacola();
    if (!titulos.length) return [];
    const casa = (t, item) => {
      const s = pontuaTitulo(t.titulo, item.nome);
      if (!s) return false;
      if (!s.exato && !(/(\.\.\.|…)\s*$/.test(t.titulo) && s.p >= PREFIXO_JA_NA_SACOLA)) return false;
      if (item.preco != null && t.preco != null && Math.abs(t.preco - item.preco) > 0.011) return false;
      return true;
    };
    const achados = [];
    for (const item of lote) {
      if (norm(item.nome).length < 20) continue; // nome curto demais para afirmar que é o mesmo produto
      const linhas = titulos.filter((t) => casa(t, item));
      if (linhas.length !== 1) continue; // nenhuma, ou ambíguo → deixa seguir o fluxo normal
      const outros = lote.filter((o) => o !== item && norm(o.nome).length >= 20 && casa(linhas[0], o));
      if (outros.length) continue; // a mesma linha serviria a outro produto do lote
      achados.push(item);
    }
    return achados;
  }

  /**
   * @param {{codigo:string,nome:string,itemId:number}[]} lote produtos recém-favoritados
   * @param {{modo:"simular"|"real", limite:number}} opc
   */
  async function adicionarNaSacola(lote, opc) {
    log.length = 0;
    avisouSemCheckbox = false;
    limiteVistoNestaRodada = false;
    selecaoVelhaRestante = 0;
    let estruturaNoLog = false; // a estrutura de UM card por rodada basta para diagnosticar
    const limite = opc.limite || 50;
    const simular = opc.modo === "simular";

    // A contagem confiável está no título "Produtos(N)", então abrimos essa janela ANTES de decidir.
    if (!(await abrirListaProdutos())) {
      await fecharModais();
      return { ok: false, motivo: "tela", atual: null, adicionados: [], pendentes: lote.map((l) => l.codigo), log };
    }
    const antes = contarSacola();
    reg(`sacola antes: ${antes == null ? "?" : antes} / ${limite}`);
    const pendentes = new Map(lote.map((l) => [l.codigo, l]));
    const selecionados = [];
    const incertos = []; // clicados sem nenhum sinal visível: a CONTAGEM decide se entraram
    const ambiguos = new Set();
    const jaEstavam = () => selecionados.filter((s) => s.jaEstava).map((s) => s.codigo);
    // O que JÁ aparece na "Lista de produtos" não precisa (nem deve) entrar de novo. Sem isto,
    // um produto que entrou por outro caminho (na mão, ou numa rodada cuja contagem não bateu)
    // ficava preso no lote e era "importado via URL" a cada rodada, para sempre.
    for (const it of jaNaSacolaPorTitulo(lote)) {
      pendentes.delete(it.codigo);
      selecionados.push({ ...it, jaEstava: true });
      reg(`já está na sacola (aparece na lista de produtos): ${it.codigo} — ${(it.nome || "").slice(0, 40)}`);
    }
    const parcialBase = () => ({ atual: antes, adicionados: [], jaEstavam: jaEstavam(), pendentes: [...pendentes.keys()], log });
    if (antes == null) {
      // Sem saber quantos há, qualquer adição pode estourar o limite. Não arriscamos.
      await fecharModais();
      return { ok: false, motivo: "semContagem", ...parcialBase(), atual: null };
    }
    if (!pendentes.size) {
      await fecharModais();
      return { ok: false, motivo: "nadaNovo", ...parcialBase() };
    }
    if (antes >= limite) {
      await fecharModais();
      return { ok: false, motivo: "cheia", ...parcialBase() };
    }
    const espaco = Math.max(0, limite - antes);

    if (!(await abrirGridFavoritos())) {
      await fecharModais();
      return { ok: false, motivo: "tela", ...parcialBase() };
    }

    // Casa 1:1 com o topo do grid, sem adivinhar em caso de ambiguidade.
    const contaNovos = () => selecionados.filter((s) => !s.jaEstava).length;
    let semCards = false;
    // NUNCA rolamos. Os recém-favoritados ficam no TOPO de "Meus Favoritos"; olhamos só uma
    // janela do topo (os N adicionados + margem, porque a dona pode estar favoritando na mão
    // ao mesmo tempo). O que não estiver ali não está mesmo — vai para "Importar via URL".
    const janela = Math.min(Math.max(pendentes.size + 4, 6), 10);
    const pronto = await esperarGridEstavel();
    reg(`grid de favoritos: ${pronto.cards} card(s) em ${pronto.ms}ms${pronto.estourou ? " (não estabilizou)" : ""}`);
    // O produto favoritado por ÚLTIMO pode ainda não estar na grade: a Shopee mostra a lista
    // que já tinha e insere o novo no topo alguns instantes depois. Uma leitura só o perdia —
    // era "marca todos menos o mais recente", e ele ia parar no Importar via URL. Agora, o que
    // não foi achado é procurado UMA vez mais (até 1 s), se a grade mudar — e daí vai direto pelo link.
    const t0Topo = Date.now();
    let assinaturaGrade = "";
    let passada = 0;
    let procurar = [...pendentes.values()];
    while (procurar.length) {
      const todosCards = cardsFavoritos();
      const assinaturaAgora = todosCards.map((c) => c.titulo).join("|");
      if (passada && assinaturaAgora === assinaturaGrade) {
        if (Date.now() - t0Topo > 1000) break;
        await sleep(400);
        continue;
      }
      assinaturaGrade = assinaturaAgora;
      passada++;
      const cards = todosCards.slice(0, janela);
      reg(`topo de Meus Favoritos (${passada}ª leitura): ${cards.length} card(s) examinados (janela ${janela}, ${todosCards.length} visíveis)`);
      if (!todosCards.length) semCards = true;
      const naoAchados = [];
      const pares = casarLoteComCards(procurar, cards);
      for (const par of pares) {
        if (cancelado) break;
        if (par.status === "naoAchado") {
          naoAchados.push(par.item);
          // Diz o que viu, para o log explicar POR QUE o produto não casou.
          const it = par.item;
          reg(
            `sem card para ${it.codigo}: nome "${(it.nome || "").slice(0, 40)}" preço ${it.preco == null ? "?" : it.preco}${it.precoMax != null && it.precoMax !== it.preco ? "–" + it.precoMax : ""}; topo: ${cards
              .slice(0, 6)
              .map((c) => `"${c.titulo.slice(0, 24)}" ${c.preco == null ? "?" : c.preco}${c.precoMax != null && c.precoMax !== c.preco ? "–" + c.precoMax : ""}`)
              .join(" | ")}`,
          );
        }
        // Só o que ENTRA de novo consome vaga; itens que já estavam não ocupam espaço novo.
        if (contaNovos() >= espaco) break;
        if (par.status === "ambiguo") {
          reg(`AMBÍGUO, não vou marcar: ${par.item.codigo} — "${(par.item.nome || "").slice(0, 40)}" casa com ${par.quantos} produtos`);
          ambiguos.add(par.item.codigo);
          pendentes.delete(par.item.codigo);
          continue;
        }
        if (par.status !== "ok") continue;
        const card = par.card;
        const titulo = card.titulo.slice(0, 40);
        const divergente = par.precoDivergente ? " (preço divergente, casou pelo título)" : "";
        if (simular) {
          // A simulação não clica: diz o que faria e EM QUE elemento clicaria.
          const est = estadoDoCard(card);
          if (est === true) {
            pendentes.delete(par.item.codigo);
            reg(`já estava na sacola (marcado em Meus Favoritos): ${par.item.codigo} — ${titulo}`);
            selecionados.push({ ...par.item, jaEstava: true });
          } else if (est === null && quadradinhoCheio(card)) {
            reg(`parece já marcado (quadradinho preenchido): ${par.item.codigo} — ${titulo}; não clicaria, iria pelo link`);
          } else if (cardDesabilitado(card)) {
            reg(`indisponível (checkbox desabilitado): ${par.item.codigo} — ${titulo}`);
          } else {
            pendentes.delete(par.item.codigo);
            const alvo = alvosDeMarcacao(card)[0];
            selecionados.push({ ...par.item, jaEstava: false });
            reg(`marcaria: ${par.item.codigo} — ${titulo}${divergente} · clicaria em ${alvo ? alvo.nome : "(nenhum alvo)"}`);
          }
          if (!estruturaNoLog) {
            estruturaNoLog = true;
            reg(`estrutura do card: ${resumoDoCard(card)}`);
          }
          continue;
        }
        const m = await marcarCard(card);
        if (m.status === "indisponivel") {
          reg(`indisponível (checkbox desabilitado): ${par.item.codigo} — ${titulo}`);
          continue; // fica em `pendentes`: NÃO é "já está na sacola"
        }
        if (m.status === "jaMarcado") {
          pendentes.delete(par.item.codigo);
          reg(`já estava na sacola (marcado em Meus Favoritos): ${par.item.codigo} — ${titulo}`);
          selecionados.push({ ...par.item, jaEstava: true });
          continue;
        }
        if (m.status === "pareceMarcado") {
          // Clicar desmarcaria; afirmar "já está" poderia sumir com uma venda. Fica em
          // `pendentes`: pelo link, a própria Shopee diz se o produto já está na sacola.
          reg(`parece já marcado (quadradinho preenchido): ${par.item.codigo} — ${titulo}; não clico, vai pelo link`);
          continue;
        }
        if (m.status === "marcado") {
          pendentes.delete(par.item.codigo);
          selecionados.push({ ...par.item, jaEstava: false });
          reg(`marcado: ${par.item.codigo} — ${titulo}${divergente} · via ${m.via} em ${m.ms}ms${m.fraco ? " (pela aparência)" : ""}`);
          continue;
        }
        // Falhou: registra o que tentou e COMO a Shopee desenhou este card — é o que permite
        // ajustar a extensão à tela real sem adivinhar.
        reg(`tentativas em ${par.item.codigo}: ${m.tentativas.join(" | ") || "—"}`);
        if (!estruturaNoLog) {
          estruturaNoLog = true;
          reg(`estrutura do card: ${resumoDoCard(cardVivo(card) || card)}`);
        }
        if (m.status === "incerto") {
          // Algo mudou mas o checkbox não confirma: confirma junto e deixa a CONTAGEM decidir.
          pendentes.delete(par.item.codigo);
          incertos.push(par);
          reg(`marcação incerta (confiro pela contagem): ${par.item.codigo} — ${titulo}`);
        } else {
          // Nenhum clique mudou nada: o produto NÃO está selecionado. Fica em `pendentes` e vai
          // pelo link, sem passar por um "Confirmar" que não adicionaria nada.
          reg(`não consegui marcar (${m.status === "sumiu" ? "o card sumiu da tela" : "nenhum clique teve efeito"}): ${par.item.codigo} — ${titulo}`);
        }
      }
      procurar = naoAchados;
      if (!procurar.length || Date.now() - t0Topo > 1000) break;
      await sleep(400);
    }
    if (procurar.length) reg(`não apareceram no topo em ${((Date.now() - t0Topo) / 1000).toFixed(1)}s: ${procurar.map((i) => i.codigo).join(", ")}`);
    if (pendentes.size) reg(`não marcados em Meus Favoritos (vão por Importar via URL se tiverem link): ${[...pendentes.keys()].join(", ")}`);

    const novos = selecionados.filter((s) => !s.jaEstava);
    const importaveis = () => [...pendentes.values()].filter((it) => it.url);
    // Para a BUSCA dentro de "Meus Favoritos" basta ter nome — não precisa de link.
    const buscaveis = () => [...pendentes.values()].filter((it) => it.nome);
    if (!novos.length && !incertos.length && !simular && (buscaveis().length || importaveis().length) && contaNovos() < espaco) {
      // Não fechamos nada: a busca e a aba "Importar via URL" ficam DENTRO desta mesma janela.
      // Fechar e reabrir custava vários segundos por produto, à toa.
      //
      // O LINK vem primeiro. Ele é exato (foi guardado na hora de favoritar) e resolve em um
      // passo; a busca por nome é mais lenta, pode não achar e serve de reserva — para os
      // produtos sem link, e para os que a conversão recusar.
      // A busca por nome foi ABOLIDA (regra da dona): ela digitava um nome próximo mas
      // incompatível (h1 traduzido, prefixo, emoji) e filtrava para o vazio, toda vez, comendo
      // minutos. Não casou no topo → conversão pela URL. Nada no meio.
      const rImp = await importarPendentesPorUrl(pendentes, antes, Math.max(0, espaco - contaNovos()), limite);
      const partida = rImp.atual != null ? rImp.atual : antes;
      const rBusca = { adicionados: [], jaEstavam: [], naoCresceram: [], atual: null };
      const entraram = [...rImp.adicionados];
      const atualAgora = partida;
      const jaTodos = [...jaEstavam(), ...rImp.jaEstavam];
      const resolvidos = entraram.length + jaTodos.length;
      return {
        ok: entraram.length > 0,
        motivo: entraram.length
          ? undefined
          : rImp.motivo === "cheia"
            ? "cheia"
          : ambiguos.size
            ? "ambiguos"
            : resolvidos && !pendentes.size
              ? "nadaNovo"
              : rImp.motivo || "naoEncontrados",
        examinou: true,
        limiteReal: rImp.motivo === "cheia" ? atualAgora : undefined,
        atual: atualAgora,
        cresceu: antes != null && atualAgora != null ? atualAgora - antes : null,
        adicionados: entraram,
        porBusca: rBusca.adicionados,
        importados: rImp.adicionados,
        importTentados: rImp.tentados,
        importNaoCresceu: [...rBusca.naoCresceram, ...rImp.naoCresceram],
        jaEstavam: jaTodos,
        ambiguos: [...ambiguos],
        pendentes: [...pendentes.keys()],
        log,
      };
    }
    if (!novos.length && !incertos.length) {
      await fecharModais();
      return {
        ok: false,
        motivo: semCards ? "gridVazio" : ambiguos.size ? "ambiguos" : pendentes.size ? "naoEncontrados" : "nadaNovo",
        examinou: true,
        atual: antes,
        adicionados: [],
        jaEstavam: jaEstavam(),
        ambiguos: [...ambiguos],
        pendentes: [...pendentes.keys()],
        log,
      };
    }

    if (simular) {
      await fecharModais();
      return {
        ok: true,
        simulado: true,
        atual: antes,
        adicionados: novos.map((n) => n.codigo),
        ambiguos: [...ambiguos],
        pendentes: [...pendentes.keys()],
        log,
      };
    }

    if (cancelado) {
      await fecharModais();
      return { ok: false, motivo: "cancelado", examinou: true, ...parcialBase() };
    }
    const confirmar = acharPorTexto(["confirmar"], "button,div,span");
    if (!confirmar) {
      await fecharModais();
      return { ok: false, motivo: "semConfirmar", examinou: true, ...parcialBase() };
    }
    if (selecaoVelhaRestante > 0) {
      await fecharModais();
      return { ok: false, motivo: "selecaoVelha", examinou: true, ...parcialBase() };
    }
    // Última conferência: o contador da janela tem de bater com o que NÓS marcamos. Mais que
    // isso é seleção antiga que entraria junto — limpa de novo; se continuar, não confirma.
    {
      const nossos = novos.length + incertos.length;
      const raizC = containerModalFavoritos();
      let contador = contadorDeSelecionados(botaoConfirmar(raizC), raizC);
      if (contador != null && contador > nossos) {
        reg(`contador mostra ${contador} selecionado(s) e marcamos ${nossos}: limpando seleção antiga antes de confirmar`);
        await limparMarcacoesVelhas();
        const raizD = containerModalFavoritos();
        contador = contadorDeSelecionados(botaoConfirmar(raizD), raizD);
        if (contador != null && contador > nossos) {
          reg(`ainda ${contador} selecionado(s) para ${nossos} nossos: NÃO confirmo — levaria produto antigo junto`);
          await fecharModais();
          return { ok: false, motivo: "selecaoVelha", examinou: true, ...parcialBase() };
        }
      }
    }
    // Registra ANTES de clicar: se o service worker hibernar ou der exceção depois daqui,
    // ainda saberemos que a confirmação foi disparada (evita reabrir tudo e duplicar).
    try {
      await chrome.storage.local.set({ bagConfirmado: { codigos: novos.map((n) => n.codigo), at: Date.now() } });
    } catch {
      /* ignore */
    }
    realClick(confirmar);
    await esperarContagemMudar(antes, 4000);

    const depois = contarSacola();
    reg(`sacola depois: ${depois == null ? "?" : depois}`);
    const cresceu = antes != null && depois != null ? depois - antes : null;
    // Só fecha tudo se não houver mais nada a importar: o Importar via URL usa a mesma
    // "Lista de produtos", e reabri-la (mouse em "Produtos", esperar a janela) custava segundos.
    if (!importaveis().length) await fecharModais();
    else if (modalFavoritosAberto()) await fecharModais();
    // Marcações incertas: o que a contagem subiu ALÉM dos marcados com sinal é deles.
    const extras = cresceu != null ? cresceu - novos.length : 0;
    if (incertos.length) {
      if (extras >= incertos.length) {
        for (const par of incertos) novos.push({ ...par.item, jaEstava: false });
        reg(`entraram (confirmado pela contagem): ${incertos.map((p) => p.item.codigo).join(", ")}`);
      } else {
        // não entraram (ou não dá para saber quais): voltam a pendentes — o Importar via URL
        // cobre, e se já estiverem lá a contagem não sobe e o item sai do lote.
        for (const par of incertos) pendentes.set(par.item.codigo, par.item);
        reg(`marcação incerta não confirmada pela contagem (+${extras} além dos marcados): ${incertos.map((p) => p.item.codigo).join(", ")}`);
      }
    }
    // Só é sucesso se a sacola cresceu exatamente o que marcamos. Crescer menos significa que
    // parte não entrou — devolvemos esses códigos ao lote em vez de dá-los como adicionados.
    const confirmado = cresceu != null && cresceu >= novos.length;
    const parcial = cresceu != null && cresceu > 0 && cresceu < novos.length;
    const alem = cresceu != null ? cresceu - novos.length - incertos.length : 0;
    if (alem > 0) reg(`ATENÇÃO: a sacola cresceu ${cresceu}, mas marcamos ${novos.length + incertos.length}: ${alem} produto(s) antigo(s) que a janela tinha como selecionados entraram junto. Confira a Lista de produtos.`);
    if (!confirmado) reg(`entrada não confirmada (antes=${antes}, depois=${depois == null ? "?" : depois}, marcados=${novos.length})`);
    // A Shopee recusou por LIMITE (o dela pode ser menor que o configurado, ou a contagem lida
    // pode estar defasada): parar aqui. Tentar o Importar via URL em sacola cheia não adiciona
    // nada — e pior, "não cresceu" seria lido como "já estava" e o produto sairia do lote.
    if (!confirmado && (limiteVistoNestaRodada || avisoDeLimite())) {
      reg(`a Shopee avisou que a sacola está no limite (${depois == null ? "?" : depois} produtos): paro aqui, sem Importar via URL; tento de novo quando houver vaga`);
      await fecharModais();
      for (const n of novos) pendentes.set(n.codigo, n); // não entraram: continuam no lote
      return { ok: false, motivo: "cheia", limiteReal: depois, examinou: true, atual: depois, cresceu, adicionados: [], jaEstavam: jaEstavam(), ambiguos: [...ambiguos], pendentes: [...pendentes.keys()], log };
    }

    // Sobrou item com link que não apareceu em "Meus Favoritos"? "Importar via URL" resolve.
    let importados = [];
    let porBusca = [];
    let importJa = [];
    let importTentados = [];
    let importNaoCresceu = [];
    let atualFinal = depois;
    let cresceuFinal = cresceu;
    // Mesma ordem do outro caminho ("nenhum entrou"): o LINK primeiro. Ele é exato (guardado ao
    // favoritar) e resolve num passo; a busca por nome é lenta e pode não achar — fica de
    // reserva para produto sem link ou que a conversão recusou. Aqui a ordem estava invertida
    // e um produto favoritado ia parar na barra de busca em vez de ser convertido.
    if (confirmado && importaveis().length && atualFinal != null && atualFinal < limite) {
      const rImp = await importarPendentesPorUrl(pendentes, atualFinal, Math.max(0, limite - atualFinal), limite);
      importados = [...importados, ...rImp.adicionados];
      importJa = [...importJa, ...rImp.jaEstavam];
      importTentados = rImp.tentados;
      importNaoCresceu = [...importNaoCresceu, ...rImp.naoCresceram];
      if (rImp.atual != null) atualFinal = rImp.atual;
      if (rImp.cresceu != null) cresceuFinal = (cresceuFinal || 0) + rImp.cresceu;
    }
    // (busca por nome abolida — ver comentário no caminho "nenhum entrou")
    return {
      ok: confirmado,
      parcial,
      entraramAlem: alem > 0 ? alem : undefined,
      limiteReal: limiteVistoNestaRodada ? atualFinal : undefined,
      motivo: confirmado ? undefined : parcial ? "parcial" : "semConfirmacao",
      examinou: true,
      atual: atualFinal,
      cresceu: cresceuFinal,
      // Em entrada parcial não sabemos QUAIS entraram: nada é removido do lote (a próxima
      // rodada vê "já estava" e resolve sozinha), o que é melhor que perder produtos.
      adicionados: confirmado ? [...novos.map((n) => n.codigo), ...porBusca, ...importados] : [],
      porBusca,
      importados,
      importTentados,
      importNaoCresceu,
      jaEstavam: [...jaEstavam(), ...importJa],
      ambiguos: [...ambiguos],
      pendentes: [...pendentes.keys()],
      log,
    };
  }

  // ---------- Buscar dentro de "Meus Favoritos" ----------
  // Quando outra pessoa (ou um parceiro) favorita muita coisa, os produtos recém-favoritados
  // deixam de estar no topo. Em vez de rolar a lista (proibido) ou converter a URL (lento),
  // usamos o campo "Buscar produtos" da própria janela: o produto volta para o topo sozinho.

  /** O campo "Buscar produtos" da janela de favoritos (não o campo de URL). */
  function campoBuscaFavoritos() {
    const raiz = containerModalFavoritos() || document;
    const base = raiz && raiz.querySelectorAll ? raiz : document;
    const inputs = Array.from(base.querySelectorAll('input:not([type="checkbox"]):not([type="hidden"])')).filter(visivel);
    return inputs.find((i) => /produt|usca|pesquis/i.test(i.getAttribute("placeholder") || "")) || null;
  }

  /** Termo de busca: as primeiras palavras do nome (nome inteiro costuma não achar nada). */
  /** Termo para o campo "Buscar produtos" de Meus Favoritos.
   *  As 4 primeiras palavras do nome inteiro traziam "Kit", "Promoção", "Original" e qualquer
   *  lixo do começo — e a busca da Shopee, por substring, filtrava para o VAZIO toda vez.
   *  Agora: só palavras de conteúdo, as 2 mais longas (mais distintivas), na ordem do nome. */
  function termoDeBusca(nome) {
    const conteudo = palavrasDeConteudo(nome);
    if (!conteudo.length) return String(nome || "").trim().slice(0, 30);
    return conteudo
      .map((w, i) => ({ w, i }))
      .sort((x, y) => y.w.length - x.w.length || x.i - y.i)
      .slice(0, 2)
      .sort((x, y) => x.i - y.i)
      .map((x) => x.w)
      .join(" ");
  }

  /** Digita o termo e espera o grid trocar. Devolve os cards do resultado. */
  async function buscarNosFavoritos(termo) {
    const campo = campoBuscaFavoritos();
    if (!campo) return null;
    const antes = cardsFavoritos()
      .map((c) => c.titulo)
      .join("|");
    campo.focus();
    setNativeValue(campo, termo);
    try {
      campo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
      campo.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, bubbles: true }));
    } catch {
      /* ignore */
    }
    await esperar(() => cardsFavoritos().map((c) => c.titulo).join("|") !== antes, 1500, 150);
    await esperarGridEstavel(2500); // o resultado da busca também leva um instante para desenhar
    return cardsFavoritos();
  }

  /** Marca UM produto usando a busca da janela de favoritos e confirma. Confere pela contagem. */
  async function adicionarUmPorBusca(item, atualAntes) {
    if (!(await abrirGridFavoritos())) return { ok: false, motivo: "tela" };
    const termo = termoDeBusca(item.nome);
    if (!termo) return { ok: false, motivo: "semNome" };
    const cards = await buscarNosFavoritos(termo);
    if (!cards) {
      reg(`busca ${item.codigo}: não achei o campo "Buscar produtos"`);
      return { ok: false, motivo: "semCampo" };
    }
    const par = casarLoteComCards([item], cards)[0];
    if (!par || par.status !== "ok") {
      reg(`busca "${termo}" (${item.codigo}): ${cards.length} resultado(s), ${par && par.status === "ambiguo" ? "ambíguo" : "nenhum casou"}`);
      return { ok: false, motivo: par && par.status === "ambiguo" ? "ambiguo" : "naoAchado" };
    }
    const m = await marcarCard(par.card);
    if (m.status === "jaMarcado") {
      reg(`busca ${item.codigo}: já estava marcado/na sacola`);
      await fecharModais();
      return { ok: true, jaEstava: true };
    }
    if (m.status === "indisponivel") {
      reg(`busca ${item.codigo}: indisponível (checkbox desabilitado)`);
      return { ok: false, motivo: "indisponivel" };
    }
    const conf = acharPorTexto(["confirmar"], "button,div,span", true);
    if (!conf || !confirmarHabilitado()) {
      reg(`busca ${item.codigo}: "Confirmar" não ficou disponível`);
      await fecharModais();
      return { ok: false, motivo: "semConfirmar" };
    }
    realClick(conf);
    await sleep(2000);
    await esperar(() => !modalFavoritosAberto(), 6000);
    const depois = contarSacola();
    await fecharModais();
    const entrou = depois != null && atualAntes != null && depois >= atualAntes + 1;
    reg(`busca ${item.codigo} ("${termo}"): sacola ${atualAntes} → ${depois == null ? "?" : depois} ${entrou ? "(entrou)" : "(não cresceu — já estava lá)"}`);
    return { ok: entrou, depois, motivo: entrou ? undefined : "naoCresceu" };
  }

  /** Tenta pela busca todos os pendentes que têm nome. */
  async function adicionarPendentesPorBusca(pendentes, atualInicial, espaco, limite) {
    const adicionados = [];
    const jaEstavam = [];
    const naoCresceram = [];
    let atual = atualInicial;
    for (const item of [...pendentes.values()]) {
      if (!item.nome) continue;
      if (adicionados.length >= espaco || (atual != null && atual >= limite)) break;
      const r = await adicionarUmPorBusca(item, atual);
      if (r.ok && r.jaEstava) {
        jaEstavam.push(item.codigo);
        pendentes.delete(item.codigo);
      } else if (r.ok) {
        adicionados.push(item.codigo);
        pendentes.delete(item.codigo);
        atual = r.depois;
      } else if (r.motivo === "naoCresceu") {
        naoCresceram.push(item.codigo);
        pendentes.delete(item.codigo);
      }
      await sleep(200);
    }
    return { adicionados, jaEstavam, naoCresceram, atual };
  }

  // ---------- Importar via URL (produto favoritado que não aparece em "Meus Favoritos") ----------

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** A Shopee avisou que a sacola está no limite? (texto normalizado, sem acento) Vale para o
   *  aviso que aparece ao confirmar E para o que fica na janela quando ela já abre cheia. */
  const RE_LIMITE = /(limite|maximo) (maximo )?de produtos|maximo de \d+ produtos|atingiu o (limite|maximo)|(sacola|lista) (esta |ja esta )?cheia|nao (e possivel|da para|pode) adicionar mais|excede(u)? o (limite|maximo)/;
  function avisoDeLimite() {
    try {
      return RE_LIMITE.test(norm((document.body.textContent || "").slice(0, 60000)));
    } catch {
      return false;
    }
  }
  let limiteVistoNestaRodada = false;
  const abaImportar = () => acharPorTexto(["importar via url", "importar via"], "div,span,li,button,a");
  /** Aviso da Shopee de que o produto do link já está na lista (texto normalizado, sem acento). */
  const RE_JA_NA_LISTA = /\bja (foi |esta |se encontra )?(adicionad|na (lista|sacola)|inclu|cadastrad)/;

  /** Abre a janela "Adicionar Produtos" na aba "Importar via URL". */
  async function abrirImportarPorUrl() {
    if (!(await abrirListaProdutos())) return false;
    if (!abaImportar()) {
      const add = acharPorTexto(["adicionar produtos relacionados", "adicionar produtos relacionado"]);
      if (!add) {
        reg("importar: não achei '+ Adicionar produtos relacionados'");
        return false;
      }
      realClick(add);
      if (!(await esperar(() => !!abaImportar(), 10000))) {
        reg("importar: a janela 'Adicionar Produtos' não abriu");
        return false;
      }
    }
    // Seleção pendente na janela (de Meus Favoritos) entra junto no Confirmar da importação — a
    // seleção é da janela inteira. SEMPRE passa por Meus Favoritos e limpa antes (o contador
    // pode não existir; confiar só nele deixava produto antigo entrar junto).
    if (abaFavoritos()) {
      realClick(abaFavoritos());
      await esperarGridEstavel(2500);
      const limpeza = await limparMarcacoesVelhas();
      if (limpeza.restantes > 0) {
        reg(`importar: ${limpeza.restantes} produto(s) antigos continuam selecionados fora da vista — não importo, para não levá-los junto`);
        await fecharModais();
        return false;
      }
    }
    const aba = abaImportar();
    realClick(aba);
    await esperar(() => !!campoUrl(), 1500, 80);
    return true;
  }

  /** Campo de URL da aba Importar (não o "Buscar produtos"). */
  function campoUrl() {
    const raiz = containerModalFavoritos() || (abaImportar() && abaImportar().parentElement?.parentElement) || document;
    const base = raiz && raiz.querySelectorAll ? raiz : document;
    const inputs = Array.from(base.querySelectorAll('input:not([type="checkbox"]):not([type="hidden"]), textarea')).filter(visivel);
    const porDica = inputs.find((i) => /url|link|http|cole|colar/i.test(i.getAttribute("placeholder") || ""));
    if (porDica) return porDica;
    const semBusca = inputs.filter((i) => !/produt|usca/i.test(i.getAttribute("placeholder") || ""));
    return semBusca[semBusca.length - 1] || inputs[inputs.length - 1] || null;
  }

  /** Importa UM produto pelo link e confirma. Verifica pela contagem (+1). */
  async function importarUmPorUrl(item, atualAntes) {
    if (!(await abrirImportarPorUrl())) return { ok: false, motivo: "tela" };
    const campo = campoUrl();
    if (!campo) {
      reg(`importar ${item.codigo}: não achei o campo de URL`);
      return { ok: false, motivo: "semCampo" };
    }
    campo.focus();
    setNativeValue(campo, item.url);
    await sleep(120);
    const conv = acharPorTexto(["converter"], "button,div,span,a", true);
    if (!conv) {
      reg(`importar ${item.codigo}: não achei o botão 'Converter'`);
      return { ok: false, motivo: "semConverter" };
    }
    const raizImp = containerModalFavoritos();
    const textoModal = () => norm(((containerModalFavoritos() || raizImp || document.body).textContent || "").slice(0, 20000));
    const avisoJaAntes = RE_JA_NA_LISTA.test(textoModal());
    realClick(conv);
    reg(`importar ${item.codigo}: link colado e 'Converter' clicado`);
    // Espera o produto aparecer (Confirmar habilita) e confere que é o nosso, se der.
    // Se a tela avisar que o produto JÁ está na lista, o objetivo está cumprido: sai do lote.
    const avisoJa = () => !avisoJaAntes && RE_JA_NA_LISTA.test(textoModal());
    const limiteAntes = avisoDeLimite();
    const avisoLimite = () => !limiteAntes && avisoDeLimite();
    await esperar(() => confirmarHabilitado() || avisoJa() || avisoLimite(), 10000);
    if (avisoLimite()) {
      reg(`importar ${item.codigo}: a Shopee avisou que a sacola está no limite — paro`);
      limiteVistoNestaRodada = true;
      await fecharModais();
      return { ok: false, motivo: "cheia" };
    }
    if (avisoJa()) {
      reg(`importar ${item.codigo}: a tela avisou que o produto já está na lista — não insisto`);
      await fecharModais();
      return { ok: true, jaEstava: true };
    }
    const cards = cardsFavoritos();
    if (cards.length) {
      const pares = casarLoteComCards([item], cards);
      const par = pares[0];
      // Só clica quando o checkbox diz, com certeza, "desmarcado": o produto convertido costuma
      // vir marcado, e um marcador desenhado de estado ilegível seria DESMARCADO pelo clique.
      if (par && par.status === "ok" && estadoDoCard(par.card) === false) {
        const m = await marcarCard(par.card);
        if (m.status !== "marcado" && m.status !== "jaMarcado") reg(`importar ${item.codigo}: marcar o produto convertido: ${m.tentativas.join(" | ") || m.status}`);
      } else if (par && par.status === "naoAchado" && cards.length > 1) {
        reg(`importar ${item.codigo}: apareceram ${cards.length} produtos e nenhum casa com o nome — não confirmo`);
        await fecharModais();
        return { ok: false, motivo: "naoCasou" };
      }
    }
    const conf = acharPorTexto(["confirmar"], "button,div,span", true);
    if (!conf || !confirmarHabilitado()) {
      reg(`importar ${item.codigo}: 'Confirmar' não ficou disponível após converter`);
      await fecharModais();
      return { ok: false, motivo: "semConfirmar" };
    }
    realClick(conf);
    await esperarContagemMudar(atualAntes, 4000);
    const depois = contarSacola();
    if (avisoLimite() || (depois != null && atualAntes != null && depois <= atualAntes && avisoDeLimite())) {
      reg(`importar ${item.codigo}: confirmei e a Shopee avisou que a sacola está no limite — paro`);
      limiteVistoNestaRodada = true;
      await fecharModais();
      return { ok: false, motivo: "cheia" };
    }
    // A janela "Adicionar Produtos" fecha sozinha ao confirmar. A "Lista de produtos" fica
    // aberta para o próximo item: fechar e reabrir tudo custava vários segundos por produto.
    if (modalFavoritosAberto()) await fecharModais();
    const entrou = depois != null && atualAntes != null && depois >= atualAntes + 1;
    reg(`importar ${item.codigo}: sacola ${atualAntes} → ${depois == null ? "?" : depois} ${entrou ? "(entrou)" : "(não cresceu — provavelmente já estava lá)"}`);
    return { ok: entrou, depois, motivo: entrou ? undefined : "naoCresceu" };
  }

  /** Importa os pendentes que têm link, um a um, respeitando o espaço. */
  async function importarPendentesPorUrl(pendentes, atualInicial, espaco, limite) {
    const adicionados = [];
    const jaEstavam = [];
    // Reconfere a "Lista de produtos" AGORA: enquanto a extensão tentava marcar, a dona pode
    // ter marcado e confirmado na mão — importar de novo duplicava o produto na sacola.
    for (const it of jaNaSacolaPorTitulo([...pendentes.values()])) {
      pendentes.delete(it.codigo);
      jaEstavam.push(it.codigo);
      reg(`já está na sacola (aparece na lista de produtos): ${it.codigo} — não importo pela URL`);
    }
    const naoCresceram = []; // converteu e confirmou, mas a sacola não cresceu: já estava lá
    const tentados = []; // tentou importar e NÃO entrou — quem decide desistir é o service worker
    let atual = atualInicial;
    let motivo = null;
    for (const item of [...pendentes.values()]) {
      if (!item.url) continue;
      if (cancelado) {
        motivo = "cancelado";
        break;
      }
      if (adicionados.length >= espaco || (atual != null && atual >= limite)) {
        motivo = "cheia";
        break;
      }
      const r = await importarUmPorUrl(item, atual);
      if (r.ok && r.jaEstava) {
        jaEstavam.push(item.codigo);
        pendentes.delete(item.codigo);
      } else if (r.ok) {
        adicionados.push(item.codigo);
        pendentes.delete(item.codigo);
        atual = r.depois;
      } else if (r.motivo === "cheia") {
        // sacola no limite: os outros também não entrariam — e ficam todos no lote
        motivo = "cheia";
        break;
      } else {
        tentados.push(item.codigo);
        if (r.motivo === "naoCresceu") naoCresceram.push(item.codigo);
        motivo = motivo || r.motivo;
      }
      await sleep(150);
    }
    await fecharModais();
    return { adicionados, jaEstavam, naoCresceram, tentados, atual, cresceu: atualInicial != null && atual != null ? atual - atualInicial : null, motivo };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "bag-run") return false;
    if (rodando) {
      sendResponse({ ok: false, motivo: "jaRodando", log });
      return true;
    }
    rodando = true;
    cancelado = false;
    (async () => {
      try {
        const r = await adicionarNaSacola(msg.lote || [], { modo: msg.modo || "simular", limite: msg.limite || 50 });
        sendResponse(r);
      } catch (e) {
        try {
          await fecharModais();
        } catch {
          /* ignore */
        }
        sendResponse({ ok: false, motivo: "erro", erro: String((e && e.message) || e), log });
      } finally {
        rodando = false;
      }
    })();
    return true;
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "bag-cancel") return false;
    cancelado = true;
    reg("o worker desistiu desta rodada (prazo): paro de mexer na tela");
    sendResponse({ ok: true, rodando });
    return true;
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "bag-count") return false;
    sendResponse({ atual: contarSacola() });
    return true;
  });
})();
