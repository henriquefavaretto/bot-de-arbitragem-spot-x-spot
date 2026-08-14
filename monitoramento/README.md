# Monitor de spreads USDT/BRL

Grava a cada 10 segundos o spread de **todas as combinações ordenadas** entre 7
venues, para você deixar rodando alguns dias e depois analisar quais
oportunidades realmente existiram.

Só leitura: nenhuma chave de API, nenhuma ordem, nenhuma transação.

## Venues

| Venue | Par | Observação |
|---|---|---|
| Binance | `USDT/BRL` | mais líquido |
| OKX | `USDT/BRL` | |
| KuCoin | `USDT/BRL` | livro de venda mais raso |
| Bitget | `USDT/BRL` | costuma ter o melhor bid |
| MEXC | `BRL/USDT` | **invertido** — preço em USDT por BRL |
| BRLA | KyberSwap · Polygon | `0xE6A537a4...f19DdDfb` |
| BRZ | KyberSwap · Polygon | `0x4eD14111...4d2475Dc` (v2, 18 casas) |

7 venues → **42 combinações ordenadas** por coleta.

> A MEXC lista o par ao contrário das outras. O código resolve o símbolo em
> runtime lendo os mercados da exchange (`resolveSymbol`) e inverte preços,
> bids e asks quando necessário. Cravar `USDT/BRL` faz o par sumir sem erro.

## Como funciona

Cada perna **A → B** é: comprar USDT com BRL em A, mover o USDT para B, vender
USDT por BRL em B.

Todo venue é normalizado para dois números, **sempre em BRL por 1 USDT**:

- `ask` — quanto custa adquirir 1 USDT ali (usado quando a rota **sai** dali)
- `bid` — quanto se recebe ao vender 1 USDT ali (usado quando a rota **chega**)

Nas DEXs o "BRL" é BRLA ou BRZ, tratados 1:1 com o real, e os dois sentidos são
cotados separadamente no KyberSwap:

- **chegando** na DEX: swap USDT → token, então `bid` = token recebido por USDT
- **saindo** da DEX: swap token → USDT, então `ask` = token gasto por USDT

É isso que dá o caminho inverso que você pediu: sair de BRLA/BRZ, virar USDT, e
vender esse USDT por BRL numa CEX.

Os preços são **efetivos**, não o topo do livro: o código percorre a
profundidade para o tamanho configurado. Se o livro não comporta o valor, a
linha é marcada com `profundidade_ok = 0` e o relatório a ignora.

### Taxas embutidas no líquido

- taxa de negociação na origem e no destino
- taxa de saque de USDT do venue de origem
- gás na Polygon quando alguma ponta é DEX (swap + transferência)

`spread_bruto − taxas = spread_líquido`. O líquido é o número que decide.

## Uso

```bash
npm install
```

Opcional: copie `.env.example` para `.env` e ajuste taxas e aporte.

```bash
npm start
```

Deixe rodando. `Ctrl+C` para parar — os dados já estão no disco a cada tick.

Para conferir se os pares estão sendo resolvidos corretamente:

```bash
npm run probe
```

Para analisar o que foi coletado:

```bash
npm run report
```

Para reconstruir a sequência de operações ao longo dos dias:

```bash
npm run chains -- --inicio=binance --valor=1000 --atraso=30
```

## Arquivos gerados

| Arquivo | Conteúdo | Volume |
|---|---|---|
| `data/cotacoes-AAAA-MM-DD.csv` | ask/bid de cada venue por coleta | ~60 mil linhas/dia |
| `data/spreads-AAAA-MM-DD.csv` | as 42 combinações por coleta | ~363 mil linhas/dia |
| `data/mercado-AAAA-MM-DD.csv` | gás e preço do POL por coleta | ~8,6 mil linhas/dia |
| `data/oportunidades.csv` | só o que passou do limiar, arquivo único | poucas linhas |
| `data/cadeia-*.csv` | resultado da última simulação de cadeias | uma linha por pulo |

Rotação diária nos dois primeiros. Cerca de **40 MB por dia** no total. Abrem
direto no Excel (têm BOM, então os acentos saem certos); para vários dias,
prefira pandas ou Power Query.

## O relatório

`npm run report` produz duas visões.

**Ranking geral** — por rota: pico, p95, mediana e *em que porcentagem do tempo*
ficou acima do limiar. O pico importa menos que a persistência: uma rota que
passa do limiar em 40% do tempo é operável; uma que só teve um pico isolado, não.

**Saídas por venue** — responde a pergunta que motivou o projeto: depois de
mover fundos para um venue, o que estava disponível para sair dali.

Exemplo real de uma coleta curta:

```
  BITGET
    nenhuma saída passou de 0.3% no período
      → KuCoin    pico  -0.720%
      → OKX       pico  -0.905%
```

Todas as rotas apontavam **para** o Bitget (melhor bid do mercado), mas nenhuma
saía dele com lucro. Entrar ali travaria o capital até o spread virar. Esse é
exatamente o tipo de armadilha que só aparece com dias de dados.

## Simulação de cadeias (`npm run chains`)

O relatório acima olha cada rota isoladamente. Este comando reconstrói a
**sequência**: começar com R$ X num venue, pular para outro, esperar, pular de
novo — encadeando ao longo dos dias.

```bash
npm run chains -- --inicio=binance --valor=1000 --atraso=30 --limiar=0.3
```

| Opção | Significado |
|---|---|
| `--inicio` | venue de partida, ou `todos` para comparar todos |
| `--valor` | capital inicial em BRL |
| `--atraso` | minutos entre a compra e a chegada no destino |
| `--limiar` | spread mínimo para o bot greedy disparar |

Ele imprime duas cadeias:

**Melhor cadeia possível** — programação dinâmica sobre `(coleta, venue)` com
visão retroativa perfeita. É o **teto**: nenhuma estratégia ao vivo bate isso.

**Bot com limiar** — o que uma regra simples teria capturado de verdade: a cada
coleta, se alguma saída do venue atual mostra spread acima do limiar, executa a
melhor. A distância entre as duas mede quanto custa não ter bola de cristal.

### Compra e venda em instantes diferentes

Esta é a diferença central em relação ao `spreads.csv`. Lá, compra e venda são
cotadas no **mesmo segundo** — útil para ranquear rotas, mas não é o que
acontece. Aqui a compra usa o preço do momento da decisão e a venda usa o preço
do momento da **chegada**, depois do atraso:

```
  #  saída                 rota                       chegada                 visto     real
   1 2026-08-04 17:20:01   BRLA (KyberSwap) → Bitget  2026-08-04 17:21:02   +0.639%  +0.639%
```

`visto` é o que apareceria no painel na hora de decidir; `real` é o que se
realizou. Quando os dois divergem muito, o spread evaporou durante a
transferência — e é esse o risco que o histórico serve para medir.

### O atraso é medido no relógio, não em coletas

A coleta tem buracos: reinício, queda de rede, máquina dormindo. Contar um
número fixo de coletas faria "1 minuto" virar 17 minutos depois de uma
interrupção, inventando um resultado que nunca existiu.

O simulador procura a primeira coleta que acontece pelo menos `--atraso`
minutos depois, e **descarta** o instante se o buraco esticar o atraso além de
2,5×. Quantos instantes foram descartados aparece no cabeçalho.

## Limites conhecidos

- **Taxas de saque são estimativas.** Estão no `.env` e mudam com frequência.
  Confira na sua conta — um erro de 0,3 USDT desloca o líquido em ~0,03 p.p.
- **Redes não são verificadas.** O custo assume que existe uma rede barata em
  comum entre origem e destino. Na prática confira se as duas suportam a mesma.
- **Spread medido ≠ spread capturado.** Entre a compra e a venda passam-se
  minutos de saque on-chain. O monitor mede o instante; o histórico serve para
  julgar se a janela costuma durar o suficiente.
- **DEX ignora o tempo de confirmação** e assume que a rota do KyberSwap
  continua válida na execução.

## Simulador de rotas (`npm run rotas`)

O `chains` escolhe o caminho por você. Este aqui testa **o caminho que você
mandar** — ou ranqueia todos os possíveis.

```bash
npm run rotas -- --rota=bitget,dex-brz,binance,bitget --valor=5000 --atraso=5
```

| Opção | Significado |
|---|---|
| `--rota` | sequência de venues, começando e terminando no mesmo |
| `--inicio` | ranquear só os ciclos que partem deste venue |
| `--profundidade` | número máximo de pernas no ranking (padrão 3) |
| `--valor` | capital, importa para amortizar taxas fixas |
| `--atraso` | minutos entre a compra e a chegada |

Sem `--rota` ele enumera todos os ciclos e ranqueia por teto.

### Três correções de modelagem que ele incorpora

**Cada perna espera o próprio gatilho.** Simular com limiar único, ou as pernas
no mesmo instante, subestima brutalmente. Numa cadeia testada a diferença foi
de −0,88% para −0,03%: a mesma rota, medida errado, parecia inviável.

**O resultado reportado é o do último ciclo FECHADO.** Uma rota que termina
parada num venue conta o ganho da última perna, mas aquele capital ainda teria
que pagar para sair. Contando o saldo final, uma rota aparecia com +1,020%
quando o número honesto era +0,211%.

**Taxas de saque lidas da API**, não estimadas. A KuCoin cobra 1,00 USDT contra
0,01 da Binance — cem vezes mais. Com a estimativa antiga de 0,20 o ranking das
rotas saía trocado.

### Como ler o teto

O `teto` do ranking é a soma do melhor momento de cada perna. Ele **não**
respeita a ordem cronológica: assume que todos os extremos acontecem na
sequência certa. Serve para descartar rotas ruins rápido, não para prometer
resultado. O número que vale é o da simulação com `--rota`.
