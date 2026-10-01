// Extrai referências de produto Shopee de um texto (mensagens do chat, colagem manual).
// Carregado como script clássico nos content scripts e importado (via globalThis) no service worker.
(function (root) {
  const RE_FULL = /https?:\/\/(?:[a-z0-9-]+\.)*shopee\.com\.br\/(?:[^\s"'<>]*?)(?:i\.(\d{1,12})\.(\d{5,16})|product\/(\d{1,12})\/(\d{5,16}))/gi;
  const RE_SHORT = /https?:\/\/(?:s\.shopee\.com\.br|br\.shp\.ee|shope\.ee|shp\.ee)\/[A-Za-z0-9_-]{3,}/gi;
  // Código de produto da live: XXX-XXX-XXX, SÓ LETRAS, em QUALQUER caixa
  // (ex.: "adiciona meu ID amiga HFE-NKL-WSN", "DDx-RAG-VZE", "ddx-rag-vze").
  // Dígitos são o que separa código de texto da interface ("162-gos-tei" veio de "162 Gostei").
  // Antes do código aceitamos: nada, ou algo que não seja letra (dígito, espaço, ".", "_"), ou
  // um NOME — 3+ letras seguidas, como o apelido de quem escreveu, que no chat gruda no código
  // ("mariaddx-rag-vze"). Continua rejeitando "BCD-EFG-HIJ" dentro de "ABCD-EFG-HIJ", onde só
  // existe 1 letra antes, e qualquer coisa precedida de traço.
  const RE_CODE = /(?<!-)(?:(?<![A-Za-z])|(?<=[A-Za-z]{3}))([A-Za-z]{3}-[A-Za-z]{3}-[A-Za-z]{3})(?![A-Za-z-])/g;
  // Complemento para apelido CURTO (1 ou 2 letras), onde a regra dos "3+ letras antes" não
  // alcança: "oiCGP-QUL-WZL". Aqui o sinal é a troca de caixa (minúscula → MAIÚSCULA).
  const RE_CODE_GLUED = /(?<=[a-z0-9_.])([A-Z][A-Za-z]{2}-[A-Za-z]{3}-[A-Za-z]{3})(?![A-Za-z-])/g;
  // Código sem/quase sem traços: 9 LETRAS com até 2 traços no meio (ex.: HFENKLWSN, HFE-NKLWSN)
  const RE_CODE_LOOSE = /(?<![A-Za-z-])([A-Za-z](?:[A-Za-z-]{7,9})[A-Za-z])(?![A-Za-z0-9-])/g;
  // Código MAIÚSCULO sem traços colado ao nome do autor ("41j8owoi86APWSCYLNJ", "pkelaineAPWSCYLNJ").
  const RE_CODE_LOOSE_GLUED = /(?<=[a-z0-9_.])([A-Z]{9})(?![A-Za-z-])/g;
  // Palavras de 9 letras comuns em chat de live (evita "ADICIONAR" virar código)
  // Palavras de 9 letras que aparecem em MAIÚSCULAS no chat e não podem virar "código".
  const COMMON_WORDS = new Set([
    "ADICIONAR", "FAVORITOS", "CARRINHOS", "VENDEDORA", "BARATINHA", "BARATINHO",
    "COMPRINHA", "AMIGUINHA", "AMIGUINHO", "SEGUIDORA", "PROMOCOES", "LINDINHOS", "LINDINHAS",
    "OBRIGADAA", "OBRIGADOO", "PARABENSS", "PRODUTOSS", "SHOPEELIV", "ACHADINHO",
    "MASCULINA", "FEMININAS", "MASCULINO", "UMEDECIDA", "ALGODOEIR", "ESPORTIVA", "ESPORTIVO", "ANTIDERRA", "IMPERMEAV", "AUTOMATIC", "PORTATIL", "SILICONES", "ORGANIZAD", "ACESSORIO", "ELETRONIC", "COZINHAAA", "BANHEIROS", "SAPATILHA", "PANTUFAAS", "CAMISETAS", "VESTIDOSS", "CALCINHAS", "CONJUNTOS", "INFANTILL", "TAMANHOOO",
    "PARABENS", "OBRIGADA", "OBRIGADO", "MARAVILHA", "TAMBEMEUU", "COMPRANDO", "ENTRARAM",
    "DESCONTOS", "CUPONZINH", "SORTEIOOO", "QUEROESSE", "QUEROMAIS", "MOSTRAAAA",
    "PRECINHOS", "FRETINHOS", "CHEGANDOO", "APROVEITE", "NOVIDADES", "COMENTARI",
    "SEGUINDOO", "AMEIDMAIS", "LINDEZAAA", "PERFEITOO", "PERFEITAA", "MARAVILHO",
  ]);
  // "ID 1234567890", "id: 1234567890", ou número solto de 8–16 dígitos
  const RE_BARE = /(?:^|[^\d])(\d{8,16})(?![\d])/g;

  /** Parece sequência aleatória (código) e não palavra em português?
   *  Palavra tem vogais espalhadas e não empilha 4 consoantes: "maravilha", "comprando".
   *  Código é sorteado: "fxbnanexe" abre com 4 consoantes seguidas; "hfenklwsn" tem 1 vogal. */
  /** Risada/enrolação, não ID. A regra "ID nunca repete letra adjacente" foi testada contra os
   *  códigos reais da live e é FALSA: DKA-AAU-QSN, DDX-RAG-VZE, CKK-TVE-HTZ, BLY-JMH-HSL têm
   *  par (até trio) adjacente — 4 de 15. O que separa "kkkkkkkkk" e "rsrsrsrsr" de um ID é a
   *  VARIEDADE: um ID sorteado tem 7–8 letras distintas; risada tem 1 ou 2. Corte em ≤3, com
   *  folga larga dos dois lados. Vale para todas as formas: com hífen, sem, colado, manual. */
  function temLetraRepetidaEmSequencia(compact) {
    return new Set(compact.toUpperCase()).size <= 3;
  }

  /** Modelo de português (shared/pt-modelo.js). Se não estiver carregado — não deveria
   *  acontecer, mas um script a menos no manifest não pode parar a live — cai na lista fixa. */
  function parecePalavraPt(token9) {
    const m = root.PtModelo;
    if (m && typeof m.parecePalavraPt === "function") return m.parecePalavraPt(token9);
    return false;
  }

  function pareceAleatorio(nove) {
    const VOGAIS = /[AEIOU]/;
    let vogais = 0;
    let corrida = 0;
    let maiorCorrida = 0;
    for (const c of nove) {
      if (VOGAIS.test(c)) {
        vogais++;
        corrida = 0;
      } else {
        corrida++;
        if (corrida > maiorCorrida) maiorCorrida = corrida;
      }
    }
    return vogais <= 2 || maiorCorrida >= 4;
  }

  /**
   * @returns {{kind:'full'|'short'|'id', itemId?:string, shopId?:string, url?:string, raw:string}[]}
   */
  /** Revalida um código já enfileirado com as regras ATUAIS. Usa o texto de origem quando
   *  existe (é o teste fiel); sem origem, testa o próprio código como uma linha de chat com
   *  um apelido fictício na frente — se nem assim passa, não é código. */
  function codigoAindaValido(code, origem) {
    const alvo = String(code || "").toUpperCase();
    if (!/^[A-Z]{3}-[A-Z]{3}-[A-Z]{3}$/.test(alvo)) return false;
    // Com origem: reparse fiel da mensagem. Sem origem: o hífen pode ter sido inventado por uma
    // regra velha ("tra-nsm-iss" de "transmissao"), então o teste honesto é o token SEM hífen —
    // e aí o modelo de português decide, como decidiria se chegasse hoje pelo chat.
    const texto = origem && String(origem).trim() ? String(origem) : "apelido " + alvo.replace(/-/g, "");
    return parseProductRefs(texto).some((r) => r.kind === "code" && r.code === alvo);
  }

  function parseProductRefs(text, opcoes) {
    // Linha de chat chega como "apelido mensagem"; texto colado no popup não tem apelido.
    const linhaDeChat = !opcoes || opcoes.linhaDeChat !== false;
    const out = [];
    const seen = new Set();
    const push = (ref) => {
      const key =
        ref.kind === "code" ? `code:${ref.code}` : ref.kind === "id" ? `id:${ref.itemId}` : ref.kind === "full" ? `full:${ref.itemId}` : `short:${ref.url}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(ref);
    };
    if (!text) return out;
    let s = String(text);
    let m;
    RE_FULL.lastIndex = 0;
    while ((m = RE_FULL.exec(s))) {
      const shopId = m[1] || m[3];
      const itemId = m[2] || m[4];
      push({ kind: "full", shopId, itemId, url: `https://shopee.com.br/product/${shopId}/${itemId}`, raw: m[0] });
    }
    s = s.replace(RE_FULL, " ");
    RE_SHORT.lastIndex = 0;
    while ((m = RE_SHORT.exec(s))) {
      push({ kind: "short", url: m[0], raw: m[0] });
    }
    s = s.replace(RE_SHORT, " ");
    // remove qualquer outra URL antes de procurar códigos/números soltos (evita pegar ids de tracking)
    s = s.replace(/https?:\/\/\S+/gi, " ");
    const textoOriginal = s;
    // Junta os achados dos dois padrões e ordena pela POSIÇÃO no texto: a ordem em que a
    // pessoa escreveu é a ordem em que os produtos entram na fila.
    const achados = [];
    for (const re of [RE_CODE, RE_CODE_GLUED]) {
      re.lastIndex = 0;
      while ((m = re.exec(s))) achados.push({ pos: m.index, code: m[1].toUpperCase(), raw: m[1] });
    }
    achados.sort((a, b) => a.pos - b.pos);
    for (const a of achados) {
      const compacto = a.code.replace(/-/g, "");
      if (COMMON_WORDS.has(compacto)) continue;
      if (temLetraRepetidaEmSequencia(compacto)) continue; // "kkk-kkk-kkk" não é ID
      push({ kind: "code", code: a.code, raw: a.raw });
    }
    s = s.replace(RE_CODE, " ").replace(RE_CODE_GLUED, " ");
    // Forma sem traços (HFENKLWSN / 41j8owoi86APWSCYLNJ): exige 9 LETRAS MAIÚSCULAS e que não
    // seja palavra comum. É assim que o pessoal manda no chat, colado ao nome de usuário.
    // Forma SEM TRAÇOS: 9 letras viram código e nós completamos os hífens.
    // Ignorar um código é a pior falha possível (some uma venda); uma palavra que escape custa
    // só uma aba aberta à toa. Por isso somos generosos — mas em MINÚSCULAS é preciso separar
    // código de palavra, senão "maravilha" e "comprando" virariam pedido de produto.
    const achadosSoltos = [];
    for (const re of [RE_CODE_LOOSE, RE_CODE_LOOSE_GLUED]) {
      re.lastIndex = 0;
      const colado = re === RE_CODE_LOOSE_GLUED;
      while ((m = re.exec(s))) {
        const antes = s[m.index - 1] || "";
        const depois = s[m.index + m[1].length] || "";
        const depois2 = s[m.index + m[1].length + 1] || "";
        // Pedaço de um endereço ("play-tx-las.livetech.shopee.com.br", "x.y.z"): não é código.
        if (antes === "." || (depois === "." && /[A-Za-z0-9]/.test(depois2))) continue;
        // Com hífen só vale o formato exato 3-3-3 (já tratado acima). "play-tx-las" tinha 9
        // letras e virava PLA-YTX-LAS: reagrupar hífens de outro jeito inventa código.
        if (m[1].includes("-")) continue;
        achadosSoltos.push({ pos: m.index, raw: m[1], colado });
      }
    }
    achadosSoltos.sort((a, b) => a.pos - b.pos);
    // Mensagens do SISTEMA nunca trazem código — e o "x" nelas é um apelido anonimizado pela
    // Shopee (9–10 letras minúsculas aleatórias). Foi assim que "foqqhrygg e 3 entraram!"
    // virou o "código" FOQ-QHR-YGG e abriu uma aba para um produto que ninguém pediu.
    const RE_SISTEMA = /\b(entrou|entraram|est[aá] comprando|est[aã]o comprando|come[cç]ar a seguir|bem-vindo [aà] shopee|compartilhou|curtiu)\b/i;
    const mensagemDoSistema = RE_SISTEMA.test(textoOriginal);
    // O chat chega como "apelido mensagem": o PRIMEIRO token é sempre quem escreveu.
    const primeiroToken = textoOriginal.trim().split(/\s+/)[0] || "";
    for (const a of achadosSoltos) {
      if (linhaDeChat && mensagemDoSistema) continue;
      const compact = a.raw.replace(/-/g, "");
      if (compact.length !== 9) continue;
      if (!/^[A-Za-z]{9}$/.test(compact)) continue; // dígito no meio → não é código
      if (temLetraRepetidaEmSequencia(compact)) continue; // "kkkkkkkkk", "rsrsrsrsr" → risada, não ID
      const CAIXA_ALTA = compact.toUpperCase();
      if (COMMON_WORDS.has(CAIXA_ALTA)) continue;
      // Palavra em português nunca é ID (modelo de bigramas do dicionário pt-BR; sem IA).
      // "transmissao"→"tra-nsm-iss" e "sobremesa"→"sob-rem-esa" nasciam aqui.
      if (parecePalavraPt(CAIXA_ALTA)) continue;
      if (!/^[A-Z]{9}$/.test(compact)) {
        // Minúsculas: nunca o apelido (1º token); depois dele, aceita quando NÃO parece palavra
        // ou quando é a mensagem inteira (apelido + código — é como o ID costuma chegar).
        if (linhaDeChat && a.raw === primeiroToken) continue;
        const sobra = textoOriginal.split(a.raw).join(" ").replace(/\s+/g, " ").trim();
        const sozinho = sobra.split(" ").filter(Boolean).length <= 1;
        if (!pareceAleatorio(CAIXA_ALTA) && !sozinho) continue;
      }
      // sempre em MAIÚSCULAS: a fila usa o código como chave e a busca da Shopee é assim
      const code = `${CAIXA_ALTA.slice(0, 3)}-${CAIXA_ALTA.slice(3, 6)}-${CAIXA_ALTA.slice(6, 9)}`;
      push({ kind: "code", code, raw: a.raw });
    }
    RE_BARE.lastIndex = 0;
    while ((m = RE_BARE.exec(s))) {
      push({ kind: "id", itemId: m[1], raw: m[1] });
    }
    return out;
  }

  function productUrl(shopId, itemId) {
    return `https://shopee.com.br/product/${shopId}/${itemId}`;
  }

  /** Extrai shopId/itemId de uma URL de produto já resolvida. */
  function idsFromUrl(url) {
    const m = /i\.(\d+)\.(\d+)|product\/(\d+)\/(\d+)/.exec(url || "");
    if (!m) return null;
    return { shopId: m[1] || m[3], itemId: m[2] || m[4] };
  }

  root.SacolinhaParse = { parseProductRefs, productUrl, idsFromUrl, codigoAindaValido };
})(typeof globalThis !== "undefined" ? globalThis : self);
