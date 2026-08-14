import {
  Contract,
  JsonRpcProvider,
  Network,
  Wallet,
  formatUnits,
  parseUnits,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';
import { config } from './config.js';
import { logger } from './log.js';

const log = logger('chain');

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

/**
 * Rede construída à mão de propósito: a definição embutida "matic" do ethers
 * carrega um plugin que consulta a gas station da Polygon, endpoint que vive
 * fora do ar e derruba qualquer getFeeData junto.
 */
const network = new Network('polygon', config.chain.chainId);

export const provider = new JsonRpcProvider(config.chain.rpcUrl, network, {
  staticNetwork: network,
});

/**
 * Em DRY_RUN sem chave configurada geramos uma carteira efêmera só para o
 * dashboard ter um endereço válido para consultar. Ela nunca assina nada real.
 */
function buildWallet(): Wallet {
  if (config.chain.privateKey) return new Wallet(config.chain.privateKey, provider);
  log.warn('DRY_RUN sem POLYGON_PRIVATE_KEY — usando carteira efêmera apenas para leitura');
  return new Wallet(Wallet.createRandom().privateKey, provider);
}

export const wallet = buildWallet();
export const walletAddress = wallet.address;

// ─── Metadados de token (decimals/symbol são imutáveis, então cacheamos) ─────

interface TokenMeta {
  address: string;
  decimals: number;
  symbol: string;
}

const metaCache = new Map<string, TokenMeta>();

export async function tokenMeta(address: string): Promise<TokenMeta> {
  const key = address.toLowerCase();
  const hit = metaCache.get(key);
  if (hit) return hit;

  const c = new Contract(address, ERC20_ABI, provider);
  const [decimals, symbol] = await Promise.all([c.decimals(), c.symbol()]);
  const meta: TokenMeta = { address, decimals: Number(decimals), symbol: String(symbol) };
  metaCache.set(key, meta);
  return meta;
}

// ─── Leitura ────────────────────────────────────────────────────────────────

export async function tokenBalance(token: string, owner = walletAddress): Promise<{ raw: bigint; formatted: number }> {
  const [meta, raw] = await Promise.all([
    tokenMeta(token),
    new Contract(token, ERC20_ABI, provider).balanceOf(owner) as Promise<bigint>,
  ]);
  return { raw, formatted: Number(formatUnits(raw, meta.decimals)) };
}

export async function nativeBalance(owner = walletAddress): Promise<{ raw: bigint; formatted: number }> {
  const raw = await provider.getBalance(owner);
  return { raw, formatted: Number(formatUnits(raw, 18)) };
}

export async function toRaw(token: string, amount: number | string): Promise<bigint> {
  const meta = await tokenMeta(token);
  // toFixed evita notação científica, que parseUnits rejeita.
  const asString = typeof amount === 'number' ? amount.toFixed(meta.decimals) : amount;
  return parseUnits(asString, meta.decimals);
}

export async function fromRaw(token: string, raw: bigint): Promise<number> {
  const meta = await tokenMeta(token);
  return Number(formatUnits(raw, meta.decimals));
}

export async function allowance(token: string, spender: string): Promise<bigint> {
  return new Contract(token, ERC20_ABI, provider).allowance(walletAddress, spender) as Promise<bigint>;
}

/** Preço de gás atual (EIP-1559) com uma folga de 20% na priority fee. */
export async function gasFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const fd = await provider.getFeeData();
  const priority = fd.maxPriorityFeePerGas ?? parseUnits('30', 'gwei');
  const maxFee = fd.maxFeePerGas ?? parseUnits('100', 'gwei');
  const bump = (v: bigint) => (v * 120n) / 100n;
  return { maxFeePerGas: bump(maxFee), maxPriorityFeePerGas: bump(priority) };
}

// ─── Escrita ────────────────────────────────────────────────────────────────

export interface TxResult {
  hash: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** Custo total em POL. */
  costNative: number;
}

async function send(tx: TransactionRequest, label: string): Promise<TxResult> {
  if (config.dryRun) {
    log.info(`[DRY_RUN] ${label} — transação NÃO enviada`);
    return { hash: '0xdryrun', gasUsed: 0n, effectiveGasPrice: 0n, costNative: 0 };
  }

  const fees = await gasFees();
  const sent: TransactionResponse = await wallet.sendTransaction({ ...tx, ...fees });
  log.info(`${label} enviada: ${sent.hash}`);

  const receipt = await sent.wait(1);
  if (!receipt) throw new Error(`${label}: receipt não retornado para ${sent.hash}`);
  if (receipt.status !== 1) throw new Error(`${label} revertida on-chain: ${sent.hash}`);

  const cost = receipt.gasUsed * receipt.gasPrice;
  log.success(`${label} confirmada (${formatUnits(cost, 18)} ${config.chain.nativeSymbol} de gás)`);

  return {
    hash: sent.hash,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.gasPrice,
    costNative: Number(formatUnits(cost, 18)),
  };
}

/** Aprova `spender` para gastar `amountRaw`, só se a allowance atual for menor. */
export async function ensureAllowance(
  token: string,
  spender: string,
  amountRaw: bigint,
): Promise<TxResult | null> {
  const current = await allowance(token, spender);
  if (current >= amountRaw) return null;

  const meta = await tokenMeta(token);
  log.info(`allowance de ${meta.symbol} insuficiente (${formatUnits(current, meta.decimals)}), aprovando...`);

  const c = new Contract(token, ERC20_ABI, wallet);
  // Aprova exatamente o necessário: allowance infinita em carteira hot é risco desnecessário.
  const data = c.interface.encodeFunctionData('approve', [spender, amountRaw]);
  return send({ to: token, data }, `approve ${meta.symbol}`);
}

export async function transferToken(token: string, to: string, amountRaw: bigint): Promise<TxResult> {
  const meta = await tokenMeta(token);
  const c = new Contract(token, ERC20_ABI, wallet);
  const data = c.interface.encodeFunctionData('transfer', [to, amountRaw]);
  return send({ to: token, data }, `transfer ${formatUnits(amountRaw, meta.decimals)} ${meta.symbol} -> ${to}`);
}

export async function sendRawSwap(to: string, data: string, value: bigint, gasLimit?: bigint): Promise<TxResult> {
  return send({ to, data, value, ...(gasLimit ? { gasLimit } : {}) }, 'swap KyberSwap');
}

/**
 * Espera o saldo de `token` subir pelo menos `minIncreaseRaw` acima do valor inicial.
 * É assim que detectamos a chegada do saque da Binance.
 */
export async function waitForBalanceIncrease(
  token: string,
  baselineRaw: bigint,
  minIncreaseRaw: bigint,
  opts: { timeoutMs: number; pollMs: number; onPoll?: (current: bigint) => void },
): Promise<bigint> {
  const deadline = Date.now() + opts.timeoutMs;
  const target = baselineRaw + minIncreaseRaw;

  while (Date.now() < deadline) {
    const { raw } = await tokenBalance(token);
    opts.onPoll?.(raw);
    if (raw >= target) return raw;
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }

  const meta = await tokenMeta(token);
  throw new Error(
    `Timeout esperando ${formatUnits(minIncreaseRaw, meta.decimals)} ${meta.symbol} chegarem em ${walletAddress}`,
  );
}
