import type { Step, SwapView } from '../api';

/**
 * The swap as two chains: USDT moves on the EVM lane, BTQ on the BTQ lane.
 * Each protocol step sits on the chain where it happens; the secret crosses
 * from the BTQ claim up to the EVM claim once it is revealed.
 */
const X0 = 96;
const STEP = 86;
const Y_EVM = 20;
const Y_BTQ = 60;
const W = X0 + STEP * 5 + 22;

const C = { evm: '#38BDF8', btq: '#A78BFA', key: '#F5C451', ok: '#34D399', warn: '#F59E0B', bad: '#F87171', line: '#2E3B5A', dim: '#5F6A82' };

function nodeFill(s: Step['state'], color: string): { fill: string; stroke: string; dash?: string } {
  switch (s) {
    case 'done':
      return { fill: color, stroke: color };
    case 'active':
      return { fill: '#0E1525', stroke: color };
    case 'failed':
      return { fill: C.bad, stroke: C.bad };
    case 'skipped':
      return { fill: '#0E1525', stroke: C.dim, dash: '2 2' };
    default:
      return { fill: '#0E1525', stroke: C.line };
  }
}

function Node({ x, y, state, color, title }: { x: number; y: number; state: Step['state']; color: string; title: string }) {
  const f = nodeFill(state, color);
  return (
    <g>
      <title>{title}</title>
      {state === 'active' && <circle cx={x} cy={y} r={10} fill={color} opacity={0.16} />}
      <circle cx={x} cy={y} r={6} fill={f.fill} stroke={f.stroke} strokeWidth={2} strokeDasharray={f.dash} />
    </g>
  );
}

export function Braid({ swap, compact = false }: { swap: SwapView; compact?: boolean }) {
  const st = Object.fromEntries(swap.steps.map((s) => [s.key, s])) as Record<Step['key'], Step>;
  const x = (i: number) => X0 + STEP * i;
  const evmDoneTo = st.usdt_claimed.state === 'done' ? 4 : st.usdt_locked.state === 'done' ? 1 : 0;
  const btqDoneTo = st.btq_claimed.state === 'done' ? 3 : st.btq_locked.state === 'done' ? 2 : 0;
  const revealed = !!swap.preimage;
  const evmRefund = !!swap.evm.refundTx;
  const btqRefund = !!swap.btq.refundTxid;
  const end = st.done;
  const endColor = end.state === 'failed' ? C.bad : swap.status === 'completed' ? C.ok : swap.tone === 'warning' ? C.warn : C.line;

  return (
    <svg viewBox={`0 0 ${W} ${compact ? 76 : 84}`} className="w-full max-w-[620px]" role="img" aria-label={`Swap ${swap.shortId}: ${swap.statusLabel}`}>
      <text x={0} y={Y_EVM + 4} fill={C.evm} fontSize="12" fontWeight={600}>{swap.rail === 'solana' ? 'USDT · Solana' : 'USDT · EVM'}</text>
      <text x={0} y={Y_BTQ + 4} fill={C.btq} fontSize="12" fontWeight={600}>BTQ · P2MR</text>

      {/* lanes: solid where the chain has progressed, faint ahead */}
      <line x1={x(0)} y1={Y_EVM} x2={x(5)} y2={Y_EVM} stroke={C.line} strokeWidth={2} />
      <line x1={x(0)} y1={Y_BTQ} x2={x(5)} y2={Y_BTQ} stroke={C.line} strokeWidth={2} />
      <line x1={x(0)} y1={Y_EVM} x2={x(evmDoneTo)} y2={Y_EVM} stroke={C.evm} strokeWidth={3} strokeLinecap="round" />
      <line x1={x(0)} y1={Y_BTQ} x2={x(btqDoneTo)} y2={Y_BTQ} stroke={C.btq} strokeWidth={3} strokeLinecap="round" />

      {/* the match binds both lanes */}
      <line x1={x(0)} y1={Y_EVM} x2={x(0)} y2={Y_BTQ} stroke={C.dim} strokeWidth={1.5} />
      <Node x={x(0)} y={Y_EVM} state="done" color={C.dim} title="Matched" />
      <Node x={x(0)} y={Y_BTQ} state="done" color={C.dim} title="Matched" />

      <Node x={x(1)} y={Y_EVM} state={st.usdt_locked.state} color={C.evm} title={`USDT locked ${st.usdt_locked.tx ?? ''}`} />
      <Node x={x(2)} y={Y_BTQ} state={st.btq_locked.state} color={C.btq} title={`BTQ locked ${st.btq_locked.tx ?? ''}`} />
      <Node x={x(3)} y={Y_BTQ} state={st.btq_claimed.state} color={C.btq} title={`BTQ claimed ${st.btq_claimed.tx ?? ''}`} />
      <Node x={x(4)} y={Y_EVM} state={st.usdt_claimed.state} color={C.evm} title={`USDT claimed ${st.usdt_claimed.tx ?? ''}`} />

      {/* the secret: revealed by the BTQ claim, used by the EVM claim */}
      {revealed && (
        <g>
          <path d={`M ${x(3)} ${Y_BTQ - 7} C ${x(3)} ${Y_EVM + 18}, ${x(4)} ${Y_BTQ - 18}, ${x(4)} ${Y_EVM + 7}`} fill="none" stroke={C.key} strokeWidth={2} strokeDasharray="4 3" />
          <g className="key-cross" transform={`translate(${x(3) - 6}, ${Y_BTQ - 18})`}>
            <circle cx={4} cy={4} r={3.5} fill="none" stroke={C.key} strokeWidth={1.8} />
            <line x1={7.5} y1={4} x2={13} y2={4} stroke={C.key} strokeWidth={1.8} />
            <line x1={11} y1={4} x2={11} y2={7} stroke={C.key} strokeWidth={1.8} />
          </g>
        </g>
      )}

      {/* settlement / refunds */}
      <circle cx={x(5)} cy={Y_EVM} r={evmRefund ? 6 : 4} fill={evmRefund ? C.warn : swap.status === 'completed' ? C.ok : '#0E1525'} stroke={evmRefund ? C.warn : endColor} strokeWidth={2}>
        <title>{evmRefund ? `USDT refunded ${swap.evm.refundTx}` : end.label}</title>
      </circle>
      <circle cx={x(5)} cy={Y_BTQ} r={btqRefund ? 6 : 4} fill={btqRefund ? C.warn : swap.status === 'completed' ? C.ok : '#0E1525'} stroke={btqRefund ? C.warn : endColor} strokeWidth={2}>
        <title>{btqRefund ? `BTQ refunded ${swap.btq.refundTxid}` : end.label}</title>
      </circle>

      {!compact && (
        <g fontSize="10.5" fill="#8C97AE">
          <text x={x(1)} y={Y_EVM - 10} textAnchor="middle">lock</text>
          <text x={x(4)} y={Y_EVM - 10} textAnchor="middle">claim</text>
          <text x={x(2)} y={Y_BTQ + 20} textAnchor="middle">lock</text>
          <text x={x(3)} y={Y_BTQ + 20} textAnchor="middle">claim · reveal</text>
          <text x={x(5)} y={Y_BTQ + 20} textAnchor="middle" fill={endColor === C.line ? '#8C97AE' : endColor}>{end.label.split(' ')[0]}</text>
        </g>
      )}
    </svg>
  );
}
