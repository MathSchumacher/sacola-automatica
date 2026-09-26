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

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2), view: window };
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

  function hover(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2), view: window };
    for (const t of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
      try {
        el.dispatchEvent(t.startsWith("pointer") ? new PointerEvent(t, o) : new MouseEvent(t, o));
      } catch {
        /* ignore */
      }
    }
  }

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
    if (cards.length) reg(`sem checkbox reconhecível: usando ${cards.length} card(s) identificados pelo preço`);
    return cards;
  }

  /** Está marcado? Com checkbox real é direto; sem ele, o card selecionado muda de aparência
   *  (classe, borda colorida ou ícone de "check" aparecendo dentro dele). */
  function marcado(c) {
    if (c.input) return c.input.checked === true || c.input.getAttribute("aria-checked") === "true";
    const el = c.container;
    if (!el) return false;
    if (el.getAttribute?.("aria-checked") === "true" || el.getAttribute?.("aria-selected") === "true") return true;
    const cls = String(el.className || "");
    if (/(selected|checked|active|ativo|selecionad)/i.test(cls)) return true;
    for (const filho of el.querySelectorAll ? el.querySelectorAll("div,span,i,svg") : []) {
      const fc = String(filho.className || "");
      if (typeof fc === "string" && /(checked|selected|tick|check)/i.test(fc) && visivel(filho)) return true;
    }
    return false;
  }
  /** Alvos de clique para marcar um card, do mais provável ao mais amplo.
   *  Checkbox estilizado (Ant Design / React): o <input> é invisível; quem recebe o clique de
   *  verdade é o <label> que o envolve ou o <span> do quadrado desenhado ao lado dele. */
  function alvosDeMarcacao(c) {
    const lista = [];
    const inp = c.input;
    if (inp) {
      const label = inp.closest ? inp.closest("label") : null;
      if (label && visivel(label)) lista.push(label);
      const irmao = inp.nextElementSibling;
      if (irmao && visivel(irmao)) lista.push(irmao);
      const pai = inp.parentElement;
      if (pai && pai !== label && visivel(pai)) lista.push(pai);
      lista.push(inp);
    }
    if (c.container) lista.push(c.container);
    const vistos = new Set();
    return lista.filter((el) => el && !vistos.has(el) && vistos.add(el));
  }

  /** Retrato do card para comparar antes/depois do clique: classes, atributos, cores e
   *  quantidade de filhos. Selecionar sempre muda ALGO — cor da borda, ícone de check que
   *  aparece, classe que entra. É o sinal que faltava para o 2º, 3º… produto de uma leva:
   *  o botão "Confirmar" só sai de apagado no primeiro, e sem outro sinal os demais eram
   *  dados como "não consegui marcar" e caíam no Importar via URL à toa. */
  function assinaturaCard(c) {
    const el = c && c.container;
    if (!el) return "";
    const partes = [String(el.className || ""), el.getAttribute?.("aria-checked") || "", el.getAttribute?.("aria-selected") || ""];
    try {
      const cs = getComputedStyle(el);
      partes.push(cs.borderColor, cs.backgroundColor, String(cs.boxShadow || "").slice(0, 40));
    } catch {
      /* fora do navegador */
    }
    const filhos = el.querySelectorAll ? el.querySelectorAll("div,span,i,svg,input,label") : [];
    let marcas = 0;
    for (let i = 0; i < filhos.length && i < 60; i++) {
      const f = filhos[i];
      const fc = String(f.className || "");
      if (/check|select|tick|ativo|marcad/i.test(fc)) marcas++;
      if (f.tagName === "SVG") marcas++;
      if (f.tagName === "INPUT" && f.checked) marcas++;
      // o marcador desenhado pode ser só uma cor de fundo/borda (ou um ::after) num nó pequeno
      if (i < 40) {
        partes.push(fc.slice(0, 30));
        try {
          const cs = getComputedStyle(f);
          partes.push(cs.backgroundColor, cs.borderColor, cs.opacity);
          const ps = getComputedStyle(f, "::after");
          partes.push(ps.content, ps.backgroundColor, ps.opacity, ps.transform);
        } catch {
          /* ignore */
        }
      }
    }
    partes.push("f" + filhos.length, "m" + marcas);
    const marcador = el.querySelector?.('input, [class*="check"], [class*="select"]');
    if (marcador) {
      try {
        const cs2 = getComputedStyle(marcador);
        partes.push(cs2.backgroundColor, cs2.borderColor);
      } catch {
        /* ignore */
      }
    }
    return partes.join("|");
  }

  /** Desabilitado ≠ "já está na sacola": costuma ser produto indisponível/inelegível.
   *  Tratar como "já está" faria o item sumir do lote sem nunca ter entrado. */
  const desabilitado = (c) => !!(c.input && (c.input.disabled === true || c.input.getAttribute("aria-disabled") === "true"));

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
    return true;
  }

  /** Fecha as janelas SEM sair clicando em qualquer "Cancelar" da página (poderia cancelar
   *  a transmissão ou um pedido). Só age dentro da modal e prefere Esc / botão de fechar. */
  async function fecharModais() {
    for (let i = 0; i < 3; i++) {
      const raiz = containerModalFavoritos();
      const alvo =
        (raiz && raiz.querySelector?.('[aria-label*="fechar" i], [aria-label*="close" i]')) ||
        (raiz ? acharDentro(raiz, ["cancelar"]) : null);
      if (alvo && visivel(alvo)) {
        realClick(alvo);
        await sleep(700);
        continue;
      }
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      } catch {
        /* ignore */
      }
      await sleep(500);
      break;
    }
  }

  /** O botão "Confirmar" fica apagado enquanto nada está selecionado — é um bom termômetro. */
  function confirmarHabilitado() {
    const raiz = containerModalFavoritos();
    const btn = (raiz && acharDentro(raiz, ["confirmar"])) || acharPorTexto(["confirmar"], "button,div,span", true);
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
    const janela = Math.min(Math.max(pendentes.size + 3, 4), 8);
    const pronto = await esperarGridEstavel();
    reg(`grid de favoritos: ${pronto.cards} card(s) em ${pronto.ms}ms${pronto.estourou ? " (não estabilizou)" : ""}`);
    const todosCards = cardsFavoritos();
    const cards = todosCards.slice(0, janela);
    reg(`topo de Meus Favoritos: ${cards.length} card(s) examinados (janela ${janela}, ${todosCards.length} visíveis)`);
    if (!todosCards.length) semCards = true;
    const pares = casarLoteComCards([...pendentes.values()], cards);
    for (const par of pares) {
      if (par.status === "naoAchado") {
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
      if (desabilitado(card) && !marcado(card)) {
        reg(`indisponível (checkbox desabilitado): ${par.item.codigo} — ${card.titulo.slice(0, 40)}`);
        continue; // fica em `pendentes`: NÃO é "já está na sacola"
      }
      pendentes.delete(par.item.codigo);
      if (marcado(card)) {
        reg(`já estava na sacola: ${par.item.codigo} — ${card.titulo.slice(0, 40)}`);
        selecionados.push({ ...par.item, jaEstava: true });
        continue;
      }
      if (!simular) {
        const antesConfirmar = confirmarHabilitado();
        const assinaturaAntes = assinaturaCard(card);
        // Três sinais, qualquer um serve: o checkbox marcado, o Confirmar acendendo (só vale
        // para o primeiro da leva) ou o card mudando de aparência.
        const pegou = () => marcado(card) || (!antesConfirmar && confirmarHabilitado()) || assinaturaCard(card) !== assinaturaAntes;
        // O checkbox da Shopee é ESTILIZADO: o <input> real fica invisível e o quadrado que
        // se vê é um <span> irmão dentro de um <label>. Clicar só no input escondido era
        // ignorado pelo React — e, sem sinal, a extensão desistia sem tentar outro alvo. Agora:
        // cascata de alvos, do mais provável ao mais amplo, conferindo o ESTADO após cada um,
        // e parando no primeiro que pegar (clicar de novo depois de pegar desmarcaria).
        for (const alvo of alvosDeMarcacao(card)) {
          if (pegou()) break;
          realClick(alvo);
          if (await esperar(pegou, 700, 100)) break;
        }
        const ok = pegou() || (await esperar(pegou, 800, 200));
        if (!ok) {
          // Nenhum sinal visível — mas o clique pode ter pegado. Em vez de dar como perdido,
          // confirma junto e deixa a CONTAGEM da sacola dizer se entrou.
          incertos.push(par);
          reg(`marcação incerta (sem sinal na tela; confiro pela contagem): ${par.item.codigo} — ${card.titulo.slice(0, 40)}`);
          continue;
        }
      }
      selecionados.push({ ...par.item, jaEstava: false });
      reg(`${simular ? "marcaria" : "marcado"}: ${par.item.codigo} — ${card.titulo.slice(0, 40)}${par.precoDivergente ? " (preço divergente, casou pelo título)" : ""}`);
    }
    if (pendentes.size) reg(`não estavam no topo (vão por Importar via URL se tiverem link): ${[...pendentes.keys()].join(", ")}`);

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
          : ambiguos.size
            ? "ambiguos"
            : resolvidos && !pendentes.size
              ? "nadaNovo"
              : rImp.motivo || "naoEncontrados",
        examinou: true,
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

    const confirmar = acharPorTexto(["confirmar"], "button,div,span");
    if (!confirmar) {
      await fecharModais();
      return { ok: false, motivo: "semConfirmar", examinou: true, ...parcialBase() };
    }
    // Registra ANTES de clicar: se o service worker hibernar ou der exceção depois daqui,
    // ainda saberemos que a confirmação foi disparada (evita reabrir tudo e duplicar).
    try {
      await chrome.storage.local.set({ bagConfirmado: { codigos: novos.map((n) => n.codigo), at: Date.now() } });
    } catch {
      /* ignore */
    }
    realClick(confirmar);
    await sleep(2500);
    await esperar(() => !modalFavoritosAberto(), 6000);

    const depois = contarSacola();
    reg(`sacola depois: ${depois == null ? "?" : depois}`);
    const cresceu = antes != null && depois != null ? depois - antes : null;
    await fecharModais();
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
    if (!confirmado) reg(`entrada não confirmada (antes=${antes}, depois=${depois == null ? "?" : depois}, marcados=${novos.length})`);

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
    if (marcado(par.card)) {
      reg(`busca ${item.codigo}: já estava marcado/na sacola`);
      await fecharModais();
      return { ok: true, jaEstava: true };
    }
    if (desabilitado(par.card)) {
      reg(`busca ${item.codigo}: indisponível (checkbox desabilitado)`);
      return { ok: false, motivo: "indisponivel" };
    }
    const assinaturaAntes = assinaturaCard(par.card);
    const antesConfirmar = confirmarHabilitado();
    const pegou = () => marcado(par.card) || (!antesConfirmar && confirmarHabilitado()) || assinaturaCard(par.card) !== assinaturaAntes;
    realClick(par.card.input || par.card.container);
    await esperar(pegou, 1500, 200);
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
    const aba = abaImportar();
    realClick(aba);
    await sleep(350);
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
    await sleep(250);
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
    await esperar(() => confirmarHabilitado() || avisoJa(), 10000);
    if (avisoJa()) {
      reg(`importar ${item.codigo}: a tela avisou que o produto já está na lista — não insisto`);
      await fecharModais();
      return { ok: true, jaEstava: true };
    }
    const cards = cardsFavoritos();
    if (cards.length) {
      const pares = casarLoteComCards([item], cards);
      const par = pares[0];
      if (par && par.status === "ok" && !marcado(par.card)) {
        realClick(par.card.input || par.card.container);
        await sleep(400);
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
    await sleep(2500);
    await esperar(() => !abaImportar(), 6000);
    const depois = contarSacola();
    await fecharModais();
    const entrou = depois != null && atualAntes != null && depois >= atualAntes + 1;
    reg(`importar ${item.codigo}: sacola ${atualAntes} → ${depois == null ? "?" : depois} ${entrou ? "(entrou)" : "(não cresceu — provavelmente já estava lá)"}`);
    return { ok: entrou, depois, motivo: entrou ? undefined : "naoCresceu" };
  }

  /** Importa os pendentes que têm link, um a um, respeitando o espaço. */
  async function importarPendentesPorUrl(pendentes, atualInicial, espaco, limite) {
    const adicionados = [];
    const jaEstavam = [];
    const naoCresceram = []; // converteu e confirmou, mas a sacola não cresceu: já estava lá
    const tentados = []; // tentou importar e NÃO entrou — quem decide desistir é o service worker
    let atual = atualInicial;
    let motivo = null;
    for (const item of [...pendentes.values()]) {
      if (!item.url) continue;
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
      } else {
        tentados.push(item.codigo);
        if (r.motivo === "naoCresceu") naoCresceram.push(item.codigo);
        motivo = motivo || r.motivo;
      }
      await sleep(250);
    }
    return { adicionados, jaEstavam, naoCresceram, tentados, atual, cresceu: atualInicial != null && atual != null ? atual - atualInicial : null, motivo };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "bag-run") return false;
    if (rodando) {
      sendResponse({ ok: false, motivo: "jaRodando", log });
      return true;
    }
    rodando = true;
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
    if (!msg || msg.type !== "bag-count") return false;
    sendResponse({ atual: contarSacola() });
    return true;
  });
})();
