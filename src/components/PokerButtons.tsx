import { Link } from './Link.tsx';

// Poker tables are still being set up; these lead to the poker page for now.

export function PokerFinderButton() {
  return (
    <Link to="/poker" className="btn btn-primary">
      Find a table
    </Link>
  );
}

export function PrivateTableButton({ variant = 'secondary' }: { variant?: 'primary' | 'secondary' }) {
  return (
    <Link to="/poker" className={`btn btn-${variant}`}>
      Create private table
    </Link>
  );
}
