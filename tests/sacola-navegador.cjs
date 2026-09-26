// Teste da SACOLA num navegador de verdade: Chromium com a extensão carregada (content script no
// mundo isolado, como no Brave) sobre uma réplica do painel da live feita em React 18.
//
// O bag-test.cjs usa um DOM de mentira — não reproduz <label>, nós que saem da página, shadow DOM,
// o React revertendo um checkbox controlado... Foi por isso que "o checkbox não marca" passou
// por ele e persistiu da 1.9.0 para a 1.9.1. Este teste mede o que acontece na tela.
//
// Preparar (uma vez):   cd tests && npm install && npx playwright install chromium
// Rodar tudo:           node tests/sacola-navegador.cjs
// Um cenário:           node tests/sacola-navegador.cjs desenhado
// Versão antiga:        node tests/sacola-navegador.cjs --ref=7761fd9   (a extensão daquele commit)
// Ver na tela:          node tests/sacola-navegador.cjs antd --ver
// Log de cada cenário:  node tests/sacola-navegador.cjs antd --detalhe
// (também valem como variáveis de ambiente: REF=..., VER=1, DETALHE=1)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const RAIZ = path.resolve(__dirname, "..");
const PAGINA = path.join(__dirname, "sacola-navegador");

function carregarPlaywright() {
  try {
    return require("playwright");
  } catch {
    try {
      const global = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
      return require(path.join(global, "playwright"));
    } catch {
      console.error("Playwright não encontrado. Rode:  cd tests && npm install && npx playwright install chromium");
      process.exit(2);
    }
  }
}

function arquivoDoReact(nome) {
  try {
    // o "exports" do React não publica umd/: resolve a pasta do pacote e monta o caminho
    const arq = path.join(path.dirname(require.resolve(`${nome}/package.json`)), "umd", `${nome}.production.min.js`);
    fs.accessSync(arq);
    return arq;
  } catch {
    console.error("React 18 não encontrado. Rode:  cd tests && npm install");
    process.exit(2);
  }
}

/** A extensão como estava num commit (REF=...), extraída com o próprio git. */
function extensaoDoCommit(ref) {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), "sacolinha-ref-"));
  const arquivos = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", "extension"], { cwd: RAIZ, encoding: "utf8" }).split("\n").filter(Boolean);
  if (!arquivos.length) throw new Error(`nada em extension/ no commit ${ref}`);
  for (const arq of arquivos) {
    const alvo = path.join(destino, arq);
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, execFileSync("git", ["show", `${ref}:${arq}`], { cwd: RAIZ, maxBuffer: 64 * 1024 * 1024 }));
  }
  return { dir: path.join(destino, "extension"), limpar: () => fs.rmSync(destino, { recursive: true, force: true }) };
}

// ---------- lote e cenários ----------

const DESEMPENADEIRA = { codigo: "AAA-BBB-CCC", nome: "Desempenadeira plástica para reboco 25cm Lisa", itemId: 1, preco: 14.56, url: "https://shopee.com.br/x-i.111.1" };
const ALCA = { codigo: "DDD-EEE-FFF", nome: "Alça De Pintura Em Spray Ergonômica Profissional", itemId: 2, preco: 22.9, url: "https://shopee.com.br/x-i.111.2" };
const FORA_DO_TOPO = { codigo: "GGG-HHH-III", nome: "Produto que não está nos favoritos de jeito nenhum", itemId: 9, preco: 9.9, url: "https://shopee.com.br/x-i.111.9" };
// O perfume já está na sacola; com este nome a "Lista de produtos" não o reconhece (não é igual),
// então quem decide é o checkbox da grade — que está marcado e não pode ser clicado.
const PERFUME = { codigo: "PPP-QQQ-RRR", nome: "Perfume Cebolinha Turma Da Mônica Colônia 30 ml Infantil", itemId: 5, preco: 19.9, url: "https://shopee.com.br/x-i.111.5" };

// cada cenário: variante da página (+ extras), lote, modo e o que mais precisa ser verdade
const CENARIOS = {
  antd: { v: "antd" },
  antdCard: { v: "antdCard" },
  desenhado: { v: "desenhado", nota: "1.9.1: 'checkbox' na classe → 'já estava na sacola', nenhum clique" },
  desenhadoMudo: { v: "embaralhado", extras: ["semContador", "cardNeutro"], nota: "sem classe de estado nem contador: só a cor muda" },
  irmao: { v: "irmao" },
  mousedown: { v: "mousedown" },
  shadow: { v: "shadow", nota: "1.9.1: 'marcação incerta', sacola +0" },
  remount: { v: "remount", nota: "1.9.1: do 2º em diante clicava em nó fora da página" },
  async: { v: "async", nota: "1.9.1: o 2º clique desmarcava a seleção ainda no servidor" },
  asyncLento: { v: "asyncLento", nota: "servidor de 3 s: espera enquanto o card mostra que está carregando" },
  tardio: { v: "tardio" },
  instavel: { v: "instavel" },
  hover: { v: "hover" },
  link: { v: "link", nota: "o clique nunca pode abrir o link do produto na aba da live" },
  insere: { v: "insere", nota: "favorito novo empurra a grade: nunca marcar o produto errado" },
  confiavel: { v: "confiavel", nota: "só clique confiável: o label.click() é repassado ao input como confiável" },
  simular: { v: "desenhado", modo: "simular" },
  // Nada marca: os dois precisam entrar pelo link, e o log precisa dizer o que foi tentado e como
  // o card é — é com isso que se ajusta a extensão quando a Shopee muda a tela.
  semEfeito: {
    v: "ignora",
    pelaUrl: true,
    confere: (r) =>
      (["AAA-BBB-CCC", "DDD-EEE-FFF"].every((c) => (r.importados || []).includes(c)) &&
        (r.log || []).some((l) => /^tentativas em AAA-BBB-CCC: .*nada mudou/.test(l)) &&
        (r.log || []).some((l) => /^estrutura do card: checkbox: .*input\.ant-checkbox-input/.test(l))) ||
      "devia ir pela URL e registrar tentativas + estrutura do card",
  },
  foraDoTopo: { v: "antd", lote: [DESEMPENADEIRA, ALCA, FORA_DO_TOPO], confere: (r) => (r.importados || []).includes("GGG-HHH-III") || "o 3º devia entrar pela URL" },
  jaMarcado: { v: "desenhado", lote: [DESEMPENADEIRA, ALCA, PERFUME], confere: (r) => (r.jaEstavam || []).includes("PPP-QQQ-RRR") || "o perfume devia constar como 'já estava'" },
  jaMarcadoIlegivel: {
    v: "embaralhado",
    extras: ["semContador", "cardNeutro"],
    lote: [DESEMPENADEIRA, ALCA, PERFUME],
    nota: "já marcado sem classe legível: não clica e não afirma 'já está' — vai pelo link",
    confere: (r) => (!(r.jaEstavam || []).includes("PPP-QQQ-RRR") && (r.importados || []).includes("PPP-QQQ-RRR")) || "o perfume devia ir pela URL, sem virar 'já estava'",
  },
};

/** O que precisa ser verdade depois da rodada. Devolve null (passou) ou o motivo da falha. */
function avaliar(c, r, eventos, sacola) {
  if (!r) return "sem resposta da página";
  const quantas = (id) => eventos.filter((e) => new RegExp(`alternar ${id} ->`).test(e)).length;
  if (eventos.some((e) => /LINK CLICADO/.test(e))) return "clicou no link do produto";
  const alheios = eventos.filter((e) => /alternar \d+/.test(e) && !/alternar [12] ->/.test(e));
  if (alheios.length) return `mexeu em produto fora do lote: ${alheios.join("; ")}`;
  if (c.modo === "simular") {
    if (eventos.some((e) => /alternar|CONFIRMAR/.test(e))) return "a simulação clicou em algo";
    if (!r.ok || !r.simulado || JSON.stringify(r.adicionados) !== JSON.stringify(["AAA-BBB-CCC", "DDD-EEE-FFF"])) return "a simulação não relatou os 2 produtos";
    return null;
  }
  if (c.pelaUrl) {
    if (eventos.some((e) => /alternar/.test(e))) return "nada devia ter sido alternado";
    const extra = c.confere(r);
    return extra === true ? null : extra;
  }
  if (quantas(1) !== 1 || quantas(2) !== 1) return `cada produto devia ser alternado 1 vez (1: ${quantas(1)}x, 2: ${quantas(2)}x)`;
  if (!eventos.some((e) => /CONFIRMAR: (1,2|2,1)( |$)/.test(e))) return "os 2 não foram confirmados juntos pelo checkbox";
  if (!r.ok || !sacola.includes(1) || !sacola.includes(2)) return `a sacola não recebeu os 2 (ok=${r.ok}, motivo=${r.motivo})`;
  if (c.confere) {
    const extra = c.confere(r);
    if (extra !== true) return extra;
  }
  return null;
}

(async () => {
  const args = process.argv.slice(2);
  const REF = (args.find((a) => a.startsWith("--ref=")) || "").slice(6) || process.env.REF || "";
  const VER = args.includes("--ver") || !!process.env.VER;
  const DETALHE = args.includes("--detalhe") || !!process.env.DETALHE;
  const pedidos = args.filter((a) => !a.startsWith("--"));
  const desconhecidos = pedidos.filter((n) => !CENARIOS[n]);
  if (desconhecidos.length) {
    console.error(`cenário desconhecido: ${desconhecidos.join(", ")}. Há: ${Object.keys(CENARIOS).join(", ")}`);
    process.exit(2);
  }
  const nomes = pedidos.length ? pedidos : Object.keys(CENARIOS);
  const { chromium } = carregarPlaywright();
  const estaticos = {
    "/__teste/react.js": arquivoDoReact("react"),
    "/__teste/react-dom.js": arquivoDoReact("react-dom"),
    "/__teste/app.js": path.join(PAGINA, "app.js"),
  };
  const ref = REF ? extensaoDoCommit(REF) : null;
  const ext = ref ? ref.dir : path.join(RAIZ, "extension");
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), "sacolinha-perfil-"));
  const ctx = await chromium.launchPersistentContext(perfil, {
    channel: "chromium", // headless novo: o único que carrega extensões
    headless: !VER,
    viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let falhas = 0;
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    const versao = await sw.evaluate(() => chrome.runtime.getManifest().version);
    console.log(`extensão ${versao}${ref ? ` (commit ${REF})` : ""} — ${nomes.length} cenário(s)\n`);
    for (const nome of nomes) {
      const c = CENARIOS[nome];
      const page = await ctx.newPage();
      await page.route("https://live.shopee.com.br/**", (route) => {
        const caminho = new URL(route.request().url()).pathname;
        if (estaticos[caminho]) return route.fulfill({ status: 200, contentType: "application/javascript", body: fs.readFileSync(estaticos[caminho]) });
        return route.fulfill({ status: 200, contentType: "text/html", body: fs.readFileSync(path.join(PAGINA, "pagina.html")) });
      });
      const extras = (c.extras || []).map((e) => `&${e}=1`).join("");
      await page.goto(`https://live.shopee.com.br/pc/live?session=1&cenario=${nome}&v=${c.v}${extras}`);
      await page.waitForSelector(".ferramenta");
      await page.waitForTimeout(800); // o content script sobe no document_idle
      const tabId = await sw.evaluate(async (nome) => (await chrome.tabs.query({})).find((t) => (t.url || "").includes(`cenario=${nome}&`)).id, nome);
      const t0 = Date.now();
      const r = await sw.evaluate(
        async ({ tabId, lote, modo }) => chrome.tabs.sendMessage(tabId, { type: "bag-run", lote, modo, limite: 50 }, { frameId: 0 }),
        { tabId, lote: c.lote || [DESEMPENADEIRA, ALCA], modo: c.modo || "real" },
      );
      const eventos = await page.evaluate(() => window.__eventos);
      const sacola = await page.evaluate(() => (window.__sacola || []).map((p) => p.id || p.titulo));
      const erro = avaliar(c, r, eventos, sacola);
      if (erro) falhas++;
      console.log(`${erro ? "FALHOU" : "ok    "} ${nome.padEnd(18)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s${erro ? `  — ${erro}` : ""}${c.nota ? `\n         (${c.nota})` : ""}`);
      if (erro || DETALHE) {
        console.log("         página:  " + (eventos.join(" | ") || "(nenhum clique registrado)"));
        console.log("         log:\n           " + ((r && r.log) || []).join("\n           "));
      }
      await page.close();
    }
  } finally {
    await ctx.close();
    fs.rmSync(perfil, { recursive: true, force: true });
    if (ref) ref.limpar();
  }
  console.log(`\n${falhas ? `${falhas} cenário(s) FALHARAM` : "todos os cenários passaram"}`);
  process.exit(falhas ? 1 : 0);
})().catch((e) => {
  console.error("ERRO", e);
  process.exit(2);
});
