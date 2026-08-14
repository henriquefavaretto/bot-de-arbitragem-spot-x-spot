import { config, POLYGON } from './config.js';

const BASE = `${config.kyber.baseUrl}/${config.kyber.chain}/api/v1`;

interface RouteSummary {
  amountIn: string;
  amountOut: string;
  amountInUsd: string;
  amountOutUsd: string;
  gas: string;
  [k: string]: unknown;
}

export interface KyberQuote {
  amountOutRaw: bigint;
  gasUnits: bigint;
  amountInUsd: number;
  amountOutUsd: number;
}

/**
 * Cotação de swap no agregador do KyberSwap. Só leitura — nenhuma transação é
 * construída nem enviada.
 */
export async function getRoute(tokenIn: string, tokenOut: string, amountInRaw: bigint): Promise<KyberQuote> {
  const qs = new URLSearchParams({
    tokenIn,
    tokenOut,
    amountIn: amountInRaw.toString(),
    gasInclude: 'true',
  });

  const res = await fetch(`${BASE}/routes?${qs}`, {
    headers: { 'x-client-id': config.kyber.clientId },
  });

  const text = await res.text();
  let body: { code: number; message: string; data?: { routeSummary: RouteSummary } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`KyberSwap devolveu resposta não-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }

  if (!res.ok || body.code !== 0 || !body.data) {
    throw new Error(`KyberSwap falhou (code ${body.code}): ${body.message}`);
  }

  const rs = body.data.routeSummary;
  return {
    amountOutRaw: BigInt(rs.amountOut),
    gasUnits: rs.gas ? BigInt(rs.gas) : BigInt(config.gasSwapUnits),
    amountInUsd: Number(rs.amountInUsd ?? 0),
    amountOutUsd: Number(rs.amountOutUsd ?? 0),
  };
}

/** Preço de gás atual na Polygon, em wei. */
export async function polygonGasPriceWei(): Promise<bigint> {
  const res = await fetch(POLYGON.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
  });
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (!body.result) throw new Error(`RPC da Polygon falhou: ${body.error?.message ?? 'sem resultado'}`);
  return BigInt(body.result);
}
