// Gera a edição comercial a partir da MESMA fonte da edição pessoal.
//
//   extension/        → edição pessoal (é a pasta que você carrega no Brave, não mexo nela)
//   dist/pro/         → edição Pro, gerada por este script
//
// Só dois arquivos mudam entre as edições: manifest.json (nome) e edicao.js (o sinalizador).
// Todo o resto é byte a byte igual, então correção feita numa vale para a outra.
//
// Uso:  node build/build.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGEM = path.join(RAIZ, "extension");
const DESTINO = path.join(RAIZ, "dist", "pro");

const EDICOES = {
  pro: {
    nome: "Sacolinha Automática Pro",
    descricao:
      "Lê os códigos de produto no chat da sua live, favorita cada um e coloca na sacolinha — sem digitar um por um. Edição Pro, por assinatura.",
    precisaLicenca: true,
  },
};

const IGNORAR = new Set(["README.md", ".DS_Store"]);

function copiar(de, para) {
  fs.mkdirSync(para, { recursive: true });
  for (const item of fs.readdirSync(de, { withFileTypes: true })) {
    if (IGNORAR.has(item.name)) continue;
    const origem = path.join(de, item.name);
    const alvo = path.join(para, item.name);
    if (item.isDirectory()) copiar(origem, alvo);
    else fs.copyFileSync(origem, alvo);
  }
}

function gerar(chave) {
  const cfg = EDICOES[chave];
  fs.rmSync(DESTINO, { recursive: true, force: true });
  copiar(ORIGEM, DESTINO);

  const manifest = JSON.parse(fs.readFileSync(path.join(DESTINO, "manifest.json"), "utf8"));
  manifest.name = cfg.nome;
  manifest.description = cfg.descricao;
  manifest.action.default_title = cfg.nome;
  fs.writeFileSync(path.join(DESTINO, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  fs.writeFileSync(
    path.join(DESTINO, "edicao.js"),
    `// GERADO por build/build.mjs — não edite aqui, edite extension/edicao.js.
(function (raiz) {
  raiz.EDICAO = {
    edicao: ${JSON.stringify(chave)},
    nome: ${JSON.stringify(cfg.nome)},
    precisaLicenca: ${cfg.precisaLicenca},
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
`,
    "utf8",
  );

  const arquivos = [];
  (function contar(dir) {
    for (const i of fs.readdirSync(dir, { withFileTypes: true })) {
      if (i.isDirectory()) contar(path.join(dir, i.name));
      else arquivos.push(path.join(dir, i.name));
    }
  })(DESTINO);

  console.log(`${cfg.nome} v${manifest.version}`);
  console.log(`  pasta: ${path.relative(process.cwd(), DESTINO)}`);
  console.log(`  ${arquivos.length} arquivo(s); licença exigida: ${cfg.precisaLicenca ? "sim" : "não"}`);
  return manifest;
}

const pessoal = JSON.parse(fs.readFileSync(path.join(ORIGEM, "manifest.json"), "utf8"));
console.log(`${pessoal.name} v${pessoal.version}`);
console.log(`  pasta: ${path.relative(process.cwd(), ORIGEM)} (edição pessoal, carregue esta no seu Brave)`);
console.log("");
gerar("pro");
console.log("");
console.log("Para instalar a Pro: brave://extensions → Carregar sem compactação → dist/pro");
console.log("As duas podem ficar instaladas ao mesmo tempo: pastas diferentes = extensões diferentes,");
console.log("cada uma com sua própria fila, calibração e configurações.");
