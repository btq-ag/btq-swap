export function Footer() {
  return (
    <footer className="border-t border-slate-800/50 bg-slate-950">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 py-6 sm:flex-row sm:px-6">
        <p className="text-sm text-slate-500">
          &copy; {new Date().getFullYear()} BTQ Swap — Quantum-Safe Atomic Swaps
        </p>
        <div className="flex items-center gap-4">
          <a
            href="https://bitcoinquantum.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-slate-500 transition-colors hover:text-slate-300"
          >
            Bitcoin Quantum
          </a>
          <a
            href="https://docs.bitcoinquantum.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-slate-500 transition-colors hover:text-slate-300"
          >
            Docs
          </a>
          <a
            href="https://github.com/nicholasyan/BTQ"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-slate-500 transition-colors hover:text-slate-300"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
