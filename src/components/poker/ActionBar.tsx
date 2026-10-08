import { useId, useState } from 'react';
import type { LegalActions, PokerActionType, PublicHand } from '../../../shared/poker.ts';
import { raisePresets } from '../../lib/poker-api.ts';

/** Your options when it's your turn. Re-created for every action (keyed by hand and seq). */
export function ActionBar({
  hand,
  actions,
  stack,
  onAct,
}: {
  hand: PublicHand;
  actions: LegalActions;
  stack: number;
  onAct: (action: PokerActionType, amount?: number) => void;
}) {
  const raise = actions.raise;
  const [amount, setAmount] = useState(raise?.min ?? 0);
  const sliderId = useId();
  const presets = raise
    ? raisePresets({ pot: hand.pot, currentBet: hand.currentBet, toCall: actions.callAmount, min: raise.min, max: raise.max })
    : null;
  const clamp = (value: number) => (raise ? Math.max(raise.min, Math.min(raise.max, Math.round(value) || raise.min)) : 0);
  // What the button shows and sends is always a legal amount, even mid-typing.
  const chosen = clamp(amount);
  const allIn = raise !== null && chosen >= raise.max;

  return (
    <div className="action-bar" role="group" aria-label="Your action">
      <div className="action-main">
        <button type="button" className="btn btn-danger" onClick={() => onAct('fold')}>
          Fold
        </button>
        {actions.canCheck ? (
          <button type="button" className="btn btn-secondary" onClick={() => onAct('check')}>
            Check
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={() => onAct('call')}>
            {actions.callAmount >= stack ? `All-in ${actions.callAmount}` : `Call ${actions.callAmount}`}
          </button>
        )}
        {raise && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onAct(allIn ? 'allin' : raise.isBet ? 'bet' : 'raise', allIn ? undefined : chosen)}
          >
            {allIn ? `All-in ${raise.max}` : `${raise.isBet ? 'Bet' : 'Raise to'} ${chosen}`}
          </button>
        )}
      </div>
      {raise && presets && raise.max > raise.min && (
        <div className="raise-controls">
          <div className="raise-presets" role="group" aria-label="Bet size shortcuts">
            <button type="button" className="chip" onClick={() => setAmount(presets.min)}>
              Min
            </button>
            <button type="button" className="chip" onClick={() => setAmount(presets.half)}>
              ½ Pot
            </button>
            <button type="button" className="chip" onClick={() => setAmount(presets.pot)}>
              Pot
            </button>
            <button type="button" className="chip" onClick={() => setAmount(presets.max)}>
              All-in
            </button>
          </div>
          <div className="raise-inputs">
            <label htmlFor={sliderId} className="sr-only">
              {raise.isBet ? 'Bet amount' : 'Raise to'}
            </label>
            <input
              id={sliderId}
              type="range"
              min={raise.min}
              max={raise.max}
              step={1}
              value={chosen}
              onChange={(event) => setAmount(clamp(Number(event.target.value)))}
            />
            <input
              type="number"
              inputMode="numeric"
              min={raise.min}
              max={raise.max}
              value={amount}
              aria-label={raise.isBet ? 'Bet amount in chips' : 'Raise to, in chips'}
              onChange={(event) => setAmount(Number(event.target.value))}
              onBlur={() => setAmount(clamp(amount))}
            />
          </div>
        </div>
      )}
    </div>
  );
}
