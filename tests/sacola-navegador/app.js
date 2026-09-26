// Réplica do painel da live da Shopee, em React 18 de verdade — usada por tests/sacola-navegador.cjs.
//
// Caminho igual ao da tela: card "Produtos" (o botão "Lista de produtos" só aparece no hover) →
// "Produtos(N)" → "+ Adicionar produtos relacionados" → aba "Meus Favoritos" → marcar → "Confirmar".
//
// ?v=<variante> escolhe COMO o checkbox de cada card é desenhado. Não sabemos qual é o da
// Shopee (ela muda a tela sem aviso), então a extensão tem de acertar em todas:
//   antd        Ant Design: label > span > <input> transparente cobrindo o quadrado + span desenhado
//   antdCard    o mesmo, dentro de um card que também seleciona no clique (checkbox com stopPropagation)
//   desenhado   SEM <input>: marcador desenhado (div) e o CARD é quem seleciona
//   embaralhado SEM <input>, classes embaralhadas (CSS modules) e o onClick só no desenho
//   irmao       <input> escondido só de enfeite + quadrado IRMÃO com o onClick, sem <label>
//   mousedown   alterna no mousedown, não no click
//   shadow      o checkbox mora num web component (shadow DOM)
//   remount     a grade inteira ganha nós novos a cada seleção
//   async       a seleção passa pelo servidor (900 ms) e ALTERNA: um 2º clique antes da resposta desmarca
//   asyncLento  o mesmo, com servidor lento (3 s, mais que a espera normal) e spinner no card enquanto processa
//   tardio      a grade é recarregada (nós novos, mesma contagem) logo depois de aberta
//   instavel    a grade ganha nós novos a cada 500 ms
//   hover       o card muda de aparência com o mouse em cima (não pode parecer seleção)
//   link        a imagem é um link para o produto e o marcador fica por cima dela, sem eventos
//   insere      chave por POSIÇÃO; um favorito novo entra no topo logo após a 1ª seleção
//   confiavel   o checkbox só aceita clique "de pessoa" (isTrusted) — o label.click() passa, porque o
//               Chrome repassa o clique do label ao input como confiável
//   ignora      o checkbox não responde a nada: simula a tela em que a extensão não consegue marcar
// Extras: &semContador=1 tira o "N produto(s) selecionado(s)"; &cardNeutro=1 tira a classe de
// seleção do card (só o quadradinho muda de cor).
//
// window.__eventos registra cada seleção/desseleção feita PELO USUÁRIO (o teste confere que cada
// produto foi alternado exatamente uma vez) e window.__sacola é o conteúdo da sacola.
(function () {
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;
  const params = new URLSearchParams(location.search);
  const V = params.get("v") || "antd";
  const eventos = (window.__eventos = []);
  const evento = (s) => eventos.push(`${(performance.now() / 1000).toFixed(2)} ${s}`);

  const FAVORITOS = [
    { id: 1, titulo: "Desempenadeira plástica para reboco 25cm Lisa", preco: "R$14,56" },
    { id: 2, titulo: "Alça De Pintura Em Spray Ergonômica Profissional", preco: "R$22,90" },
    { id: 3, titulo: "Relógio Digital LED Bracelete Esportivo Unissex", preco: "R$9,99" },
    { id: 4, titulo: "Busca Brisa Coquetel Kit Com 3 Unidades", preco: "R$31,00" },
    { id: 5, titulo: "Perfume Cebolinha Turma Da Mônica Colônia 30ml", preco: "R$19,90" },
    { id: 6, titulo: "Oferta Parceiro Item Numero Seis Azul", preco: "R$5,00" },
    { id: 7, titulo: "Oferta Parceiro Item Numero Sete Verde", preco: "R$6,00" },
    { id: 8, titulo: "Oferta Parceiro Item Numero Oito Rosa", preco: "R$7,00" },
  ];
  const NA_SACOLA_INICIAL = [FAVORITOS[4]]; // o perfume já está na sacola (marcado e desabilitado)
  const OUTROS_NA_SACOLA = 20; // produtos na sacola que não aparecem na lista acima

  // ---------------- checkboxes ----------------

  function AntCheckbox({ checked, disabled, onChange, parar }) {
    return h(
      "label",
      { className: "ant-checkbox-wrapper" + (checked ? " ant-checkbox-wrapper-checked" : ""), onClick: parar ? (e) => e.stopPropagation() : undefined },
      h(
        "span",
        { className: "ant-checkbox" + (checked ? " ant-checkbox-checked" : "") + (disabled ? " ant-checkbox-disabled" : "") },
        h("input", {
          type: "checkbox",
          className: "ant-checkbox-input",
          checked,
          disabled,
          onChange: (e) => {
            if (V === "ignora" || (V === "confiavel" && !e.nativeEvent.isTrusted)) return;
            onChange(e.target.checked);
          },
        }),
        h("span", { className: "ant-checkbox-inner" }),
      ),
    );
  }

  function Desenhado({ checked, disabled }) {
    return h(
      "div",
      { className: "shp-checkbox" + (checked ? " shp-checkbox--checked" : "") + (disabled ? " shp-checkbox--disabled" : "") },
      checked ? h("svg", { viewBox: "0 0 10 10", width: 10, height: 10 }, h("path", { d: "M1 5 L4 8 L9 2", stroke: "#fff", fill: "none" })) : null,
    );
  }

  function Embaralhado({ checked, disabled, onChange }) {
    return h("div", {
      className: checked ? "_q7Zk _x1Pa" : "_q7Zk",
      style: { width: 16, height: 16, border: "1px solid #aaa", background: checked ? "#ee4d2d" : "#fff", cursor: "pointer" },
      onClick: (e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      },
    });
  }

  function IrmaoComHandler({ checked, disabled, onChange }) {
    return h(
      "div",
      { className: "chk" },
      h("input", { type: "checkbox", readOnly: true, checked, disabled, style: { display: "none" } }),
      h("span", { className: "chk-box" + (checked ? " chk-box--on" : ""), onClick: () => !disabled && onChange(!checked) }),
    );
  }

  function NoMouseDown({ checked, disabled, onChange }) {
    return h(
      "span",
      {
        className: "md-check" + (checked ? " md-check--on" : ""),
        onMouseDown: (e) => {
          e.preventDefault();
          if (!disabled) onChange(!checked);
        },
      },
      h("input", { type: "checkbox", checked, disabled, readOnly: true, tabIndex: -1, style: { position: "absolute", opacity: 0, width: 0, height: 0 } }),
    );
  }

  if (!customElements.get("shp-check")) {
    customElements.define(
      "shp-check",
      class extends HTMLElement {
        constructor() {
          super();
          const raiz = this.attachShadow({ mode: "open" });
          raiz.innerHTML = `<style>label{display:block;width:18px;height:18px;border:1px solid #999;background:#fff;border-radius:2px;cursor:pointer}
            input{position:absolute;opacity:0;width:0;height:0} :host([checked]) label{background:#ee4d2d;border-color:#ee4d2d}</style>
            <label><input type="checkbox"></label>`;
          this._inp = raiz.querySelector("input");
          this._inp.addEventListener("change", () => this.dispatchEvent(new CustomEvent("shp-change", { detail: this._inp.checked, bubbles: true })));
        }
        set checked(v) {
          this._inp.checked = !!v;
          this.toggleAttribute("checked", !!v);
        }
        set disabled(v) {
          this._inp.disabled = !!v;
        }
      },
    );
  }
  function ShadowCheck({ checked, disabled, onChange }) {
    const ref = useRef(null);
    useEffect(() => {
      const el = ref.current;
      el.checked = checked;
      el.disabled = disabled;
      const f = (e) => onChange(e.detail);
      el.addEventListener("shp-change", f);
      return () => el.removeEventListener("shp-change", f);
    });
    return h("shp-check", { ref });
  }

  // ---------------- card ----------------

  function Card({ p, sel, naSacola, alternar, ocupado }) {
    const [emCima, setEmCima] = useState(false);
    const checked = sel || naSacola;
    const disabled = naSacola;
    const onChange = (v) => alternar(p.id, v);
    const cardSeleciona = V === "desenhado" || V === "antdCard" || V === "link";
    let chk;
    if (V === "desenhado") chk = h(Desenhado, { checked, disabled });
    else if (V === "link") chk = h("div", { style: { pointerEvents: "none" } }, h(Desenhado, { checked, disabled }));
    else if (V === "embaralhado") chk = h(Embaralhado, { checked, disabled, onChange });
    else if (V === "irmao") chk = h(IrmaoComHandler, { checked, disabled, onChange });
    else if (V === "mousedown") chk = h(NoMouseDown, { checked, disabled, onChange });
    else if (V === "shadow") chk = h(ShadowCheck, { checked, disabled, onChange });
    else chk = h(AntCheckbox, { checked, disabled, onChange, parar: V === "antdCard" });
    const hoverVisivel = emCima && V === "hover";
    const imagem = h("div", { className: "fav-img" });
    return h(
      "div",
      {
        className: "fav-card" + (checked && !params.get("cardNeutro") ? " fav-card--selected" : "") + (hoverVisivel ? " fav-card--hover" : ""),
        onClick: cardSeleciona ? () => !disabled && alternar(p.id, !sel) : undefined,
        onMouseEnter: () => setEmCima(true),
        onMouseLeave: () => setEmCima(false),
      },
      h("div", { className: "fav-chk", style: V === "link" ? { pointerEvents: "none" } : undefined }, chk),
      V === "link"
        ? h(
            "a",
            {
              href: "https://shopee.com.br/produto-i.1." + p.id,
              onClick: (e) => {
                evento("LINK CLICADO " + p.id);
                e.preventDefault();
                e.stopPropagation();
              },
            },
            imagem,
          )
        : imagem,
      h("div", { className: "fav-nome" }, p.titulo),
      h("div", { className: "fav-preco" }, p.preco),
      hoverVisivel ? h("div", { className: "fav-ver" }, "Ver detalhes") : null,
      ocupado ? h("div", { className: "spin-carregando", "aria-busy": "true" }) : null,
    );
  }

  // ---------------- janelas ----------------

  function AdicionarProdutos({ naSacola, onConfirmar, onFechar }) {
    const [aba, setAba] = useState("fav");
    const [sel, setSel] = useState([]);
    const [geracao, setGeracao] = useState(0); // muda as chaves → nós novos
    const [url, setUrl] = useState("");
    const [convertido, setConvertido] = useState(null);
    const [lista, setLista] = useState(FAVORITOS);
    const [pendentes, setPendentes] = useState([]); // seleções esperando o "servidor"

    useEffect(() => {
      if (V !== "tardio") return undefined;
      const t = setTimeout(() => {
        evento("grade recarregada (nós novos)");
        setLista(FAVORITOS.map((p) => ({ ...p })));
        setGeracao((g) => g + 1);
      }, 1400);
      return () => clearTimeout(t);
    }, []);
    useEffect(() => {
      if (V !== "instavel") return undefined;
      const t = setInterval(() => setGeracao((g) => g + 1), 500);
      return () => clearInterval(t);
    }, []);

    const alternar = (id, v) => {
      evento(`alternar ${id} -> ${v}`);
      const servidor = V === "async" || V === "asyncLento";
      const aplica = () => {
        if (servidor) {
          setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
          setPendentes((ps) => ps.filter((x) => x !== id));
        } else setSel((s) => (v ? (s.includes(id) ? s : [...s, id]) : s.filter((x) => x !== id)));
        if (V === "remount") setGeracao((g) => g + 1);
      };
      if (servidor) {
        if (V === "asyncLento") setPendentes((ps) => [...ps, id]);
        setTimeout(aplica, V === "asyncLento" ? 3000 : 900);
      } else aplica();
      if (V === "insere" && !window.__inseriu) {
        window.__inseriu = true;
        setTimeout(() => {
          evento("favorito novo entrou no topo");
          setLista((l) => [{ id: 99, titulo: "Produto Favoritado Agora Pela Dona Na Mao", preco: "R$3,00" }, ...l]);
        }, 60);
      }
    };
    const n = sel.length + (convertido ? 1 : 0);
    const abas = [
      ["fav", "Meus Favoritos"],
      ["loja", "Minha Loja"],
      ["rec", "Recente"],
      ["url", "Importar via URL"],
      ["conj", "Adicionar conjunto de produtos"],
    ];
    const chave = (p, i) => (V === "insere" ? "pos" + i : `${p.id}-${geracao}`);
    return h(
      "div",
      { className: "mask" },
      h(
        "div",
        { className: "dialog", role: "dialog", "aria-modal": "true" },
        h("div", { className: "dlg-head" }, h("span", null, "Adicionar Produtos"), h("span", { className: "x", "aria-label": "Fechar", onClick: onFechar }, "×")),
        h(
          "div",
          { className: "dlg-body" },
          h(
            "div",
            { className: "abas" },
            abas.map(([k, t]) => h("div", { key: k, className: "aba" + (aba === k ? " aba--ativa" : ""), onClick: () => setAba(k) }, t)),
          ),
          aba === "url"
            ? h(
                "div",
                { className: "conteudo" },
                h("input", { className: "campo", placeholder: "Cole a URL do produto", value: url, onChange: (e) => setUrl(e.target.value) }),
                h(
                  "button",
                  { className: "btn", onClick: () => /i\.\d+\.\d+/.test(url) && setConvertido({ titulo: "Produto importado pela URL", preco: "R$9,90" }) },
                  "Converter",
                ),
                convertido
                  ? h(
                      "div",
                      { className: "fav-card" },
                      h(AntCheckbox, { checked: true, onChange: () => {} }),
                      h("div", { className: "fav-nome" }, convertido.titulo),
                      h("div", { className: "fav-preco" }, convertido.preco),
                    )
                  : null,
              )
            : h(
                "div",
                { className: "conteudo" },
                h("input", { className: "campo", placeholder: "Buscar produtos" }),
                h(
                  "div",
                  { className: "grid", key: "g" + geracao },
                  aba === "fav"
                    ? lista.map((p, i) =>
                        h(Card, { key: chave(p, i), p, sel: sel.includes(p.id), naSacola: naSacola.some((x) => x.id === p.id), alternar, ocupado: pendentes.includes(p.id) }),
                      )
                    : null,
                ),
              ),
        ),
        h(
          "div",
          { className: "dlg-foot" },
          h("span", { className: "contador" }, params.get("semContador") ? "" : `${n} produto(s) selecionado(s)`),
          h("button", { className: "btn", onClick: onFechar }, "Cancelar"),
          h(
            "button",
            { className: "btn btn--pri", disabled: n === 0, onClick: () => onConfirmar(lista.filter((p) => sel.includes(p.id)), convertido) },
            "Confirmar",
          ),
        ),
      ),
    );
  }

  function ListaProdutos({ sacola, onAdicionar, onFechar }) {
    return h(
      "div",
      { className: "painel" },
      h("div", { className: "painel-head" }, h("h3", null, `Produtos(${OUTROS_NA_SACOLA + sacola.length})`), h("span", { className: "x", "aria-label": "Fechar", onClick: onFechar }, "×")),
      h("button", { className: "btn", onClick: onAdicionar }, "+ Adicionar produtos relacionados"),
      h(
        "div",
        { className: "sacola" },
        sacola.map((p, i) => h("div", { key: i, className: "linha" }, h("span", null, p.titulo), h("span", null, p.preco))),
      ),
    );
  }

  function App() {
    const [emCimaProdutos, setEmCimaProdutos] = useState(false);
    const [lista, setLista] = useState(false);
    const [adicionar, setAdicionar] = useState(false);
    const [sacola, setSacola] = useState(NA_SACOLA_INICIAL);
    window.__sacola = sacola;
    useEffect(() => {
      const f = (e) => {
        if (e.key !== "Escape") return;
        if (adicionar) setAdicionar(false);
        else setLista(false);
      };
      document.addEventListener("keydown", f);
      return () => document.removeEventListener("keydown", f);
    });
    return h(
      "div",
      { className: "app" },
      h(
        "div",
        { className: "lateral" },
        h(
          "div",
          { className: "ferramenta", onMouseEnter: () => setEmCimaProdutos(true), onMouseLeave: () => setEmCimaProdutos(false) },
          h("div", { className: "icone" }, "🛍"),
          h("span", null, "Produtos"),
          emCimaProdutos ? h("div", { className: "btn-lista", onClick: () => setLista(true) }, "Lista de produtos") : null,
        ),
        h("div", { className: "ferramenta" }, h("div", { className: "icone" }, "⚡"), h("span", null, "Atividade")),
        h("div", { className: "ferramenta" }, h("div", { className: "icone" }, "🙋"), h("span", null, "Pedidos de Intro")),
      ),
      h("div", { className: "video" }, "vídeo"),
      lista ? h(ListaProdutos, { sacola, onAdicionar: () => setAdicionar(true), onFechar: () => setLista(false) }) : null,
      adicionar
        ? h(AdicionarProdutos, {
            naSacola: sacola,
            onFechar: () => setAdicionar(false),
            onConfirmar: (novos, conv) => {
              evento(`CONFIRMAR: ${novos.map((p) => p.id).join(",")}${conv ? " +url" : ""}`);
              setSacola((s) => [...s, ...novos, ...(conv ? [conv] : [])]);
              setAdicionar(false);
            },
          })
        : null,
    );
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
