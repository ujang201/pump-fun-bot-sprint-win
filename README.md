[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ujang201/pump-fun-bot-sprint-win/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ujang201/pump-fun-bot-sprint-win/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint — Confirmed-Opening Sniper

A paper-trading bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) bounty. It trades paper money on a replay of pump.fun bonding-curve data. No real SOL ever moves.

## Strategy

Most pump.fun curves spike, then bleed — so chasing a rise buys the top.
This bot only buys openings whose tape is still clean:

- **Entry:** a coin's first 8 trades are all buys, from at least 3 distinct
  non-creator wallets, and the size cap already allows a buy of at least
  0.01 SOL. One buy per coin, 0.02 SOL stake (the 1% of real reserve cap
  usually binds first).
- **Exit:** sell the whole position at the first sell trade after entry.
  Backstops: stop-loss at 85% of cost, a trailing stop once up 15%
  (sell on a 7% giveback from the peak), and a maximum hold of 1,200 slots.
- **Retries:** a buy the market rejects (or whose transaction fails) is
  retried while the opening tape is still clean; a failed sell is retried
  on the next batch instead of abandoning the position.

## Results on the dev window

- Net PnL **−0.105 SOL** over 191 round trips (win rate 24.6%,
  max drawdown 1.1%) — essentially breakeven on a tape where
  momentum-chasing variants lost 2–3 SOL and the house sniper pilot
  lost 0.47 SOL. Guardrails met: 191 coins with a round trip of at
  least 0.01 SOL, drawdown far under the 50% cap.
- Deterministic: the grader's two executions reproduce byte for byte.

## Run

```sh
node main.ts
```

`main.ts` speaks `agent-fun/replay/v2` on stdin/stdout through the
vendored shim in `vendor/makefun-bot.ts` (a byte-identical copy of the
kit's `sdk/ts/makefun-bot.ts`). No dependencies, no network, no clock,
no randomness — every decision is a pure function of the batches the
harness delivers.

## License

MIT — see [LICENSE](LICENSE).
