// Completion Ride — Paper Sprint
//
// Idea: most pump.fun curves that gather real reserves and strong recent
// buying flow are on their way to completing the bonding curve. This bot
// waits until a coin already holds a solid reserve base and its last
// 30 seconds of flow are clearly net-buy, then rides it with a fixed
// stake. It leaves quickly: a hard stop, a trailing exit after a strong
// peak, a flow-reversal exit, and time-based exits when the curve stalls.

import { runBot, type OrderInput } from './vendor/makefun-bot.ts';

// ---- tunable gates (swept on the dev grader) ----
const ENTRY_RES_SOL = 50;
const FLOW_MIN_SOL = 0.5;
const SIZE_SOL = 1.0;

// ---- fixed strategy constants ----
const LAMPORTS = 1_000_000_000;
const FLOW_WINDOW_SEC = 150;
const FLOW_FAST_SEC = 30;
const MIN_SIZE_LAMPORTS = 200_000_000n;
const CASH_BUFFER_LAMPORTS = 2_000_000n;
const MAX_OPEN = 5;
const BUY_SLIPPAGE_BPS = 1200;
const SELL_SLIPPAGE_BPS = 2500;
const STOP_GAIN = -0.12;
const PEAK_ARM_GAIN = 0.3;
const PEAK_GIVEBACK = 0.18;
const TAKE_PROFIT_GAIN = 1.6;
const FLOW_EXIT_SOL = -3;
const HALF_AT_GAIN = 0.6;
const STALL_AFTER_SEC = 60;
const STALL_RES_MULT = 1.05;
const MAX_HOLD_SEC = 300;

interface FlowPoint {
  ts: number;
  lamports: number;
}

interface PosMeta {
  entryTs: number;
  entryRealLamports: number;
  entryPrice: number;
  peakPrice: number;
  halfSold: boolean;
}

const flowByMint = new Map<string, FlowPoint[]>();
const latestTsByMint = new Map<string, number>();
const enteredEver = new Set<string>();
const metaByMint = new Map<string, PosMeta>();

function recordTrade(mint: string, ts: number, signedLamports: number): void {
  let arr = flowByMint.get(mint);
  if (arr === undefined) {
    arr = [];
    flowByMint.set(mint, arr);
  }
  arr.push({ ts, lamports: signedLamports });
  const prev = latestTsByMint.get(mint);
  if (prev === undefined || ts > prev) latestTsByMint.set(mint, ts);
  const latest = latestTsByMint.get(mint) as number;
  const cutoff = latest - FLOW_WINDOW_SEC;
  let drop = 0;
  while (drop < arr.length && arr[drop].ts < cutoff) drop += 1;
  if (drop > 0) arr.splice(0, drop);
}

function flow30Sol(mint: string): number {
  const arr = flowByMint.get(mint);
  const latest = latestTsByMint.get(mint);
  if (arr === undefined || latest === undefined) return 0;
  const cutoff = latest - FLOW_FAST_SEC;
  let sum = 0;
  for (const p of arr) {
    if (p.ts >= cutoff) sum += p.lamports;
  }
  return sum / LAMPORTS;
}

function curvePrice(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

await runBot({
  onBatch(state, batch) {
    // 1) Fold this batch's trades into the trailing-flow books first, so
    //    both entries and exits judge the freshest flow.
    const touched = new Set<string>();
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const ts = Number(e.timestamp);
      const amount = Number(BigInt(e.quote_amount));
      recordTrade(e.mint, ts, e.is_buy ? amount : -amount);
      touched.add(e.mint);
    }

    const cap = state.hello.caps.max_orders_per_batch;
    const exits: OrderInput[] = [];
    const entries: OrderInput[] = [];

    // 2) Position bookkeeping: open meta for new positions, refresh the
    //    peak price for held ones, forget closed ones.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      let meta = metaByMint.get(mint);
      if (meta === undefined) {
        const entryPrice = Number(holding.cost_lamports) / Number(holding.token_amount);
        meta = {
          entryTs: latestTsByMint.get(mint) ?? 0,
          entryRealLamports: Number(curve.real_quote_reserves),
          entryPrice,
          peakPrice: price,
          halfSold: false,
        };
        metaByMint.set(mint, meta);
      }
      if (price > meta.peakPrice) meta.peakPrice = price;
    }
    for (const mint of [...metaByMint.keys()]) {
      if (!state.positions.has(mint)) metaByMint.delete(mint);
    }

    const pendingSellMints = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSellMints.add(p.order.mint);
    }

    // 3) Exits, decided before any new entry.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      const meta = metaByMint.get(mint);
      if (curve === undefined || meta === undefined) continue;
      if (curve.complete) continue;
      if (pendingSellMints.has(mint)) continue;
      const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0 || meta.entryPrice <= 0) continue;
      const gain = price / meta.entryPrice - 1;
      const peakGain = meta.peakPrice / meta.entryPrice - 1;
      const latest = latestTsByMint.get(mint) ?? meta.entryTs;
      const heldSec = latest - meta.entryTs;
      const flow = flow30Sol(mint);
      const currentReal = Number(curve.real_quote_reserves);

      let sellAll = false;
      if (gain <= STOP_GAIN) sellAll = true;
      else if (peakGain >= PEAK_ARM_GAIN && price <= meta.peakPrice * (1 - PEAK_GIVEBACK)) sellAll = true;
      else if (gain >= TAKE_PROFIT_GAIN) sellAll = true;
      else if (flow <= FLOW_EXIT_SOL) sellAll = true;
      else if (heldSec >= STALL_AFTER_SEC && currentReal <= meta.entryRealLamports * STALL_RES_MULT) sellAll = true;
      else if (heldSec >= MAX_HOLD_SEC) sellAll = true;

      if (sellAll) {
        exits.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        continue;
      }
      if (!meta.halfSold && gain >= HALF_AT_GAIN) {
        meta.halfSold = true;
        exits.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount / 2n,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    // 4) Entries: only mints that traded in this batch, only once each.
    const openLimit = Math.min(MAX_OPEN, state.hello.caps.max_open_positions);
    let committed = state.committedPositionCount();
    let plannedSpend = 0n;
    const entryResLamports = BigInt(ENTRY_RES_SOL) * BigInt(LAMPORTS);
    const sizeLamports = BigInt(Math.round(SIZE_SOL * LAMPORTS));

    for (const mint of touched) {
      if (entries.length + exits.length >= cap) break;
      if (committed >= openLimit) break;
      if (enteredEver.has(mint)) continue;
      if (state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < entryResLamports) continue;
      if (flow30Sol(mint) < FLOW_MIN_SOL) continue;

      let size = sizeLamports;
      const maxBuy = state.maxBuyLamports(mint);
      if (maxBuy < size) size = maxBuy;
      if (size < MIN_SIZE_LAMPORTS) continue;
      const free = state.freeCashLamports() - plannedSpend;
      if (free < size + CASH_BUFFER_LAMPORTS) continue;

      entries.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      enteredEver.add(mint);
      plannedSpend += size + state.txFeeLamports();
      committed += 1;
    }

    // 5) Exits first, then entries, capped at the batch order limit.
    return [...exits, ...entries].slice(0, cap);
  },
});
