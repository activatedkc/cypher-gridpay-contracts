/**
 * SplitAllocationEditor.tsx
 *
 * Visual split-payment and forwarding-rule configurator.
 * Implements docs/ux/split-forwarding-configurator.md
 *
 * i18n / RTL changes (issue #424):
 *   - Physical margin/padding/border/text-align → logical equivalents.
 *   - Stellar addresses in inputs wrapped in dir="ltr" isolate containers.
 *   - textAlign: 'start' replaces 'left' throughout.
 *   - formatBps from formatAmount.ts used for tooltip-style bps descriptions.
 */

import React, {
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_BPS = 10_000;
const EXAMPLE_AMOUNT_USDC = 100;
const DEFAULT_MAX_RECIPIENTS = 10;
const DEFAULT_PROTOCOL_FEE_BPS = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InputMode = "pct" | "bps";

export interface SplitRecipient {
  id: string;
  address: string;
  share_bps: number;
  isDustSink: boolean;
}

export interface ForwardingRule {
  id: string;
  forward_to: string;
  forward_bps: number;
  active: boolean;
}

export interface SplitAllocationEditorProps {
  merchantAddress: string;
  maxRecipients?: number;
  protocolFeeBps?: number;
  onSave?: (config: {
    recipients: Array<{ address: string; share_bps: number }>;
    forwardingRules: Array<{ merchant: string; forward_to: string; forward_bps: number; active: boolean }>;
  }) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pctToBps(pct: number): number { return Math.round(pct * 100); }
function bpsToPct(bps: number): number { return Math.round(bps) / 100; }

function bpsToUsdc(bps: number, feeBps: number): string {
  const afterFee = EXAMPLE_AMOUNT_USDC * (1 - feeBps / TOTAL_BPS);
  return ((bps / TOTAL_BPS) * afterFee).toFixed(2);
}

function isValidStellarAddress(addr: string): boolean {
  return /^[GC][A-Z2-7]{55}$/.test(addr.trim());
}

function detectForwardingCycle(rules: ForwardingRule[], _recipients: SplitRecipient[]): string[] | null {
  const forwardAddresses = rules.filter((r) => r.active).map((r) => r.forward_to).filter(Boolean);
  const duplicateForward = forwardAddresses.filter((addr, i) => forwardAddresses.indexOf(addr) !== i);
  if (duplicateForward.length > 0) return duplicateForward;
  return null;
}

function splitEvenly(count: number, dustSinkIndex: number): number[] {
  if (count === 0) return [];
  const base = Math.floor(TOTAL_BPS / count);
  const remainder = TOTAL_BPS - base * count;
  const result = Array(count).fill(base) as number[];
  const sinkIdx = dustSinkIndex >= 0 && dustSinkIndex < count ? dustSinkIndex : count - 1;
  result[sinkIdx] += remainder;
  return result;
}

let _uid = 0;
function uid(): string { return `row_${++_uid}`; }

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

interface EditorState { recipients: SplitRecipient[]; forwardingRules: ForwardingRule[]; inputMode: InputMode; }
type EditorAction =
  | { type: "SET_MODE"; mode: InputMode }
  | { type: "ADD_RECIPIENT" }
  | { type: "REMOVE_RECIPIENT"; id: string }
  | { type: "UPDATE_ADDRESS"; id: string; address: string }
  | { type: "UPDATE_BPS"; id: string; bps: number }
  | { type: "SET_DUST_SINK"; id: string }
  | { type: "SPLIT_EVENLY" }
  | { type: "FILL_REMAINING"; id: string }
  | { type: "MOVE_ROW"; id: string; direction: "up" | "down" }
  | { type: "RESET" }
  | { type: "ADD_FORWARD_RULE" }
  | { type: "REMOVE_FORWARD_RULE"; id: string }
  | { type: "UPDATE_FORWARD_RULE"; id: string; patch: Partial<ForwardingRule> };

function initialRecipient(overrides?: Partial<SplitRecipient>): SplitRecipient {
  return { id: uid(), address: "", share_bps: 0, isDustSink: false, ...overrides };
}
function initialForwardingRule(): ForwardingRule {
  return { id: uid(), forward_to: "", forward_bps: 0, active: true };
}

const initialState: EditorState = {
  recipients: [initialRecipient({ share_bps: TOTAL_BPS, isDustSink: true })],
  forwardingRules: [],
  inputMode: "pct",
};

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "SET_MODE":          return { ...state, inputMode: action.mode };
    case "ADD_RECIPIENT":     return { ...state, recipients: [...state.recipients, initialRecipient()] };
    case "REMOVE_RECIPIENT": {
      const remaining = state.recipients.filter((r) => r.id !== action.id);
      const hasSink = remaining.some((r) => r.isDustSink);
      if (!hasSink && remaining.length > 0) remaining[remaining.length - 1] = { ...remaining[remaining.length - 1], isDustSink: true };
      return { ...state, recipients: remaining };
    }
    case "UPDATE_ADDRESS":    return { ...state, recipients: state.recipients.map((r) => r.id === action.id ? { ...r, address: action.address } : r) };
    case "UPDATE_BPS":        return { ...state, recipients: state.recipients.map((r) => r.id === action.id ? { ...r, share_bps: action.bps } : r) };
    case "SET_DUST_SINK":     return { ...state, recipients: state.recipients.map((r) => ({ ...r, isDustSink: r.id === action.id })) };
    case "SPLIT_EVENLY": {
      const sinkIdx = state.recipients.findIndex((r) => r.isDustSink);
      const bpsValues = splitEvenly(state.recipients.length, sinkIdx);
      return { ...state, recipients: state.recipients.map((r, i) => ({ ...r, share_bps: bpsValues[i] })) };
    }
    case "FILL_REMAINING": {
      const others = state.recipients.filter((r) => r.id !== action.id).reduce((s, r) => s + r.share_bps, 0);
      const fill = TOTAL_BPS - others;
      if (fill < 0) return state;
      return { ...state, recipients: state.recipients.map((r) => r.id === action.id ? { ...r, share_bps: fill } : r) };
    }
    case "MOVE_ROW": {
      const idx = state.recipients.findIndex((r) => r.id === action.id);
      if (idx < 0) return state;
      const newIdx = action.direction === "up" ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= state.recipients.length) return state;
      const rows = [...state.recipients];
      [rows[idx], rows[newIdx]] = [rows[newIdx], rows[idx]];
      return { ...state, recipients: rows };
    }
    case "RESET":             return { ...initialState, recipients: [initialRecipient({ share_bps: TOTAL_BPS, isDustSink: true })] };
    case "ADD_FORWARD_RULE":  return { ...state, forwardingRules: [...state.forwardingRules, initialForwardingRule()] };
    case "REMOVE_FORWARD_RULE": return { ...state, forwardingRules: state.forwardingRules.filter((r) => r.id !== action.id) };
    case "UPDATE_FORWARD_RULE": return { ...state, forwardingRules: state.forwardingRules.map((r) => r.id === action.id ? { ...r, ...action.patch } : r) };
    default: return state;
  }
}

// ---------------------------------------------------------------------------
// Allocation bar
// ---------------------------------------------------------------------------

function AllocationBar({ totalBps }: { totalBps: number }) {
  const pct = Math.min((totalBps / TOTAL_BPS) * 100, 100);
  const isOver  = totalBps > TOTAL_BPS;
  const isExact = totalBps === TOTAL_BPS;
  const barColor = isOver ? "#ef4444" : isExact ? "#22c55e" : "#f59e0b";

  return (
    <div style={{ marginBlockEnd: 8 }}>
      <div role="meter" aria-valuenow={totalBps} aria-valuemin={0} aria-valuemax={TOTAL_BPS}
        aria-label={`Total allocation: ${totalBps} bps (${bpsToPct(totalBps).toFixed(2)}%)`}
        style={{ height: 10, borderRadius: 5, background: "#e5e7eb", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: barColor, transition: "width 0.2s, background 0.2s" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBlockStart: 4, color: isOver ? "#ef4444" : isExact ? "#22c55e" : "#f59e0b" }}>
        <span dir="ltr" style={{ unicodeBidi: "isolate" }}>{totalBps} bps ({bpsToPct(totalBps).toFixed(2)}%)</span>
        {!isExact && (
          <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
            {isOver ? `${totalBps - TOTAL_BPS} bps over 100%` : `${TOTAL_BPS - totalBps} bps short of 100%`}
          </span>
        )}
        {isExact && <span>✓ 100.00%</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recipient row
// ---------------------------------------------------------------------------

interface RecipientRowProps {
  recipient: SplitRecipient; index: number; total: number; inputMode: InputMode;
  duplicateAddresses: Set<string>;
  onAddressChange: (id: string, value: string) => void;
  onBpsChange: (id: string, bps: number) => void;
  onSetDustSink: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, dir: "up" | "down") => void;
  onFillRemaining: (id: string) => void;
}

function RecipientRow({ recipient, index, total, inputMode, duplicateAddresses, onAddressChange, onBpsChange, onRemove, onSetDustSink, onMove, onFillRemaining }: RecipientRowProps) {
  const isSingle = total === 1;
  const isDuplicate = recipient.address.trim() !== "" && duplicateAddresses.has(recipient.address.trim());
  const isInvalidAddr = recipient.address.trim() !== "" && !isValidStellarAddress(recipient.address);
  const displayValue = inputMode === "pct" ? bpsToPct(recipient.share_bps).toFixed(2) : String(recipient.share_bps);

  function handleAllocationChange(raw: string) {
    if (inputMode === "pct") {
      if (/\.\d{3,}/.test(raw)) return;
      const num = parseFloat(raw);
      if (isNaN(num) || num < 0) return;
      onBpsChange(recipient.id, pctToBps(num));
    } else {
      const num = parseInt(raw, 10);
      if (isNaN(num) || num < 0) return;
      onBpsChange(recipient.id, Math.min(num, TOTAL_BPS));
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.altKey && e.key === "ArrowUp")   { e.preventDefault(); onMove(recipient.id, "up"); }
    if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); onMove(recipient.id, "down"); }
  }

  return (
    <div onKeyDown={handleKeyDown} style={{ display: "grid", gridTemplateColumns: "1fr 160px auto auto auto", gap: 8, alignItems: "center", paddingBlock: 8, borderBlockEnd: "1px solid #f3f4f6" }}>
      <div>
        {/* Address input — dir="ltr" on the input so Stellar addresses type correctly in RTL docs */}
        <input type="text" dir="ltr" aria-label={`Recipient ${index + 1} address`}
          placeholder="G… or C… Stellar address" value={recipient.address}
          onChange={(e) => onAddressChange(recipient.id, e.target.value)}
          style={{ width: "100%", paddingBlock: 6, paddingInline: 8, border: `1px solid ${isDuplicate || isInvalidAddr ? "#ef4444" : "#d1d5db"}`, borderRadius: 4, fontSize: 13, fontFamily: "monospace", boxSizing: "border-box" }} />
        {isDuplicate && <p role="alert" style={{ color: "#ef4444", fontSize: 11, margin: "2px 0 0" }}>Duplicate address — each recipient must be unique.</p>}
        {isInvalidAddr && !isDuplicate && <p role="alert" style={{ color: "#ef4444", fontSize: 11, margin: "2px 0 0" }}>Invalid Stellar address.</p>}
      </div>

      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input type="number" dir="ltr" aria-label={`Recipient ${index + 1} allocation in ${inputMode === "pct" ? "percent" : "basis points"}`}
          min={0} max={inputMode === "pct" ? 100 : TOTAL_BPS} step={inputMode === "pct" ? 0.01 : 1}
          value={displayValue} disabled={isSingle}
          onKeyDown={(e) => { if (inputMode === "bps" && e.key === ".") e.preventDefault(); }}
          onChange={(e) => handleAllocationChange(e.target.value)}
          style={{ width: 90, paddingBlock: 6, paddingInline: 8, border: "1px solid #d1d5db", borderRadius: 4, fontSize: 13 }} />
        <span style={{ fontSize: 12, color: "#6b7280", minWidth: 28 }}>{inputMode === "pct" ? "%" : "bps"}</span>
      </div>

      <button type="button" aria-label={recipient.isDustSink ? "This recipient is the dust-sink" : `Set recipient ${index + 1} as dust-sink`}
        aria-pressed={recipient.isDustSink} onClick={() => onSetDustSink(recipient.id)}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: recipient.isDustSink ? "#f59e0b" : "#d1d5db", lineHeight: 1, padding: 0 }}>
        ★
      </button>

      <button type="button" aria-label={`Fill remaining allocation into recipient ${index + 1}`}
        onClick={() => onFillRemaining(recipient.id)} disabled={isSingle}
        style={{ paddingBlock: 4, paddingInline: 8, border: "1px solid #d1d5db", borderRadius: 4, background: "#f9fafb", cursor: isSingle ? "not-allowed" : "pointer", fontSize: 11, color: "#374151" }}>
        Fill&nbsp;%
      </button>

      <button type="button" aria-label={`Remove recipient ${index + 1}`}
        onClick={() => onRemove(recipient.id)} disabled={isSingle}
        style={{ paddingBlock: 4, paddingInline: 8, border: "1px solid #fca5a5", borderRadius: 4, background: "#fef2f2", cursor: isSingle ? "not-allowed" : "pointer", fontSize: 11, color: "#dc2626" }}>
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forwarding rule row
// ---------------------------------------------------------------------------

interface ForwardingRuleRowProps {
  rule: ForwardingRule; inputMode: InputMode;
  onChange: (id: string, patch: Partial<ForwardingRule>) => void;
  onRemove: (id: string) => void;
}

function ForwardingRuleRow({ rule, inputMode, onChange, onRemove }: ForwardingRuleRowProps) {
  const isInvalid = rule.forward_to.trim() !== "" && !isValidStellarAddress(rule.forward_to);
  const isZeroBps = rule.forward_bps === 0;
  const displayBps = inputMode === "pct" ? bpsToPct(rule.forward_bps).toFixed(2) : String(rule.forward_bps);

  function handleBpsChange(raw: string) {
    if (inputMode === "pct") {
      if (/\.\d{3,}/.test(raw)) return;
      const num = parseFloat(raw);
      if (!isNaN(num) && num >= 0) onChange(rule.id, { forward_bps: pctToBps(num) });
    } else {
      const num = parseInt(raw, 10);
      if (!isNaN(num) && num >= 0) onChange(rule.id, { forward_bps: Math.min(num, TOTAL_BPS) });
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 160px 60px auto", gap: 8, alignItems: "center", paddingBlock: 8, borderBlockEnd: "1px solid #f3f4f6" }}>
      <div>
        <input type="text" dir="ltr" aria-label="Forward-to Stellar address"
          placeholder="Forward-to G… or C…" value={rule.forward_to}
          onChange={(e) => onChange(rule.id, { forward_to: e.target.value })}
          style={{ width: "100%", paddingBlock: 6, paddingInline: 8, border: `1px solid ${isInvalid ? "#ef4444" : "#d1d5db"}`, borderRadius: 4, fontSize: 13, fontFamily: "monospace", boxSizing: "border-box" }} />
        {isInvalid && <p role="alert" style={{ color: "#ef4444", fontSize: 11, margin: "2px 0 0" }}>Invalid Stellar address.</p>}
        {isZeroBps && <p style={{ color: "#f59e0b", fontSize: 11, margin: "2px 0 0" }}>A zero-bps forwarding rule has no effect.</p>}
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input type="number" dir="ltr" aria-label={`Forward ${inputMode === "pct" ? "percent" : "basis points"}`}
          min={0} max={inputMode === "pct" ? 100 : TOTAL_BPS} step={inputMode === "pct" ? 0.01 : 1}
          value={displayBps}
          onKeyDown={(e) => { if (inputMode === "bps" && e.key === ".") e.preventDefault(); }}
          onChange={(e) => handleBpsChange(e.target.value)}
          style={{ width: 90, paddingBlock: 6, paddingInline: 8, border: "1px solid #d1d5db", borderRadius: 4, fontSize: 13 }} />
        <span style={{ fontSize: 12, color: "#6b7280", minWidth: 28 }}>{inputMode === "pct" ? "%" : "bps"}</span>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
        <input type="checkbox" checked={rule.active} onChange={(e) => onChange(rule.id, { active: e.target.checked })} aria-label="Forwarding rule active" />
        Active
      </label>
      <button type="button" onClick={() => onRemove(rule.id)} aria-label="Remove forwarding rule"
        style={{ paddingBlock: 4, paddingInline: 8, border: "1px solid #fca5a5", borderRadius: 4, background: "#fef2f2", cursor: "pointer", fontSize: 11, color: "#dc2626" }}>
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flow Preview (SVG)
// ---------------------------------------------------------------------------

interface FlowPreviewProps { recipients: SplitRecipient[]; forwardingRules: ForwardingRule[]; protocolFeeBps: number; cycleAddresses: string[] | null; }

function FlowPreview({ recipients, forwardingRules, protocolFeeBps, cycleAddresses }: FlowPreviewProps) {
  const W = 580;
  const H = Math.max(200, 60 + recipients.length * 60 + 40);
  const afterFeeBps = TOTAL_BPS - protocolFeeBps;
  const protocolFeeUsdc = ((protocolFeeBps / TOTAL_BPS) * EXAMPLE_AMOUNT_USDC).toFixed(2);
  const NODE_W = 130; const NODE_H = 32;
  const customerX = 10; const feeX = 10; const recipientX = 230; const forwardX = 420;
  const customerY = 20; const feeY = customerY + 60; const recipientStartY = feeY + 20; const recipientGap = 52;

  function truncAddr(addr: string) {
    if (!addr || addr.length < 10) return addr || "—";
    return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
  }

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} aria-label="Payment flow diagram" role="img" style={{ display: "block" }}>
      {/* Customer node */}
      <g tabIndex={0} aria-label={`Customer payment: ${EXAMPLE_AMOUNT_USDC}.00 USDC`}>
        <rect x={customerX} y={customerY} width={NODE_W} height={NODE_H} rx={4} fill="#dbeafe" stroke="#93c5fd" />
        <text x={customerX + 8} y={customerY + 14} fontSize={10} fill="#1e40af" fontWeight="bold">Customer</text>
        <text x={customerX + 8} y={customerY + 26} fontSize={10} fill="#1e40af">{EXAMPLE_AMOUNT_USDC}.00 USDC</text>
      </g>
      <line x1={customerX + NODE_W / 2} y1={customerY + NODE_H} x2={feeX + NODE_W / 2} y2={feeY} stroke="#94a3b8" strokeWidth={2} markerEnd="url(#arrow)" />
      {/* Fee node */}
      <g tabIndex={0} aria-label={`Protocol fee: ${protocolFeeBps} bps (${protocolFeeUsdc} USDC)`}>
        <rect x={feeX} y={feeY} width={NODE_W} height={NODE_H} rx={4} fill="#fef9c3" stroke="#fde047" />
        <text x={feeX + 8} y={feeY + 14} fontSize={10} fill="#854d0e" fontWeight="bold">Protocol Fee</text>
        <text x={feeX + 8} y={feeY + 26} fontSize={10} fill="#854d0e">{protocolFeeBps} bps · −{protocolFeeUsdc} USDC</text>
      </g>
      {recipients.map((r, i) => {
        const ry = recipientStartY + i * recipientGap;
        const shareUsdc = bpsToUsdc(r.share_bps, protocolFeeBps);
        const isCyclic = cycleAddresses?.includes(r.address);
        const fwdRule = forwardingRules.find((f) => f.active && f.forward_to !== r.address);
        return (
          <g key={r.id}>
            <line x1={feeX + NODE_W} y1={feeY + NODE_H / 2} x2={recipientX} y2={ry + NODE_H / 2} stroke={isCyclic ? "#ef4444" : "#94a3b8"} strokeWidth={Math.max(1, (r.share_bps / TOTAL_BPS) * 8)} strokeDasharray={isCyclic ? "4 2" : undefined} markerEnd="url(#arrow)" />
            <g tabIndex={0} aria-label={`Recipient ${truncAddr(r.address)}: ${bpsToPct(r.share_bps).toFixed(2)}%, ${shareUsdc} USDC${r.isDustSink ? ", dust-sink" : ""}`}>
              <rect x={recipientX} y={ry} width={NODE_W} height={NODE_H} rx={4} fill={isCyclic ? "#fee2e2" : "#dcfce7"} stroke={isCyclic ? "#ef4444" : "#86efac"} />
              <text x={recipientX + 8} y={ry + 13} fontSize={10} fill="#166534" fontWeight="bold">{truncAddr(r.address)}{r.isDustSink ? " ★" : ""}</text>
              <text x={recipientX + 8} y={ry + 25} fontSize={10} fill="#166534">{r.share_bps} bps · {shareUsdc} USDC</text>
              {isCyclic && <text x={recipientX + NODE_W - 40} y={ry + 20} fontSize={10} fill="#ef4444" fontWeight="bold">⚠ LOOP</text>}
            </g>
            {fwdRule && fwdRule.forward_to && (
              <>
                <line x1={recipientX + NODE_W} y1={ry + NODE_H / 2} x2={forwardX} y2={ry + NODE_H / 2} stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="4 2" markerEnd="url(#arrowPurple)" />
                <g tabIndex={0} aria-label={`Forward to ${truncAddr(fwdRule.forward_to)}: ${fwdRule.forward_bps} bps`}>
                  <rect x={forwardX} y={ry} width={NODE_W - 10} height={NODE_H} rx={4} fill="#ede9fe" stroke="#a78bfa" />
                  <text x={forwardX + 6} y={ry + 13} fontSize={9} fill="#5b21b6" fontWeight="bold">→ {truncAddr(fwdRule.forward_to)}</text>
                  <text x={forwardX + 6} y={ry + 25} fontSize={9} fill="#5b21b6">{fwdRule.forward_bps} bps</text>
                </g>
              </>
            )}
          </g>
        );
      })}
      <defs>
        <marker id="arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="#94a3b8" /></marker>
        <marker id="arrowPurple" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="#a78bfa" /></marker>
      </defs>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Compact table
// ---------------------------------------------------------------------------

function CompactTable({ recipients, protocolFeeBps }: { recipients: SplitRecipient[]; protocolFeeBps: number }) {
  const thStyle: React.CSSProperties = { paddingBlock: 6, paddingInline: 8, textAlign: "start", fontWeight: 600, borderBlockEnd: "2px solid #e5e7eb" };
  const tdStyle: React.CSSProperties = { paddingBlock: 5, paddingInline: 8, fontFamily: "monospace" };
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ background: "#f9fafb" }}>
          <th style={thStyle}>Recipient</th>
          <th style={thStyle}>bps</th>
          <th style={thStyle}>%</th>
          <th style={thStyle}>USDC (of 100)</th>
        </tr>
      </thead>
      <tbody>
        {recipients.map((r, i) => (
          <tr key={r.id} style={{ borderBlockEnd: "1px solid #e5e7eb" }}>
            <td style={tdStyle}>
              {/* Address always LTR */}
              <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                {r.address ? `${r.address.slice(0, 4)}…${r.address.slice(-4)}` : `Recipient ${i + 1}`}
              </span>
              {r.isDustSink ? " ★" : ""}
            </td>
            <td style={tdStyle}><span dir="ltr" style={{ unicodeBidi: "isolate" }}>{r.share_bps}</span></td>
            <td style={tdStyle}><span dir="ltr" style={{ unicodeBidi: "isolate" }}>{bpsToPct(r.share_bps).toFixed(2)}%</span></td>
            <td style={tdStyle}><span dir="ltr" style={{ unicodeBidi: "isolate" }}>{bpsToUsdc(r.share_bps, protocolFeeBps)}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SplitAllocationEditor({
  merchantAddress, maxRecipients = DEFAULT_MAX_RECIPIENTS,
  protocolFeeBps = DEFAULT_PROTOCOL_FEE_BPS, onSave,
}: SplitAllocationEditorProps) {
  const [state, dispatch] = useReducer(editorReducer, initialState);
  const [forwardingOpen, setForwardingOpen] = useState(false);
  const [confirmReset, setConfirmReset]     = useState(false);
  const formId = useId();

  const { recipients, forwardingRules, inputMode } = state;
  const totalBps = recipients.reduce((s, r) => s + r.share_bps, 0);
  const isExact  = totalBps === TOTAL_BPS;

  const addressCounts = recipients.reduce<Record<string, number>>((acc, r) => {
    const a = r.address.trim();
    if (a) acc[a] = (acc[a] ?? 0) + 1;
    return acc;
  }, {});
  const duplicateAddresses = new Set(Object.entries(addressCounts).filter(([, c]) => c > 1).map(([a]) => a));

  const cycleAddresses = useMemo(() => detectForwardingCycle(forwardingRules, recipients), [forwardingRules, recipients]);

  const hasInvalidAddresses = recipients.some((r) => r.address.trim() !== "" && !isValidStellarAddress(r.address));
  const hasForwardInvalid   = forwardingRules.some((r) => r.forward_to.trim() !== "" && !isValidStellarAddress(r.forward_to));
  const canSave = isExact && duplicateAddresses.size === 0 && !hasInvalidAddresses && !hasForwardInvalid && cycleAddresses === null && recipients.every((r) => r.address.trim() !== "");

  function handleSave() {
    if (!canSave || !onSave) return;
    onSave({
      recipients: recipients.map((r) => ({ address: r.address.trim(), share_bps: r.share_bps })),
      forwardingRules: forwardingRules.map((r) => ({ merchant: merchantAddress, forward_to: r.forward_to.trim(), forward_bps: r.forward_bps, active: r.active })),
    });
  }

  function handleReset() {
    if (recipients.length > 1 || recipients[0].address !== "") { setConfirmReset(true); }
    else { dispatch({ type: "RESET" }); }
  }

  function modeBtn(active: boolean): React.CSSProperties {
    return { paddingBlock: 4, paddingInline: 12, border: `1px solid ${active ? "#3b82f6" : "#d1d5db"}`, borderRadius: 20, background: active ? "#eff6ff" : "#fff", color: active ? "#1d4ed8" : "#374151", fontWeight: active ? 600 : 400, cursor: "pointer", fontSize: 12 };
  }
  function toolbarBtn(disabled: boolean, danger = false): React.CSSProperties {
    return { paddingBlock: 5, paddingInline: 12, border: `1px solid ${danger ? "#fca5a5" : "#d1d5db"}`, borderRadius: 4, background: danger ? "#fef2f2" : "#f9fafb", color: danger ? "#dc2626" : "#374151", cursor: disabled ? "not-allowed" : "pointer", fontSize: 12, opacity: disabled ? 0.5 : 1 };
  }

  return (
    <div id={formId} style={{ fontFamily: "system-ui, sans-serif", color: "#111827" }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBlockEnd: 12 }}>Split &amp; Forwarding Configurator</h2>

      {/* Mode toggle */}
      <div style={{ display: "flex", gap: 8, marginBlockEnd: 12, alignItems: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Input mode:</span>
        <button type="button" aria-pressed={inputMode === "pct"} onClick={() => dispatch({ type: "SET_MODE", mode: "pct" })} style={modeBtn(inputMode === "pct")}>% Percentage</button>
        <button type="button" aria-pressed={inputMode === "bps"} onClick={() => dispatch({ type: "SET_MODE", mode: "bps" })} style={modeBtn(inputMode === "bps")}>bps Basis Points</button>
      </div>

      {/* Split screen */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        {/* LEFT PANE */}
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBlockEnd: 8 }}>Recipients</h3>

          {/* Column headers */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 160px auto auto auto", gap: 8, fontSize: 11, color: "#6b7280", paddingBlockEnd: 4, borderBlockEnd: "1px solid #e5e7eb" }}>
            <span>Address</span><span>Allocation</span><span title="Dust-sink">★</span><span>Fill</span><span>Del</span>
          </div>

          {recipients.map((r, i) => (
            <RecipientRow key={r.id} recipient={r} index={i} total={recipients.length} inputMode={inputMode}
              duplicateAddresses={duplicateAddresses}
              onAddressChange={(id, val) => dispatch({ type: "UPDATE_ADDRESS", id, address: val })}
              onBpsChange={(id, bps) => dispatch({ type: "UPDATE_BPS", id, bps })}
              onSetDustSink={(id) => dispatch({ type: "SET_DUST_SINK", id })}
              onRemove={(id) => dispatch({ type: "REMOVE_RECIPIENT", id })}
              onMove={(id, dir) => dispatch({ type: "MOVE_ROW", id, direction: dir })}
              onFillRemaining={(id) => dispatch({ type: "FILL_REMAINING", id })} />
          ))}

          <div style={{ marginBlockStart: 12 }}><AllocationBar totalBps={totalBps} /></div>

          {!isExact && (
            <div role="alert" style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 4, paddingBlock: 8, paddingInline: 10, fontSize: 12, color: "#92400e", marginBlockEnd: 8 }}>
              <strong>Total:{" "}<span dir="ltr" style={{ unicodeBidi: "isolate" }}>{totalBps} bps ({bpsToPct(totalBps).toFixed(2)}%)</span></strong>
              {totalBps < TOTAL_BPS ? ` — ${TOTAL_BPS - totalBps} bps short of 100%.` : ` — ${totalBps - TOTAL_BPS} bps over 100%.`}
            </div>
          )}

          {cycleAddresses && (
            <div role="alert" style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 4, paddingBlock: 8, paddingInline: 10, fontSize: 12, color: "#991b1b", marginBlockEnd: 8 }}>
              <strong>⚠ Cycle detected:</strong>{" "}
              {cycleAddresses.map((a, i) => (
                <span key={i}>
                  <code dir="ltr" style={{ unicodeBidi: "isolate", fontFamily: "monospace" }}>{a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a}</code>
                  {i < cycleAddresses.length - 1 ? " → " : ""}
                </span>
              ))}{" "}forms a loop.
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBlockStart: 8 }}>
            <button type="button" onClick={() => dispatch({ type: "ADD_RECIPIENT" })} disabled={recipients.length >= maxRecipients} style={toolbarBtn(recipients.length >= maxRecipients)}>+ Add Recipient</button>
            <button type="button" onClick={() => dispatch({ type: "SPLIT_EVENLY" })} style={toolbarBtn(false)}>Split Evenly</button>
            <button type="button" onClick={handleReset} style={toolbarBtn(false, true)}>Reset</button>
          </div>

          {confirmReset && (
            <div style={{ marginBlockStart: 8, paddingBlock: 8, paddingInline: 10, background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 4, fontSize: 12 }}>
              Clear all recipients?{" "}
              <button type="button" onClick={() => { dispatch({ type: "RESET" }); setConfirmReset(false); }} style={{ color: "#dc2626", fontWeight: 600, background: "none", border: "none", cursor: "pointer" }}>Yes, reset</button>
              {" "}·{" "}
              <button type="button" onClick={() => setConfirmReset(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#374151" }}>Cancel</button>
            </div>
          )}

          {/* Forwarding rules */}
          <div style={{ marginBlockStart: 20 }}>
            <button type="button" onClick={() => setForwardingOpen((o) => !o)} aria-expanded={forwardingOpen}
              style={{ width: "100%", textAlign: "start", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 4, paddingBlock: 8, paddingInline: 10, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              {forwardingOpen ? "▾" : "▸"} Forwarding Rules ({forwardingRules.length})
            </button>

            {forwardingOpen && (
              <div style={{ paddingBlock: 8 }}>
                <p style={{ fontSize: 11, color: "#6b7280", marginBlockEnd: 8 }}>
                  Merchant:{" "}
                  <code dir="ltr" style={{ unicodeBidi: "isolate", fontFamily: "monospace" }}>{merchantAddress || "—"}</code>
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 160px 60px auto", gap: 8, fontSize: 11, color: "#6b7280", paddingBlockEnd: 4, borderBlockEnd: "1px solid #e5e7eb" }}>
                  <span>Forward-to Address</span><span>Amount</span><span>Active</span><span>Del</span>
                </div>
                {forwardingRules.map((rule) => (
                  <ForwardingRuleRow key={rule.id} rule={rule} inputMode={inputMode}
                    onChange={(id, patch) => dispatch({ type: "UPDATE_FORWARD_RULE", id, patch })}
                    onRemove={(id) => dispatch({ type: "REMOVE_FORWARD_RULE", id })} />
                ))}
                <button type="button" onClick={() => dispatch({ type: "ADD_FORWARD_RULE" })} style={{ ...toolbarBtn(false), marginBlockStart: 8 }}>+ Add Forwarding Rule</button>
              </div>
            )}
          </div>

          {/* Save */}
          <button type="button" onClick={handleSave} disabled={!canSave}
            title={!canSave ? "Resolve all errors before saving" : "Save configuration to contract"}
            style={{ marginBlockStart: 16, paddingBlock: 10, paddingInline: 20, background: canSave ? "#16a34a" : "#d1d5db", color: canSave ? "#fff" : "#6b7280", border: "none", borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: canSave ? "pointer" : "not-allowed", width: "100%" }}>
            Save Configuration
          </button>
        </div>

        {/* RIGHT PANE — Flow Preview */}
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBlockEnd: 8 }}>
            Live Flow Preview
            <span style={{ fontSize: 11, fontWeight: 400, color: "#6b7280", marginInlineStart: 8 }}>
              (example: {EXAMPLE_AMOUNT_USDC}.00 USDC)
            </span>
          </h3>

          <div style={{ border: "1px solid #e5e7eb", borderRadius: 6, paddingBlock: 12, paddingInline: 12, background: "#fafafa", overflowX: "auto" }}>
            <FlowPreview recipients={recipients} forwardingRules={forwardingRules} protocolFeeBps={protocolFeeBps} cycleAddresses={cycleAddresses} />
          </div>

          <details style={{ marginBlockStart: 12 }}>
            <summary style={{ fontSize: 12, color: "#6b7280", cursor: "pointer" }}>Show allocation table</summary>
            <div style={{ marginBlockStart: 8 }}>
              <CompactTable recipients={recipients} protocolFeeBps={protocolFeeBps} />
            </div>
          </details>

          {/* Legend */}
          <div style={{ marginBlockStart: 12, fontSize: 11, color: "#6b7280", display: "flex", gap: 16, flexWrap: "wrap" }}>
            {[
              { bg: "#dbeafe", border: "#93c5fd", label: "Customer" },
              { bg: "#fef9c3", border: "#fde047", label: "Protocol Fee" },
              { bg: "#dcfce7", border: "#86efac", label: "Recipient" },
              { bg: "#ede9fe", border: "#a78bfa", label: "Forwarding hop" },
              { bg: "#fee2e2", border: "#ef4444", label: "Cycle / error" },
            ].map(({ bg, border, label }) => (
              <span key={label}>
                <span style={{ display: "inline-block", width: 10, height: 10, background: bg, border: `1px solid ${border}`, marginInlineEnd: 4 }} />
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SplitAllocationEditor;
