# Completion Ride — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/zamrdzhu/pumpfun-boothlord-ride/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/zamrdzhu/pumpfun-boothlord-ride/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

## Strategy

Most pump.fun curves that accumulate a real reserve base and keep attracting
net buying are on their way to completing the bonding curve. This bot rides
that completion push instead of chasing fresh launches.

For every mint it keeps a trailing 150-second tape of signed trade flow and
derives the last-30-seconds net flow at the mint's own latest event time. A
coin becomes a buy only when all of these hold at once:

- the curve is not complete and already holds at least 50 SOL of real quote
  reserves,
- the 30-second flow is at least +0.5 SOL net buy,
- the coin was never entered before in this run and is not currently held,
- fewer than 5 positions are open, the size capped by the harness per-mint
  limit is at least 0.2 SOL, and free cash covers the trade plus a buffer.

Position size is 1.0 SOL with 1200 bps buy slippage. Exits are layered:
a -12% hard stop, a trailing exit once the peak gain reaches +30% and the
price gives back 18% from the peak, a +160% take-profit, an exit when the
30-second flow drops to -3 SOL or worse, a stall exit after 60 seconds if
real reserves have grown no more than 5% since entry, and a hard 300-second
maximum hold. At +60% gain the bot sells half once and lets the rest ride.
Sells use 2500 bps slippage. The bot is fully deterministic: no clock, no
randomness, no environment reads — all timing comes from event timestamps.

## Dev grade (kit dev window, final config)

- Return: -0.0425 (net PnL -0.425 SOL)
- Win rate: 0.458
- Distinct coins traded: 24 (guardrail bar is 20)
- Round trips: 24
- Max drawdown: 0.120 (bar is 0.50)

A stricter 55 SOL reserve gate was more profitable on this dev window
(return +0.0089, win rate 0.579) but traded only 19 distinct coins — below
the 20-coin guardrail that the final ranking requires — so the shipped
config uses the 50 SOL gate, which clears the bar with margin while still
beating the account's previous live entry (return -0.0975, win rate 0.073)
on both return and win rate.
