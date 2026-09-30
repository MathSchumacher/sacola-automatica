// Teste da FILA DE FAVORITOS num navegador de verdade: Chromium com a extensão carregada e um
// shopee.com.br de mentira servido localmente (HTTPS na porta 443, certificado autoassinado;
// o Chromium resolve shopee.com.br para 127.0.0.1). Mede o que importa na live: em quanto
// tempo um código sai da fila — favoritado, ou descartado quando não é produto.
//
// Preparar (uma vez):   cd tests && npm install && npx playwright install chromium
// Rodar tudo:           node tests/fila-navegador.cjs
// Um cenário:           node tests/fila-navegador.cjs lista
// Versão antiga:        node tests/fila-navegador.cjs --ref=7761fd9
//
// Cenários (o que a "Shopee" faz com o código ABC-DEF-GHI):
//   produto   a busca redireciona para o produto → favoritado, entra no lote da sacola
//   lista     a busca mostra uma lista de resultados = código inválido → sai da fila NA HORA, sem retry
//   sembarra  a home vem sem barra de busca → falha rápida, sem retry
//   trava     a página nunca responde → o prazo do worker estoura (50 s) e o item ganha UMA
//             nova tentativa no fim da fila (era 120 s + 120 s = 4 min "favoritando…")
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const RAIZ = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const REF = (args.find((a) => a.startsWith("--ref=")) || "").slice(6) || process.env.REF || "";
const pedidos = args.filter((a) => !a.startsWith("--"));

function carregar(nome) {
  try {
    return require(nome);
  } catch {
    console.error(`${nome} não encontrado. Rode:  cd tests && npm install && npx playwright install chromium`);
    process.exit(2);
  }
}

function extensaoDoCommit(ref) {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), "sacolinha-ref-"));
  const arquivos = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", "extension"], { cwd: RAIZ, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const arq of arquivos) {
    const alvo = path.join(destino, arq);
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, execFileSync("git", ["show", `${ref}:${arq}`], { cwd: RAIZ, maxBuffer: 64 * 1024 * 1024 }));
  }
  return { dir: path.join(destino, "extension"), limpar: () => fs.rmSync(destino, { recursive: true, force: true }) };
}

// ---------- a "Shopee" ----------
const HOME = `<html><body><form><input class="shopee-searchbar-input__input" placeholder="Buscar na Shopee" style="width:400px"><button type="button">🔍</button></form>
<script>
const inp = document.querySelector("input"); inp.__reactProps$abc = { onChange() {} };
inp.addEventListener("keydown", (e) => { if (e.key === "Enter") location.href = "/search?keyword=" + encodeURIComponent(inp.value); });
</script></body></html>`;
const LISTA = `<html><body><h2>Resultado da pesquisa para 'ABC-DEF-GHI'</h2>${[1, 2, 3, 4, 5].map((i) => `<a href="/produto-i.1.${i}">Produto ${i}</a>`).join("")}</body></html>`;
const PRODUTO = `<html><head><title>Produto Bom</title></head><body><h1>Produto Bom Demais Mesmo</h1><div style="font-size:30px">R$10,00</div>
<button id="like" aria-label="Favoritar (12)"><svg><path style="fill:rgb(255,255,255)"/></svg>Favoritar (12)</button>
<script>const b = document.getElementById("like"); b.__reactProps$abc = { onClick() {} }; b.addEventListener("click", () => { b.querySelector("path").style.fill = "rgb(238,77,45)"; });</script></body></html>`;

const CENARIOS = {
  produto: { confere: (q, bag) => (q.status === "done" && bag.length === 1) || `esperava favoritado + 1 no lote (status=${q.status}, lote=${bag.length})`, maxSeg: 20 },
  lista: { confere: (q) => (q.status === "failed" && !q.tentativas) || `esperava falha sem retry (status=${q.status}, tentativas=${q.tentativas || 0})`, maxSeg: 10 },
  sembarra: { confere: (q) => (q.status === "failed" && !q.tentativas) || `esperava falha sem retry (status=${q.status}, tentativas=${q.tentativas || 0})`, maxSeg: 15 },
  trava: { confere: (q) => q.status === "failed" || `esperava falha (status=${q.status})`, maxSeg: 110 },
};

function servidor(modo) {
  const { generate } = carregar("selfsigned");
  const pem = generate([{ name: "commonName", value: "shopee.com.br" }], { days: 1 });
  const srv = https.createServer({ key: pem.private, cert: pem.cert }, (req, res) => {
    if (modo === "trava") return; // nunca responde
    let body = HOME;
    if (req.url.startsWith("/search")) body = modo === "produto" ? `<html><body><script>location.href = "/produto-bom-i.111.222"</script></body></html>` : LISTA;
    else if (/-i\.\d+\.\d+/.test(req.url)) body = PRODUTO;
    else if (modo === "sembarra") body = "<html><body><h1>Home sem barra</h1></body></html>";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  return new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen(443, "127.0.0.1", () => res(srv));
  });
}

(async () => {
  const desconhecidos = pedidos.filter((n) => !CENARIOS[n]);
  if (desconhecidos.length) {
    console.error(`cenário desconhecido: ${desconhecidos.join(", ")}. Há: ${Object.keys(CENARIOS).join(", ")}`);
    process.exit(2);
  }
  const nomes = pedidos.length ? pedidos : Object.keys(CENARIOS);
  const { chromium } = carregar("playwright");
  const ref = REF ? extensaoDoCommit(REF) : null;
  const ext = ref ? ref.dir : path.join(RAIZ, "extension");
  let falhas = 0;
  for (const nome of nomes) {
    const c = CENARIOS[nome];
    let srv;
    try {
      srv = await servidor(nome);
    } catch (e) {
      console.error(`não consegui abrir a porta 443 (${e.message}) — o teste precisa dela para fingir shopee.com.br`);
      process.exit(2);
    }
    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), "sacolinha-perfil-"));
    const ctx = await chromium.launchPersistentContext(perfil, {
      channel: "chromium",
      headless: true,
      ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--host-resolver-rules=MAP shopee.com.br 127.0.0.1", "--ignore-certificate-errors", "--no-proxy-server"],
    });
    try {
      let [sw] = ctx.serviceWorkers();
      if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
      const t0 = Date.now();
      await sw.evaluate(async () => chrome.storage.local.set({ settings: { enabled: true, openMode: "tab", minDelayMs: 1500, maxDelayMs: 1500 } }));
      await sw.evaluate(async () => enqueue(parseProductRefs("ABC-DEF-GHI", { linhaDeChat: false }), "manual"));
      let q = null;
      let bag = [];
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const st = await sw.evaluate(() => chrome.storage.local.get(["queue", "bag"]));
        q = (st.queue || [])[0];
        bag = st.bag || [];
        if (q && q.status !== "pending" && q.status !== "working") break;
        if (Date.now() - t0 > 300000) break;
      }
      const seg = (Date.now() - t0) / 1000;
      let erro = !q || q.status === "pending" || q.status === "working" ? "não terminou em 300 s" : null;
      if (!erro) {
        const r = c.confere(q, bag);
        if (r !== true) erro = r;
      }
      if (!erro && seg > c.maxSeg) erro = `demorou ${seg.toFixed(0)} s (máximo ${c.maxSeg} s)`;
      if (erro) falhas++;
      console.log(`${erro ? "FALHOU" : "ok    "} ${nome.padEnd(9)} ${seg.toFixed(0).padStart(4)}s  ${q ? `${q.status} · "${q.note}"${q.tentativas ? ` · ${q.tentativas} retry` : ""}` : ""}${erro ? `\n         — ${erro}` : ""}`);
    } finally {
      await ctx.close();
      fs.rmSync(perfil, { recursive: true, force: true });
      srv.close();
    }
  }
  if (ref) ref.limpar();
  console.log(`\n${falhas ? `${falhas} cenário(s) FALHARAM` : "todos os cenários passaram"}`);
  process.exit(falhas ? 1 : 0);
})().catch((e) => {
  console.error("ERRO", e);
  process.exit(2);
});
