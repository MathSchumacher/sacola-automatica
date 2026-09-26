// Simulador da SACOLA (content-bag.js) — vive no repositório, não em temp.
//
// Uso:  node tests/bag-test.cjs <cenario>        (--ref=<commit> roda o content-bag.js daquele commit)
//
// DOM de mentira: rápido e sem dependências, bom para a LÓGICA (casamento, limite, lote, URL).
// Não reproduz clique em <label>, nós que saem da página, shadow DOM nem o React — o checkbox
// que não marcava passou por aqui da 1.9.0 à 1.9.1. Para a marcação: tests/sacola-navegador.cjs.
//
// Cenários:
//   real               2 do lote no topo → marca os 2, confirma, sacola +2; o 3º (sem link) fica pendente
//   checkboxEstilizado checkbox da Shopee (Ant Design): <input> invisível que IGNORA click(); só o
//                      <label>/<span> desenhado alternam o estado → precisa marcar os 2 mesmo assim
//   simular            modo simulação: relata o que marcaria e não confirma nada
//   cheia              sacola em 50/50 → não clica em nada, motivo "cheia"
//   sobrouComLink      2 no topo + 1 fora do topo COM link → os 2 pelo checkbox, o 3º pela URL
//   semBusca           nada casou no topo, item com link → direto à URL, busca por nome NUNCA roda
//   h1Ingles           nome do lote em inglês (h1 traduzido), nomeAba em pt-BR → casa pela aba
//   ambiguo            um nome casa com 2 cards → AMBÍGUO, não marca (a sacola é pública)
const fs = require("fs");
const path = require("path");
const EXT = path.resolve(__dirname, "..", "extension");
const args = process.argv.slice(2);
const cenario = args.find((a) => !a.startsWith("--")) || "real";
const REF = (args.find((a) => a.startsWith("--ref=")) || "").slice(6) || process.env.REF || "";

class El {
  constructor(tag, text = "", attrs = {}) {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.parentElement = null;
    this._text = text; this.attrs = attrs; this.type = attrs.type || ""; this.checked = !!attrs.checked;
    this.disabled = !!attrs.disabled; this.className = attrs.class || ""; this.id = attrs.id || "";
    this.scrollHeight = 0; this.clientHeight = 0; this.scrollTop = 0; this.style = {}; this._h = {};
  }
  get childElementCount() { return this.children.length; }
  get textContent() { return this._text || this.children.map((c) => c.textContent).join(" "); }
  get nextElementSibling() { const p = this.parentElement; if (!p) return null; const i = p.children.indexOf(this); return i >= 0 ? p.children[i + 1] || null : null; }
  getAttribute(a) { return this.attrs[a] ?? null; }
  focus() {}
  getBoundingClientRect() { return this._invisivel ? { width: 0, height: 0, left: 0, top: 0 } : { width: 100, height: 30, left: 0, top: 0 }; }
  add(c) { c.parentElement = this; this.children.push(c); return c; }
  dispatchEvent() { return true; }
  click() { if (this._onClick) this._onClick(this); }
  addEventListener(t, f) { this._h[t] = f; }
  contains(n) { let p = n; while (p) { if (p === this) return true; p = p.parentElement; } return false; }
  closest(sel) { for (let a = this; a; a = a.parentElement) if (sel.split(",").some((s) => a.tagName === s.trim().toUpperCase())) return a; return null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return coletar(this).filter((e) => casaSel(e, sel)); }
}
function coletar(raiz) { const out = []; (function rec(e) { for (const c of e.children) { out.push(c); rec(c); } })(raiz); return out; }
function casaSel(e, sel) {
  return sel.split(",").map((s) => s.trim()).some((s) => {
    if (s === 'input[type="checkbox"]') return e.tagName === "INPUT" && e.type === "checkbox";
    if (s.startsWith("input:not(")) { if (e.tagName !== "INPUT") return false; const ex = [...s.matchAll(/\[type="([^"]+)"\]/g)].map((m) => m[1]); return !ex.includes(e.type || "text"); }
    if (s.startsWith("[")) return false;
    return e.tagName === s.toUpperCase();
  });
}

// ---------- a tela ----------
const body = new El("body");
const sidebar = body.add(new El("div"));
const cardProdutos = sidebar.add(new El("div"));
cardProdutos.add(new El("span", "Produtos"));
let sacolaAtual = cenario === "cheia" ? 50 : 21;
const selo = cardProdutos.add(new El("span", String(sacolaAtual)));
let modalProdutos = null, modalFavoritos = null;
const confirmados = [];
const EMPURRADOS = Array.from({ length: 8 }, (_, i) => ({ titulo: `Oferta Parceiro Item Numero ${i + 1}` }));
const catalogo = cenario === "ambiguo"
  ? [{ titulo: "Camiseta Básica" }]
  : [
      { titulo: "Perfume Cebolinha Turma Da Mônica Colônia 30ml", jaNaSacola: true },
      { titulo: "Desempenadeira plást..." },
      { titulo: "Alça De Pintura Em Sp..." },
      { titulo: "Relógio Digital LED Br..." },
      { titulo: "Busca Brisa Coquetel ..." },
    ];
const btnLista = new El("div", "Lista de produtos");
btnLista._onClick = () => {
  modalProdutos = body.add(new El("div"));
  modalProdutos.add(new El("h2", `Produtos(${sacolaAtual})`));
  const add = modalProdutos.add(new El("button", "Adicionar produtos relacionados"));
  add._onClick = () => {
    modalFavoritos = body.add(new El("div"));
    const aba = modalFavoritos.add(new El("div", "Meus Favoritos")); aba.attrs["aria-selected"] = "true";
    const abaImp = modalFavoritos.add(new El("div", "Importar via URL"));
    abaImp._onClick = () => {
      const campo = modalFavoritos.add(new El("input", "", { type: "text", placeholder: "Cole a URL do produto" }));
      const conv = modalFavoritos.add(new El("button", "Converter"));
      conv._onClick = () => {
        if (!/i\.1410551122\.58217546624/.test(campo.value || "")) return;
        const card = modalFavoritos.add(new El("div"));
        card.add(new El("input", "", { type: "checkbox", checked: true }));
        card.add(new El("span", "R$ 9,90"));
        const t = card.add(new El("span", "Produto que não está nos favoritos")); t.attrs.title = t._text;
        modalFavoritos._importado = true;
      };
    };
    modalFavoritos.add(new El("input", "", { type: "text", placeholder: "Buscar produtos" }));
    const grid = modalFavoritos.add(new El("div"));
    for (const p of catalogo) {
      const card = grid.add(new El("div"));
      let inp;
      if (cenario === "checkboxEstilizado") {
        // <label><input (invisível)/><span class="ant-checkbox-inner"/></label>
        const label = card.add(new El("label", ""));
        inp = label.add(new El("input", "", { type: "checkbox", checked: !!p.jaNaSacola }));
        inp._invisivel = true; inp._onClick = () => {}; // o React ignora o click no input escondido
        const quadrado = label.add(new El("span", "", { class: "ant-checkbox-inner" }));
        const alterna = () => { inp.checked = !inp.checked; };
        label._onClick = alterna; quadrado._onClick = alterna;
      } else {
        inp = card.add(new El("input", "", { type: "checkbox", checked: !!p.jaNaSacola }));
        inp._onClick = () => { if (!inp.disabled) inp.checked = !inp.checked; };
      }
      card.add(new El("span", "R$ 14,56"));
      const t = card.add(new El("span", p.titulo)); t.attrs.title = p.titulo;
      p._card = card; p._input = inp;
    }
    const conf = modalFavoritos.add(new El("button", "Confirmar"));
    conf._onClick = () => {
      const marcados = catalogo.filter((p) => p._input.checked && !p.jaNaSacola);
      let n = marcados.length;
      if (modalFavoritos._importado) { n += 1; confirmados.push("IMPORTADO:Produto que não está nos favoritos"); }
      sacolaAtual += n; selo._text = String(sacolaAtual);
      if (modalProdutos) modalProdutos.children[0]._text = `Produtos(${sacolaAtual})`;
      confirmados.push(...marcados.map((p) => p.titulo));
      body.children.splice(body.children.indexOf(modalFavoritos), 1); modalFavoritos = null;
    };
    modalFavoritos.add(new El("button", "Cancelar"))._onClick = () => { body.children.splice(body.children.indexOf(modalFavoritos), 1); modalFavoritos = null; };
  };
};
sidebar.add(btnLista);

// ---------- ambiente ----------
global.window = { addEventListener() {} }; global.window.top = global.window;
global.HTMLInputElement = class {}; global.HTMLTextAreaElement = class {};
global.Event = class { constructor(t, o) { Object.assign(this, o); this.type = t; } };
global.KeyboardEvent = global.PointerEvent = global.MouseEvent = class { constructor(t, o) { Object.assign(this, o); this.type = t; } };
global.getComputedStyle = () => ({ pointerEvents: "auto", opacity: "1", color: "rgb(20,20,20)", cursor: "default", visibility: "visible", display: "block", fill: "", stroke: "", borderColor: "", backgroundColor: "", boxShadow: "" });
global.document = {
  body,
  querySelectorAll: (sel) => coletar(body).filter((e) => casaSel(e, sel)),
  querySelector: (sel) => (/placeholder/.test(sel) ? coletar(body).find((e) => e.tagName === "INPUT" && /buscar/i.test(e.getAttribute("placeholder") || "")) || null : coletar(body).filter((e) => casaSel(e, sel))[0] || null),
  dispatchEvent() { return true; },
};
let resposta = null;
global.chrome = { runtime: { onMessage: { addListener(fn) { (global.__lst ||= []).push(fn); } }, sendMessage: async () => ({}), lastError: null }, storage: { local: { set: async () => {}, get: async () => ({}) } } };

const src = (
  REF
    ? require("child_process").execFileSync("git", ["show", `${REF}:extension/content-bag.js`], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" })
    : fs.readFileSync(path.join(EXT, "content-bag.js"), "utf8")
).replace("const log = [];", "const log = (global.__logParcial = []);");
eval(src);

// ---------- o lote ----------
const COM_URL = new Set(["sobrouComLink", "semBusca"]);
const lote = cenario === "ambiguo"
  ? [{ codigo: "XXX-YYY-ZZZ", nome: "Camiseta Básica Preta Masculina", itemId: 9 }, { codigo: "WWW-VVV-UUU", nome: "Camiseta Básica Branca Feminina", itemId: 10 }]
  : cenario === "semBusca"
    ? [{ codigo: "GGG-HHH-III", nome: "Produto que não está nos favoritos", itemId: 3, url: "https://shopee.com.br/affiliation-i.1410551122.58217546624" }]
    : [
        { codigo: "AAA-BBB-CCC", nome: cenario === "h1Ingles" ? "Plastic trowel for plastering 25cm" : "Desempenadeira plástica para reboco 25cm", nomeAba: cenario === "h1Ingles" ? "Desempenadeira plástica para reboco 25cm" : undefined, itemId: 1 },
        { codigo: "DDD-EEE-FFF", nome: "Alça De Pintura Em Spray Ergonômica", itemId: 2 },
        { codigo: "GGG-HHH-III", nome: "Produto que não está nos favoritos", itemId: 3, url: COM_URL.has(cenario) ? "https://shopee.com.br/affiliation-i.1410551122.58217546624" : null },
      ];
const modo = cenario === "simular" ? "simular" : "real";
global.__lst[0]({ type: "bag-run", lote, modo, limite: 50 }, {}, (r) => { resposta = r; });

const t0 = Date.now();
const relogio = setInterval(() => {
  if (!resposta && Date.now() - t0 < 25000) return;
  clearInterval(relogio);
  if (!resposta) { console.log("SEM RESPOSTA"); process.exit(1); }
  const log = resposta.log || [];
  const rodouBusca = log.some((l) => /^busca /.test(l));
  const incerta = log.some((l) => /marcação incerta/.test(l));
  console.log(`cenário=${cenario}${REF ? ` [${REF}]` : ""} modo=${modo} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log("resultado:", JSON.stringify({ ok: resposta.ok, motivo: resposta.motivo, adicionados: resposta.adicionados, importados: resposta.importados, pendentes: resposta.pendentes, atual: resposta.atual, cresceu: resposta.cresceu }));
  console.log("confirmados na tela:", JSON.stringify(confirmados));
  let ok;
  const imp = resposta.importados || [];
  if (cenario === "real" || cenario === "checkboxEstilizado" || cenario === "h1Ingles") {
    ok = resposta.ok && confirmados.includes("Desempenadeira plást...") && confirmados.includes("Alça De Pintura Em Sp...") && resposta.cresceu === 2 && !incerta && !rodouBusca;
  } else if (cenario === "simular") ok = resposta.ok && resposta.simulado && confirmados.length === 0 && JSON.stringify(resposta.adicionados) === JSON.stringify(["AAA-BBB-CCC", "DDD-EEE-FFF"]);
  else if (cenario === "cheia") ok = !resposta.ok && resposta.motivo === "cheia" && confirmados.length === 0;
  else if (cenario === "sobrouComLink") ok = resposta.ok && confirmados.length === 3 && imp.includes("GGG-HHH-III") && !rodouBusca;
  else if (cenario === "semBusca") ok = imp.includes("GGG-HHH-III") && !rodouBusca;
  else if (cenario === "ambiguo") ok = !resposta.ok && resposta.motivo === "ambiguos" && confirmados.length === 0 && (resposta.ambiguos || []).length === 2;
  if (!ok) console.log("log:\n  " + log.join("\n  "));
  console.log(ok ? "OK" : "FALHOU");
  process.exit(ok ? 0 : 1);
}, 250);
