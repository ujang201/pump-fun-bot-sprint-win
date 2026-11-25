// Pump.fun paper-trading bot: confirmed-opening sniper with a first-sell exit.
//
// What the dev tape taught (offline sweep over the kit's 24 h window,
// 1,222 coins, then confirmed with grade-local):
//   - V1 chased coins after a +15% rise and lost 3.16 SOL: most curves
//     spike, then bleed, so buying the top is the worst seat.
//   - V2 bought while the tape was still buying and lost 1.99 SOL.
//   - The house sniper pilot (buy in the first 3 slots, flip in 10)
//     lost only 0.47 SOL: the edge, such as it is, lives in the opening
//     tape, not in chasing.
//   - The strongest single signal in the data is the absence of selling:
//     coins whose first 8 trades are all buys, from at least 3 distinct
//     wallets, keep rising far more often than the average coin — and the
//     moment the first sell prints, the distribution turns. So this bot
//     buys exactly those coins, once, with a small stake, and sells the
//     whole position at the first sell trade after entry. A stop-loss, a
//     trailing stop and a maximum hold are backstops for coins that fade
//     without a sell ever printing.
//   - Size is capped by the harness at 1% of the real SOL reserve, so the
//     stake is small (0.02 SOL) and the cap usually binds; adding to
//     winners and second-chance entries both tested worse offline.
//   - A buy that the market rejects or whose transaction fails is retried
//     while the opening tape is still clean; a sell that fails is retried
//     on the next batch instead of abandoning the position.
//
// Paper trading only: no real SOL ever moves. No clock, no environment,
// no randomness: every decision is a pure function of the batches the
// harness delivered, so two runs produce the same replies.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

// --- tunables (v3, chosen by the offline sweep) ---------------------------
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL per buy
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL: the round-trip bar
const CONFIRM_TRADES = 8; // opening trades that must all be buys
const MIN_BUYERS = 3; // distinct non-creator buyers among them
const STOP_LOSS = 0.85; // mark value / cost basis
const TRAIL_ARM = 1.15; // peak ratio that arms the trailing exit
const TRAIL_GIVEBACK = 0.93; // sell once the ratio falls to 93% of its peak
const MAX_HOLD_SLOTS = 1_200; // give up after this long (~8 min)
const MAX_SLIPPAGE_BPS = 10_000; // never refuse a fill over the price moving

/** What the bot remembers about a coin it has not bought yet. */
interface Candidate {
  /** Slot of its CreateEvent (or of the first trade seen). */
  createdSlot: number;
  /** The curve's creator: their buys do not count as outside interest. */
  creator: string;
  /** Opening trades seen so far. */
  trades: number;
  /** True once any sell has printed on the coin. */
  sold: boolean;
  /** Distinct non-creator wallets that bought in the opening tape. */
  buyers: Set<string>;
}

/** What the bot remembers about a coin it holds. */
interface Held {
  /** Best mark-value / cost ratio seen while holding. */
  peak: number;
  /** Slot the buy was decided on. */
  buySlot: number;
  /** True once a sell has printed since the buy. */
  sellSeen: boolean;
}

const candidates = new Map<string, Candidate>();
const held = new Map<string, Held>();
/** Mints already decided (bought, or skipped for good): buy once per coin. */
const decided = new Set<string>();

/** Mark value of a holding in lamports: tokens * virtualQuote / virtualToken. */
function markValue(tokens: bigint, vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return (Number(tokens) * Number(vq)) / Number(vt);
}

/** True when one of our own sell orders on this mint is still in flight. */
function hasPendingSell(state: { pending: Map<string, { order: { side: string; mint: string } }> }, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell' && p.order.mint === mint) return true;
  }
  return false;
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const orders: Array<BuyInput | SellInput> = [];
    /** Candidates touched by this batch, in first-seen order. */
    const touched: string[] = [];
    const touchedSet = new Set<string>();
    const touch = (mint: string): void => {
      if (!touchedSet.has(mint)) {
        touchedSet.add(mint);
        touched.push(mint);
      }
    };

    // --- settle what resolved since the last batch -----------------------
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // A harness close (complete / flatten / write-off): position gone.
        held.delete(f.mint);
        continue;
      }
      if (f.status === 'filled') {
        if (f.side === 'sell') held.delete(f.mint);
        continue;
      }
      // Rejected or failed: a buy may be retried while the tape is clean;
      // a sell stays held and is retried on the next batch.
      if (f.side === 'buy') {
        held.delete(f.mint);
        decided.delete(f.mint);
      }
    }

    // --- fold the batch's events into the opening tape -------------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!decided.has(e.mint) && !candidates.has(e.mint)) {
          candidates.set(e.mint, { createdSlot: e.slot, creator: e.creator, trades: 0, sold: false, buyers: new Set() });
        }
        touch(e.mint);
        continue;
      }
      if (e.event === 'CompleteEvent') {
        candidates.delete(e.mint);
        held.delete(e.mint);
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      const rec = held.get(mint);
      if (rec !== undefined && !e.is_buy) rec.sellSeen = true;
      if (decided.has(mint)) continue;
      let cand = candidates.get(mint);
      if (cand === undefined) {
        cand = { createdSlot: e.slot, creator: e.creator, trades: 0, sold: false, buyers: new Set() };
        candidates.set(mint, cand);
      }
      touch(mint);
      cand.trades += 1;
      if (!e.is_buy) {
        cand.sold = true;
      } else if (e.user !== cand.creator) {
        cand.buyers.add(e.user);
      }
    }

    // --- exits first: free slots and cash before any new entry ----------
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        held.delete(mint);
        continue;
      }
      if (hasPendingSell(state, mint)) continue;
      const rec = held.get(mint);
      const ratio = markValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) / Number(pos.cost_lamports);
      const peak = Math.max(rec?.peak ?? ratio, ratio);
      const age = state.slot - (rec?.buySlot ?? state.slot);
      const firstSell = rec?.sellSeen === true;
      const giveUp = age > MAX_HOLD_SLOTS;
      const trailHit = peak >= TRAIL_ARM && ratio <= peak * TRAIL_GIVEBACK;
      if (firstSell || ratio <= STOP_LOSS || trailHit || giveUp) {
        if (orders.length < caps.max_orders_per_batch) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
          decided.add(mint);
        }
      } else if (rec !== undefined) {
        rec.peak = peak;
      }
    }

    // --- entries: only openings with no sell on the tape -----------------
    // Evaluated after the whole batch is folded in, so a sell anywhere in
    // this batch disqualifies the coin, exactly like the offline sweep.
    for (const mint of touched) {
      const cand = candidates.get(mint);
      if (cand === undefined || decided.has(mint)) continue;
      if (cand.sold) {
        candidates.delete(mint);
        decided.add(mint);
        continue;
      }
      if (cand.trades < CONFIRM_TRADES) continue;
      if (cand.buyers.size < MIN_BUYERS) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        candidates.delete(mint);
        continue;
      }
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) {
        // Too small to ever count toward the round-trip bar: skip for good.
        candidates.delete(mint);
        decided.add(mint);
        continue;
      }
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (orders.length >= caps.max_orders_per_batch || slots <= 0 || free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      decided.add(mint);
      held.set(mint, { peak: 0, buySlot: state.slot, sellSeen: false });
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  },
});
