// Roda em páginas da Shopee. Se esta aba foi aberta pela fila, encontra o botão "Curtir/Favoritar" e clica.
// Também oferece o modo de calibração: a usuária clica no coração uma vez e gravamos o seletor.
(() => {
  const { idsFromUrl } = globalThis.SacolinhaParse;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const LIKE_WORDS = /^(curtir|favoritar|adicionar aos favoritos|like|curtido|favoritado|liked)\b/i;
  const LIKED_WORDS = /^(curtido|favoritado|liked)\b/i;

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function textOf(el) {
    return (el.getAttribute("aria-label") || el.textContent || "").trim();
  }

  /** Heurísticas para achar o botão de favoritar na página do produto. */
  function findLikeButton(calibrated) {
    if (calibrated) {
      try {
        const el = document.querySelector(calibrated);
        if (el && visible(el)) return el;
      } catch {
        /* seletor inválido */
      }
    }
    const candidates = Array.from(document.querySelectorAll("button, [role=button], div, span, a"))
      .filter((el) => visible(el))
      .filter((el) => {
        const t = textOf(el);
        return t.length <= 40 && LIKE_WORDS.test(t.replace(/[\s ]+/g, " ").replace(/\(\d[\d.,]*\)/g, "").trim());
      });
    // prefere o elemento mais interno (menor texto) que seja clicável
    candidates.sort((a, b) => textOf(a).length - textOf(b).length);
    for (const el of candidates) {
      const clickable = el.closest("button, [role=button], a") || el;
      return clickable;
    }
    // fallback: svg de coração com aria-label
    const heart = document.querySelector('[aria-label*="curtir" i], [aria-label*="favorit" i], [aria-label*="like" i]');
    if (heart && visible(heart)) return heart.closest("button, [role=button]") || heart;
    return null;
  }

  function isLiked(btn) {
    const t = textOf(btn).replace(/[\s ]+/g, " ");
    if (LIKED_WORDS.test(t)) return true;
    if (btn.getAttribute("aria-pressed") === "true") return true;
    const cls = (btn.className && String(btn.className)) || "";
    if (/\b(liked|active|selected|is-liked)\b/i.test(cls)) return true;
    // O rótulo é "Favoritar (N)" nos dois estados; quem muda é o CORAÇÃO:
    // preenchido de vermelho = favoritado | vazado (branco/none) = não favoritado.
    return heartFilled(btn);
  }

  /** true quando algum caminho do ícone está preenchido de vermelho (= favoritado). */
  function heartFilled(btn) {
    const svgs = btn.querySelectorAll("svg");
    for (const svg of svgs) {
      const alvos = [...svg.querySelectorAll("path"), svg];
      for (const p of alvos) {
        let f = "";
        try {
          f = getComputedStyle(p).fill || "";
        } catch {
          continue;
        }
        if (!f || f === "none") continue;
        const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(f);
        if (!m) continue;
        const r = +m[1];
        const g = +m[2];
        const b = +m[3];
        const a = m[4] === undefined ? 1 : +m[4];
        if (a < 0.1) continue;
        const branco = r > 240 && g > 240 && b > 240;
        const avermelhado = r > 150 && g < 160 && b < 160;
        if (avermelhado && !branco) return true;
      }
    }
    return false;
  }

  /** Espera o botão chegar no estado desejado (favoritado = true/false). */
  async function waitForState(target, calibrated, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const b = findLikeButton(calibrated);
      if (b && isLiked(b) === target) return true;
      await sleep(300);
    }
    return false;
  }

  /** Alvos possíveis do clique: o handler da Shopee pode estar no ícone, no rótulo ou no
   *  contêiner que envolve os dois. Testamos em cascata, do mais provável ao mais amplo. */
  function likeTargets(btn) {
    const list = [];
    const svg = btn.querySelector("svg");
    if (svg) {
      if (svg.parentElement) list.push(svg.parentElement);
      list.push(svg);
    }
    list.push(btn);
    let p = btn.parentElement;
    for (let i = 0; i < 2 && p; i++) {
      list.push(p);
      p = p.parentElement;
    }
    const seen = new Set();
    return list.filter((e) => {
      if (!e || seen.has(e) || !visible(e)) return false;
      seen.add(e);
      return true;
    });
  }

  const describe = (el) => `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(/\s+/)[0].slice(0, 20) : ""}`;

  /** Garante o estado desejado (favoritado = true/false), tentando cada alvo e conferindo o coração. */
  async function setFavorite(target, calibrated) {
    const tentativas = [];
    for (let rodada = 0; rodada < 2; rodada++) {
      const b = findLikeButton(calibrated);
      if (!b) return { ok: false, motivo: "botão não encontrado", tentativas };
      if (isLiked(b) === target) return { ok: true, tentativas };
      for (const alvo of likeTargets(b)) {
        alvo.scrollIntoView({ block: "center" });
        await sleep(200 + Math.random() * 250);
        const clicado = realClick(alvo);
        const mudou = await waitForState(target, calibrated, 2500);
        tentativas.push(`${describe(alvo)}${clicado ? "" : "(sem evento)"}${mudou ? "=OK" : ""}`);
        if (mudou) {
          // Memoriza o elemento que funcionou: nas próximas vezes acerta de primeira
          // (evita a cascata de tentativas, que é o que fazia demorar).
          if (!calibrated) {
            try {
              chrome.runtime.sendMessage({ type: "calibrated", selector: cssPath(alvo) }, () => void chrome.runtime.lastError);
            } catch {
              /* ignore */
            }
          }
          return { ok: true, tentativas };
        }
      }
      await sleep(1500);
    }
    return { ok: false, motivo: "nenhum alvo respondeu ao clique", tentativas };
  }

  /** Assinatura do botão, para comparar antes/depois do clique. */
  function buttonSignature(btn) {
    const svg = btn.querySelector("svg path") || btn.querySelector("svg");
    let fill = "";
    try {
      if (svg) {
        const cs = getComputedStyle(svg);
        fill = `${cs.fill}|${cs.stroke}`;
      }
    } catch {
      /* ignore */
    }
    return {
      texto: textOf(btn).replace(/\s+/g, " ").slice(0, 60),
      aria: `${btn.getAttribute("aria-pressed") || ""}/${btn.getAttribute("aria-label") || ""}`.slice(0, 60),
      cls: String(btn.className || "").slice(0, 120),
      fill,
    };
  }

  /** "Favoritar (2,7mil)" → 2700 ; "(765)" → 765 ; sem número → null */
  function parseCount(texto) {
    const m = /\(([\d.,]+)\s*(mil|k)?\)/i.exec(texto || "");
    if (!m) return null;
    const n = Number(m[1].replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(n)) return null;
    return m[2] ? Math.round(n * 1000) : n;
  }

  /** Captura o aviso ("toast") que a Shopee mostra após favoritar/desfavoritar. */
  function watchToast(ms) {
    return new Promise((resolve) => {
      const re = /favorit|curtid|adicionad|removid|salvo|lista de desejos|wishlist/i;
      let done = false;
      const finish = (t) => {
        if (done) return;
        done = true;
        obs.disconnect();
        resolve(t);
      };
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            const t = (n.textContent || "").trim().replace(/\s+/g, " ");
            if (t && t.length < 90 && re.test(t)) return finish(t);
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => finish(""), ms);
    });
  }

  /** Clique "de verdade": alguns componentes reagem a mousedown/pointerdown, não a click.
   *  Retorna se o evento realmente chegou ao elemento (prova de que clicamos). */
  function realClick(el) {
    let recebido = false;
    const spy = () => {
      recebido = true;
    };
    el.addEventListener("click", spy, true);
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    try {
      el.dispatchEvent(new PointerEvent("pointerover", opts));
      el.dispatchEvent(new MouseEvent("mouseover", opts));
      el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, button: 0, isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...opts, button: 0 }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...opts, button: 0, isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...opts, button: 0 }));
    } catch {
      /* navegadores antigos */
    }
    el.click();
    el.removeEventListener("click", spy, true);
    return recebido;
  }

  /** Clica no botão e descobre, pelo aviso da Shopee (ou pelo contador), o que aconteceu.
   *  Retorna { estado: "added" | "removed" | "unknown", clicado, toast, before, after } */
  async function toggleFavorite(btn, calibrated) {
    const before = buttonSignature(btn);
    const toastPromise = watchToast(7000);
    btn.scrollIntoView({ block: "center" });
    await sleep(250 + Math.random() * 350);
    const clicado = realClick(btn);
    const toast = await toastPromise;
    await sleep(700);
    const after = buttonSignature(findLikeButton(calibrated) || btn);

    let estado = "unknown";
    if (/remov|retirad|desfavorit|excluíd|excluid/i.test(toast)) estado = "removed";
    else if (/adicionad|favoritad|salvo|curtid/i.test(toast)) estado = "added";
    else {
      const n1 = parseCount(before.texto);
      const n2 = parseCount(after.texto);
      if (n1 != null && n2 != null && n1 !== n2) estado = n2 < n1 ? "removed" : "added";
      else if (LIKED_WORDS.test(after.texto) && !LIKED_WORDS.test(before.texto)) estado = "added";
      else if (!LIKED_WORDS.test(after.texto) && LIKED_WORDS.test(before.texto)) estado = "removed";
    }
    return { estado, clicado, toast, before, after };
  }

  function pageProblem() {
    const url = location.href;
    if (/\/buyer\/login|\/login\b/.test(url)) return { code: "login", message: "não está logada na Shopee" };
    if (/verify|captcha/i.test(url)) return { code: "captcha", message: "verificação/captcha exibido pela Shopee" };
    const bodyText = (document.body?.innerText || "").slice(0, 3000);
    if (/produto não encontrado|não existe|foi removido|item not found/i.test(bodyText)) return { code: "notfound", message: "produto não encontrado" };
    return null;
  }

  const isProductUrl = (href) => /i\.\d+\.\d+|product\/\d+\/\d+/.test(href || "");

  /** Preço principal da página do produto — serve para desempatar produtos de nome parecido
   *  na hora de casar com os cards de "Meus Favoritos". */
  /** Preço principal da página: entre todos os textos "R$…" (ou faixas "R$… - R$…"), o de
   *  MAIOR fonte. Pegar o primeiro do documento trazia frete, parcela ou cupom, e aí o card em
   *  "Meus Favoritos" era rejeitado pelo preço. Devolve faixa (min = max quando é um só). */
  function precoDaPagina() {
    const num = (x) => Number(String(x).replace(/\./g, "").replace(",", "."));
    const cands = Array.from(document.querySelectorAll("div,span,h1,h2,section,p")).filter((e) => visible(e) && e.childElementCount <= 3);
    let melhor = null;
    for (const el of cands) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length > 40) continue;
      const m = /^R\$\s*([\d.]{1,9},\d{2})(?:\s*-\s*R\$\s*([\d.]{1,9},\d{2}))?$/i.exec(t);
      if (!m) continue;
      const a = num(m[1]);
      const b = m[2] ? num(m[2]) : a;
      if (!(a > 0) || !(b > 0)) continue;
      let fonte = 0;
      try {
        fonte = parseFloat(getComputedStyle(el).fontSize) || 0;
      } catch {
        fonte = 0;
      }
      if (!melhor || fonte > melhor.fonte) melhor = { precoMin: Math.min(a, b), precoMax: Math.max(a, b), fonte };
    }
    return melhor ? { preco: melhor.precoMin, precoMin: melhor.precoMin, precoMax: melhor.precoMax } : null;
  }

  /** Nome e preço do produto, lidos DEPOIS de favoritar (a página já rendeu tudo). Espera o
   *  h1 de verdade: ler cedo demais dava "Shopee Brasil" como nome, e com esse nome o card em
   *  "Meus Favoritos" nunca casava — o produto acabava indo para "Importar via URL". */
  async function lerProduto() {
    let name = "";
    for (let i = 0; i < 25; i++) {
      const h1 = (document.querySelector("h1")?.textContent || "").replace(/\s+/g, " ").trim();
      if (h1.length >= 6) {
        name = h1;
        break;
      }
      await sleep(120);
    }
    if (!name) {
      const t = (document.title || "").replace(/\s*[|\-–]\s*Shopee.*$/i, "").trim();
      if (t.length >= 6 && !/^shopee/i.test(t)) name = t;
    }
    // O <h1> segue o idioma da interface (em "English" vem traduzido) mas o título da ABA
    // costuma manter o nome cadastrado pelo vendedor, em pt-BR — que é o que aparece no card
    // de Meus Favoritos. Guardamos os dois: o casamento tenta o da aba primeiro.
    const nomeAba = (document.title || "").replace(/\s*[|\-–]\s*Shopee.*$/i, "").trim();
    const p = precoDaPagina();
    return { name: name.slice(0, 120), nomeAba: nomeAba.length >= 6 && !/^shopee/i.test(nomeAba) ? nomeAba.slice(0, 120) : "", preco: p ? p.preco : null, precoMin: p ? p.precoMin : null, precoMax: p ? p.precoMax : null };
  }

  // ---- busca digitando o código na barra (replica o que a usuária faz na mão) ----

  function findSearchInput() {
    const direct = document.querySelector("input.shopee-searchbar-input__input");
    if (direct && visible(direct)) return direct;
    const inputs = Array.from(document.querySelectorAll("input")).filter(
      (el) => visible(el) && !/hidden|checkbox|radio|file/i.test(el.type || "") && el.getBoundingClientRect().width > 120,
    );
    const byPlaceholder = inputs.find((el) => /busc|pesquis|search/i.test(el.getAttribute("placeholder") || ""));
    return byPlaceholder || inputs[0] || null;
  }

  /** Inputs controlados por React ignoram `el.value = x`: é preciso o setter nativo. */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Enter "de verdade": só eventos de teclado. NÃO submeter o form —
   *  o submit nativo pula o JavaScript da Shopee que resolve o código e leva ao produto,
   *  e a página acaba parada em /search. */
  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  /** Digita caractere a caractere, como uma pessoa — o autocomplete da Shopee reage a isso. */
  /** Cola o texto inteiro no campo (equivalente ao Ctrl+V). Relocaliza o campo e confere o
   *  valor final, porque o React da Shopee pode trocar o elemento no meio. */
  async function colarNoCampo(el, text) {
    let alvo = el;
    alvo.focus();
    alvo.click();
    if (alvo.value) {
      setNativeValue(alvo, "");
      await sleep(80);
      alvo = findSearchInput() || alvo;
    }
    // Caminho principal: setter nativo + evento input de uma vez só. É a mesma via que a
    // digitação letra a letra usava (e que o React da Shopee reconhece), só que num passo.
    alvo.focus();
    setNativeValue(alvo, text);
    // Um keyup no fim, como o teclado faria: é o gatilho do autocomplete e do "tem texto".
    try {
      alvo.dispatchEvent(new KeyboardEvent("keyup", { key: text.slice(-1), bubbles: true }));
    } catch {
      /* ignore */
    }
    await sleep(150);
    alvo = findSearchInput() || alvo;
    if ((alvo.value || "") !== text) {
      // Fallback: colagem "de verdade" pelo comando do editor.
      try {
        alvo.focus();
        if (typeof alvo.select === "function") alvo.select();
        document.execCommand("insertText", false, text);
      } catch {
        /* ignore */
      }
      await sleep(150);
    }
    for (let i = 0; i < 4; i++) {
      alvo = findSearchInput() || alvo;
      if ((alvo.value || "") === text) break;
      alvo.focus();
      setNativeValue(alvo, text);
      await sleep(200);
    }
    return alvo;
  }

  /** Digita letra a letra RELOCALIZANDO o campo a cada tecla: quando o autocomplete abre, a
   *  Shopee (React) troca o elemento do input — segurar a referência antiga trunca o código
   *  (foi assim que "DKA-AAU-QSN" virou "DKA-AA"). Devolve o campo realmente usado. */
  async function typeLikeHuman(el, text) {
    let alvo = el;
    alvo.focus();
    alvo.click();
    setNativeValue(alvo, "");
    await sleep(150);
    let acc = "";
    for (const ch of text) {
      acc += ch;
      const atual = findSearchInput();
      if (atual && atual !== alvo) {
        alvo = atual;
        alvo.focus();
      } else if (!alvo.isConnected) {
        alvo = atual || alvo;
      }
      alvo.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      setNativeValue(alvo, acc);
      alvo.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await sleep(60 + Math.random() * 90);
    }
    // Confere o que ficou escrito e corrige de uma vez se faltou alguma letra.
    for (let i = 0; i < 5; i++) {
      const atual = findSearchInput() || alvo;
      alvo = atual;
      if ((alvo.value || "") === text) break;
      alvo.focus();
      setNativeValue(alvo, text);
      await sleep(250);
    }
    return alvo;
  }

  function clickSearchButton() {
    const btn =
      document.querySelector("button.shopee-searchbar__search-button") ||
      Array.from(document.querySelectorAll("button")).find((b) => visible(b) && /^(buscar|pesquisar|search)?$/i.test(textOf(b)) && b.querySelector("svg"));
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  /** A barra chega no HTML antes de o React da Shopee assumir o controle dela. Colar ANTES
   *  disso é o que fazia o código aparecer, "sumir" (a hidratação zera o campo) e ser colado
   *  de novo. Sinais de que o React já está no campo: o rastreador de valor que ele instala
   *  em inputs controlados, ou as propriedades internas que grava no nó. */
  function reactPronto(el) {
    try {
      if (el._valueTracker) return true;
      return Object.keys(el).some((k) => k.startsWith("__react"));
    } catch {
      return false;
    }
  }

  const CHAVE_BUSCA = "achadinhos_busca";
  /** Linha do tempo da busca (para o popup): sobrevive à navegação até a página do produto. */
  function guardarBusca(texto) {
    try {
      sessionStorage.setItem(CHAVE_BUSCA, texto);
    } catch {
      /* ignore */
    }
  }
  function lerBusca() {
    try {
      const v = sessionStorage.getItem(CHAVE_BUSCA) || "";
      sessionStorage.removeItem(CHAVE_BUSCA);
      return v;
    } catch {
      return "";
    }
  }

  /** Cola o código na barra e dispara a busca. Retorna erro ou null (deu certo, seguir esperando). */
  async function typeCodeInSearch(code) {
    const t0 = Date.now();
    const marcos = [];
    const marca = (m) => marcos.push(`${m} ${Date.now() - t0}ms`);
    const saiuDaHome = () => isProductUrl(location.href) || /\/search/.test(location.href);
    const concluir = () => {
      marca("saiu da home em");
      guardarBusca("busca: " + marcos.join(", "));
      return null;
    };
    let input = null;
    for (let i = 0; i < 150 && !input; i++) {
      if (i % 4 === 0) {
        const prob = pageProblem();
        if (prob) return { ok: false, ...prob, url: location.href };
      }
      input = findSearchInput();
      if (!input) await sleep(120);
    }
    if (!input) return { ok: false, code: "nosearchbox", message: "barra de busca não encontrada na página", url: location.href };

    // Espera SÓ a barra de busca ficar viva (o React assumir o input), e no máximo ~1 s.
    // O resto da home — produtos, banners, imagens — não é usado e não vale espera nenhuma.
    // Sem o sinal no prazo, cola do mesmo jeito: se o React limpar o campo ao assumir,
    // a conferência logo abaixo recola. Melhor recolar do que ficar parado.
    for (let i = 0; i < 12 && !reactPronto(input); i++) {
      await sleep(80);
      input = findSearchInput() || input;
    }
    marca(reactPronto(input) ? "react pronto em" : "sem sinal do react após");

    // "Ctrl+V": cola o código inteiro de uma vez (setter nativo + evento input, o que o React
    // reconhece). Com a barra já hidratada, pega de primeira.
    let campo = await colarNoCampo(input, code);
    marca("colado em");
    // um instante para o estado assentar, como quando a usuária cola e dá Enter
    await sleep(140 + Math.random() * 120);
    // Só dispara o Enter com o código COMPLETO no campo.
    campo = findSearchInput() || campo;
    if ((campo.value || "") !== code) {
      marca("campo zerou, recolando em");
      campo.focus();
      setNativeValue(campo, code);
      await sleep(300);
      campo = findSearchInput() || campo;
      if ((campo.value || "") !== code) {
        return { ok: false, code: "digitacao", message: `não consegui escrever o código inteiro (ficou "${campo.value || ""}")`, url: location.href };
      }
    }
    pressEnter(campo);
    marca("enter em");

    // Dá tempo para o próprio JavaScript da Shopee resolver o código e navegar.
    for (let i = 0; i < 14; i++) {
      await sleep(150);
      if (saiuDaHome()) return concluir();
    }
    // ~2 s sem navegar: o campo pode ter sido trocado pelo React depois da colagem.
    // Reencontra, garante o valor e repete o Enter no nó ATUAL.
    campo = findSearchInput() || campo;
    if ((campo.value || "") !== code) setNativeValue(campo, code);
    campo.focus();
    pressEnter(campo);
    marca("2º enter em");
    for (let i = 0; i < 14; i++) {
      await sleep(150);
      if (saiuDaHome()) return concluir();
    }
    // Ainda nada: a lupa.
    clickSearchButton();
    marca("lupa em");
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      if (saiuDaHome()) return concluir();
    }
    guardarBusca("busca: " + marcos.join(", ") + ", não navegou");
    return null;
  }

  /** Página de busca com código XXX-XXX-XXX: a Shopee redireciona direto ao produto.
   *  Espera o redirecionamento (SPA ou navegação completa); clicar num resultado é só fallback. */
  /** O termo realmente buscado (parâmetro keyword da URL). */
  function keywordDaUrl() {
    try {
      return new URL(location.href).searchParams.get("keyword") || "";
    } catch {
      return "";
    }
  }

  async function runSearchHop(code, refazer) {
    // Buscou com o código truncado/errado? Refaz a busca em vez de reportar "não encontrado".
    if (code && refazer) {
      const kw = keywordDaUrl();
      if (kw && kw.toUpperCase() !== code.toUpperCase()) {
        const err = await typeCodeInSearch(code);
        if (err) return { done: true, result: err };
        await sleep(600);
      }
    }
    // Um código VÁLIDO redireciona para o produto em ~1–2 s. Um código que NÃO EXISTE cai numa
    // página de busca comum ("Resultado da pesquisa para 'xxx-xxx-xxx'", lojas relacionadas,
    // 17 páginas de produtos aleatórios). Ficar 30 s nela era o "insiste no produto que não
    // existe"; e o fallback antigo — clicar no PRIMEIRO resultado — favoritaria um produto
    // qualquer, que iria parar na sacola. Nunca mais: lista de resultados = código inválido.
    for (let i = 0; i < 40; i++) {
      // Redirecionou via SPA para o produto no MESMO documento → segue para o coração aqui mesmo.
      if (isProductUrl(location.href)) return { done: true, result: null };
      const prob = pageProblem();
      if (prob) return { done: true, result: { ok: false, ...prob, url: location.href } };
      const body = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 4000);
      if (/nenhum resultado|não encontramos|no results|não foi encontrado/i.test(body)) {
        return { done: true, result: { ok: false, code: "noresult", message: "busca não reconheceu o código", url: location.href, diag: diagnose() } };
      }
      // Página de resultados de busca montada = a Shopee NÃO reconheceu o código como produto.
      const ehListaDeBusca =
        /resultado da pesquisa para|search results? for|lojas relacionadas a|shops related to/i.test(body) ||
        document.querySelectorAll('a[href*="-i."], a[href*="/product/"]').length >= 4;
      if (ehListaDeBusca) {
        return {
          done: true,
          result: { ok: false, code: "noresult", message: "código não corresponde a nenhum produto (a busca mostrou uma lista, não um produto)", url: location.href, diag: diagnose() },
        };
      }
      await sleep(150);
    }
    return {
      done: true,
      result: { ok: false, code: "noresult", message: "a busca não redirecionou para o produto", url: location.href, diag: diagnose() },
    };
  }

  /** Fotografia do estado da página, para depurar sem precisar de print. */
  function diagnose() {
    const anchors = Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") || "");
    return {
      url: location.href,
      titulo: (document.title || "").slice(0, 60),
      links: anchors.length,
      linksProduto: anchors.filter((h) => /i\.\d+\.\d+|product\/\d+\/\d+/.test(h)).slice(0, 2),
      texto: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 200),
    };
  }

  async function runJob(calibrated, code) {
    // 1) Página inicial + código pendente → digita na barra de busca.
    if (code && !isProductUrl(location.href) && !/\/search/.test(location.href)) {
      const err = await typeCodeInSearch(code);
      if (err) return err;
    }
    // 2) Página de busca → a Shopee redireciona para o produto (ou usamos o 1º resultado).
    if (/\/search/.test(location.href) && !isProductUrl(location.href)) {
      const hop = await runSearchHop(code, true);
      if (!hop.done) return null; // navegando para o produto; o job continua lá
      if (hop.result) return hop.result;
      // redirecionamento SPA concluído: cai no fluxo normal de favoritar abaixo
    }
    // 3) Ainda não é produto? espera um pouco mais (SPA pode redirecionar com atraso)
    for (let i = 0; i < 70 && !isProductUrl(location.href); i++) {
      if (i % 4 === 0) {
        const prob = pageProblem();
        if (prob) return { ok: false, ...prob, url: location.href };
      }
      await sleep(150);
    }
    if (!isProductUrl(location.href)) {
      return { ok: false, code: "noresult", message: "a busca não abriu o produto", url: location.href, diag: diagnose() };
    }
    // Espera a SPA renderizar.
    let btn = null;
    for (let i = 0; i < 150 && !btn; i++) {
      if (i % 4 === 0) {
        const prob = pageProblem();
        if (prob) return { ok: false, ...prob, url: location.href };
      }
      btn = findLikeButton(calibrated);
      if (!btn) await sleep(120);
    }
    const ids = idsFromUrl(location.href) || {};
    if (!btn) return { ok: false, code: "nobutton", message: "botão Curtir/Favoritar não encontrado — use a calibração", url: location.href, ...ids, ...(await lerProduto()) };

    // nome e preço são lidos na hora de devolver o resultado (página inteira já renderizada)
    const base = async () => ({ url: location.href, ...ids, ...(await lerProduto()), busca: lerBusca() || undefined });
    // A página é React: clicar antes dela "hidratar" não faz nada. Em vez de um tempo fixo,
    // segue assim que o próprio botão estiver sob controle do React.
    for (let i = 0; i < 12; i++) {
      const b = findLikeButton(calibrated) || btn;
      if (reactPronto(b)) break;
      await sleep(100);
    }
    await sleep(250);

    const jaFavoritado = isLiked(findLikeButton(calibrated) || btn);

    if (jaFavoritado) {
      // Regra pedida: já favoritado → desfavorita e favorita de novo (sobe para o topo da lista).
      const off = await setFavorite(false, calibrated);
      if (!off.ok) {
        return { ok: false, code: "unlike", message: `não consegui desfavoritar (${off.motivo})`, ...(await base()), diag: { estadoInicial: "favoritado", off } };
      }
      await sleep(800 + Math.random() * 600);
      const on = await setFavorite(true, calibrated);
      if (!on.ok) {
        return { ok: false, code: "refav", message: `removi mas não consegui favoritar de novo (${on.motivo})`, ...(await base()), diag: { off, on } };
      }
      return { ok: true, refavorited: true, ...(await base()) };
    }

    const on = await setFavorite(true, calibrated);
    if (!on.ok) {
      return { ok: false, code: "like", message: `cliquei mas o produto não ficou favoritado (${on.motivo})`, ...(await base()), diag: { estadoInicial: "não favoritado", on } };
    }
    return { ok: true, refavorited: false, ...(await base()) };
  }

  // ---- calibração: grava o seletor do elemento clicado ----
  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      let part = el.tagName.toLowerCase();
      if (el.id) {
        parts.unshift(`#${CSS.escape(el.id)}`);
        break;
      }
      const cls = Array.from(el.classList).filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c)).slice(0, 2);
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "start-calibration") {
      const banner = document.createElement("div");
      banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#ee4d2d;color:#fff;padding:10px;text-align:center;font:14px Segoe UI,sans-serif";
      banner.textContent = "Calibração: clique no botão Curtir/Favoritar deste produto (Esc para cancelar).";
      document.body.appendChild(banner);
      const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const target = e.target.closest("button, [role=button], a") || e.target;
        const selector = cssPath(target);
        chrome.runtime.sendMessage({ type: "calibrated", selector });
        banner.textContent = `Gravado: ${selector}`;
        setTimeout(() => banner.remove(), 2500);
        document.removeEventListener("click", onClick, true);
      };
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", function esc(e) {
        if (e.key === "Escape") {
          banner.remove();
          document.removeEventListener("click", onClick, true);
          document.removeEventListener("keydown", esc);
        }
      });
      sendResponse({ ok: true });
    }
    return false;
  });

  // ---- se esta aba é um trabalho da fila, executa ----
  // A aba pode carregar antes de o "trabalho" ser registrado pelo service worker:
  // perguntamos algumas vezes antes de desistir (em páginas abertas pela usuária, nada acontece).
  const askJob = () =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "get-like-job" }, (resp) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(resp);
      });
    });

  (async () => {
    for (let i = 0; i < 8; i++) {
      const resp = await askJob();
      if (resp && resp.job) {
        const result = await runJob(resp.calibratedSelector, resp.code);
        if (result) chrome.runtime.sendMessage({ type: "like-result", result });
        return;
      }
      await sleep(250);
    }
  })();
})();
