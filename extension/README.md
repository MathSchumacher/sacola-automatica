# Sacolinha Automática (extensão Brave/Edge/Chrome)

Durante a live, o chat pede produtos por **código** (`XXX-XXX-XXX`, ex.: "adiciona meu ID amiga HFE-NKL-WSN"). A extensão lê o chat no **painel do criador** (`creator.shopee.com.br`, o mesmo que a streamer já usa no PC), extrai os códigos e **favorita cada produto sozinha**: abre `shopee.com.br`, busca o código, entra no primeiro resultado e clica no coração — tudo na sessão logada dela, em ritmo humano, sem repetir código.

## Como funciona

1. Com a live criada em `creator.shopee.com.br` (Criar live → painel com chat e sacola), o script observa as mensagens do chat e extrai:
   - **códigos** `XXX-XXX-XXX` em **qualquer caixa** (`HFE-NKL-WSN`, `DDx-RAG-VZE`, `ddx-rag-vze`), inclusive grudados no apelido de quem escreveu (`mariaddx-rag-vze`) — o padrão 3-3-3 letras com traços já é distintivo. **Sem traços** em **minúsculas** (`fxbnanexe`) também vale, com duas barreiras estruturais contra os **apelidos anonimizados** da Shopee (9–10 letras minúsculas aleatórias, como `foqqhrygg` — um deles chegou a virar o "código" FOQ-QHR-YGG): mensagens do **sistema** ("x entrou!", "x e 3 entraram!", "x está comprando produtos!") são puladas por inteiro, e o **primeiro token** de uma linha de chat é sempre quem escreveu, nunca código. Passadas as barreiras, o token entra quando não parece palavra em português (poucas vogais, ou pilha de 4+ consoantes) ou quando é a mensagem inteira depois do apelido. Na **colagem manual** pelo popup não há apelido, então essas barreiras não se aplicam. O código é sempre normalizado para MAIÚSCULAS. **Sem traços** em maiúsculas (`HFENKLWSN`, `AKFACPDNT`) é completado: 9 letras MAIÚSCULAS viram código e os hífens são acrescentados. **Não exigimos contexto nenhum** — código legítimo chega sozinho na mensagem, e ignorar um código é a pior falha possível, porque some uma venda. Uma palavra de 9 letras que escape custa só uma aba aberta à toa; as mais frequentes estão numa lista de exceções. O que causou "MASCULINA" virar código não foi o parser, foi a leitura ter escapado para a lista de produtos — resolvido acima. Censurados tipo `***-daw-nsm` são ignorados, não há como recuperá-los;
   - links completos/curtos de produto e IDs numéricos (nas páginas de live comuns; no painel do criador números soltos são ignorados — lá tudo é métrica).
2. **Nenhum código se perde no caminho.** O código só é dado como enviado depois que o service worker CONFIRMA o recebimento. Se o envio falha (o worker hiberna e demora a acordar — comum na rajada logo após marcar o chat), as marcas são desfeitas e a mensagem é relida na próxima varredura. Antes, uma falha de envio apagava o código para sempre: nem a mensagem era relida nem o código reenviado. O painel mostra a contagem de reenvios.
3. Cada código entra numa **fila sem repetição** (a fila descarta o mesmo código dentro da live; ao recarregar a página da live ela recomeça, então um produto anunciado de novo volta a ser favoritado — o que foi descartado por repetição aparece no popup, embaixo do chat). Um por vez, em aba de segundo plano: busca do código em `shopee.com.br/search` → a Shopee **redireciona direto para o produto** → clique em **❤ Favoritar** → aba fecha. Se o produto **já estiver favoritado, desfavorita e favorita de novo** (volta ao topo da lista de favoritos). Ritmo humano (6–12 s entre itens, limite por hora configurável). Se em vez de redirecionar aparecer uma lista, o primeiro resultado é usado como fallback.
3. Depois é só, no celular, usar "Adicionar produtos → Favoritos" da sacolinha.
4. Se a Shopee pedir login ou captcha, a fila **pausa** e notifica; resolva no navegador e clique em "Ativar".
5. Com o app desktop aberto, IDs numéricos são resolvidos pela API oficial e os favoritados entram na "Lista da Live" do app (origem "pedido no chat"). O app é opcional para o fluxo de códigos.
6. Também dá para colar códigos/links/texto do chat manualmente no popup ("Favoritar estes").

## O chat é só o chat

A extensão abre a janela "Adicionar Produtos" sozinha para mexer na sacola. Isso re-renderiza a página e mata o contêiner do chat. Ao reachá-lo, ela antes só perguntava "parece uma lista?" — e o grid de favoritos passa nisso com folga. Resultado: ela travava no grid, lia **títulos de produto como mensagem** e chegava a **rolar a lista de favoritos** que a dona estava olhando.

Agora, para ser aceito como chat, o contêiner precisa:

- estar **dentro do painel de comentários** — mas só quando o painel é *confiável*, isto é, foi localizado **e** tem uma lista de mensagens dentro dele. Sem essa ressalva, um painel mal localizado recusava o chat de verdade e a extensão parava inteira; sem exigência nenhuma, ela travava em qualquer lista da página e chegou a "favoritar" texto que não veio do chat;
- **não** estar dentro de uma janela de produtos. A checagem é precisa e não conta níveis: ou o elemento está sob `role="dialog"` / `aria-modal="true"`, ou ele (ou um ancestral a no máximo dois níveis) traz **dois** rótulos exatos da janela — "Meus Favoritos" e "Adicionar Produtos", por exemplo. Dois rótulos curtos e exatos evitam acusar o chat quando alguém digita uma dessas frases, e a subida para assim que encontra o bloco que contém a caixa de escrever do chat, porque esse bloco é a página e não uma janela. **Contar ancestrais era frágil**: o número certo dependia da profundidade do DOM, e quando a subida ia longe demais alcançava um bloco com o chat e a janela juntos, passando a recusar o próprio chat.

Uma armadilha que custou caro e vale registrar: `melhorListaDentro` chamava `ehChatValido`, que chamava `acharPainelComentarios`, que chamava `melhorListaDentro` de volta. Essa **recursão infinita** derrubava a leitura por completo. Hoje a checagem de janela não consulta o painel, o que fecha o ciclo.

Se o contêiner travado **derivar** para uma dessas regiões, a extensão solta e redescobre — mas só depois de **duas** leituras seguidas acusando, porque soltar o chat por engano faz as mensagens já na tela deixarem de ser lidas. E ao travar (inclusive pelo 📍 marcar chat) ela lê **na hora** o que já está na tela, então códigos que já estavam no chat antes da marcação entram na fila. O rolar automático também confere isso antes de encostar em qualquer coisa.

## Custo da descoberta

Enquanto o chat não está localizado, a descoberta roda a cada 2 s e valida cada candidato. Sem cache, cada validação refazia a varredura do painel de comentários inteiro — medido: **3,5 s por rodada** numa página de 2 mil nós, a página travava. As buscas caras (caixa de escrever, painel, "painel confiável", rótulos por elemento) são guardadas por **400 ms** e recalculadas uma vez por rodada: **3,4 ms** na mesma página. O harness `perf-test.cjs` falha se uma rodada passar de 150 ms.

## A sacola nunca é rolada pela extensão

A dona gerencia a **Lista de produtos** no PC com o chat travado ao lado. A rolagem automática do chat chegou a devolver a *sacola* "ao fim" enquanto ela olhava os produtos. Três defesas, independentes: a sacola (rótulos "Lista de produtos", cabeçalho "Produtos(N)", "Recarregar") entra no guarda de janela de produto; o **próprio elemento que iria rolar** é conferido, não só os ancestrais até ele; e se o **mouse da dona está sobre a lista**, ela está usando aquilo agora — a rolagem automática não age, ponto. O harness `sacola-rolagem-test.cjs` reproduz o cenário com e sem mouse e é verificado também contra o código antigo, onde falha.

## Chat rolado para cima

Quando a lista de comentários é rolada para cima (para ler alguma mensagem), a Shopee **não coloca as mensagens novas na página** — elas ficam retidas e aparece o aviso de "novas mensagens". O que não está na página não tem como ser lido, nem pela captura na inserção nem pela releitura: **cada segundo parado é código que se perde**, e as mais antigas a Shopee simplesmente descarta.

Por isso a regra é:

- **Aviso de "novas mensagens" na tela** → volta ao fim **na hora**, sem esperar. Esse aviso é a prova de que há mensagem retida.
- **Rolado para cima sem aviso** → espera **4 segundos** e volta ao fim.
- Ao voltar, relê a lista três vezes (0,3 s, 0,9 s e 2 s), porque a Shopee renderiza em etapas.

Para segurar a tela por mais tempo, use o **pausar** do painel: ele desliga a leitura inteira, deixando explícito que naquele período nada será capturado. O painel mostra a contagem regressiva e quantas vezes já precisou voltar ao fim.

## Sacola da live (etapa 2)

Depois de favoritar, os produtos entram num **lote** e podem ser adicionados à sacola da live automaticamente: Produtos → "Lista de produtos" → "+ Adicionar produtos relacionados" → "Meus Favoritos" → marca **só os do lote** → "Confirmar".

Regras de segurança (a sacola é visível para os clientes):

- **Ordem obrigatória**: a sacola só é tocada quando a fila de favoritos está zerada. Enquanto houver código do chat pendente, a operação é recusada.
- **Só o lote**: os cards são casados com o lote por **título** (e **preço** como desempate). Casamento é 1:1; se um título casar com mais de um produto, o item é marcado como **ambíguo e ignorado** — nunca se adivinha.
- **Limite (padrão 50)**: a quantidade atual é lida antes de cada tentativa. Sacola cheia → não clica em nada e tenta de novo a cada 60 s, esperando a dona liberar espaço. Se houver menos vagas que itens, adiciona o que cabe e mantém o resto no lote.
- **Nunca desmarca** nada nem mexe no que já está na sacola.
- **Nunca rola**: os recém-favoritados ficam no topo de "Meus Favoritos". A extensão examina só uma janela do topo (N adicionados + margem, entre 4 e 8 cards — a dona pode estar favoritando na mão ao mesmo tempo), marca o que casa e confirma.
- **Busca dentro de "Meus Favoritos"**: se o produto não está no topo (acontece quando um parceiro favorita muita coisa e empurra os recentes para baixo), a extensão digita o nome no campo "Buscar produtos" da própria janela e o produto volta ao topo. É a segunda tentativa, antes de recorrer ao link.
- **Importar via URL**: produto favoritado que não aparece em "Meus Favoritos" (acontece) entra pelo link — aba "Importar via URL" → cola `https://shopee.com.br/…-i.{loja}.{item}` → "Converter" → "Confirmar". O lote guarda o link de cada produto para isso.
- **Já está na sacola**: antes de mexer em qualquer coisa, os títulos da "Lista de produtos" são comparados com o lote; o que já aparece lá (adicionado na mão, ou numa rodada anterior cuja contagem não bateu) sai do lote sem nova tentativa. O casamento tem de ser único dos dois lados — título ambíguo não tira nada do lote. O aviso da Shopee de "produto já adicionado" na importação também conta, e o mesmo vale quando o link é convertido e confirmado mas a contagem da sacola não sobe.
- **Desistência**: um item que foi procurado várias vezes sem entrar (duas importações via URL falhas, ou quatro rodadas sem aparecer no topo) sai do lote com aviso no log, em vez de ser tentado a cada rodada para sempre.
- **Vigia da sacola**: a cada 15 s a extensão confere se a sacola está alcançável, **sem depender de haver uma rodada em curso**. O sinal principal é o mesmo que você vê na tela: o ícone de Produtos perde a cor quando a live trava, enquanto "Atividade" e "Pedidos de Intro" continuam normais — a comparação é entre eles, não contra um valor fixo, então tema e zoom não atrapalham. Precisa de duas leituras seguidas e clica no máximo uma vez por minuto. Os números medidos aparecem no popup.
- **Live travada**: sempre que a "Lista de produtos" fica inacessível — botão cinza, botão que some, ou clique que não abre a janela — a extensão clica no **Recarregar** que fica sobre o vídeo e tenta de novo. Se ele estiver dentro do quadro do player, o pedido é repassado para lá. No máximo um Recarregar a cada 20 s, para nunca virar um laço.
- **Falha rara ao favoritar**: uma nova tentativa automática antes de marcar como falha.
- **Marcação confiável**: a Shopee desenha o próprio marcador (não é um checkbox comum), então a seleção é confirmada por três sinais — checkbox marcado, botão "Confirmar" acendendo ou o card mudando de aparência. Sem o terceiro, só o **primeiro** produto de cada leva era dado como marcado e os demais iam para "Importar via URL" sem necessidade.
- **Casamento pelo título; preço só desempata**: com um único card de título compatível no topo, ele é o produto. O preço da página (lido pelo texto de maior fonte, aceitando faixas) só entra quando há mais de um candidato. Nome e preço são lidos depois de favoritar, com a página inteira renderizada.
- **Marcação incerta conta pela sacola**: se o clique não gera sinal visível, o produto é confirmado junto e a contagem da sacola diz se entrou.
- **O checkbox de Meus Favoritos é estilizado — e agora é marcado de verdade**: o checkbox da Shopee (Ant Design/React) tem o `<input>` real invisível; o quadrado que se vê é um `<span>` irmão dentro de um `<label>`. A extensão clicava só no input escondido, o React ignorava, e sem sinal ela desistia como "marcação incerta" sem tentar outro alvo — item visível no topo, nunca marcado, sacola `+0`. Agora clica numa **cascata de alvos** (label → quadrado desenhado → pai → input → card), confere o **estado** após cada um e para no primeiro que pegar (clicar de novo depois de pegar desmarcaria). O harness `checkboxEstilizado` reproduz o checkbox da Shopee; com `ANTIGO=1` ele recria o clique só no input e falha exatamente com "marcação incerta".
- **Os simuladores agora vivem no repositório** (`tests/`), não em pasta temporária: uma limpeza do Temp do Windows apagou a bateria inteira uma vez. `node tests/bag-test.cjs <cenário>` roda cada um; `ANTIGO=1` compara com o comportamento anterior.
- **Busca por nome abolida; checkbox ou URL, nada no meio**: quando o produto não casa com nenhum card do topo, a extensão vai **direto** para "Importar via URL". A busca no campo "Buscar produtos" de Meus Favoritos foi removida dos dois caminhos: ela digitava um nome próximo mas incompatível (h1 traduzido, prefixo, emoji) e filtrava para o vazio toda vez, comendo minutos. Os harnesses `semBusca` e `empurrado` falham se ela voltar a rodar.
- **Nome da aba em pt-BR junto do `<h1>`**: com a Shopee em "English", o `<h1>` do produto vem traduzido ("Plastic trowel…") mas o card de Meus Favoritos segue em português — e nunca casaria. Agora o título da aba (que mantém o nome cadastrado pelo vendedor) é guardado junto, e o casamento tenta primeiro por ele. O harness `h1Ingles` cobre exatamente esse caso.
- **Casamento por palavras, não por prefixo**: o nome guardado ao favoritar vem do `<h1>` da página do produto; o título do card vem do grid de Meus Favoritos, e a Shopee os monta de jeitos diferentes ("Promoção" na frente, emoji, caixa, um espaço a mais, truncamento "..."). Um único caractere no começo derrubava o prefixo exato → "não está no topo" (estava) → busca por nome com as 4 primeiras palavras do mesmo nome, lixo incluído → a busca por substring da Shopee filtrava para o vazio, **sempre** → só então o link. Agora as palavras de conteúdo do lado mais curto (o card, truncado) precisam aparecer no outro lado, com tolerância de uma quando há 4+; a última palavra de um card truncado casa como prefixo ("plást" ↔ "plastica"). Produtos parecidos continuam **não** casando (camiseta preta ≠ branca; camisetas ≠ cuecas). O termo de busca passou a ser as 2 palavras de conteúdo mais longas, sem "Kit", "Promoção", "Original". O harness `casamento-test.cjs` roda também contra as regras antigas, onde falha exatamente nos casos reais.
- **Espera o grid ficar pronto antes de ler**: os cards de "Meus Favoritos" levam um instante para serem desenhados. A extensão espera a **condição** (grid povoado e com a contagem estável), não um tempo fixo — rápido quando a tela responde rápido, seguro quando ela demora. Ler cedo demais fazia o produto recém-favoritado, que está no topo, passar batido e cair no caminho lento da busca e da URL. O log mostra quantos cards havia e em quanto tempo.
- **O link do produto é guardado sempre que dá**: o `shopId` vem do resultado do favoritar (lido da URL do produto) e agora é gravado. Sem ele, quando a URL final não era a do produto, o item entrava no lote **sem link** — e sem link ele pula o "Importar via URL" e cai direto na busca por nome, que é o caminho lento. Quando mesmo assim não der para montar o link, o log diz isso na hora.
- **Palavra em português nunca vira ID (sem IA)**: um modelo de **bigramas** extraído do dicionário pt-BR do LibreOffice (256 mil palavras) dá nota a cada token de 9 letras pela probabilidade dos seus pares de letras adjacentes — "ES", "TR", "SS" são portugueses; "KZ", "QH", "XK" não são. Calibrado contra 18 códigos reais desta live (nenhum perdido) e 24 palavras que já viraram código por engano (nenhuma aceita), com folga limpa entre os dois grupos. Foi assim que `transmissao` deixou de virar `tra-nsm-iss` e `sobremesa` de virar `sob-rem-esa`. Vale para todas as formas sem hífen; com hífen o texto é aceito como ID (quem digita hífen está mandando ID).
- **Nova live = nova sessão**: ao abrir a live, um pendente que já **falhou** antes (ganhou retry) e qualquer item preso em *working* são sobras da live anterior e saem — mesmo que pareçam ID legítimo. Era assim que um código pedido na live passada, cuja busca não achou produto, aparecia "do nada" com o chat vazio. O `📍 marcar chat` também passa pelas barreiras de janela de produto: clicar por engano na sacola não a transforma em chat. Cada item da fila mostra no popup a mensagem de onde saiu ("veio de: …"); item sem origem é suspeito e diz isso.
- **Código que não existe não é insistido**: um código válido redireciona para o produto em 1–2 s. Um inexistente cai numa página de busca comum ("Resultado da pesquisa para 'xxx'", lojas relacionadas, páginas de produtos aleatórios). A extensão esperava 30 s ali e — pior — o fallback antigo clicava no **primeiro resultado da lista**, um produto qualquer, que iria parar na sacola. Agora: lista de resultados = código inválido, resposta em menos de 3 s, nenhum clique, e "noresult" não ganha nova tentativa. O harness `inexistente-test.cjs` roda contra a rota antiga, onde ela navega para um perfume aleatório.
- **Código fantasma na fila**: um pendente gerado por uma regra velha ficava gravado e, por ser o mais antigo, entrava na frente de todo código real a cada live. Agora cada pendente é **revalidado com o parser atual** ao abrir a live e ao atualizar a extensão; o que a regra de hoje recusa, sai. E um pendente que falha ganha **uma** nova tentativa no **fim da fila** — nunca mais na frente dos códigos reais — e na segunda falha é descartado. Cada item guarda a mensagem de origem ("veio de: …").
- **Risada não é ID**: `kkkkkkkkk` chegou a virar KKK-KKK-KKK. A primeira ideia — "um ID nunca repete a mesma letra em sequência" — foi testada contra os 15 códigos reais desta live e é **falsa**: `DKA-AAU-QSN`, `DDx-RAG-VZE`, `CKK-TVE-HTZ` e `BLY-JMH-HSL` têm par (até trio) adjacente. O que separa risada de ID é a **variedade**: um ID sorteado tem 7–8 letras distintas, uma risada tem 1 ou 2. O corte é em 3 letras distintas ou menos, com folga larga dos dois lados, e vale para todas as formas — com hífen, sem hífen, colado ao apelido e colagem manual.
- **Link antes da busca, nos dois caminhos**: "não está no topo" acontece em dois lugares — quando nenhum produto do lote entrou e quando alguns entraram e outros não (pós-Confirmar). O segundo ainda fazia a busca por nome antes de converter o link, e um produto favoritado ia parar na barra de busca. Agora a ordem é a mesma nos dois.
- **Sem rodeio quando não está no topo**: a busca por nome e a aba "Importar via URL" ficam **dentro da mesma janela** que já está aberta, então ela não é mais fechada e reaberta. E o **link vem primeiro**: ele é exato (guardado na hora de favoritar) e resolve num passo, enquanto a busca por nome é lenta e pode não achar — a busca ficou como reserva, para produto sem link ou quando a conversão recusa.
- **Importar via URL é o último recurso**: só entra quando o produto realmente não está no topo de "Meus Favoritos" ou o clique não pegou.
- **Caixas de "rascunho"**: quando a Shopee empilha janelinhas perguntando sobre rascunho (que travam a tela inteira), a extensão clica em **Não** sozinha, quantas vezes for preciso, e registra no log. Ela só toca em caixas cujo texto fala de rascunho.
- **Busca por colagem**: o código é colado inteiro na barra de busca (como Ctrl+V), não digitado letra a letra. A extensão espera o React da Shopee assumir a barra antes de colar (colar antes disso fazia o código "sumir" e ser colado de novo); a linha do tempo da busca ("react pronto em…, colado em…, enter em…, saiu da home em…") aparece na nota do item, no popup.
- **Modo simulação** (👁 Simular): percorre todas as telas, mostra o que marcaria e cancela sem confirmar.

O interruptor **automático** no popup dispara o fluxo sozinho quando a fila zera. Ele vem **desligado** — use a simulação primeiro.

## Duas edições, uma fonte só

| | pasta | para quem |
| --- | --- | --- |
| **Sacolinha Automática** | `extension/` | uso próprio, sem cobrança |
| **Sacolinha Automática Pro** | `dist/pro/` | vendida por assinatura |

A Pro é **gerada** a partir de `extension/` por `node build/build.mjs`. Só dois arquivos diferem: `manifest.json` (o nome) e `edicao.js` (o sinalizador da edição). Todo o resto é igual, então correção feita numa vale para as duas — não existe código duplicado para manter.

As duas podem ficar instaladas ao mesmo tempo: pastas diferentes são extensões diferentes para o navegador, cada uma com sua própria fila, calibração e configurações.

## Instalar (modo desenvolvedor)

Brave: `brave://extensions` → ativar **Modo de desenvolvedor** → **Carregar sem compactação** → escolher a pasta `extension/`.
Edge: `edge://extensions` · Chrome: `chrome://extensions` — mesmo caminho.

Esteja logada na Shopee (`shopee.com.br`) nesse navegador.

## Volume alto (live cheia)

O limite padrão passou a ser **600 favoritos por hora** (era 120, que virava gargalo com muita gente mandando código). Ao bater no teto a fila **avisa**: notificação, log e um alerta em amarelo no popup, em vez de parar em silêncio. A ordem é sempre **do código mais antigo para o mais recente**, mesmo com várias janelas favoritando em paralelo. Se uma aba ficar congelada em segundo plano, a extensão dá foco nela sozinha depois de 25 s para destravar.

## Velocidade

Ao favoritar, a extensão espera **só a barra de busca** ficar pronta — não a home inteira (produtos, banners e imagens abaixo dela não são usados). O mesmo na página do produto: o clique sai assim que o botão de favoritar está vivo, sem tempo fixo de espera. A linha do tempo de cada busca aparece na nota do item, no popup.

## Calibração (se "botão Curtir não encontrado")

A detecção do botão é por texto/aria-label ("Curtir", "Favoritar"…). Se a Shopee mudar a tela: abra um produto, clique em **Calibrar botão Curtir** no popup e clique no coração da página — o seletor fica gravado.

O **📍 marcar chat** é o equivalente para a live, e também é opcional: a extensão acha a caixa de comentários sozinha, pela estrutura do painel (não precisa esperar mensagem nova) ou por onde as mensagens entram. Use o marcador só se o painel disser que não achou o chat.

## Riscos e limites (leia)

- A extensão age na conta dela, no navegador dela, com ritmo humano — mas **automatizar ações na Shopee não é previsto pelos termos de uso**. Mantenha o ritmo conservador (padrão: 6–12 s, 120/h) e não rode em várias contas.
- Depende da tela da Shopee (SPA); mudanças de layout podem exigir recalibrar.
- IDs soltos só são resolvidos com o app aberto **e** credenciais da API; sem isso a extensão tenta `shopee.com.br/product/0/{id}`.
- A live precisa estar visível no navegador do PC para a leitura automática do chat; caso contrário use a colagem manual (ou o app mobile companheiro, ver README principal).
