import type { SwapStep } from '../../types';

interface SwapProgressProps {
  steps: SwapStep[];
}

export function SwapProgress({ steps }: SwapProgressProps) {
  return (
    <div className="w-full">
      {/* Desktop horizontal stepper */}
      <div className="hidden md:block">
        <div className="relative flex items-center justify-between">
          {/* Progress line */}
          <div className="absolute left-0 right-0 top-4 h-0.5 bg-slate-700">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 transition-all duration-500"
              style={{
                width: `${(steps.filter((s) => s.status === 'completed').length / (steps.length - 1)) * 100}%`,
              }}
            />
          </div>

          {steps.map((step, i) => (
            <div key={i} className="relative z-10 flex flex-col items-center">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full border-2 transition-all ${
                  step.status === 'completed'
                    ? 'border-emerald-500 bg-emerald-500 text-white'
                    : step.status === 'active'
                      ? 'border-blue-500 bg-blue-500/20 text-blue-400 ring-4 ring-blue-500/20'
                      : step.status === 'failed'
                        ? 'border-red-500 bg-red-500/20 text-red-400'
                        : 'border-slate-600 bg-slate-800 text-slate-500'
                }`}
              >
                {step.status === 'completed' ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : step.status === 'failed' ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : step.status === 'active' ? (
                  <div className="h-2.5 w-2.5 animate-pulse rounded-full bg-blue-400" />
                ) : (
                  <span className="text-xs font-medium">{i + 1}</span>
                )}
              </div>
              <span
                className={`mt-2 max-w-[100px] text-center text-xs font-medium ${
                  step.status === 'completed'
                    ? 'text-emerald-400'
                    : step.status === 'active'
                      ? 'text-blue-400'
                      : step.status === 'failed'
                        ? 'text-red-400'
                        : 'text-slate-500'
                }`}
              >
                {step.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Mobile vertical stepper */}
      <div className="space-y-3 md:hidden">
        {steps.map((step, i) => (
          <div key={i} className="flex items-start gap-3">
            <div className="flex flex-col items-center">
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full border-2 ${
                  step.status === 'completed'
                    ? 'border-emerald-500 bg-emerald-500 text-white'
                    : step.status === 'active'
                      ? 'border-blue-500 bg-blue-500/20 text-blue-400'
                      : step.status === 'failed'
                        ? 'border-red-500 bg-red-500/20 text-red-400'
                        : 'border-slate-600 bg-slate-800 text-slate-500'
                }`}
              >
                {step.status === 'completed' ? (
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <span className="text-xs font-medium">{i + 1}</span>
                )}
              </div>
              {i < steps.length - 1 && (
                <div className={`mt-1 h-6 w-0.5 ${step.status === 'completed' ? 'bg-emerald-500' : 'bg-slate-700'}`} />
              )}
            </div>
            <div className="flex-1 pb-2">
              <p
                className={`text-sm font-medium ${
                  step.status === 'completed'
                    ? 'text-emerald-400'
                    : step.status === 'active'
                      ? 'text-blue-400'
                      : 'text-slate-500'
                }`}
              >
                {step.label}
              </p>
              {step.status === 'active' && (
                <p className="mt-0.5 text-xs text-slate-400">{step.description}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
