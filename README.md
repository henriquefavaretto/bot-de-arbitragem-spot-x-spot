# arb desk

Bot de arbitragem com três rotas, todas partindo de BRL na Binance:

```
CEX→DEX  BRL → USDT → Polygon → swap KyberSwap → BRLA → carteira Picnic
CEX→DEX  BRL → USDT → Polygon → swap KyberSwap → BRZ  → carteira Chainless
CEX→CEX  BRL → USDT → BEP20   → vender USDT/BRL na Bitget
CEX→CEX  BRL → USDT → BEP20   → vender USDT/BRL na KuCoin
```

O saque final em BRL você faz manualmente via PIX na plataforma de destino.

A rota da Bitget é um porte fiel do bot Python `binance_arb_bep20.py` — mesma
biblioteca (ccxt), mesma sequência de chamadas, mesma estratégia de venda com
ordens LIMIT reprecificadas no melhor bid. Ver [src/cex.ts](src/cex.ts).

O dashboard mostra, para cada rota, o **spread líquido** e o **lucro em reais**
do ciclo inteiro, já descontando taxa de negociação, taxa de saque da Binance,
gás na Polygon e taxa da plataforma de destino. Dá para executar um ciclo com um
botão ou ligar o **modo automático** por rota, que dispara sozinho quando o
spread passa do alvo definido.

As duas rotas compartilham a mesma conta Binance e a mesma carteira, então **só
um ciclo roda por vez**. Se as duas baterem o alvo ao mesmo tempo no modo
automático, o bot escolhe a de maior spread.

---

## Instalação

```bash
npm install
```

Copie `.env.example` para `.env` e preencha. Depois:

```bash
npm run dev
```

O dashboard sobe em `http://127.0.0.1:3000`.

Para rodar compilado:

```bash
npm run build && npm start
```

---

## Configuração mínima

| Variável | O que é |
|---|---|
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | API key com **Spot Trading** e **Withdrawals** habilitados |
| `POLYGON_PRIVATE_KEY` | **Chave privada** (64 caracteres hex) da carteira hot que recebe o USDT, faz o swap e envia o token. Não é o endereço. |
| `PICNIC_DEPOSIT_ADDRESS` | Endereço de depósito da sua conta Picnic — habilita a rota BRLA |
| `CHAINLESS_DEPOSIT_ADDRESS` | Endereço de depósito da sua conta Chainless — habilita a rota BRZ |
| `BITGET_DEPOSIT_ADDRESS` | Endereço de USDT na Bitget, **rede BEP20 (BSC)** — habilita a rota Bitget |
| `BITGET_API_KEY` / `_SECRET` / `_PASSWORD` | Credenciais da Bitget (a passphrase é obrigatória na API deles) |
| `KUCOIN_DEPOSIT_ADDRESS` | Endereço de USDT na KuCoin, **rede BEP20 (BSC)** — habilita a rota KuCoin |
| `KUCOIN_API_KEY` / `_SECRET` / `_PASSWORD` | Credenciais da KuCoin (também exige passphrase) |
| `TRADE_AMOUNT_BRL` | Quanto gastar por ciclo |
| `MIN_SPREAD_PCT` | Spread líquido mínimo para o modo automático disparar |
| `DRY_RUN` | `true` simula tudo sem enviar nada. **Comece com `true`.** |

Uma rota sem endereço de destino aparece no dashboard mas fica desabilitada —
dá para rodar só a Picnic, só a Chainless, ou as duas.

O endereço da carteira do bot é derivado automaticamente da chave privada e
aparece no dashboard, em **Configurações → endereços**.

### Antes de rodar com dinheiro real

1. **Whitelist na Binance.** Cadastre o endereço da carteira Polygon na lista de
   endereços de saque da Binance. Sem isso o `withdraw` é rejeitado.
2. **Restrinja a API key por IP.** Uma key com permissão de saque sem restrição
   de IP é o pior cenário possível se vazar.
3. **Carteira dedicada.** Use uma carteira nova, só com o capital de um ciclo.
   A chave privada fica em texto no `.env` — quem tiver acesso à máquina tem
   acesso aos fundos.
4. **POL para gás.** A carteira precisa de POL para pagar approve + swap +
   transfer. O bot recusa o ciclo se o saldo não cobrir o dobro do estimado.
5. **Rode em `DRY_RUN=true` primeiro** e acompanhe o spread por algumas horas
   antes de virar a chave.

---

## Contratos verificados on-chain

| Token | Endereço na Polygon | Dec. |
|---|---|---|
| USDT | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` | 6 |
| BRLA | `0xE6A537a407488807F0bbeb0038B79004f19DdDfb` | 18 |
| BRZ | `0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc` | 18 |

## Malha (aba "Malha")

As 4 rotas acima partem sempre de BRL na Binance. A **malha** é o passo seguinte:
trata os 7 venues como nós de um grafo e mostra as **42 pernas ordenadas** entre
eles, para encadear operações sem precisar sacar para o banco no meio.

Cada venue é normalizado para dois números, sempre em **BRL por 1 USDT**:

- `ask` — quanto custa adquirir 1 USDT ali (a perna **sai** dali)
- `bid` — quanto se recebe ao vender 1 USDT ali (a perna **chega** ali)

Nas DEX o "BRL" é BRLA ou BRZ, tratados 1:1 com o real, e os dois sentidos do
swap são cotados separadamente. É essa normalização que permite tratar CEX e
DEX como nós do mesmo grafo.

### Estado do capital

A peça que faltava para encadear: o bot guarda **onde o dinheiro está**
(`data/position.json`). O painel mostra as saídas a partir dali, ranqueadas, e
o lucro acumulado da cadeia.

### Seleção automática de rede

Para cada perna o bot escolhe a rede mais barata que a origem consegue sacar e
o destino consegue depositar.

Isso exige normalizar os nomes: a Binance chama de `BSC` o que KuCoin e Bitget
chamam de `BEP20`, e o mesmo vale para `MATIC`/`Polygon`, `TRX`/`TRC20`. Sem a
tabela de apelidos em [venues.ts](src/venues.ts), nenhuma perna acha rede em
comum e todas caem no fallback pessimista.

Taxas reais medidas na API (saque de USDT, BEP20):

| Origem | Taxa |
|---|---|
| Binance | 0,01 USDT |
| Bitget | 0,15 USDT |
| KuCoin | **1,00 USDT** |

Sacar da KuCoin custa 100× o da Binance — por isso ela funciona bem como
destino e mal como origem.

> **OKX e MEXC** não expõem taxas de saque sem chave de API. Enquanto não houver
> credenciais, essas pernas usam um fallback conservador de 1 USDT e aparecem
> marcadas com `~` no painel. Uma chave somente-leitura já resolve.

### Monitoramento (botão "Monitorar")

O painel da malha tem um botão que liga a gravação contínua em CSV. Ele grava
**a mesma cotação que a tela mostra**, sem recalcular nada — não existe
divergência possível entre o que você vê e o que fica registrado.

| Arquivo | Conteúdo |
|---|---|
| `data/monitor/cotacoes-AAAA-MM-DD.csv` | ask/bid de cada venue por coleta |
| `data/monitor/spreads-AAAA-MM-DD.csv` | as 42 pernas por coleta |
| `data/monitor/mercado-AAAA-MM-DD.csv` | gás, POL e quantos venues responderam |
| `data/monitor/oportunidades.csv` | só o que passou do limiar |

Rotação diária. Cerca de 40 MB/dia. O estado sobrevive a reinício: se estava
gravando, volta gravando.

#### O que torna o registro fiel

- **Preços da caminhada real do livro**, não do topo — o spread já reflete o
  impacto do seu tamanho.
- **Taxa de saque lida da API** de cada exchange, por rede, autenticada.
- **Nomes de rede normalizados** antes de comparar origem e destino
  (`BSC`≡`BEP20`, `MATIC`≡`Polygon`).
- **Aporte de referência fixo** (`MONITOR_AMOUNT_BRL`), independente do saldo da
  posição. Spreads cotados com R$ 1.000 e com R$ 5.000 percorrem profundidades
  diferentes; base móvel tornaria dias diferentes incomparáveis.
- **Toda estimativa é marcada.** As colunas `taxa_rede_conhecida` e
  `profundidade_ok` dizem em quais linhas confiar. Uma perna com taxa estimada
  **nunca** entra em `oportunidades.csv`.
- **Falha vira registro, não buraco.** Venue que não respondeu grava linha com
  `erro` em vez de repetir o dado anterior.

#### Analisando os dados

As colunas são compatíveis com os scripts do projeto de monitoramento — basta
apontar `DATA_DIR` para esta pasta:

```bash
cd ../monitoramento; $env:DATA_DIR="C:\Users\henrique\Desktop\bot-picnic\data\monitor"; npm run report
```

### O que a fase 2 faz e não faz

O botão **registrar** move a posição usando o resultado previsto pela cotação
do momento. **Nenhum dinheiro é movido.** Serve para acompanhar a cadeia e
validar a lógica antes de expor capital.

Só as pernas que saem da Binance têm execução real implementada. As demais
aparecem para análise com o botão marcado — comprar USDT fora da Binance e
sacar de outras exchanges é a fase 3.

---

## Escolha da rede nas rotas CEX → CEX

Taxas de saque de USDT lidas da API da Binance, cruzadas com as redes que
Bitget e KuCoin aceitam depositar, e os tempos informados pela KuCoin:

| Rede | Taxa de saque | Tempo | Memo? |
|---|---|---|---|
| **BEP20 (BSC)** | **0,010 USDT** | ~3 min | não |
| PLASMA | 0,012 USDT | ~1 min | não |
| AVAXC / OP | 0,040 USDT | ~3 min | não |
| MATIC | 0,070 USDT | ~10 min | não |
| TON | 0,300 USDT | ~3 min | **sim** |
| ERC20 | 0,400 USDT | ~3 min | não |
| TRC20 | 1,500 USDT | ~1 min | não |

O padrão é **BEP20**: a mais barata e sem memo.

Duas armadilhas nessa tabela. **TRC20** parece atraente por ser rápida, mas
custa 150× mais — num ciclo de R$ 1.000 são R$ 7,70 contra R$ 0,05, ou seja
0,77 ponto percentual de spread perdido só na escolha da rede. E **TON** exige
memo: um depósito sem memo é perdido.

PLASMA chega 2 minutos mais rápido por praticamente o mesmo custo, mas é uma
chain recente e pouco rodada — não vale o risco pela diferença.

---

⚠️ Existe um contrato BRZ antigo na Polygon
(`0x491a4eB4f1FC3BfF8E1d2FC856a6A46663aD556f`, 4 decimais) que ainda responde
mas está sem liquidez — uma cotação de 195 USDT nele devolve 1,88 BRZ. Não
troque o `BRZ_ADDRESS` por esse.

---

## Como o spread é calculado

A cada 10 segundos (`QUOTE_INTERVAL_MS`) o bot busca **um** snapshot de mercado
(livro da Binance, taxa de saque, preço do gás) e monta a cotação de cada rota
em cima dele, sem enviar nenhuma ordem:

1. **Binance** — percorre o livro de ofertas de `USDTBRL` simulando uma ordem a
   mercado do valor configurado. Usa a profundidade real, então o preço já
   reflete o impacto da sua ordem, não o topo do livro.
2. **Taxa de negociação** — `BINANCE_TAKER_FEE` (0,1% por padrão).
3. **Taxa de saque** — lida da própria Binance (`capital/config/getall`) para a
   moeda e rede configuradas.
4. **KyberSwap** — cota a rota USDT → token na Polygon para o valor que
   efetivamente chegaria na carteira.
5. **Gás** — estima approve + swap + transfer com o preço de gás atual e
   converte para BRL via POL/USDT × USDT/BRL.
6. **Plataforma de destino** — desconta a taxa configurada da Picnic/Chainless.

O resultado é `spread % = (BRL líquido no fim / BRL investido − 1) × 100`, e o
card decompõe isso em **spread bruto − taxas**. O spread bruto é o ganho de
preço puro (comprar USDT a X e vender a Y), calculado aplicando a taxa efetiva
do swap ao volume antes das taxas — uma aproximação que ignora a curvatura do
slippage entre os dois volumes.

O **impacto de preço** vem do próprio KyberSwap (diferença entre o valor em USD
que entra e o que sai da rota).

---

## Segurança embutida

- **Destino travado.** Cada token só vai para o endereço configurado da sua
  rota. Endereços de queima são recusados fora do modo simulação.
- **Um ciclo por vez.** As rotas dividem a mesma conta e a mesma carteira; o
  bot serializa a execução.
- **Teto por ciclo.** `MAX_TRADE_AMOUNT_BRL` bloqueia qualquer valor acima, mesmo
  que a UI peça.
- **Allowance exata.** O approve libera só o valor daquele swap, nunca infinito.
- **Piso de saída no swap.** Se o swap entregar menos que o mínimo do slippage,
  o ciclo falha em vez de seguir.
- **Ciclo travado bloqueia o bot.** Se algo falhar depois da compra, há dinheiro
  parado em algum ponto do caminho. O bot desliga o modo automático e só volta a
  operar depois de você revisar e liberar pelo dashboard.
- **Dashboard só em localhost** por padrão (`HOST` para mudar). Defina
  `DASHBOARD_PASSWORD` se for expor a porta.

---

## Estrutura

```
src/
  config.ts    validação do .env + definição das rotas
  binance.ts   REST assinado: livro, saldos, ordem a mercado, saque
  chain.ts     ethers na Polygon: ERC20, allowance, transfer, envio de tx
  kyber.ts     KyberSwap Aggregator: GET /routes + POST /route/build
  cex.ts       porte do bot Python: Bitget via ccxt, venda no melhor bid
  quote.ts     snapshot de mercado + cálculo do spread por rota
  engine.ts    máquina de estados do ciclo, modo automático, persistência
  server.ts    Express + SSE + estáticos
public/        dashboard (sidebar, cards por rota, histórico, configurações)
data/          histórico de ciclos e configurações (criado em runtime)
```

Para adicionar uma rota nova, basta um `dexRoute({...})` ou `cexRoute({...})` no
array `routes` de [src/config.ts](src/config.ts) — cotação, execução, UI e
histórico se ajustam sozinhos.

### As duas formas de rota

| | `dex` | `cex` |
|---|---|---|
| Passos | comprar → sacar → aguardar → aprovar → swap → transferir | comprar → sacar → aguardar → vender |
| Conversão | KyberSwap na Polygon | livro USDT/BRL da exchange de destino |
| Custo de rede | gás em POL | nenhum |
| Precisa de | chave privada + POL | credenciais da exchange |

---

## Riscos que o bot não elimina

- **O spread pode virar durante o ciclo.** Entre a compra na Binance e o swap
  passam-se minutos — o saque da Binance não é instantâneo. A cotação mostrada é
  do momento do disparo, não uma garantia. Esse é o risco central da operação.
- **Liquidez do BRLA e do BRZ.** Os dois pares têm profundidade limitada.
  Valores altos por ciclo degradam a execução; o `SLIPPAGE_BPS` protege contra o
  pior caso mas não contra um preço ruim dentro da tolerância. Acompanhe o
  impacto de preço no card antes de subir o valor.
- **Saque suspenso.** A Binance pode suspender saques de USDT na Polygon a
  qualquer momento, inclusive depois da compra.
- **Tributação.** Operações de arbitragem com cripto têm implicações fiscais no
  Brasil. Não sou contador — consulte um.
- **Fallback a mercado na Bitget.** Se as 8 tentativas de ordem LIMIT não
  encherem, o bot vende o restante a mercado para não deixar capital preso.
  Isso pode sair a um preço pior que o cotado — está no log quando acontece.
