import { useCallback, useEffect, useRef, useState } from 'react';

type TBotState = 'idle' | 'scanning' | 'trading';
type TSignalType = 'CALL' | 'PUT';

const CFG_STAKE = 0.35;
const CFG_DUR_NUM = 1;
const CFG_DUR_UNIT = 't';
const CFG_MART = 2.0;
const CFG_STEPS = 3;
const PROPOSAL_TTL_MS = 800;
const WATCHDOG_MS = 1500;
const EXEC_QUEUE_MAX = 2;
const RETRY_KEEPALIVE_MS = 500;
const LS_KEY = 'derivbot_analytics';
const ASSETS = ['R_25', 'R_100'];
const ASSET_NAMES: Record<string, string> = { R_25: 'V25', R_100: 'V100' };
const UI_THROTTLE = 300;
const APP_ID = '1089';

interface IEvt {
    tickLat?: number | null;
    orderRTT?: number | null;
    retryUsed?: boolean;
    retryPreloaded?: boolean;
    martLevel?: number;
    result?: string;
    asset?: string;
    stake?: number;
    tickGapAtEntry?: number;
    avgTickGapAtEntry?: number;
    ts?: number;
}

interface IBotRefs {
    botState: TBotState;
    activeSignal: TSignalType | null;
    activeContractId: number | null;
    currentStake: number;
    martLevel: number;
    entryStepCount: number;
    currentAsset: string;
    assetIndex: number;
    tradesOnAsset: number;
    lastTickPrice: number | null;
    tickHistory: string[];
    tickTimestamps: number[];
    lastTickMs: number;
    lastTickGapMs: number;
    entryTickGapMs: number;
    entryTickAvgGap: number;
    patternsFound: number;
    sessionPnl: number;
    wins: number;
    losses: number;
    totalTrades: number;
    bestTrade: number;
    worstTrade: number;
    entryProposalId: string | null;
    entryProposalType: TSignalType | null;
    entryPending: boolean;
    isArmed: boolean;
    entryProposalArrival: number;
    waitingForDeferred: boolean;
    deferredSignalType: TSignalType | null;
    deferredFires: number;
    ttlSkips: number;
    queueStaleness: number;
    retryProposalId: string | null;
    retryProposalReady: boolean;
    retryPending: boolean;
    retryProposalArrival: number;
    watchdogFires: number;
    doubleFillGuards: number;
    proposalReloads: number;
    queueBlocks: number;
    executionLocked: boolean;
    pendingExecutionId: string | null;
    executionTimestamps: Record<string, number>;
    execQueue: Array<{ type: string; proposalId?: string; stake: number; signal?: string; proposalTs: number; _execId: string }>;
    execRunning: boolean;
    _lastRTT: number | null;
    latencyDataset: IEvt[];
}

function makeRefs(): IBotRefs {
    return {
        botState: 'idle', activeSignal: null, activeContractId: null,
        currentStake: CFG_STAKE, martLevel: 0, entryStepCount: 0,
        currentAsset: ASSETS[0], assetIndex: 0, tradesOnAsset: 0,
        lastTickPrice: null, tickHistory: [], tickTimestamps: [],
        lastTickMs: 0, lastTickGapMs: 0, entryTickGapMs: 0, entryTickAvgGap: 0,
        patternsFound: 0, sessionPnl: 0, wins: 0, losses: 0, totalTrades: 0,
        bestTrade: 0, worstTrade: 0,
        entryProposalId: null, entryProposalType: null, entryPending: false,
        isArmed: false, entryProposalArrival: 0,
        waitingForDeferred: false, deferredSignalType: null, deferredFires: 0,
        ttlSkips: 0, queueStaleness: 0,
        retryProposalId: null, retryProposalReady: false, retryPending: false,
        retryProposalArrival: 0,
        watchdogFires: 0, doubleFillGuards: 0, proposalReloads: 0, queueBlocks: 0,
        executionLocked: false, pendingExecutionId: null, executionTimestamps: {},
        execQueue: [], execRunning: false, _lastRTT: null, latencyDataset: [],
    };
}

const FreeBots = () => {
    const wsRef = useRef<WebSocket | null>(null);
    const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retryKaRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const uiTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const statusRef = useRef<{ text: string; type: string } | null>(null);
    const b = useRef<IBotRefs>(makeRefs());
    const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reconnectAttemptRef = useRef(0);
    const mountedRef = useRef(true);
    const connectFnRef = useRef<(() => void) | null>(null);

    const [renderTick, setRenderTick] = useState(0);
    const [isConnected, setIsConnected] = useState(false);
    const [balance, setBalance] = useState('—');
    const [currency, setCurrency] = useState('USD');
    const [statusMsg, setStatusMsg] = useState<{ text: string; type: string } | null>(null);
    const [tradeLog, setTradeLog] = useState<Array<{ time: string; asset: string; type: string; dir: string; stake: number; pnl: number; win: boolean }>>([]);
    const [rotateLog, setRotateLog] = useState<Array<{ time: string; msg: string }>>([]);
    const [tickBoxes, setTickBoxes] = useState<string[]>(['—', '—', '—', '—', '—']);
    const [signal, setSignal] = useState('WATCHING…');
    const [signalClass, setSignalClass] = useState('sig-wait');
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    useEffect(() => {
        const tick = () => {
            setRenderTick(n => n + 1);
            if (statusRef.current) setStatusMsg(statusRef.current);
        };
        uiTimerRef.current = setInterval(tick, UI_THROTTLE);
        return () => { if (uiTimerRef.current) clearInterval(uiTimerRef.current); };
    }, []);

    const showStatus = useCallback((msg: string, type: string) => {
        statusRef.current = { text: msg, type };
        setStatusMsg({ text: msg, type });
    }, []);

    const getToken = useCallback(() => {
        const list = JSON.parse(localStorage.getItem('accountsList') || '{}');
        const loginid = localStorage.getItem('active_loginid');
        if (loginid && list[loginid]) {
            const t = list[loginid];
            if (typeof t === 'string') return t;
            if (t?.token) return t.token;
        }
        const t = localStorage.getItem('authToken');
        if (t) return t;
        const ai = JSON.parse(localStorage.getItem('auth_info') || '{}');
        if (ai?.access_token) return ai.access_token;
        return null;
    }, []);

    const wsSend = useCallback((obj: any) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(obj));
    }, []);

    const clearWatchdog = useCallback(() => {
        if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    }, []);

    const stopRetryKa = useCallback(() => {
        if (retryKaRef.current) { clearInterval(retryKaRef.current); retryKaRef.current = null; }
    }, []);

    const resetEntry = useCallback(() => {
        const s = b.current;
        s.entryProposalId = null; s.entryProposalType = null; s.entryPending = false;
        s.isArmed = false; s.entryProposalArrival = 0;
    }, []);

    const resetRetry = useCallback(() => {
        const s = b.current;
        stopRetryKa();
        s.retryProposalId = null; s.retryProposalReady = false;
        s.retryPending = false; s.retryProposalArrival = 0;
    }, [stopRetryKa]);

    const safeForget = useCallback(() => {
        stopRetryKa();
        b.current.execQueue = []; b.current.execRunning = false;
        b.current.executionLocked = false; b.current.pendingExecutionId = null;
        wsSend({ forget_all: 'proposal' });
    }, [stopRetryKa, wsSend]);

    const saveDataset = useCallback(() => {
        try { localStorage.setItem(LS_KEY, JSON.stringify(b.current.latencyDataset.slice(-1000))); } catch (_) { }
    }, []);

    const handleMessage = useCallback((e: MessageEvent) => {
        let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
        const s = b.current;

        if (msg.error) { showStatus('API: ' + msg.error.message, 'error'); return; }

        switch (msg.msg_type) {
            case 'authorize': {
                const a = msg.authorize;
                setIsConnected(true);
                reconnectAttemptRef.current = 0;
                setBalance(a.balance);
                setCurrency(a.currency || 'USD');
                showStatus('Connected as ' + (a.email || a.loginid), 'success');
                wsSend({ balance: 1, subscribe: 1 });
                if (pingRef.current) clearInterval(pingRef.current);
                pingRef.current = setInterval(() => wsSend({ ping: 1 }), 20000);
                break;
            }
            case 'balance': {
                setBalance(msg.balance.balance);
                setCurrency(msg.balance.currency || 'USD');
                break;
            }
            case 'tick': {
                const tick = msg.tick;
                const now = performance.now();
                const price = tick.quote;
                if (s.lastTickMs > 0) s.lastTickGapMs = Math.round(now - s.lastTickMs);
                s.tickTimestamps.push(now);
                if (s.tickTimestamps.length > 10) s.tickTimestamps.shift();
                s.lastTickMs = now;

                if (s.lastTickPrice !== null && s.botState === 'scanning') {
                    const dir = price >= s.lastTickPrice ? 'rise' : 'fall';
                    s.tickHistory.push(dir);
                    if (s.tickHistory.length > 20) s.tickHistory.shift();
                    const L = s.tickHistory.length;

                    if (!s.isArmed && !s.entryPending && !s.waitingForDeferred && L >= 4) {
                        const d = s.tickHistory[L - 1];
                        if (s.tickHistory[L - 4] === d && s.tickHistory[L - 3] === d && s.tickHistory[L - 2] === d && s.tickHistory[L - 1] === d) {
                            preloadEntryFn(s, d === 'rise' ? 'PUT' : 'CALL');
                        }
                    }
                    if (L >= 5) {
                        const d = s.tickHistory[L - 1];
                        const same = s.tickHistory[L - 5] === d && s.tickHistory[L - 4] === d && s.tickHistory[L - 3] === d && s.tickHistory[L - 2] === d;
                        if (same && !s.waitingForDeferred) {
                            const exp = d === 'rise' ? 'PUT' : 'CALL';
                            if (!s.entryProposalId || s.entryPending) {
                                showStatus('Signal — deferring…', 'info');
                                s.waitingForDeferred = true; s.deferredSignalType = exp;
                                s.entryTickGapMs = s.lastTickGapMs;
                            } else if (Date.now() - s.entryProposalArrival > PROPOSAL_TTL_MS) {
                                s.ttlSkips++; resetEntry(); saveDataset();
                                preloadEntryFn(s, exp);
                                s.waitingForDeferred = true; s.deferredSignalType = exp;
                                s.entryTickGapMs = s.lastTickGapMs;
                            } else if (s.entryProposalType === exp) {
                                triggerArmedFn(s);
                            } else {
                                disarmFn(s);
                            }
                        } else if (!same && !s.waitingForDeferred) {
                            disarmFn(s);
                        }
                    }
                }
                s.lastTickPrice = price;
                break;
            }
            case 'proposal': {
                const p = msg.proposal; const er = msg.echo_req; const role = er?.passthrough?.role;
                if (role === 'entry') {
                    if (!s.entryPending) return;
                    s.entryProposalId = p.id; s.entryPending = false;
                    s.entryProposalArrival = Date.now(); s.isArmed = true;
                    if (s.waitingForDeferred) {
                        if (s.deferredSignalType === s.entryProposalType) {
                            s.deferredFires++; s.waitingForDeferred = false; s.deferredSignalType = null; saveDataset();
                            showStatus('Deferred entry firing', 'info');
                            triggerArmedFn(s);
                        } else {
                            s.waitingForDeferred = false; s.deferredSignalType = null; disarmFn(s);
                            showStatus('Signal mismatch — discarding', 'warn');
                        }
                    }
                } else if (role === 'retry') {
                    if (!s.retryPending) return;
                    s.retryProposalId = p.id; s.retryPending = false;
                    s.retryProposalReady = true; s.retryProposalArrival = Date.now();
                } else if (role === 'watchdog' || role === 'retry-immediate') {
                    if (s.botState !== 'trading') return;
                    const eid = role + '-' + Date.now();
                    s.pendingExecutionId = eid; s.executionLocked = true;
                    enqueueFn(s, { type: 'BUY_PROPOSAL', proposalId: p.id, stake: s.currentStake, proposalTs: Date.now(), _execId: eid });
                }
                break;
            }
            case 'buy': {
                const buy = msg.buy;
                if (s.botState !== 'trading') return;
                clearWatchdog();
                s.activeContractId = buy.contract_id;
                const eid = s.pendingExecutionId;
                const sent = s.executionTimestamps[eid || ''] || performance.now();
                const rtt = Math.round(performance.now() - sent);
                if (eid) delete s.executionTimestamps[eid];
                s._lastRTT = rtt; s.executionLocked = false;
                const dir = s.activeSignal === 'CALL' ? 'RISE' : 'FALL';
                showStatus(`Contract #${buy.contract_id} (${dir}) $${parseFloat(buy.buy_price).toFixed(2)} | RTT ${rtt}ms`, 'info');
                wsSend({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1 });
                startRetryKaFn();
                drainFn(s);
                break;
            }
            case 'proposal_open_contract': {
                const c = msg.proposal_open_contract;
                if (c.contract_id !== s.activeContractId) return;
                if (!c.is_expired && !c.is_sold) return;
                s.activeContractId = null;
                clearWatchdog(); stopRetryKa();
                const pnl = parseFloat(c.profit); const stake = parseFloat(c.buy_price);
                const isWin = pnl > 0; const asset = s.currentAsset;
                const retry = s.entryStepCount > 0;
                s.sessionPnl += pnl; s.totalTrades++; s.tradesOnAsset++;
                if (isWin) s.wins++; else s.losses++;
                if (pnl > s.bestTrade) s.bestTrade = pnl;
                if (pnl < s.worstTrade) s.worstTrade = pnl;
                s.latencyDataset.push({
                    tickLat: null, orderRTT: s._lastRTT, retryUsed: retry,
                    retryPreloaded: retry && !s.retryPending && s.retryProposalReady,
                    martLevel: s.martLevel, result: isWin ? 'win' : 'loss',
                    asset: ASSET_NAMES[asset] || asset, stake,
                    tickGapAtEntry: s.entryTickGapMs, avgTickGapAtEntry: s.entryTickAvgGap, ts: Date.now(),
                });
                saveDataset();
                addTradeRowFn(c, pnl, stake, isWin, asset, retry);

                if (isWin) {
                    safeForget();
                    s.currentStake = CFG_STAKE; s.martLevel = 0; s.entryStepCount = 0;
                    s.activeSignal = null; s.tickHistory = []; s.botState = 'scanning';
                    resetEntry(); resetRetry();
                    showStatus(`WIN +$${pnl.toFixed(2)} — reset. Scanning ${ASSET_NAMES[s.currentAsset]}…`, 'success');
                } else {
                    s.martLevel++; s.entryStepCount++;
                    s.currentStake = parseFloat((CFG_STAKE * Math.pow(CFG_MART, s.martLevel)).toFixed(2));
                    if (s.entryStepCount < CFG_STEPS) {
                        showStatus(`LOSS -$${Math.abs(pnl).toFixed(2)} — L${s.martLevel} ${s.entryStepCount}/${CFG_STEPS} $${s.currentStake.toFixed(2)}`, 'error');
                        setTimeout(fireRetryFn, 0);
                    } else {
                        s.activeSignal = null; s.tickHistory = [];
                        resetEntry(); resetRetry();
                        rotateFn();
                    }
                }
                s.execRunning = false;
                break;
            }
        }
    }, [showStatus, wsSend, saveDataset, clearWatchdog, stopRetryKa, resetEntry, resetRetry, safeForget]);

    function preloadEntryFn(s: IBotRefs, ct: TSignalType) {
        if (s.botState !== 'scanning') return;
        s.entryPending = true; s.entryProposalId = null; s.entryProposalType = ct; s.entryProposalArrival = 0;
        wsSend({ proposal: 1, contract_type: ct, symbol: s.currentAsset, duration: CFG_DUR_NUM, duration_unit: CFG_DUR_UNIT, amount: s.currentStake, basis: 'stake', currency: 'USD', passthrough: { role: 'entry' } });
    }

    function disarmFn(s: IBotRefs) {
        s.entryProposalId = null; s.entryProposalType = null; s.entryPending = false; s.isArmed = false; s.entryProposalArrival = 0;
    }

    function startRetryKaFn() {
        stopRetryKa();
        retryKaRef.current = setInterval(() => {
            const s2 = b.current;
            if (s2.botState === 'trading' && s2.activeSignal && !s2.retryPending) {
                preloadRetryFn(s2);
            }
        }, RETRY_KEEPALIVE_MS);
    }

    function preloadRetryFn(s: IBotRefs) {
        if (!s.activeSignal) return;
        const nextStake = parseFloat((CFG_STAKE * Math.pow(CFG_MART, s.martLevel + 1)).toFixed(2));
        s.retryPending = true; s.retryProposalId = null; s.retryProposalReady = false; s.retryProposalArrival = 0;
        wsSend({ proposal: 1, contract_type: s.activeSignal, symbol: s.currentAsset, duration: CFG_DUR_NUM, duration_unit: CFG_DUR_UNIT, amount: nextStake, basis: 'stake', currency: 'USD', passthrough: { role: 'retry' } });
    }

    function enqueueFn(s: IBotRefs, cmd: { type: string; proposalId?: string; stake: number; signal?: string; proposalTs: number; _execId: string }) {
        if (s.execQueue.length >= EXEC_QUEUE_MAX) { s.queueBlocks++; saveDataset(); showStatus('Exec queue full', 'warn'); return; }
        s.execQueue.push(cmd);
        if (!s.execRunning) drainFn(s);
    }

    function drainFn(s: IBotRefs) {
        if (!s.execQueue.length) { s.execRunning = false; return; }
        s.execRunning = true;
        const cmd = s.execQueue.shift()!;
        const eid = cmd._execId;
        s.executionTimestamps[eid] = performance.now();
        if (cmd.type === 'BUY_PROPOSAL') {
            const age = Date.now() - (cmd.proposalTs || 0);
            if (age > PROPOSAL_TTL_MS) {
                s.queueStaleness++; s.proposalReloads++; saveDataset();
                showStatus('Proposal stale (' + age + 'ms) — reloading…', 'warn');
                s.executionLocked = false;
                wsSend({ proposal: 1, contract_type: s.activeSignal || s.entryProposalType || 'CALL', symbol: s.currentAsset, duration: CFG_DUR_NUM, duration_unit: CFG_DUR_UNIT, amount: cmd.stake, basis: 'stake', currency: 'USD', passthrough: { role: 'retry-immediate' } });
                s.execRunning = false;
                setTimeout(() => drainFn(b.current), 0);
                return;
            }
            wsSend({ buy: cmd.proposalId, price: cmd.stake });
        } else {
            wsSend({ buy: 1, price: cmd.stake, parameters: { amount: cmd.stake, basis: 'stake', contract_type: cmd.signal, currency: 'USD', symbol: s.currentAsset, duration: CFG_DUR_NUM, duration_unit: CFG_DUR_UNIT } });
        }
        startWatchdogFn(s);
    }

    function startWatchdogFn(s: IBotRefs) {
        clearWatchdog();
        watchdogRef.current = setTimeout(() => {
            const s2 = b.current;
            if (s2.activeContractId === null && s2.botState === 'trading') {
                s2.watchdogFires++; saveDataset(); showStatus('Watchdog fired', 'warn');
                if (s2.executionLocked) {
                    s2.doubleFillGuards++; saveDataset(); showStatus('Watchdog locked — waiting', 'warn');
                    setTimeout(() => {
                        if (b.current.activeContractId === null && b.current.botState === 'trading') {
                            b.current.execRunning = false; b.current.executionLocked = false;
                            wsSend({ proposal: 1, contract_type: b.current.activeSignal, symbol: b.current.currentAsset, duration: CFG_DUR_NUM, duration_unit: CFG_DUR_UNIT, amount: b.current.currentStake, basis: 'stake', currency: 'USD', passthrough: { role: 'watchdog' } });
                        }
                    }, 500);
                } else {
                    s2.execRunning = false; s2.executionLocked = false;
                    wsSend({ proposal: 1, contract_type: s2.activeSignal, symbol: s2.currentAsset, duration: CFG_DUR_NUM, duration_unit: CFG_DUR_UNIT, amount: s2.currentStake, basis: 'stake', currency: 'USD', passthrough: { role: 'watchdog' } });
                }
            }
        }, WATCHDOG_MS);
    }

    function triggerArmedFn(s: IBotRefs) {
        if (!s.entryProposalId || s.entryPending) { showStatus('Proposal not ready', 'warn'); return; }
        if (Date.now() - s.entryProposalArrival > PROPOSAL_TTL_MS) {
            s.ttlSkips++; saveDataset(); showStatus('TTL expired — deferring…', 'warn');
            const sig = s.entryProposalType; resetEntry();
            preloadEntryFn(s, sig!);
            s.waitingForDeferred = true; s.deferredSignalType = sig;
            return;
        }
        if (s.executionLocked) { showStatus('Locked — blocked', 'warn'); return; }
        s.entryTickGapMs = s.lastTickGapMs;
        s.entryTickAvgGap = (() => { const ts = s.tickTimestamps; if (ts.length < 2) return 0; let sum = 0; for (let i = 1; i < ts.length; i++) sum += ts[i] - ts[i - 1]; return Math.round(sum / (ts.length - 1)); })();
        s.botState = 'trading'; s.activeSignal = s.entryProposalType; s.entryStepCount = 0; s.patternsFound++;
        s.tickHistory = []; s.waitingForDeferred = false; s.deferredSignalType = null;
        const pid = s.entryProposalId; const pts = s.entryProposalArrival;
        s.entryProposalId = null; s.entryProposalType = null; s.isArmed = false;
        const eid = 'entry-' + Date.now(); s.pendingExecutionId = eid; s.executionLocked = true;
        enqueueFn(s, { type: 'BUY_PROPOSAL', proposalId: pid, stake: s.currentStake, proposalTs: pts, _execId: eid });
        showStatus(`Pattern — firing on ${ASSET_NAMES[s.currentAsset]}…`, 'warn');
    }

    function fireRetryFn() {
        const s = b.current;
        if (!s.activeSignal) return;
        if (s.executionLocked) { showStatus('Retry blocked', 'warn'); return; }
        stopRetryKa(); s.botState = 'trading';
        const fresh = s.retryProposalReady && (Date.now() - s.retryProposalArrival) < PROPOSAL_TTL_MS;
        if (!fresh && s.retryProposalReady) {
            s.proposalReloads++; saveDataset(); showStatus('Retry expired — reloading…', 'warn');
            resetRetry();
            wsSend({ proposal: 1, contract_type: s.activeSignal, symbol: s.currentAsset, duration: CFG_DUR_NUM, duration_unit: CFG_DUR_UNIT, amount: s.currentStake, basis: 'stake', currency: 'USD', passthrough: { role: 'retry-immediate' } });
            return;
        }
        if (fresh && s.retryProposalId) {
            showStatus(`RETRY L${s.martLevel} $${s.currentStake.toFixed(2)} — hot proposal`, 'warn');
            const pid = s.retryProposalId; const pts = s.retryProposalArrival;
            resetRetry();
            const eid = 'retry-' + Date.now(); s.pendingExecutionId = eid; s.executionLocked = true;
            enqueueFn(s, { type: 'BUY_PROPOSAL', proposalId: pid, stake: s.currentStake, proposalTs: pts, _execId: eid });
        } else {
            showStatus(`RETRY L${s.martLevel} $${s.currentStake.toFixed(2)} — fallback`, 'warn');
            resetRetry();
            const eid = 'retry-std-' + Date.now(); s.pendingExecutionId = eid; s.executionLocked = true;
            enqueueFn(s, { type: 'BUY_STANDARD', signal: s.activeSignal, stake: s.currentStake, proposalTs: Date.now(), _execId: eid });
        }
    }

    function rotateFn() {
        const s = b.current;
        const prev = ASSET_NAMES[s.currentAsset];
        s.assetIndex = (s.assetIndex + 1) % ASSETS.length;
        s.currentAsset = ASSETS[s.assetIndex]; s.tradesOnAsset = 0;
        s.botState = 'scanning'; s.activeSignal = null; s.tickHistory = [];
        s.lastTickPrice = null; s.waitingForDeferred = false; s.deferredSignalType = null;
        clearWatchdog(); stopRetryKa(); resetEntry(); resetRetry();
        addRotateRowFn(prev, ASSET_NAMES[s.currentAsset], s.martLevel, s.currentStake);
        showStatus(`${prev} → ${ASSET_NAMES[s.currentAsset]} | L${s.martLevel} $${s.currentStake.toFixed(2)}`, 'warn');
        subscribeAssetFn();
    }

    function subscribeAssetFn() {
        const s = b.current;
        safeForget(); wsSend({ forget_all: 'ticks' }); clearWatchdog();
        s.waitingForDeferred = false; s.deferredSignalType = null;
        setTimeout(() => {
            wsSend({ ticks: s.currentAsset, subscribe: 1 });
            s.tickHistory = []; s.lastTickPrice = null; s.tickTimestamps = [];
            s.lastTickGapMs = 0; s.entryTickGapMs = 0; s.entryTickAvgGap = 0;
            resetEntry(); resetRetry();
        }, 200);
    }

    function addTradeRowFn(c: any, pnl: number, stake: number, isWin: boolean, asset: string, retry: boolean) {
        const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const label = c.contract_type === 'CALL' ? 'RISE' : 'FALL';
        const ttype = retry ? 'RETRY L' + b.current.martLevel : 'PATTERN';
        setTradeLog(prev => [{ time, asset: ASSET_NAMES[asset] || asset, type: ttype, dir: label, stake, pnl, win: isWin }, ...prev].slice(0, 500));
    }

    function addRotateRowFn(from: string, to: string, level: number, stake: number) {
        const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setRotateLog(prev => [{ time, msg: `MAX STEPS (L${level}) on ${from} → ${to} carrying $${stake.toFixed(2)}` }, ...prev].slice(0, 100));
    }

    const connect = useCallback(() => {
        const token = getToken();
        if (!token) {
            showStatus('No authentication token found. Log in to use the bot.', 'error');
            setIsConnected(false);
            return;
        }
        if (wsRef.current) try { wsRef.current.close(); } catch (_) { }
        showStatus('Connecting with app authentication…', 'info');
        const wsUrl = `wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => wsSend({ authorize: token });
        ws.onerror = () => { setIsConnected(false); showStatus('Connection error.', 'error'); };
        ws.onclose = () => {
            setIsConnected(false);
            if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
            clearWatchdog(); stopRetryKa(); resetEntry(); resetRetry();
            if (mountedRef.current && b.current.botState !== 'idle') {
                const attempt = reconnectAttemptRef.current;
                const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
                reconnectAttemptRef.current = attempt + 1;
                showStatus(`Disconnected. Reconnecting in ${Math.round(delay / 1000)}s… (attempt ${attempt + 1})`, 'warn');
                reconnectRef.current = setTimeout(() => {
                    if (mountedRef.current) connect();
                }, delay);
            }
        };
        ws.onmessage = handleMessage;
    }, [getToken, handleMessage, showStatus, wsSend, clearWatchdog, stopRetryKa, resetEntry, resetRetry]);

    connectFnRef.current = connect;

    useEffect(() => {
        mountedRef.current = true;
        connect();
        return () => {
            mountedRef.current = false;
            if (reconnectRef.current) clearTimeout(reconnectRef.current);
            if (wsRef.current) try { wsRef.current.close(); } catch (_) { }
            if (pingRef.current) clearInterval(pingRef.current);
            clearWatchdog(); stopRetryKa();
        };
    }, [connect, clearWatchdog, stopRetryKa]);

    const reconnect = useCallback(() => {
        if (reconnectRef.current) clearTimeout(reconnectRef.current);
        reconnectAttemptRef.current = 0;
        if (wsRef.current) try { wsRef.current.close(); } catch (_) { }
        connect();
    }, [connect]);

    const startBot = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) { showStatus('Not connected.', 'error'); return; }
        const s = b.current;
        s.currentStake = CFG_STAKE; s.martLevel = 0; s.entryStepCount = 0;
        s.sessionPnl = 0; s.wins = 0; s.losses = 0; s.totalTrades = 0;
        s.bestTrade = 0; s.worstTrade = 0; s.patternsFound = 0;
        s.activeSignal = null; s.activeContractId = null;
        s.assetIndex = 0; s.currentAsset = ASSETS[0]; s.tradesOnAsset = 0;
        s.tickHistory = []; s.lastTickPrice = null; s.tickTimestamps = [];
        s.lastTickGapMs = 0; s.entryTickGapMs = 0; s.entryTickAvgGap = 0; s._lastRTT = null;
        setTradeLog([]); setRotateLog([]);
        clearWatchdog(); stopRetryKa(); resetEntry(); resetRetry(); safeForget();
        s.botState = 'scanning';
        showStatus('Bot started — Scanning V25 for 5-pattern…', 'info');
        subscribeAssetFn();
    }, [showStatus, clearWatchdog, stopRetryKa, resetEntry, resetRetry, safeForget]);

    const stopBot = useCallback(() => {
        const s = b.current;
        s.botState = 'idle'; s.activeSignal = null; s.activeContractId = null;
        s.tickHistory = [];
        clearWatchdog(); s.waitingForDeferred = false; s.deferredSignalType = null;
        stopRetryKa(); resetEntry(); resetRetry(); safeForget();
        showStatus('Bot stopped.', 'info');
    }, [clearWatchdog, stopRetryKa, resetEntry, resetRetry, safeForget, showStatus]);

    const s = b.current;
    const tickLatMs = s.lastTickMs ? Date.now() - (s.lastTickMs - performance.now() + s.lastTickMs) : 0;
    const wr = s.totalTrades > 0 ? Math.round(s.wins / s.totalTrades * 100) : 0;
    const pnlStr = (s.sessionPnl >= 0 ? '+' : '') + '$' + Math.abs(s.sessionPnl).toFixed(2);
    const bState = s.botState;

    const last5 = bState === 'scanning' && !s.waitingForDeferred ? s.tickHistory.slice(-5) : [];
    const boxes: string[] = [];
    for (let i = 0; i < 5; i++) boxes.push(last5[i] === 'rise' ? '▲' : last5[i] === 'fall' ? '▼' : '—');
    if (boxes.some((v, i) => v !== tickBoxes[i])) setTickBoxes(boxes);

    if (bState === 'scanning') {
        if (last5.length === 5 && last5[0] === last5[1] && last5[1] === last5[2] && last5[2] === last5[3] && last5[3] === last5[4]) {
            const sc = last5[0] === 'rise' ? 'sig-fall' : 'sig-rise';
            const sg = last5[0] === 'rise' ? '▼ TRADE FALL' : '▲ TRADE RISE';
            if (signalClass !== sc) setSignalClass(sc);
            if (signal !== sg) setSignal(sg);
        } else {
            if (signalClass !== 'sig-wait') setSignalClass('sig-wait');
            if (signal !== 'WATCHING…') setSignal('WATCHING…');
        }
    } else if (bState === 'trading') {
        const sc = s.activeSignal === 'PUT' ? 'sig-fall' : 'sig-rise';
        const sg = s.activeSignal === 'PUT' ? '▼ TRADING FALL' : '▲ TRADING RISE';
        if (signalClass !== sc) setSignalClass(sc);
        if (signal !== sg) setSignal(sg);
    }

    const badgeItems = [
        { key: 'scan', label: 'SCANNING', active: bState === 'scanning', cls: 'scan' },
        { key: 'trade', label: 'TRADING', active: bState === 'trading', cls: 'trade' },
        { key: 'armed', label: 'ARMED', active: s.isArmed, cls: 'armed' },
        { key: 'defer', label: 'DEFERRED', active: s.waitingForDeferred, cls: 'defer' },
        { key: 'carry', label: 'CARRYING', active: s.martLevel >= CFG_STEPS && bState === 'scanning', cls: 'carry' },
    ];

    const activeBadges = badgeItems.filter(bb => bb.active);

    return (
        <div className='free-bots'>
            <div className='free-bots__container'>
                <header className='free-bots__header'>
                    <div className='free-bots__header-left'>
                        <div className='free-bots__logo-mark'>⚡</div>
                        <div className='free-bots__logo-text'>Deriv <span>Bot</span></div>
                    </div>
                    <button
                        className='free-bots__menu-toggle'
                        onClick={() => setMobileMenuOpen(o => !o)}
                        aria-label='Toggle menu'
                    >
                        <span />
                        <span />
                        <span />
                    </button>
                    <div className={`free-bots__header-right ${mobileMenuOpen ? 'open' : ''}`}>
                        <div className='free-bots__badge-row'>
                            {activeBadges.map(bb => (
                                <div key={bb.key} className={`free-bots__badge free-bots__badge--${bb.cls} active`}>
                                    <div className='free-bots__blink' /> {bb.label}
                                </div>
                            ))}
                            {activeBadges.length === 0 && (
                                <div className='free-bots__badge free-bots__badge--idle active'>
                                    <div className='free-bots__blink' /> IDLE
                                </div>
                            )}
                        </div>
                        <div className='free-bots__conn-status'>
                            <div className={`free-bots__conn-dot ${isConnected ? 'on' : 'err'}`} />
                            <span>{isConnected ? 'CONNECTED' : 'DOWN'}</span>
                        </div>
                    </div>
                </header>

                <div className='free-bots__latency-bar'>
                    <div className='free-bots__lat-item'>
                        <div className='free-bots__lat-label'>Latency</div>
                        <div className={`free-bots__lat-val ${tickLatMs < 100 ? 'good' : tickLatMs < 300 ? 'ok' : 'bad'}`}>
                            {tickLatMs ? tickLatMs + 'ms' : '—'}
                        </div>
                    </div>
                    <div className='free-bots__lat-sep'>|</div>
                    <div className='free-bots__lat-item'>
                        <div className='free-bots__lat-label'>RTT</div>
                        <div className={`free-bots__lat-val ${s._lastRTT !== null ? (s._lastRTT < 150 ? 'good' : s._lastRTT < 400 ? 'ok' : 'bad') : ''}`}>
                            {s._lastRTT !== null ? s._lastRTT + 'ms' : '—'}
                        </div>
                    </div>
                    <div className='free-bots__lat-sep'>|</div>
                    <div className='free-bots__lat-item'>
                        <div className='free-bots__lat-label'>Tick Gap</div>
                        <div className={`free-bots__lat-val ${s.lastTickGapMs < 400 ? 'good' : s.lastTickGapMs < 800 ? 'ok' : 'bad'}`}>
                            {s.lastTickGapMs ? s.lastTickGapMs + 'ms' : '—'}
                        </div>
                    </div>
                    <div className='free-bots__lat-sep'>|</div>
                    <div className='free-bots__lat-item'>
                        <div className='free-bots__lat-label'>Entry</div>
                        <div className={`free-bots__lat-val ${s.isArmed ? 'good' : s.entryPending ? 'ok' : ''}`}>
                            {s.isArmed ? 'READY' : s.entryPending ? 'LOAD' : '—'}
                        </div>
                    </div>
                    <div className='free-bots__lat-sep'>|</div>
                    <div className='free-bots__lat-item'>
                        <div className='free-bots__lat-label'>Retry</div>
                        <div className={`free-bots__lat-val ${s.retryProposalReady ? 'good' : s.retryPending ? 'ok' : ''}`}>
                            {s.retryProposalReady ? 'READY' : s.retryPending ? 'LOAD' : '—'}
                        </div>
                    </div>
                    <div className='free-bots__lat-sep'>|</div>
                    <div className='free-bots__lat-item'>
                        <div className='free-bots__lat-label'>Next ETA</div>
                        <div className='free-bots__lat-val'>
                            {(() => {
                                const ts = s.tickTimestamps;
                                if (ts.length < 2) return '—';
                                let sum = 0;
                                for (let i = 1; i < ts.length; i++) sum += ts[i] - ts[i - 1];
                                const avg = Math.round(sum / (ts.length - 1));
                                const eta = Math.max(0, Math.round(avg - (performance.now() - s.lastTickMs)));
                                return eta + 'ms';
                            })()}
                        </div>
                    </div>
                </div>

                <div className='free-bots__rotation-bar'>
                    <div className='free-bots__rot-label'>Assets</div>
                    <div className='free-bots__asset-pills'>
                        {ASSETS.map((a, i) => (
                            <div key={a} className={`free-bots__asset-pill ${a === s.currentAsset ? 'active' : s.assetIndex > i ? 'done' : ''}`}>
                                {ASSET_NAMES[a]}
                            </div>
                        ))}
                    </div>
                    <div className='free-bots__trade-counter'>
                        Trades: <span>{s.tradesOnAsset}</span> | Mart: <span>{s.martLevel}</span>/<span>{CFG_STEPS}</span>
                    </div>
                </div>

                <div className='free-bots__ticker' style={{ display: s.lastTickPrice !== null ? 'flex' : 'none' }}>
                    <span className='free-bots__ticker-sym'>{ASSET_NAMES[s.currentAsset]}</span>
                    <span className='free-bots__ticker-price'>{s.lastTickPrice?.toFixed(5) ?? '—'}</span>
                    <span className='free-bots__ticker-time'>{new Date().toLocaleTimeString()}</span>
                </div>

                <div className='free-bots__pattern-card'>
                    <div className='free-bots__pat-label'>Pattern</div>
                    <div className='free-bots__tick-boxes'>
                        {tickBoxes.map((v, i) => (
                            <div key={i} className={`free-bots__tick-box ${v === '—' ? 'slot' : v === '▲' ? 'rise' : 'fall'}`}>{v}</div>
                        ))}
                        <div className='free-bots__arrow-sep'>→</div>
                        <div className={`free-bots__tick-box ${s.isArmed ? 'armed' : 'slot'}`}>
                            {s.isArmed ? (s.entryProposalType === 'PUT' ? '▼' : '▲') : '?'}
                        </div>
                    </div>
                    <div className={`free-bots__signal-box ${signalClass}`}>{signal}</div>
                </div>

                <div className='free-bots__grid4'>
                    <div className='free-bots__card'>
                        <div className='free-bots__card-label'>Balance</div>
                        <div className='free-bots__card-value free-bots__card-value--accent'>${balance}</div>
                        <div className='free-bots__card-sub'>{currency}</div>
                    </div>
                    <div className='free-bots__card'>
                        <div className='free-bots__card-label'>P&L</div>
                        <div className={`free-bots__card-value ${s.sessionPnl > 0 ? 'green' : s.sessionPnl < 0 ? 'red' : ''}`}>{pnlStr}</div>
                        <div className='free-bots__progress-bar'>
                            <div className={`free-bots__progress-fill ${s.sessionPnl >= 0 ? 'pf-green' : 'pf-red'}`} style={{ width: Math.min(Math.abs(s.sessionPnl) / 50 * 100, 100) + '%' }} />
                        </div>
                    </div>
                    <div className='free-bots__card'>
                        <div className='free-bots__card-label'>Win Rate</div>
                        <div className={`free-bots__card-value ${wr >= 50 ? 'green' : 'red'}`}>{wr}%</div>
                        <div className='free-bots__card-sub'>{s.wins}W / {s.losses}L</div>
                        <div className='free-bots__progress-bar'><div className='free-bots__progress-fill pf-green' style={{ width: wr + '%' }} /></div>
                    </div>
                    <div className='free-bots__card'>
                        <div className='free-bots__card-label'>Trades</div>
                        <div className='free-bots__card-value free-bots__card-value--blue'>{s.totalTrades}</div>
                        <div className='free-bots__card-sub'>{s.patternsFound} patterns</div>
                    </div>
                </div>

                <div className='free-bots__grid3'>
                    <div className='free-bots__card'>
                        <div className='free-bots__card-label'>Stake</div>
                        <div className='free-bots__card-value free-bots__card-value--orange'>${s.currentStake.toFixed(2)}</div>
                        <div className='free-bots__card-sub'>Mart <span>{s.martLevel}</span> | Step <span>{s.entryStepCount}</span>/<span>{CFG_STEPS}</span></div>
                        <div className='free-bots__mart-dots'>
                            {Array.from({ length: CFG_STEPS + 1 }, (_, i) => (
                                <div key={i} className={`free-bots__mart-dot ${i <= s.martLevel && s.martLevel > 0 ? (s.martLevel >= CFG_STEPS && bState === 'scanning' ? 'carry' : 'active') : ''}`} />
                            ))}
                        </div>
                    </div>
                    <div className='free-bots__card'>
                        <div className='free-bots__card-label'>Best / Worst</div>
                        <div className='free-bots__bw-row'>
                            <div className='free-bots__card-value free-bots__card-value--green'>+${s.bestTrade.toFixed(2)}</div>
                            <div className='free-bots__bw-sep'>/</div>
                            <div className='free-bots__card-value free-bots__card-value--red'>${s.worstTrade.toFixed(2)}</div>
                        </div>
                    </div>
                    <div className='free-bots__card'>
                        <div className='free-bots__card-label'>Asset</div>
                        <div className='free-bots__card-value free-bots__card-value--accent'>{ASSET_NAMES[s.currentAsset]}</div>
                        <div className='free-bots__card-sub'>{isConnected ? 'Active' : 'Waiting…'}</div>
                    </div>
                </div>

                <div className='free-bots__settings-panel'>
                    <div className='free-bots__settings-title'>Config</div>
                    <div className='free-bots__settings-info'>
                        Stake: <span>${CFG_STAKE}</span> | Dur: <span>1 Tick</span> | Mart: <span>×{CFG_MART}</span> | Steps: <span>{CFG_STEPS}</span> | Assets: <span>V25 → V100</span>
                    </div>
                </div>

                <div className='free-bots__controls-panel'>
                    <div className='free-bots__controls-title'>Controls</div>
                    <div className='free-bots__btn-row'>
                        {bState === 'idle' ? (
                            <button className='free-bots__btn free-bots__btn--start' onClick={startBot} disabled={!isConnected}>
                                ▶ Start Bot
                            </button>
                        ) : (
                            <button className='free-bots__btn free-bots__btn--stop' onClick={stopBot}>
                                ■ Stop Bot
                            </button>
                        )}
                        <button className='free-bots__btn free-bots__btn--clear' onClick={() => { setTradeLog([]); setRotateLog([]); }}>
                            Clear Log
                        </button>
                        <button className='free-bots__btn free-bots__btn--reconnect' onClick={reconnect}>
                            ↻ Reconnect
                        </button>
                    </div>
                </div>

                <div className='free-bots__log-card'>
                    <div className='free-bots__log-header'>
                        <div className='free-bots__log-title'>Trade Log ({tradeLog.length})</div>
                        <button className='free-bots__log-clear' onClick={() => { setTradeLog([]); setRotateLog([]); }}>Clear</button>
                    </div>
                    {tradeLog.length > 0 && (
                        <div className='free-bots__log-cols'>
                            <span>Time</span><span>Asset</span><span>Type</span>
                            <span>Dir</span><span>Stake</span><span>P&L</span><span>Rslt</span>
                        </div>
                    )}
                    <div className='free-bots__log-body'>
                        {tradeLog.length === 0 && rotateLog.length === 0 ? (
                            <div className='free-bots__log-empty'>Connect and start to begin scanning…</div>
                        ) : (
                            <>
                                {rotateLog.map((r, i) => (
                                    <div key={'rot-' + i} className='free-bots__rotate-row'>{r.time} — {r.msg}</div>
                                ))}
                                {tradeLog.map((t, i) => (
                                    <div key={'tr-' + i} className='free-bots__trade-row'>
                                        <span className='free-bots__tr-time'>{t.time}</span>
                                        <span className='free-bots__tr-asset'>{t.asset}</span>
                                        <span className='free-bots__tr-signal'>{t.type}</span>
                                        <span className={`free-bots__tr-dir ${t.dir.includes('RISE') ? 'rise' : 'fall'}`}>{t.dir}</span>
                                        <span className='free-bots__tr-stake'>${t.stake.toFixed(2)}</span>
                                        <span className={`free-bots__tr-pnl ${t.win ? 'win' : 'loss'}`}>{(t.pnl >= 0 ? '+' : '') + '$' + Math.abs(t.pnl).toFixed(2)}</span>
                                        <span className={`free-bots__tr-badge ${t.win ? 'win' : 'loss'}`}>{t.win ? 'WIN' : 'LOSS'}</span>
                                    </div>
                                ))}
                            </>
                        )}
                    </div>
                </div>

                <div className='free-bots__status-msg'>
                    {statusMsg && <div className={`free-bots__status-text ${statusMsg.type}`}>▸ {statusMsg.text}</div>}
                </div>
            </div>

            <div className='free-bots__mobile-footer'>
                <div className='free-bots__mobile-footer-inner'>
                    {bState === 'idle' ? (
                        <button
                            className='free-bots__btn-start'
                            onClick={startBot}
                            disabled={!isConnected}
                        >
                            <span className='free-bots__btn-start-icon'>▶</span>
                            <span className='free-bots__btn-start-label'>Start Bot</span>
                        </button>
                    ) : (
                        <button
                            className='free-bots__btn-stop'
                            onClick={stopBot}
                        >
                            <span className='free-bots__btn-stop-icon'>■</span>
                            <span className='free-bots__btn-stop-label'>Stop Bot</span>
                        </button>
                    )}
                    <button className='free-bots__btn-mini' onClick={reconnect} title='Reconnect'>
                        ↻
                    </button>
                </div>
            </div>
        </div>
    );
};

export default FreeBots;
