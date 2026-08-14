/**
 * Descobre quais exchanges realmente têm mercado spot USDT/BRL e se o livro
 * responde. Rode com `npm run probe` antes de confiar na lista de venues.
 */
import { venues } from './config.js';
import { resolveSymbol } from './venues.js';
import ccxt from 'ccxt';

/**
 * Cuidado ao procurar o par: nem toda exchange lista USDT/BRL. A MEXC usa
 * BRL/USDT (BRL na base), então filtrar por símbolos terminados em "/BRL"
 * deixa o par de fora e dá a impressão errada de que não existe.
 */
async function probe(exchangeId: string, label: string) {
  try {
    const { symbol, inverted } = await resolveSymbol(exchangeId);

    const Ctor = (ccxt as unknown as Record<string, new (c: unknown) => InstanceType<typeof ccxt.Exchange>>)[
      exchangeId
    ];
    const ex = new Ctor({ enableRateLimit: true });
    const ob = await ex.fetchOrderBook(symbol, 100);

    const bids = (ob.bids ?? []) as [number, number][];
    const asks = (ob.asks ?? []) as [number, number][];
    if (!bids.length || !asks.length) {
      console.log(`${label.padEnd(10)} ${symbol.padEnd(10)} livro vazio`);
      return;
    }

    // Converte tudo para "BRL por 1 USDT" e mede a profundidade em BRL.
    const askBrl = inverted ? 1 / bids[0][0] : asks[0][0];
    const bidBrl = inverted ? 1 / asks[0][0] : bids[0][0];
    const depthBrl = (levels: [number, number][]) =>
      levels.reduce((s, [p, q]) => s + (inverted ? q : p * q), 0);

    console.log(
      `${label.padEnd(10)} ${symbol.padEnd(10)}${inverted ? 'invertido' : '  normal '}  ` +
        `ask ${askBrl.toFixed(4)}  bid ${bidBrl.toFixed(4)}  ` +
        `profundidade 100 níveis: compra R$ ${depthBrl(asks).toFixed(0)} / venda R$ ${depthBrl(bids).toFixed(0)}`,
    );
  } catch (e) {
    console.log(`${label.padEnd(10)} ERRO: ${(e as Error).message.slice(0, 110)}`);
  }
}

for (const v of venues) {
  if (v.kind !== 'cex') continue;
  await probe(v.exchange!, v.label);
}
