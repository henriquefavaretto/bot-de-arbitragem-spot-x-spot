import { config } from './config.js';
import { logger } from './log.js';

const log = logger('kyber');

/** O objeto de rota é opaco para nós — devolvemos exatamente como veio para o /route/build. */
export interface RouteSummary {
  tokenIn: string;
  amountIn: string;
  amountInUsd: string;
  tokenOut: string;
  amountOut: string;
  amountOutUsd: string;
  gas: string;
  gasPrice: string;
  gasUsd: string;
  route: unknown[];
  [k: string]: unknown;
}

export interface RouteQuote {
  routeSummary: RouteSummary;
  routerAddress: string;
  amountOutRaw: bigint;
  gasUsd: number;
}

export interface BuiltSwap {
  data: string;
  routerAddress: string;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  /** Mínimo garantido após o slippage — é o piso do ciclo. */
  amountOutMinRaw: bigint;
  transactionValue: bigint;
  gas: bigint;
  gasUsd: number;
}

interface KyberEnvelope<T> {
  code: number;
  message: string;
  data: T;
  requestId?: string;
}

const BASE = `${config.kyber.baseUrl}/${config.chain.chainSlug}/api/v1`;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'x-client-id': config.kyber.clientId,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const text = await res.text();
  let body: KyberEnvelope<T>;
  try {
    body = JSON.parse(text) as KyberEnvelope<T>;
  } catch {
    throw new Error(`KyberSwap devolveu resposta não-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok || body.code !== 0) {
    throw new Error(`KyberSwap ${url.replace(config.kyber.baseUrl, '')} falhou (code ${body.code}): ${body.message}`);
  }
  return body.data;
}

/** Cotação USDT -> BRLA. `amountInRaw` está nas unidades mínimas do token de entrada. */
export async function getRoute(
  tokenIn: string,
  tokenOut: string,
  amountInRaw: bigint,
  origin: string,
): Promise<RouteQuote> {
  const qs = new URLSearchParams({
    tokenIn,
    tokenOut,
    amountIn: amountInRaw.toString(),
    gasInclude: 'true',
    origin,
  });

  const data = await call<{ routeSummary: RouteSummary; routerAddress: string }>(`${BASE}/routes?${qs}`);

  return {
    routeSummary: data.routeSummary,
    routerAddress: data.routerAddress,
    amountOutRaw: BigInt(data.routeSummary.amountOut),
    gasUsd: Number(data.routeSummary.gasUsd ?? 0),
  };
}

/**
 * Converte a rota em calldata assinável.
 * `recipient` recebe o BRLA — em geral a própria carteira do bot.
 */
export async function buildRoute(
  quote: RouteQuote,
  sender: string,
  recipient: string,
  slippageBps: number,
): Promise<BuiltSwap> {
  const data = await call<{
    data: string;
    routerAddress: string;
    amountIn: string;
    amountOut: string;
    transactionValue: string;
    gas: string;
    gasUsd: string;
  }>(`${BASE}/route/build`, {
    method: 'POST',
    body: JSON.stringify({
      routeSummary: quote.routeSummary,
      sender,
      recipient,
      slippageTolerance: slippageBps,
      deadline: Math.floor(Date.now() / 1000) + 20 * 60,
      source: config.kyber.clientId,
      // A estimativa simula o swap on-chain; em DRY_RUN a carteira não tem
      // saldo nem allowance, então a simulação reverteria sem motivo real.
      enableGasEstimation: !config.dryRun,
    }),
  });

  const amountOutRaw = BigInt(data.amountOut);
  const amountOutMinRaw = (amountOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;

  log.info(`rota construída via router ${data.routerAddress} (gas est. ~$${Number(data.gasUsd).toFixed(3)})`);

  return {
    data: data.data,
    routerAddress: data.routerAddress,
    amountInRaw: BigInt(data.amountIn),
    amountOutRaw,
    amountOutMinRaw,
    transactionValue: BigInt(data.transactionValue ?? '0'),
    gas: BigInt(data.gas ?? '0'),
    gasUsd: Number(data.gasUsd ?? 0),
  };
}
