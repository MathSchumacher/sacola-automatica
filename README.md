# Achadinhos Shopee

App desktop (Windows) em **Rust + Tauri 2** que usa a **API oficial de Afiliados da Shopee** para:

- monitorar buscas automaticamente e montar um **histórico de preços** local (SQLite);
- detectar **achadinhos** de três tipos:
  - ⚡ **preço fora da curva** — o "bug": produto muito abaixo do preço normal dos produtos parecidos (camiseta a R$ 2, tênis a R$ 8), típico de vendedor novo buscando reputação; comparado à **mediana da mesma palavra-chave**, sem exigir vendas;
  - **queda vs histórico** — bem abaixo da média de preço que o próprio app registrou;
  - **desconto alto** informado pela Shopee;
- montar a **lista de IDs para a Shopee Live** (manual ou automática) e copiá-la com um clique — um ID por linha, com vírgula, links de afiliado ou CSV;
- notificar no Windows quando surgem achadinhos novos.

Sem credenciais o app roda em **modo DEMO** (produtos fictícios com preços que variam) para testar toda a interface.

## Como rodar

Pré-requisitos: Rust (stable), Node 18+, pnpm, WebView2 (já vem no Windows 11).

```powershell
pnpm install
# desenvolvimento (hot reload do frontend)
scripts\lowcpu.cmd pnpm tauri dev
# instalador (NSIS/MSI em src-tauri\target\release\bundle)
scripts\lowcpu.cmd pnpm tauri build
# testes do backend
scripts\lowcpu.cmd cargo test --manifest-path src-tauri\Cargo.toml
```

> `scripts\lowcpu.cmd` prende o comando a **1 núcleo com prioridade baixa** (processos filhos herdam) e `src-tauri/.cargo/config.toml` fixa `jobs = 1` — builds ficam lentos de propósito para não sobrecarregar o PC.

## Credenciais da API

1. Estar ativa no Programa de Afiliados Shopee.
2. No painel de afiliado → Central de Ajuda → "Quero ativar a API" (formulário pede ID de afiliado e telefone).
3. A Shopee analisa (até ~2 semanas) e envia **App ID** e **Secret** por e-mail; depois aparecem em *affiliate.shopee.com.br → Open API*.
4. No app: **Configurações → Credenciais**, colar, **Salvar** e **Testar conexão**.

A autenticação é `Authorization: SHA256 Credential={AppId}, Timestamp={ts}, Signature=sha256_hex(AppId+Timestamp+Payload+Secret)` contra `https://open-api.affiliate.shopee.com.br/graphql` ([src-tauri/src/shopee/auth.rs](src-tauri/src/shopee/auth.rs)). As credenciais ficam só no banco local do app (`%APPDATA%\br.com.achadinhos.shopee\achadinhos.db`).

## Fluxo de uso

1. **Monitoramento** — cadastre buscas por **tipo de produto** ("camiseta", "tênis masculino", "vestido"…). Para cada uma, a cada N minutos o app faz a busca **base** (ordenação escolhida; define o **preço normal** = mediana da palavra-chave) e, com "⚡ Caçar menor preço", a mesma busca ordenada por **menor preço** (onde os bugs aparecem). Tudo vira histórico.
2. **Achadinhos** — cards ordenados por *score*; filtro **Tipo** (fora da curva / desconto). Fora da curva = `preço ÷ mediana dos pares ≤ 0,35` (≥ 65% abaixo do normal, com ≥ 8 pares) — não exige vendas e marca "vendedor novo?" quando não há vendas/avaliações. Desconto/queda = `vendas ≥ mínimo` **e** (`desconto ≥ X%` **ou** `preço ≥ Y% abaixo da média histórica`). Tudo em Configurações. "Hist." abre o histórico de preço.
3. **Lista da Live** — recebe produtos via `+ Live` (Achadinhos/Buscar), seleção múltipla ou **Preenchimento automático** (regras: máx. itens, score mínimo, preço máx., palavra-chave; pode rodar ao fim de cada varredura). Botões copiam os IDs prontos para colar na sacolinha da Shopee Live.
4. **Buscar** — consulta manual ao `productOfferV2` (também alimenta o histórico) e "Monitorar esta busca".

### Sobre adicionar os IDs na live

A API de Afiliados **não** tem endpoint para inserir produtos na sacolinha de uma live — esse passo é feito na tela da Shopee Live (web/app). O que o app automatiza é **toda a parte anterior**: escolher os produtos, obter os `itemId`s, manter a lista e copiá-los no formato que a tela aceita. Se a Shopee expuser uma API para a live, o ponto de integração é `commands::export_live` / `db::list_live`.

## Arquitetura

```
src-tauri/src
├── shopee/        cliente da API (auth SHA256, GraphQL, tipos tolerantes a string/número, mock)
├── deals.rs       regra pura "é achadinho?" (fora da curva / queda / desconto) + score (testes unitários)
├── db.rs          SQLite: products, price_history, peer_stats/product_peers, searches, live_list, settings (migrações por user_version)
├── scheduler.rs   varredura periódica: busca base + caça menor preço → histórico → mediana dos pares → achadinhos → notificação → auto-live
├── state.rs       AppState (conexão, cliente real/mock, status), AppSettings
└── commands.rs    comandos Tauri expostos ao frontend
src/               Vite + TypeScript vanilla (api.ts = contrato com o backend; views/*)
```

Eventos backend → frontend: `scan:status`, `scan:finished`, `live:changed`, `settings:changed`.

## Ícone

Fonte em `design/icon-src.png` (gerado por IA, 1254², sem alfa) → `design/icon-1024.png` (fundo fora do squircle tornado transparente, 1024² RGBA). Todos os tamanhos (`src-tauri/icons/*.png`, `icon.ico`, `icon.icns`) vêm de `pnpm tauri icon design/icon-1024.png`; a UI usa `public/icon-128.png` e `public/favicon.png` (cópias de `icons/`). Para trocar o ícone: substituir `design/icon-1024.png` (PNG quadrado **com transparência**), rodar o comando acima, copiar `icons/128x128.png` e `icons/32x32.png` para `public/` e rebuildar.

## Limitações conhecidas

- O "preço normal" é a mediana dos resultados da palavra-chave: palavras genéricas ("kit", "promoção") misturam produtos e geram falsos positivos; prefira tipos de produto. Cada produto usa o grupo mais específico (menor) que tenha pares suficientes.
- Histórico começa vazio: a "queda vs média" só passa a valer depois de N capturas (padrão 3). Até lá, fora da curva e desconto Shopee são os critérios.
- A API tem limite de requisições (erro 10030); o agendador espaça chamadas (~0,6 s entre páginas) e faz pausa ao ser limitado. Se ocorrer, aumente o intervalo/reduza páginas.
- Campos `shopType`, `productCatIds` ainda não são consultados (não afetam a detecção).
