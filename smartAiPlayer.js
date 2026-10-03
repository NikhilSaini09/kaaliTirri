// Fairness rule for every function in this file: a CPU only ever reads its OWN player.hand,
// plus purely public information - state.board, everyone's wonCards, revealed team status,
// and how many cards an opponent has left (a count, never contents). It never reads another
// player's real hand. Where this file needs to reason about opponents' likely cards (the
// endgame lookahead, the bidding estimate), it does so by SAMPLING plausible hands from the
// unseen-card pool - never by peeking at what's actually in anyone's hand.

// ---------------------------------------------------------------------------------------
// AI FLAGS - every newer piece of logic can be switched off here without touching the code.
// ---------------------------------------------------------------------------------------
const AI_FLAGS = {
    defenderInference: true,   // unknown seat that cannot hold any unplayed called card = certain defender
    sampledProbs: true,        // trick-win chance from sampled, constraint-consistent hands (top-level decisions)
    lastSeatRules: true,       // last seat: win as cheaply as possible only if worth it, feed when a teammate wins
    matePickup: true,          // dump (don't overtake) when a teammate behind will probably take the trick
    secureTeammateTrick: true, // take over a rich trick when the winning teammate is likely to be overtaken
    bidAwareness: true,        // contest more when the bid is slipping, play safe when comfortable
    seatAwareLeads: true,      // lead choice considers called cards, voids, ruff risk and suit shortness
    smartDiscards: true,       // void discards: shed short suits, keep K/Q guards
    endgameBidObjective: true, // endgame search maximises WINNING the bid (points only as tie-break)
    simTrumpChoice: true       // trump + partner calls chosen by simulation (needs the bid for best results)
};

// ---------------------------------------------------------------------------------------
// TRICK MEMORY
// Completed tricks, each player's known voids and the set of played cards are remembered in
// a WeakMap keyed by the state object.
// ---------------------------------------------------------------------------------------

const trickMemories = new WeakMap();

function cardCode(c) { return `${c.value}${c.suit}`; }

function newTrickMemory() {
    return {
        ids: [],           // player-id order this memory was built for, to detect a changed table
        tricks: [],        // [{ cards: [...n cards in play order], ordered: bool }]
        seenLen: {},       // playerId -> how many of their wonCards are already recorded
        anchor: {},        // playerId -> { value, suit } of their first won card (deal-change detector)
        voids: {},         // playerId -> Set of suits shown void in COMPLETED tricks
        played: new Set()  // card codes of every card in a completed trick
    };
}

function resetTrickMemory(mem, state) {
    mem.ids = state.players.map(p => p.id);
    mem.tricks = [];
    mem.seenLen = {};
    mem.anchor = {};
    mem.voids = {};
    mem.played = new Set();
    for (const p of state.players) { mem.voids[p.id] = new Set(); mem.seenLen[p.id] = 0; }
}

function addTrickToMemory(mem, cards, ordered) {
    mem.tricks.push({ cards: cards.slice(), ordered });
    const leadSuit = cards[0].suit;
    for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        mem.played.add(cardCode(c));
        if (i > 0 && c.suit !== leadSuit && c.playedBy) {
            if (!mem.voids[c.playedBy]) mem.voids[c.playedBy] = new Set();
            mem.voids[c.playedBy].add(leadSuit);
        }
    }
}

function syncTrickMemory(mem, state) {
    const players = state.players;
    const n = players.length;
    if (!n) return mem;

    let stale = mem.ids.length !== n;
    for (let i = 0; !stale && i < n; i++) {
        const p = players[i];
        if (mem.ids[i] !== p.id) { stale = true; break; }
        const won = p.wonCards || [];
        const seen = mem.seenLen[p.id] || 0;
        if (seen > won.length) { stale = true; break; }
        if (seen > 0) {
            const a = mem.anchor[p.id];
            if (!a || won[0].value !== a.value || won[0].suit !== a.suit) { stale = true; break; }
        }
    }
    if (stale) resetTrickMemory(mem, state);

    // Pick up whatever is new since the last look (usually nothing).
    let fresh = null;
    for (let i = 0; i < n; i++) {
        const p = players[i];
        const won = p.wonCards;
        if (!won) continue;
        let k = mem.seenLen[p.id] || 0;
        if (k + n > won.length) continue;
        if (k === 0) mem.anchor[p.id] = { value: won[0].value, suit: won[0].suit };
        if (!fresh) fresh = [];
        for (; k + n <= won.length; k += n) fresh.push(won.slice(k, k + n));
        mem.seenLen[p.id] = k;
    }
    if (fresh) {
        const ordered = fresh.length === 1;
        for (const cards of fresh) addTrickToMemory(mem, cards, ordered);
    }
    return mem;
}

function getTrickMemory(state) {
    let mem = trickMemories.get(state);
    if (!mem) {
        mem = newTrickMemory();
        resetTrickMemory(mem, state);
        trickMemories.set(state, mem);
    }
    return syncTrickMemory(mem, state);
}

/**
 * Hook for game.js: Catches the memory up first, then records this trick in exact order.
 */
function cpuObserveTrick(state, trickCards, winnerId) {
    if (!trickCards || trickCards.length === 0) return;
    const mem = getTrickMemory(state);
    addTrickToMemory(mem, trickCards, true);
    if (!(mem.seenLen[winnerId] > 0)) mem.anchor[winnerId] = { value: trickCards[0].value, suit: trickCards[0].suit };
    mem.seenLen[winnerId] = (mem.seenLen[winnerId] || 0) + trickCards.length;
}

// Copy of a state's memory for a synthetic (endgame) state that starts from the same history.
function seedTrickMemory(simState, realState) {
    const src = getTrickMemory(realState);
    const copy = newTrickMemory();
    copy.ids = src.ids.slice();
    copy.tricks = src.tricks.slice();
    copy.seenLen = { ...src.seenLen };
    copy.anchor = { ...src.anchor };
    copy.voids = {};
    Object.keys(src.voids).forEach(id => { copy.voids[id] = new Set(src.voids[id]); });
    copy.played = new Set(src.played);
    trickMemories.set(simState, copy);
}

function resolveTrickWinnerCard(trick, trumpSuit) {
    if (!trick || trick.length === 0) return null;
    const leadSuit = trick[0].suit;
    let winner = trick[0];
    for (let i = 1; i < trick.length; i++) {
        const c = trick[i];
        const isTrump = c.suit === trumpSuit;
        const winIsTrump = winner.suit === trumpSuit;
        if (isTrump && !winIsTrump) {
            winner = c;
        } else if ((isTrump && winIsTrump) || (!isTrump && !winIsTrump && c.suit === leadSuit)) {
            if (getCardRank(c) > getCardRank(winner)) winner = c;
        }
    }
    return winner;
}

function computeVoidMap(state) {
    const mem = getTrickMemory(state);
    const voidMap = {};
    state.players.forEach(p => { voidMap[p.id] = new Set(mem.voids[p.id] || []); });

    const board = state.board;
    if (board && board.length > 0) {
        const leadSuit = board[0].suit;
        for (let i = 1; i < board.length; i++) {
            const c = board[i];
            if (c.suit !== leadSuit && c.playedBy && voidMap[c.playedBy]) voidMap[c.playedBy].add(leadSuit);
        }
    }
    return voidMap;
}

// Weight for tricks whose position in the game is unknown (see syncTrickMemory).
const UNORDERED_AFFINITY_FACTOR = 1.5;

function computeTeamAffinity(state) {
    const affinity = {};
    state.players.forEach(p => { affinity[p.id] = 0; });
    const teamOf = {};
    state.players.forEach(p => { teamOf[p.id] = p.team; });
    let affinityFactor = 2.4;

    // Chronological order matters here: earlier tricks carry more weight.
    getTrickMemory(state).tricks.forEach(entry => {
        const trick = entry.cards;
        const leadSuit = trick[0].suit;
        const winnerCard = resolveTrickWinnerCard(trick, state.trumpSuit);
        if (!winnerCard) return;
        const winnerTeam = teamOf[winnerCard.playedBy];
        if (winnerTeam !== 'BIDDER_TEAM' && winnerTeam !== 'DEFENDER_TEAM') return;
        const weight = entry.ordered ? affinityFactor : UNORDERED_AFFINITY_FACTOR;
        const sign = winnerTeam === 'BIDDER_TEAM' ? weight : -weight;
        if (entry.ordered) affinityFactor -= 0.15;

        trick.forEach(c => {
            if (c === winnerCard) return;
            const pid = c.playedBy;
            if (!pid || teamOf[pid] !== 'UNKNOWN') return;
            const wasFree = c.suit !== leadSuit;
            const points = getCardPoints(c);
            if (wasFree && points > 0) {
                affinity[pid] = (affinity[pid] || 0) + sign * (points / 10);
            }
        });
    });

    return affinity;
}

const TEAM_AFFINITY_THRESHOLD = 3.5;
function guessTeam(playerId, state, affinity, beliefs) {
    const p = state.players.find(pl => pl.id === playerId);
    if (!p) return 'UNKNOWN';
    if (p.team !== 'UNKNOWN') return p.team;
    if (beliefs && beliefs[playerId] && beliefs[playerId].team !== 'UNKNOWN') return beliefs[playerId].team;
    const score = affinity ? (affinity[playerId] || 0) : 0;
    if (score >= TEAM_AFFINITY_THRESHOLD) return 'BIDDER_TEAM';
    if (score <= -TEAM_AFFINITY_THRESHOLD) return 'DEFENDER_TEAM';
    return 'UNKNOWN';
}

function determineMyTeam(playerId, state) {
    const player = state.players.find(p => p.id === playerId);
    if (!player) return 'UNKNOWN';
    if (player.team !== 'UNKNOWN') return player.team;

    const myCodes = new Set(player.hand.map(c => `${c.value}${c.suit}`));
    const everCalled = (state.calledCards && state.calledCards.length > 0)
        ? state.calledCards
        : (state.calledCards || []);
    if (everCalled.length === 0) return 'DEFENDER_TEAM';
    return everCalled.some(code => myCodes.has(code)) ? 'BIDDER_TEAM' : 'DEFENDER_TEAM';
}

// ---------------------------------------------------------------------------------------
// TEAM INFERENCE FROM THE PUBLIC CALLED CARDS
// The called partner cards are public. Every called card that has not been played yet (and is
// not in our hand or cut from the deck) sits in somebody else's hand. A player who has shown
// void in that card's suit, who holds no cards, or who is already revealed as a Defender cannot
// be its holder. So:
//   - exactly one possible holder left        -> that player is a CERTAIN partner
//   - an unknown player who cannot hold ANY unplayed called card -> a CERTAIN defender
//     (only applied once the bidder is marked as a bidder-team member - see isBidderAccountedFor -
//      otherwise the bidder itself would be mistaken for a defender)
//   - otherwise each card is split evenly over its remaining holders to give a per-player
//     chance of being a partner, which is sharper than one flat prior for every seat.
// Only public facts plus our own hand are read; opponents' hand SIZES, never contents.
// ---------------------------------------------------------------------------------------

function inferTeamBeliefs(playerId, state, voidMapIn) {
    const beliefs = {};
    const me = state.players.find(p => p.id === playerId);
    if (!me) return beliefs;
    const defenderOk = AI_FLAGS.defenderInference && isBidderAccountedFor(state);

    const mem = getTrickMemory(state);
    const voidMap = voidMapIn || computeVoidMap(state);
    const evicted = getEvictedCardSet(state.players.length);
    const myCodes = new Set(me.hand.map(cardCode));
    const boardCodes = new Set(state.board.map(cardCode));

    const calledLeft = (state.calledCards || []).filter(code =>
        !myCodes.has(code) && !evicted.has(code) && !mem.played.has(code) && !boardCodes.has(code));

    const others = state.players.filter(p => p.id !== playerId);
    const holders = calledLeft.map(code => {
        const suit = code.slice(-1);
        return others.filter(p =>
            p.hand.length > 0 &&
            p.team !== 'DEFENDER_TEAM' &&
            !(voidMap[p.id] && voidMap[p.id].has(suit)));
    });

    others.forEach(p => {
        if (p.team !== 'UNKNOWN') { beliefs[p.id] = { team: p.team, pBidder: p.team === 'BIDDER_TEAM' ? 1 : 0 }; return; }
        let pNone = 1, sole = false, canHoldAny = false;
        holders.forEach(h => {
            if (!h.some(x => x.id === p.id)) return;
            canHoldAny = true;
            if (h.length === 1) sole = true;
            pNone *= (1 - 1 / h.length);
        });
        if (sole) { beliefs[p.id] = { team: 'BIDDER_TEAM', pBidder: 1 }; return; }
        if (defenderOk && !canHoldAny) { beliefs[p.id] = { team: 'DEFENDER_TEAM', pBidder: 0 }; return; }
        beliefs[p.id] = { team: 'UNKNOWN', pBidder: 1 - pNone };
    });
    return beliefs;
}

// ---------------------------------------------------------------------------------------
// DECISION CONTEXT (cached)
// Everything a decision needs that only depends on public information plus the actor's own
// hand: void map, affinity, team beliefs, unseen cards, bid pressure and the sampled worlds.
// Cached per (state object, position) so one decision never recomputes it.
// ---------------------------------------------------------------------------------------

const ctxCache = new WeakMap();
const NEUTRAL_MOOD = { label: 'normal', contestShift: 0, feedShift: 0 };

function sumCardPoints(cards) {
    let t = 0;
    if (cards) for (const c of cards) t += getCardPoints(c);
    return t;
}

function totalAvailablePoints(numPlayers) {
    const ev = getEvictedCardSet(numPlayers);
    let t = 0;
    suits.forEach(s => values.forEach(v => {
        if (!ev.has(`${v}${s}`)) t += getCardPoints({ value: v, suit: s });
    }));
    return t;
}

// The defender inference is only valid when the bidder is already marked as a bidder-team
// member (otherwise the bidder itself would be "deduced" to be a defender).
function isBidderAccountedFor(state) {
    if (state.highestBid && state.highestBid.playerId) return true;
    if (state.players.some(p => p.team === 'BIDDER_TEAM')) return true;
    return ['bidWinnerId', 'bidderId', 'bidWinner', 'bidder', 'highestBidderId']
        .some(k => state[k] !== undefined && state[k] !== null);
}

// The winning bid. game.js may expose it under several names; __bid is what the simulations set.
function getBidAmount(state) {
    if (state.highestBid && typeof state.highestBid.amount === 'number' && state.highestBid.amount > 0) return state.highestBid.amount;
    if (typeof state.__bid === 'number') return state.__bid;
    const names = ['bidAmount', 'biddingAmount', 'currentBid', 'highestBid', 'winningBid', 'bidValue', 'bid', 'BIDDING_AMOUNT'];
    for (const k of names) if (typeof state[k] === 'number' && state[k] >= 100 && state[k] <= 250) return state[k];
    for (const k of Object.keys(state)) {
        if (/bid/i.test(k) && typeof state[k] === 'number' && state[k] >= 100 && state[k] <= 250) return state[k];
    }
    return null;
}

function getCtx(playerId, state) {
    const me = state.players.find(p => p.id === playerId);
    const mem = getTrickMemory(state);
    const key = [
        playerId, state.trumpSuit, state.board.map(cardCode).join(','), mem.played.size,
        me ? me.hand.map(cardCode).join(',') : '', (state.calledCards || []).join(','),
        state.players.map(p => (p.team || 'U').charAt(0) + p.hand.length).join('')
    ].join('|');
    const hit = ctxCache.get(state);
    if (hit && hit.key === key) return hit;

    const voidMap = computeVoidMap(state);
    const ctx = { key, playerId, me, voidMap, myTeam: determineMyTeam(playerId, state) };
    ctx.affinity = computeTeamAffinity(state);
    ctx.beliefs = inferTeamBeliefs(playerId, state, voidMap);
    ctx.unseen = listUnseenCards(state, me ? me.hand : []);
    ctx.bidderOk = isBidderAccountedFor(state);
    ctx.bid = getBidAmount(state);

    const evicted = getEvictedCardSet(state.players.length);
    const myCodes = new Set(me ? me.hand.map(cardCode) : []);
    const boardCodes = new Set(state.board.map(cardCode));
    ctx.calledLeft = (state.calledCards || []).filter(code =>
        !myCodes.has(code) && !evicted.has(code) && !mem.played.has(code) && !boardCodes.has(code));
    ctx.calledLeftSet = new Set(ctx.calledLeft);

    let othersCards = 0;
    state.players.forEach(p => { if (p.id !== playerId) othersCards += p.hand.length; });
    ctx.poolOk = ctx.unseen.length === othersCards;   // sampling only makes sense when the books balance

    ctx.mood = null; ctx.worlds = null; ctx.probCache = new Map();
    ctxCache.set(state, ctx);
    return ctx;
}

function certainTeamOf(ctx, state, id) {
    if (id === ctx.playerId) return ctx.myTeam;
    const p = state.players.find(x => x.id === id);
    if (p && p.team !== 'UNKNOWN') return p.team;
    const b = ctx.beliefs[id];
    return b ? b.team : 'UNKNOWN';
}

// ---------------------------------------------------------------------------------------
// PLAY FOR THE BID, NOT FOR POINTS
// The round is won or lost on the bid. Compare the points our side still NEEDS with the
// points still in play:
//   need / remaining >= 0.7  -> the bid is slipping for us: contest and feed more readily
//   need / remaining <= 0.3  -> comfortable: no need to take risks
//   need <= 0 or need > remaining -> already decided: play normally
// Points won by seats whose team is still unresolved are not counted for either side.
// ---------------------------------------------------------------------------------------
function getMood(ctx, state) {
    if (ctx.mood) return ctx.mood;
    ctx.mood = NEUTRAL_MOOD;
    if (ctx.bid == null || !ctx.me) return ctx.mood;

    const totalAvail = totalAvailablePoints(state.players.length);
    let bPts = 0, dPts = 0, all = 0;
    for (const p of state.players) {
        const pts = sumCardPoints(p.wonCards);
        all += pts;
        const t = certainTeamOf(ctx, state, p.id);
        if (t === 'BIDDER_TEAM') bPts += pts; else if (t === 'DEFENDER_TEAM') dPts += pts;
    }
    const remaining = totalAvail - all;
    if (remaining <= 0) return ctx.mood;
    const need = ctx.myTeam === 'BIDDER_TEAM' ? ctx.bid - bPts : (totalAvail - ctx.bid + 5) - dPts;
    if (need <= 0 || need > remaining) return ctx.mood;

    const ratio = need / remaining;
    if (ratio >= 0.7) ctx.mood = { label: 'push', contestShift: 0.10, feedShift: 0.04 };
    else if (ratio <= 0.3) ctx.mood = { label: 'safe', contestShift: -0.05, feedShift: -0.04 };
    return ctx.mood;
}

// ---------------------------------------------------------------------------------------
// SAMPLED WORLDS
// A "world" is one complete, consistent guess of everybody's hidden hand:
//   - each unplayed called card is placed with a player who could actually hold it (not a
//     known defender, not void in that suit), weighted by free slots
//   - the rest of the unseen cards are dealt respecting every known void and hand size
//   - a seat's team follows from what it holds: a called card means bidder team
//   - worlds are weighted by how well they fit the play-history affinity (soft evidence)
// This replaces the independence assumption of the analytic estimate: hands, teams and voids
// are correlated, and a sampled world keeps all of that consistent.
// ---------------------------------------------------------------------------------------

const WORLD_SAMPLES = 48;
const AFFINITY_WEIGHT = 0.35;

function dealWorld(ctx, state, playerId) {
    const others = state.players.filter(p => p.id !== playerId);
    const pool = ctx.unseen.slice();
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const used = new Array(pool.length).fill(false);
    const hands = {}, need = {};
    others.forEach(p => { hands[p.id] = []; need[p.id] = p.hand.length; });
    const knownDefender = p => p.team === 'DEFENDER_TEAM' || (ctx.beliefs[p.id] && ctx.beliefs[p.id].team === 'DEFENDER_TEAM');

    // 1. called cards go to players who can hold them
    for (const code of ctx.calledLeft) {
        const idx = pool.findIndex((c, i) => !used[i] && cardCode(c) === code);
        if (idx < 0) continue;
        const suit = pool[idx].suit;
        const elig = []; let total = 0;
        for (const p of others) {
            const free = need[p.id] - hands[p.id].length;
            if (free <= 0 || knownDefender(p) || ctx.voidMap[p.id].has(suit)) continue;
            elig.push([p, free]); total += free;
        }
        if (!elig.length) continue;
        let r = Math.random() * total, pick = elig[elig.length - 1][0];
        for (const [p, f] of elig) { r -= f; if (r <= 0) { pick = p; break; } }
        hands[pick.id].push(pool[idx]); used[idx] = true;
    }

    // 2. everything else, most constrained seats first
    const order = others.slice().sort((a, b) =>
        (ctx.voidMap[b.id].size - ctx.voidMap[a.id].size) || (Math.random() - 0.5));
    for (const p of order) {
        const voids = ctx.voidMap[p.id];
        for (let i = 0; i < pool.length && hands[p.id].length < need[p.id]; i++) {
            if (!used[i] && !voids.has(pool[i].suit)) { hands[p.id].push(pool[i]); used[i] = true; }
        }
    }
    // 3. voids left too few legal cards (rare): complete the sample anyway
    for (const p of order) {
        for (let i = 0; i < pool.length && hands[p.id].length < need[p.id]; i++) {
            if (!used[i]) { hands[p.id].push(pool[i]); used[i] = true; }
        }
    }

    // teams + weight
    const team = {}; let w = 1;
    for (const p of others) {
        if (p.team !== 'UNKNOWN') { team[p.id] = p.team; continue; }
        const holdsCalled = hands[p.id].some(c => ctx.calledLeftSet.has(cardCode(c)));
        team[p.id] = holdsCalled ? 'BIDDER_TEAM' : 'DEFENDER_TEAM';
        const e = AFFINITY_WEIGHT * (ctx.affinity[p.id] || 0) * (holdsCalled ? 1 : -1);
        w *= Math.exp(Math.max(-2.5, Math.min(2.5, e)));
    }
    team[playerId] = ctx.myTeam;
    return { hands, team, w };
}

function getWorlds(ctx, state) {
    if (!ctx.worlds) {
        ctx.worlds = [];
        for (let i = 0; i < WORLD_SAMPLES; i++) ctx.worlds.push(dealWorld(ctx, state, ctx.playerId));
    }
    return ctx.worlds;
}

// Does card c take the lead over winner card wc?
function cardBeats(c, wc, trump) {
    if (c.suit === wc.suit) return getCardRank(c) > getCardRank(wc);
    return c.suit === trump && wc.suit !== trump;
}

const MATE_RESCUE_VALUE = 0.88;   // a teammate behind overtaking an enemy is likely, not certain

function sampledTeamTrickProb(playerId, state, card, ctx) {
    const n = state.players.length;
    const meIdx = state.players.findIndex(p => p.id === playerId);
    const trump = state.trumpSuit;
    const board = [...state.board, { value: card.value, suit: card.suit, playedBy: playerId }];
    const leadSuit = board[0].suit;
    const remaining = [];
    for (let k = 1; board.length + remaining.length < n; k++) remaining.push(state.players[(meIdx + k) % n]);
    const baseWinner = resolveTrickWinnerCard(board, trump);
    const myTeam = ctx.myTeam;

    let sum = 0, wsum = 0;
    for (const world of getWorlds(ctx, state)) {
        let winner = baseWinner;
        let winTeam = winner.playedBy === playerId ? myTeam
            : (state.players.find(p => p.id === winner.playedBy).team !== 'UNKNOWN'
                ? state.players.find(p => p.id === winner.playedBy).team : world.team[winner.playedBy]);
        let rescued = false;
        for (const r of remaining) {
            const hand = world.hands[r.id];
            if (!hand || hand.length === 0) continue;
            const rTeam = r.team !== 'UNKNOWN' ? r.team : world.team[r.id];
            const wantsWin = rTeam !== myTeam || winTeam !== myTeam;
            if (!wantsWin) continue;
            const follow = hand.filter(c => c.suit === leadSuit);
            const legal = follow.length ? follow : hand;
            let best = null;
            for (const c of legal) {
                if (!cardBeats(c, winner, trump)) continue;
                if (!best || (c.suit === trump) < (best.suit === trump) ||
                    ((c.suit === trump) === (best.suit === trump) && getCardRank(c) < getCardRank(best))) best = c;
            }
            if (best) {
                winner = { value: best.value, suit: best.suit, playedBy: r.id };
                winTeam = rTeam;
                rescued = rTeam === myTeam;
            }
        }
        const res = winTeam === myTeam ? (rescued ? MATE_RESCUE_VALUE : 1) : 0;
        sum += world.w * res; wsum += world.w;
    }
    return wsum > 0 ? sum / wsum : 0;
}

// ---------------------------------------------------------------------------------------
// POSITION-AWARE "SURE WIN"
// True only if, whatever the seats still to act could hold, our team certainly ends up with
// the trick after `card` is played. Differences from the old check:
//   - certain teammates behind us are never threats; the actor itself is not a threat
//   - it judges the card ACTUALLY being played (it may become the winner)
//   - it knows the highest card still out in a suit (not just the Ace) from the unseen pool
//   - a seat that must follow suit (pigeonhole on hand size) cannot ruff; known voids and
//     exhausted trumps are used
// ---------------------------------------------------------------------------------------
function trickSecuredByCard(state, playerId, card, ctx) {
    const n = state.players.length;
    const meIdx = state.players.findIndex(p => p.id === playerId);
    const trump = state.trumpSuit;
    const board = [...state.board, { value: card.value, suit: card.suit, playedBy: playerId }];
    const leadSuit = board[0].suit;
    const winner = resolveTrickWinnerCard(board, trump);
    if (certainTeamOf(ctx, state, winner.playedBy) !== ctx.myTeam) return false;
    if (board.length >= n) return true;

    const wRank = getCardRank(winner);
    for (let k = 1; board.length + k - 1 < n; k++) {
        const r = state.players[(meIdx + k) % n];
        if (r.hand.length === 0) continue;
        if (certainTeamOf(ctx, state, r.id) === ctx.myTeam) continue;      // a teammate can't hurt us

        const voids = ctx.voidMap[r.id] || new Set();
        const pool = ctx.unseen.filter(c => !voids.has(c.suit));
        const h = Math.min(r.hand.length, pool.length);
        if (h === 0) continue;
        const nonLead = pool.filter(c => c.suit !== leadSuit).length;
        const mustFollow = !voids.has(leadSuit) && h > nonLead;            // can't be void in the lead suit
        const canBeVoid = !mustFollow;

        const higherSame = pool.some(c => c.suit === winner.suit && getCardRank(c) > wRank);
        if (higherSame && (winner.suit === leadSuit || canBeVoid)) return false;
        if (winner.suit !== trump && canBeVoid && pool.some(c => c.suit === trump)) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------------------
// KAALI TIRRI (3♠, 30 pts) GATE
// The 3♠ is worth 30 points, so it is only ever played voluntarily when our team is very
// likely to take the trick it lands in (or it's forced).
// ---------------------------------------------------------------------------------------

const KAALI_FEED_PROB = 0.92; // near-certain our team takes the trick -> actively cash the 30

function isKaali(card) {
    return !!card && card.value === '3' && card.suit === '♠';
}

// Minimum chance our team must have of taking the trick before we may *choose* 3♠ over
// another legal card. Relaxes as the hand shrinks, because the card has to go out eventually.
function kaaliPlayThreshold(handSize) {
    if (handSize >= 6) return 0.80;
    if (handSize >= 4) return 0.70;
    if (handSize >= 3) return 0.60;
    return 0.50;
}

function getLegalCards(player, state) {
    if (state.board.length > 0) {
        const leadSuit = state.board[0].suit;
        const follow = player.hand.filter(c => c.suit === leadSuit);
        if (follow.length > 0) return follow;
    }
    return [...player.hand];
}

// ---------------------------------------------------------------------------------------
// DETERMINISTIC TRUMP CONTROL
//
// If:
//   - we are void in the current lead suit,
//   - our teammate is currently winning,
//   - the lead suit is not trump,
//   - every opponent is PROVEN void in trump,
//   - teams are fully known,
//   - all remaining trumps therefore belong to our team,
//   - and remaining trumps == remaining tricks,
//
// then every remaining trick can be secured by spending exactly one team trump per trick.
// In this situation there is no reason to save the trump for later: doing so can allow a
// teammate to lead trump later and force multiple team trumps onto the same trick.
//
// Play the cheapest available trump immediately.
//
// This is intentionally deterministic and only fires when every condition is certain.
// ---------------------------------------------------------------------------------------

function getDeterministicTrumpControlCard(playerId, state) {
    if (!state || !state.board || state.board.length === 0) return null;
    if (!state.trumpSuit) return null;

    const player = state.players.find(p => p.id === playerId);
    if (!player || player.hand.length === 0) return null;

    const nPlayers = state.players.length;
    if (nPlayers < 2) return null;

    const leadSuit = state.board[0].suit;
    const trump = state.trumpSuit;

    // If trump itself is led, normal follow-suit rules already handle this case.
    if (leadSuit === trump) return null;

    // We must actually be void in the lead suit.
    if (player.hand.some(c => c.suit === leadSuit)) return null;

    // Determine the current trick winner using the exact same rules as the game.
    let winner = state.board[0];

    for (let i = 1; i < state.board.length; i++) {
        const c = state.board[i];

        const isTrump = c.suit === trump;
        const winnerIsTrump = winner.suit === trump;

        if (isTrump && !winnerIsTrump) {
            winner = c;
        } else if (
            (isTrump && winnerIsTrump) ||
            (!isTrump && !winnerIsTrump && c.suit === leadSuit)
        ) {
            if (getCardRank(c) > getCardRank(winner)) {
                winner = c;
            }
        }
    }

    // The current winner must be a teammate whose team is known with certainty.
    const myTeam = determineMyTeam(playerId, state);
    if (myTeam !== 'BIDDER_TEAM' && myTeam !== 'DEFENDER_TEAM') return null;

    const winnerPlayer = state.players.find(p => p.id === winner.playedBy);
    if (!winnerPlayer) return null;

    if (winnerPlayer.id === playerId) return null;
    if (winnerPlayer.team !== myTeam) return null;

    // All teams must be known. We do NOT use probabilistic team inference here.
    if (state.players.some(p =>
        p.id !== playerId &&
        p.team !== 'BIDDER_TEAM' &&
        p.team !== 'DEFENDER_TEAM'
    )) {
        return null;
    }

    // Obtain the public void map.
    const voidMap = computeVoidMap(state);

    // Every opponent must be PROVEN void in trump.
    const opponents = state.players.filter(p => p.team !== myTeam);

    if (opponents.length === 0) return null;

    const allOpponentsVoidInTrump = opponents.every(p =>
        voidMap[p.id] && voidMap[p.id].has(trump)
    );

    if (!allOpponentsVoidInTrump) return null;

    // Count all remaining trumps.
    // A card is no longer remaining if it was:
    //   - evicted from the deal,
    //   - played in a completed trick,
    //   - or is currently on the board.
    const mem = getTrickMemory(state);
    const playedCodes = mem.played;
    const boardCodes = new Set(state.board.map(cardCode));
    const evictedCodes = getEvictedCardSet(nPlayers);

    let remainingTrumpCount = 0;

    for (const value of values) {
        const code = `${value}${trump}`;

        if (
            evictedCodes.has(code) ||
            playedCodes.has(code) ||
            boardCodes.has(code)
        ) {
            continue;
        }

        remainingTrumpCount++;
    }

    // The player must actually have a trump to spend now.
    const trumpsInHand = player.hand.filter(c => c.suit === trump);
    if (trumpsInHand.length === 0) return null;

    // Number of tricks still to be played, including the current incomplete trick.
    //
    // Every unplayed card is currently either:
    //   - in someone's hand, or
    //   - on the board.
    //
    // With evenly dealt hands, ceil(total cards still in hands / players) gives
    // current trick + all future tricks.
    const cardsStillInHands = state.players.reduce(
        (total, p) => total + p.hand.length,
        0
    );

    const remainingTricks = Math.ceil(cardsStillInHands / nPlayers);

    // The key deterministic condition:
    // exactly one team trump is available for every remaining trick.
    if (remainingTrumpCount !== remainingTricks) return null;

    // Spend the cheapest trump now.
    trumpsInHand.sort((a, b) => getCardRank(a) - getCardRank(b));

    return trumpsInHand[0];
}

// P(at least one of K "marked" cards is among h cards drawn from a pool of U).
function probHoldsAny(h, U, K) {
    if (K <= 0 || h <= 0 || U <= 0) return 0;
    if (K >= U || U - K < h) return 1;
    let pNone = 1;
    for (let i = 0; i < h; i++) pNone *= (U - K - i) / (U - i);
    return 1 - pNone;
}

// Chance a given other player is on the OTHER team from `myTeam`.
function makeEnemyProbFn(playerId, state, myTeam) {
    const me = state.players.find(p => p.id === playerId);
    const ctx = getCtx(playerId, state);
    const affinity = ctx.affinity;
    const beliefs = ctx.beliefs;
    const myCodes = new Set(me.hand.map(c => `${c.value}${c.suit}`));
    const unknownOthers = state.players.filter(p => p.id !== playerId && p.team === 'UNKNOWN').length;
    const calledLeft = (state.calledCards || []).filter(code => !myCodes.has(code));
    const hiddenPartners = Math.min(calledLeft.length, unknownOthers);

    let prior = 0.5;
    if (unknownOthers > 0) {
        prior = myTeam === 'BIDDER_TEAM'
            ? 1 - hiddenPartners / unknownOthers
            : hiddenPartners / unknownOthers;
    }
    prior = Math.max(0.03, Math.min(0.97, prior));

    return (r) => {
        if (r.team !== 'UNKNOWN') return r.team === myTeam ? 0 : 1;
        const b = beliefs[r.id];
        if (b && b.team !== 'UNKNOWN') return b.team === myTeam ? 0 : 1;   // deduced for certain
        const g = guessTeam(r.id, state, affinity);                         // affinity only
        if (g !== 'UNKNOWN') return g === myTeam ? 0.15 : 0.85;
        if (b) {
            const pEnemy = myTeam === 'BIDDER_TEAM' ? 1 - b.pBidder : b.pBidder;
            return Math.max(0.03, Math.min(0.97, pEnemy));
        }
        return prior;
    };
}

/**
 * Analytic (independence-assumption) version. Probability that OUR TEAM ends up taking the current
 * trick if `playerId` plays `card` now. Assumes opponents beat the trick whenever they're able to (deliberately pessimistic).
 */
function estimateTeamTrickProbAnalytic(playerId, state, card) {
    const n = state.players.length;
    const meIdx = state.players.findIndex(p => p.id === playerId);
    if (meIdx === -1 || !state.trumpSuit) return 0;
    const me = state.players[meIdx];
    const trump = state.trumpSuit;
    const myTeam = determineMyTeam(playerId, state);

    const board = [...state.board, { value: card.value, suit: card.suit, playedBy: playerId }];
    const leadSuit = board[0].suit;
    const winnerCard = resolveTrickWinnerCard(board, trump);
    const wRank = getCardRank(winnerCard);

    const remaining = [];
    for (let k = 1; board.length + remaining.length < n; k++) {
        remaining.push(state.players[(meIdx + k) % n]);
    }

    const ctx = getCtx(playerId, state);
    const unseen = ctx.unseen;
    const voidMap = ctx.voidMap;
    const enemyProb = makeEnemyProbFn(playerId, state, myTeam, voidMap);

    const pBeat = (r) => {
        const voids = voidMap[r.id] || new Set();
        const pool = unseen.filter(c => !voids.has(c.suit));
        const U = pool.length;
        const h = Math.min(r.hand.length, U);
        if (h === 0) return 0;
        const count = (pred) => { let t = 0; for (const c of pool) if (pred(c)) t++; return t; };

        const pVoidLead = 1 - probHoldsAny(h, U, count(c => c.suit === leadSuit));
        const higherTrump = count(c => c.suit === trump && getCardRank(c) > wRank);

        if (leadSuit === trump) return probHoldsAny(h, U, higherTrump);
        if (winnerCard.suit === trump) return pVoidLead * probHoldsAny(h, U, higherTrump);

        const pHigher = probHoldsAny(h, U, count(c => c.suit === leadSuit && getCardRank(c) > wRank));
        const pRuff = pVoidLead * probHoldsAny(h, U, count(c => c.suit === trump));
        return 1 - (1 - pHigher) * (1 - pRuff);
    };

    let enemiesFail = 1; // chance no remaining enemy beats the current winner
    let matesFail = 1;   // chance no remaining teammate beats the current winner
    remaining.forEach(r => {
        const q = enemyProb(r);
        const pb = pBeat(r);
        enemiesFail *= (1 - q * pb);
        matesFail *= (1 - (1 - q) * pb);
    });

    if (winnerCard.playedBy === playerId) return enemiesFail;

    const winner = state.players.find(p => p.id === winnerCard.playedBy);
    const pWinnerOurs = winner ? 1 - enemyProb(winner) : 0.5;
    // If an enemy holds the trick right now we still win it when a teammate later beats them.
    return pWinnerOurs * enemiesFail + (1 - pWinnerOurs) * (1 - matesFail) * 0.8;
}

/**
 * Probability that OUR TEAM takes the current trick if `playerId` plays `card` now.
 * Top-level decisions use sampled, constraint-consistent worlds; inside simulations (and
 * whenever the books don't balance) the cheaper analytic estimate is used.
 */
function estimateTeamTrickProb(playerId, state, card) {
    if (!state.trumpSuit) return 0;
    const meIdx = state.players.findIndex(p => p.id === playerId);
    if (meIdx === -1) return 0;
    if (AI_FLAGS.sampledProbs && !state.__sim) {
        const ctx = getCtx(playerId, state);
        if (ctx.bidderOk && ctx.poolOk) {
            const code = cardCode(card);
            let v = ctx.probCache.get(code);
            if (v === undefined) {
                v = sampledTeamTrickProb(playerId, state, card, ctx);
                ctx.probCache.set(code, v);
            }
            return v;
        }
    }
    return estimateTeamTrickProbAnalytic(playerId, state, card);
}

/**
 * Applies the 3♠ rule to a list of legal cards:
 *  - near-certain our team takes the trick  -> [3♠] (cash the 30 points)
 *  - decent chance (threshold relaxes late) -> leave 3♠ as an option
 *  - otherwise                              -> 3♠ removed (unless it's the only legal card)
 */
function gateKaaliCandidates(playerId, state, legal) {
    if (legal.length <= 1) return legal;
    const kaali = legal.find(isKaali);
    if (!kaali) return legal;
    const me = state.players.find(p => p.id === playerId);
    const p = estimateTeamTrickProb(playerId, state, kaali);
    if (p >= KAALI_FEED_PROB) return [kaali];
    if (p >= kaaliPlayThreshold(me.hand.length)) return legal;
    return legal.filter(c => !isKaali(c));
}

// Public entry point. The AI is large and heuristic-heavy; if anything in it throws, the table
// must still get a legal move, so fall back to a random legal card and log what happened.
function getBestCardToPlay(playerId, state) {
    try {
        return getBestCardToPlayCore(playerId, state);
    } catch (e) {
        console.error('[ai] getBestCardToPlay failed for ' + playerId + '; falling back to a random legal card.', e);
        try {
            const player = state.players.find(p => p.id === playerId);
            if (!player || player.hand.length === 0) return null;
            const legal = getLegalCards(player, state);
            return legal[Math.floor(Math.random() * legal.length)] || null;
        } catch (e2) {
            console.error('[ai] The random-card fallback failed too:', e2);
            return null;
        }
    }
}

function getBestCardToPlayCore(playerId, state) {
    const player = state.players.find(p => p.id === playerId);
    if (!player || player.hand.length === 0) return null;
    getTrickMemory(state);

    const trumpControlCard = getDeterministicTrumpControlCard(playerId, state);
    if (trumpControlCard) return trumpControlCard;

    if (player.hand.length <= ENDGAME_SEARCH_MAX_HAND && state.board.length < state.players.length) {
        try {
            const legal = getLegalCards(player, state);
            if (legal.length > 1) {
                const candidates = gateKaaliCandidates(playerId, state, legal);
                if (candidates.length === 1) return candidates[0];
                const choice = getBestCardToPlayEndgame(playerId, state, candidates);
                if (choice) return choice;
            }
        } catch (e) {
            console.error('[ai] Endgame search failed; using the standard heuristic instead.', e);
        }
    }

    let choice = getBestCardToPlayInner(playerId, state);
    return choice || player.hand[0];
}

function getBestCardToPlayInner(playerId, state) {
    const player = state.players.find(p => p.id === playerId);
    if (!player || player.hand.length === 0) return null;
    getTrickMemory(state);

    const trumpControlCard = getDeterministicTrumpControlCard(playerId, state);
    if (trumpControlCard) return trumpControlCard;

    const legal = getLegalCards(player, state);
    if (legal.length === 1) return legal[0];

    const candidates = gateKaaliCandidates(playerId, state, legal);
    if (candidates.length === 1) return candidates[0];

    const excludeKaali = legal.some(isKaali) && !candidates.some(isKaali);
    return chooseCardHeuristic(playerId, state, excludeKaali);
}

// ---------------------------------------------------------------------------------------
// TOP-CARD DISCIPLINE
// The highest card still out in a suit (usually its Ace) wins its own trick sooner or later, so
// it shouldn't be spent where it earns nothing:
//   - leading it into a suit nobody has played yet only makes everyone follow with zero-point
//     cards (the points are still safely hidden in their hands), and
//   - feeding it to a teammate moves points that were coming home anyway.
// Both change once the suit has been played for a while: players start running out of it, so
// point cards get forced out - and the top card risks being ruffed, so it's time to use it.
// ---------------------------------------------------------------------------------------

const SMALL_TABLE_MAX_PLAYERS = 6;   // with more players, suits thin out fast enough to lead aces freely
const LEAD_ACE_MIN_ROUNDS = 1;       // an Ace may be led once its suit has already been led this many times
const FEED_TOP_CARD_MIN_ROUNDS = 2;  // a top card may be fed to a teammate once its suit has been led this often

// How many completed tricks were led in `suit`.
function suitRoundsLed(state, suit) {
    let rounds = 0;
    for (const t of getTrickMemory(state).tricks) {
        if (t.cards[0].suit === suit) rounds++;
    }
    return rounds;
}

// True when the suit has been played enough (or someone has already shown void in it) that the
// players still holding it are running short - i.e. a top card in it is no longer a sure homecomer.
function suitIsMature(state, suit, playerId, voidMap, minRounds) {
    if (suitRoundsLed(state, suit) >= minRounds) return true;
    return state.players.some(p => p.id !== playerId && p.hand.length > 0 &&
        (voidMap[p.id] || new Set()).has(suit));
}

// Leading a lone Ace into a fresh suit at a small table: nobody has to give up a point card yet.
// Holding the King as well makes it worthwhile (the pair keeps winning), as does a suit that has
// already been led.
function isPrematureAceLead(card, player, state) {
    if (state.players.length > SMALL_TABLE_MAX_PLAYERS) return false;
    if (card.value !== 'A') return false;
    if (suitRoundsLed(state, card.suit) >= LEAD_ACE_MIN_ROUNDS) return false;
    return !player.hand.some(c => c.suit === card.suit && c.value === 'K');
}

function isTrickWinGuaranteed(state, currentWinnerCard, voidMap) {
    if (!currentWinnerCard) return false;
    // +1 accounts for the card the current player is about to drop
    const cardsPlayedSoFar = state.board.length + 1; 
    if (cardsPlayedSoFar >= state.players.length) return true;

    const leadSuit = state.board[0].suit;
    const trumpSuit = state.trumpSuit;
    const isWinnerTrump = currentWinnerCard.suit === trumpSuit;
    const winnerRank = getCardRank(currentWinnerCard);

    // Find players who haven't played yet this trick
    const playedPlayerIds = new Set(state.board.map(c => c.playedBy));
    const pendingPlayers = state.players.filter(p => !playedPlayerIds.has(p.id));

    for (const opp of pendingPlayers) {
        const oppVoids = voidMap[opp.id] || new Set();
        
        // If current winner isn't trump, an opponent void in the lead suit might ruff it
        if (!isWinnerTrump) {
            if (oppVoids.has(leadSuit) && !oppVoids.has(trumpSuit)) return false;
        }
        // If opponent hasn't shown void in the winning suit, and the winner isn't the Ace
        if (!oppVoids.has(currentWinnerCard.suit) && winnerRank < values.length - 1) {
            return false;
        }
    }
    return true;
}

// Feeding thresholds: the chance our team takes the trick must clear these for the card ACTUALLY
// being fed. A provably secured trick needs no probability at all.
const FEED_PROB_5 = 0.66;
const FEED_PROB_10 = 0.72;

function chooseCardHeuristic(playerId, state, excludeKaali) {
    const player = state.players.find(p => p.id === playerId);
    if (!player || player.hand.length === 0) return null;

    // 1. DEDUCE GAME CONTEXT & VALID MOVES
    let validCards = [...player.hand];
    let hasLead = false;
    let leadSuit = null;

    if (state.board.length > 0) {
        leadSuit = state.board[0].suit;
        hasLead = player.hand.some(c => c.suit === leadSuit);
        if (hasLead) validCards = player.hand.filter(c => c.suit === leadSuit);
    }

    if (excludeKaali) {
        const rest = validCards.filter(c => !isKaali(c));
        if (rest.length > 0) validCards = rest;
    }

    if (validCards.length === 1) return validCards[0];

    const ctx = getCtx(playerId, state);
    const voidMap = ctx.voidMap;
    const trump = state.trumpSuit;
    const nPlayers = state.players.length;
    const lastSeat = state.board.length > 0 && state.board.length + 1 === nPlayers;
    const mood = AI_FLAGS.bidAwareness ? getMood(ctx, state) : NEUTRAL_MOOD;

    // 2. CARD COUNTING
    const playedCodes = getTrickMemory(state).played;
    const boardCodes = new Set(state.board.map(cardCode));

    const evictedCodes = getEvictedCardSet(nPlayers);
    const isBoss = (card) => {
        const rankIdx = getCardRank(card);
        for (let r = rankIdx + 1; r < values.length; r++) {
            const higherVal = values[r];
            const code = `${higherVal}${card.suit}`;
            const isPlayed = evictedCodes.has(code) || playedCodes.has(code) || boardCodes.has(code);
            const inHand = player.hand.some(hc => hc.value === higherVal && hc.suit === card.suit);
            if (!isPlayed && !inHand) return false; // Someone else still holds a higher card
        }
        return true;
    };

    // A top card of a suit that is still fresh will come home by itself: don't feed it away.
    const keepForHome = (card) =>
        isBoss(card) && !suitIsMature(state, card.suit, playerId, voidMap, FEED_TOP_CARD_MIN_ROUNDS);

    // 3. TEAM ALLIANCE (certain, from our own hand vs. the full call list) + deductions
    const myTrueTeam = ctx.myTeam;
    const beliefs = ctx.beliefs;

    // 4. ANALYZE CURRENT BOARD
    let currentWinnerCard = null;
    let currentWinnerId = null;
    let isTeammateWinning = false;
    let trickPoints = 0;

    if (state.board.length > 0) {
        currentWinnerCard = state.board[0];
        trickPoints += getCardPoints(currentWinnerCard);

        for (let i = 1; i < state.board.length; i++) {
            const c = state.board[i];
            trickPoints += getCardPoints(c);
            const isTrump = c.suit === trump;
            const winIsTrump = currentWinnerCard.suit === trump;

            if (isTrump && !winIsTrump) {
                currentWinnerCard = c;
            } else if ((isTrump && winIsTrump) || (!isTrump && !winIsTrump && c.suit === leadSuit)) {
                if (getCardRank(c) > getCardRank(currentWinnerCard)) currentWinnerCard = c;
            }
        }

        currentWinnerId = currentWinnerCard.playedBy;
        if (currentWinnerId === playerId) {
            isTeammateWinning = true;
        } else {
            const effectiveWinnerTeam = guessTeam(currentWinnerId, state, ctx.affinity, beliefs);
            if (effectiveWinnerTeam !== 'UNKNOWN' && effectiveWinnerTeam === myTrueTeam) {
                isTeammateWinning = true;
            }
        }
    }

    const isTeammateWinGuaranteed = isTeammateWinning && isTrickWinGuaranteed(state, currentWinnerCard, voidMap);
    const kaaliOnBoard = state.board.some(isKaali);
    const mustRescueKaali = kaaliOnBoard && !isTeammateWinGuaranteed;

    // ----- shared helpers -------------------------------------------------------------
    const prob = (c) => estimateTeamTrickProb(playerId, state, c);
    const secured = (c) => trickSecuredByCard(state, playerId, c, ctx);
    const byPointsThenRankAsc = (a, b) => (getCardPoints(a) - getCardPoints(b)) || (getCardRank(a) - getCardRank(b));
    const byRankAsc = (a, b) => getCardRank(a) - getCardRank(b);

    const feedProbFor = (c) => {
        if (isKaali(c)) return KAALI_FEED_PROB;
        const base = getCardPoints(c) >= 10 ? FEED_PROB_10 : FEED_PROB_5;
        return Math.max(0.55, Math.min(0.97, base - mood.feedShift));
    };

    // Highest-value point card that is safe to feed - judged on the card actually played.
    const pickFeed = (cards, secureOnly) => {
        const sorted = cards.filter(c => getCardPoints(c) > 0)
            .sort((a, b) => (getCardPoints(b) - getCardPoints(a)) || byRankAsc(a, b));
        for (const c of sorted) {
            if (secured(c)) return c;
            if (!secureOnly && prob(c) >= feedProbFor(c)) return c;
        }
        return null;
    };

    // Discarding when we cannot / will not win the trick: shed short suits (creates ruffing
    // chances and frees us from following with points), keep small guards for our K/Q.
    const suitLen = {};
    player.hand.forEach(c => { suitLen[c.suit] = (suitLen[c.suit] || 0) + 1; });
    const hasHonor = (s) => player.hand.some(c => c.suit === s && (c.value === 'K' || c.value === 'Q'));
    const discardScore = (c) => {
        let s = -10 * getCardPoints(c);
        const len = suitLen[c.suit] || 1;
        s += 4 * (4 - Math.min(len, 4));
        if (len <= 2 && hasHonor(c.suit) && c.value !== 'K' && c.value !== 'Q') s -= 12;  // guard of our own honor
        if (isBoss(c)) s -= 8;
        s -= 0.3 * getCardRank(c);
        return s;
    };
    const smartDiscard = (cards) => {
        const zero = cards.filter(c => getCardPoints(c) === 0);
        const pool = zero.length ? zero : cards;
        if (!AI_FLAGS.smartDiscards) {
            if (zero.length) return zero.slice().sort((a, b) => getCardRank(b) - getCardRank(a))[0];
            return cards.slice().sort((a, b) => getCardPoints(a) - getCardPoints(b))[0];
        }
        return pool.slice().sort((a, b) => discardScore(b) - discardScore(a))[0];
    };

    // --- STRATEGY SCENARIO 1: LEADING THE TRICK ---
    if (state.board.length === 0) {
        const others = state.players.filter(p => p.id !== playerId && p.hand.length > 0);

        const unseenTrumpExists = ctx.unseen.some(c => c.suit === trump);
        const canRuff = p =>
            p.hand.length > 0 &&
            certainTeamOf(ctx, state, p.id) !== myTrueTeam &&        // certain teammates can't hurt us
            !(voidMap[p.id] || new Set()).has(trump) &&              // proven void in trump = can't ruff
            unseenTrumpExists;                                       // no trump left out there = nobody can ruff
        const nobodyCanRuff = !others.some(canRuff);

        const guaranteedSuits = suits.filter(s =>
            s !== trump && nobodyCanRuff && others.length > 0 &&
            others.every(p => (voidMap[p.id] || new Set()).has(s)) &&
            validCards.some(c => c.suit === s));
        if (guaranteedSuits.length > 0) {
            const safeCards = validCards.filter(c => guaranteedSuits.includes(c.suit));
            return safeCards.sort((a, b) => {
                if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(a) - getCardPoints(b);
                return getCardRank(a) - getCardRank(b);
            })[0];
        }

        const enemiesHaveNoTrump = others.every(p => {
            const effectiveTeam = p.team !== 'UNKNOWN' ? p.team : guessTeam(p.id, state, ctx.affinity, beliefs);
            if (effectiveTeam === myTrueTeam) return true; // Ignore teammates
            return (voidMap[p.id] || new Set()).has(trump);
        });

        // Priority 1: play a Boss card (Guaranteed trick win without wasting trump)
        let thischanceBosses = validCards.filter(c => isBoss(c) && !isPrematureAceLead(c, player, state));
        if (thischanceBosses.length > 0) {
            return thischanceBosses.sort((a, b) => {
                const aIsTrump = a.suit === trump;
                const bIsTrump = b.suit === trump;
                if (aIsTrump !== bIsTrump) {
                    if (enemiesHaveNoTrump) return aIsTrump ? 1 : -1;
                    return aIsTrump ? -1 : 1;
                }
                return getCardPoints(b) - getCardPoints(a);
            })[0];
        }

        // Priority 2: play a card with a high chance of taking the trick
        let highWinCards = [];
        for (let c of validCards) {
            if (isPrematureAceLead(c, player, state)) continue;
            if (prob(c) >= 0.82) highWinCards.push(c);
        }
        if (highWinCards.length > 0) {
            return highWinCards.sort((a, b) => {
                if (a.suit === trump && b.suit !== trump) return 1;
                if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(b) - getCardPoints(a);
                return getCardRank(b) - getCardRank(a);
            })[0];
        }

        // Priority 3: bleed a worthless non-trump card. With seat awareness the choice looks at
        // who sits behind us, the called cards (public), ruff risk and which suit to shorten.
        const trash = validCards.filter(c => c.suit !== trump && getCardPoints(c) === 0);
        if (trash.length > 0) {
            if (!AI_FLAGS.seatAwareLeads) return trash.sort(byRankAsc)[0];

            const lowestPerSuit = {};
            trash.forEach(c => {
                if (!lowestPerSuit[c.suit] || getCardRank(c) < getCardRank(lowestPerSuit[c.suit])) lowestPerSuit[c.suit] = c;
            });
            const calledAdjust = (c) => {
                const called = ctx.calledLeft.filter(code => code.slice(-1) === c.suit);
                if (!called.length) return 0;
                const someoneCanHold = state.players.some(p => p.id !== playerId && p.hand.length > 0 &&
                    p.team !== 'DEFENDER_TEAM' && !(voidMap[p.id] && voidMap[p.id].has(c.suit)));
                if (!someoneCanHold) return 0;
                if (myTrueTeam === 'BIDDER_TEAM') return 0.10;   // flush the partner's called card out under our lead
                const topCalled = called.some(code => getCardRank({ value: code.slice(0, -1) }) > getCardRank(c));
                return topCalled ? -0.12 : 0;                    // don't hand the called top card a free trick
            };
            let best = null, bestScore = -Infinity;
            Object.values(lowestPerSuit).forEach(c => {
                const len = suitLen[c.suit] || 1;
                let score = prob(c) + calledAdjust(c);
                score += 0.04 * (4 - Math.min(len, 4));                             // shorten short suits
                if (len <= 2 && hasHonor(c.suit)) score -= 0.10;                    // don't strip our own K/Q
                score -= 0.004 * getCardRank(c);
                if (score > bestScore) { bestScore = score; best = c; }
            });
            if (best) return best;
            return trash.sort(byRankAsc)[0];
        }

        // Priority 4: Forced to play trump or point cards; play the lowest rank
        return validCards.sort(byRankAsc)[0];
    }

    // --- STRATEGY SCENARIO 2: MUST FOLLOW SUIT ---
    if (hasLead) {
        const dumpPool = (() => { const nk = validCards.filter(c => !isKaali(c)); return nk.length ? nk : validCards; })();
        const dumpCard = dumpPool.slice().sort(byPointsThenRankAsc)[0];

        if (mustRescueKaali) {
            let winningCards = validCards.filter(c => {
                if (currentWinnerCard && currentWinnerCard.suit === trump && leadSuit !== trump) return false;
                return currentWinnerCard ? getCardRank(c) > getCardRank(currentWinnerCard) : true;
            });
            if (winningCards.length > 0) {
                return winningCards.sort((a, b) => getCardRank(b) - getCardRank(a))[0];
            }
        }

        if (isTeammateWinning) {
            const feed = pickFeed(validCards.filter(c => !keepForHome(c)), false);
            if (feed) return feed;

            // Our winning teammate is likely to be overtaken and the trick is rich: take it over.
            if (AI_FLAGS.secureTeammateTrick && !lastSeat && trickPoints >= 10 && currentWinnerId !== playerId) {
                const pDuck = prob(dumpCard);
                if (pDuck < 0.6) {
                    const over = validCards.filter(c => !isKaali(c) && cardBeats(c, currentWinnerCard, trump));
                    let bestP = -1;
                    over.forEach(c => { bestP = Math.max(bestP, prob(c)); });
                    if (over.length && bestP >= pDuck + 0.2) {
                        return over.filter(c => prob(c) >= bestP - 0.05).sort(byRankAsc)[0];
                    }
                }
            }
            return dumpCard;
        } else {
            // Enemy/Unknown is winning
            const winningCards = validCards.filter(c => {
                if (currentWinnerCard.suit === trump && leadSuit !== trump) return false;
                return getCardRank(c) > getCardRank(currentWinnerCard);
            });

            if (winningCards.length > 0) {
                if (lastSeat) {
                    // Outcome is certain: win as cheaply as possible, unless it only burns a fresh top card for nothing.
                    const cheapest = winningCards.slice().sort(byRankAsc)[0];
                    const waste = AI_FLAGS.lastSeatRules && trickPoints === 0 && isBoss(cheapest) && keepForHome(cheapest);
                    if (!waste) return cheapest;
                } else {
                    let bestProb = -1;
                    for (let c of winningCards) bestProb = Math.max(bestProb, prob(c));
                    const winThr = Math.max(0.35, Math.min(0.7, 0.55 - mood.contestShift));

                    if (bestProb >= winThr) {
                        const viable = winningCards.filter(c => prob(c) >= bestProb - 0.05);
                        const winCard = viable.sort(byRankAsc)[0];
                        // A teammate behind can pick it up: keep the high card, just dump.
                        if (AI_FLAGS.matePickup && trickPoints > 0) {
                            const pD = prob(dumpCard);
                            if (pD >= 0.85 && pD >= bestProb - 0.05) return dumpCard;
                        }
                        return winCard;
                    }
                }
            }
            return dumpCard;
        }
    }

    // --- STRATEGY SCENARIO 3: VOID IN LEAD SUIT (Can Trump or Discard) ---
    const trumps = validCards.filter(c => c.suit === trump);
    const nonTrumps = validCards.filter(c => c.suit !== trump);

    if (mustRescueKaali && trumps.length > 0) {
        let winningTrumps = trumps.filter(c => {
            if (currentWinnerCard && currentWinnerCard.suit === trump) return getCardRank(c) > getCardRank(currentWinnerCard);
            return true;
        });

        if (winningTrumps.length > 0) {
            const roundsLed = suitRoundsLed(state, leadSuit);
            if (roundsLed === 0) {
                return winningTrumps.sort((a, b) => getCardRank(a) - getCardRank(b))[0];
            } else {
                return winningTrumps.sort((a, b) => getCardRank(b) - getCardRank(a))[0];
            }
        }
    }
    if (isTeammateWinning) {
        // Feed non-trump points first; a point-bearing trump only when the trick is provably ours.
        let feed = pickFeed(nonTrumps.filter(c => !keepForHome(c)), false);
        if (!feed) feed = pickFeed(trumps.filter(c => !keepForHome(c)), true);
        if (feed) return feed;

        if (nonTrumps.length > 0) return smartDiscard(nonTrumps);
        return trumps.sort(byRankAsc)[0];
    } else {
        // Enemy is winning. Should we trump it?
        const winningTrumps = trumps.filter(c => {
            if (currentWinnerCard.suit === trump) return getCardRank(c) > getCardRank(currentWinnerCard);
            return true;
        });
        const dump = nonTrumps.length > 0 ? smartDiscard(nonTrumps) : null;

        if (winningTrumps.length > 0) {
            let bestProb = -1;
            for (let c of winningTrumps) bestProb = Math.max(bestProb, prob(c));
            const thr = Math.max(0.3, Math.min(0.6, 0.45 - mood.contestShift));

            if (lastSeat || bestProb >= thr) {
                const viable = winningTrumps.filter(c => prob(c) >= bestProb - 0.05);
                const cheapest = viable.sort(byRankAsc)[0];
                const cheapTrump = getCardRank(cheapest) <= getCardRank({ value: '8' });
                // Worth a trump? Rich tricks yes; a small trump for a small trick yes; never a big
                // trump on a worthless trick.
                const pointsSaved = dump ? getCardPoints(dump) : 0;
                const effectiveTrickPoints = trickPoints + pointsSaved;

                const worth = effectiveTrickPoints >= 10
                    || (effectiveTrickPoints >= 5 && (getCardPoints(cheapest) === 0 || bestProb >= 0.8))
                    || (getCardPoints(cheapest) === 0 && cheapTrump && bestProb >= 0.8)
                    || (bestProb > 0.95 && dump && getCardPoints(dump) > 0);
                if (worth) {
                    if (AI_FLAGS.matePickup && !lastSeat && dump && trickPoints > 0) {
                        const pD = prob(dump);
                        if (pD >= 0.85 && pD >= bestProb - 0.05) return dump;
                    }
                    return cheapest;
                }
            }
        }

        // Refuse to waste a high trump on a poor trick, or we simply have no trumps. Discard.
        if (dump) return dump;

        // Absolutely forced to play a trump on a lost trick
        return validCards.sort(byRankAsc)[0];
    }
}

// ---------------------------------------------------------------------------------------
// Pure simulation engine - builds self-contained synthetic states shaped exactly like the
// real one, then reuses getBestCardToPlayInner as the "brain" for every seat during a
// rollout. Nothing here ever touches or mutates the real gameState.
// ---------------------------------------------------------------------------------------

function simPlayCard(sim, playerId, card) {
    const player = sim.players.find(p => p.id === playerId);
    if (!player) return;
    const idx = player.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
    if (idx === -1) return;
    const [played] = player.hand.splice(idx, 1);
    played.playedBy = playerId;
    sim.board.push(played);

    const code = `${played.value}${played.suit}`;
    if (sim.calledCards.includes(code)) {
        player.team = 'BIDDER_TEAM';
        sim.calledCards = sim.calledCards.filter(c => c !== code);
        if (sim.calledCards.length === 0) {
            sim.players.forEach(p => { if (p.team === 'UNKNOWN') p.team = 'DEFENDER_TEAM'; });
        }
    }

    if (sim.board.length === sim.players.length) {
        const winnerCard = resolveTrickWinnerCard(sim.board, sim.trumpSuit);
        const winner = sim.players.find(p => p.id === winnerCard.playedBy);
        const trickPoints = sim.board.reduce((s, c) => s + getCardPoints(c), 0);
        cpuObserveTrick(sim, sim.board, winner.id);
        winner.points += trickPoints;
        winner.wonCards.push(...sim.board);
        sim.board = [];
        sim.turnIndex = sim.players.findIndex(p => p.id === winner.id);
    } else {
        sim.turnIndex = (sim.turnIndex + 1) % sim.players.length;
    }
}

/** Plays a synthetic state forward to completion, every seat choosing via the same shared
 *  heuristic. `guard` just protects against an unforeseen infinite loop from a bad sample. */
function runPlayout(sim) {
    let guard = 0;
    const maxSteps = sim.players.length * 14;
    while (sim.players.some(p => p.hand.length > 0) && guard < maxSteps) {
        guard++;
        const actor = sim.players[sim.turnIndex];
        if (!actor || actor.hand.length === 0) {
            sim.turnIndex = (sim.turnIndex + 1) % sim.players.length;
            continue;
        }
        const card = getBestCardToPlayInner(actor.id, sim) || actor.hand[0];
        simPlayCard(sim, actor.id, card);
    }
    return sim;
}

/**
 * Every card that could still be in another player's hand: not in `excludeHand` (our own),
 * not already played, and - importantly - not one of the cards this deal evicted from the
 * deck (they're public knowledge and never in anyone's hand). `numPlayersOverride` is for
 * synthetic states that don't carry a full player list yet (the bidding simulation).
 */
function listUnseenCards(state, excludeHand, numPlayersOverride) {
    const seen = new Set();
    (excludeHand || []).forEach(c => seen.add(`${c.value}${c.suit}`));
    if (state.players.length > 0) getTrickMemory(state).played.forEach(code => seen.add(code));
    state.board.forEach(c => seen.add(`${c.value}${c.suit}`));
    const n = numPlayersOverride || (state.players && state.players.length) || 0;
    getEvictedCardSet(n).forEach(code => seen.add(code));
    const pool = [];
    suits.forEach(s => values.forEach(v => {
        if (!seen.has(`${v}${s}`)) pool.push({ value: v, suit: s });
    }));
    return pool;
}

function unseenCardPool(state, excludeHand, numPlayersOverride) {
    const pool = listUnseenCards(state, excludeHand, numPlayersOverride);
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool;
}

// ---------------------------------------------------------------------------------------
// 4. ENDGAME LOOKAHEAD - last few tricks only. A handful of plausible worlds is sampled ONCE
//    (called cards only with seats that could hold them, voids and hand sizes respected) and
//    every legal play is rolled out in the SAME worlds, so the comparison between candidate
//    cards is paired and far less noisy. The objective is winning the bid; points are only a
//    tie-break (or the whole objective when the bid is unknown). Bounded by a time budget.
// ---------------------------------------------------------------------------------------

const ENDGAME_SEARCH_MAX_HAND = 6;
const ENDGAME_SAMPLES = 10;
const ENDGAME_TIME_BUDGET_MS = 1000;

function buildSimFromWorld(state, myId, world, ctx) {
    const me = state.players.find(p => p.id === myId);
    const simPlayers = state.players.map(p => ({
        id: p.id,
        hand: (p.id === myId ? me.hand : world.hands[p.id]).map(c => ({ ...c })),
        wonCards: (p.wonCards || []).map(c => ({ ...c })),
        team: p.team,
        points: sumCardPoints(p.wonCards)
    }));
    const simState = {
        players: simPlayers,
        board: state.board.map(c => ({ ...c })),
        trumpSuit: state.trumpSuit,
        calledCards: [...(state.calledCards || [])],
        turnIndex: state.turnIndex,
        __sim: true
    };
    if (ctx && ctx.bid != null) simState.__bid = ctx.bid;
    seedTrickMemory(simState, state);
    return simState;
}

// Bidder-team / defender points at the end of a finished playout. A seat whose team is still
// unresolved at the end held no called card: it is a defender (we resolve ourselves via myTeam).
function finalPointsByTeam(sim, myId, myTeam) {
    let b = 0, d = 0;
    sim.players.forEach(p => {
        let t = p.team;
        if (t === 'UNKNOWN') t = p.id === myId ? myTeam : 'DEFENDER_TEAM';
        if (t === 'BIDDER_TEAM') b += p.points || 0; else d += p.points || 0;
    });
    return { b, d };
}

function scoreEndgameOutcome(sim, myId, myTeam, bid) {
    const { b, d } = finalPointsByTeam(sim, myId, myTeam);
    const mine = myTeam === 'BIDDER_TEAM' ? b : d;
    if (bid == null) return mine;
    const win = myTeam === 'BIDDER_TEAM' ? b >= bid : b < bid;
    return (win ? 1 : 0) + mine / 1000;
}

function getBestCardToPlayEndgame(playerId, state, legalCards) {
    const ctx = getCtx(playerId, state);
    const bid = AI_FLAGS.endgameBidObjective ? ctx.bid : null;
    const totals = legalCards.map(() => 0);
    const t0 = Date.now();
    let done = 0;

    for (let s = 0; s < ENDGAME_SAMPLES; s++) {
        const world = dealWorld(ctx, state, playerId);
        for (let i = 0; i < legalCards.length; i++) {
            const sim = buildSimFromWorld(state, playerId, world, ctx);
            simPlayCard(sim, playerId, legalCards[i]);
            runPlayout(sim);
            totals[i] += scoreEndgameOutcome(sim, playerId, ctx.myTeam, bid);
        }
        done++;
        if (done >= 3 && Date.now() - t0 > ENDGAME_TIME_BUDGET_MS) break;
    }

    let bestIdx = 0;
    for (let i = 1; i < totals.length; i++) if (totals[i] > totals[bestIdx]) bestIdx = i;
    return legalCards[bestIdx];
}

// ---------------------------------------------------------------------------------------
// 3. BIDDING - simulate a handful of full hands (random-but-legal opponent deals, played out
//    with the same shared heuristic every seat uses) to see how many points this hand
//    realistically converts into as the bidder, rather than trusting one fixed formula. This
//    is what actually fixes hands that look strong on paper (raw high-card count) but don't
//    convert well in practice (e.g. all bunched in one suit that gets trumped early).
// ---------------------------------------------------------------------------------------

const BID_SIM_SAMPLES = 40;      // playouts per bid decision (~2ms each)
const BID_RISK_LAMBDA = 0.60;   // std-devs below the expected score we bid (tuned via self-play sweep)
const BID_MIN_SIGMA = 6;        // floor on the spread so a near-deterministic sim (2p) still gets a margin
const TOTAL_POINTS = 250;

// Random deal of the other seats' hands for a bidding / trump-choice simulation.
function dealOpponentHands(hand, numPlayers) {
    const cardsPerPlayer = Math.min(13, Math.floor(52 / numPlayers));
    if (hand.length > cardsPerPlayer) return null; // inconsistent guess at numPlayers - skip this sample
    const pool = unseenCardPool({ players: [], board: [] }, hand, numPlayers);
    const hands = [];
    let cursor = 0;
    for (let i = 1; i < numPlayers; i++) {
        hands.push(pool.slice(cursor, cursor + cardsPerPlayer));
        cursor += cardsPerPlayer;
    }
    return hands;
}

// Plays a full hand with `choice` ({suit, calls}) as bidder against the given opponent hands and
// returns the bidder team's points.
function playBidderSim(hand, oppHands, choice, bid) {
    const myId = 'sim_me';
    const simPlayers = [{ id: myId, hand: hand.map(c => ({ ...c })), wonCards: [], team: 'BIDDER_TEAM', points: 0 }];
    oppHands.forEach((h, i) => {
        simPlayers.push({ id: 'sim_opp_' + (i + 1), hand: h.map(c => ({ ...c })), wonCards: [], team: 'UNKNOWN', points: 0 });
    });
    const sim = {
        players: simPlayers, board: [], trumpSuit: choice.suit,
        calledCards: [...choice.calls], turnIndex: 0, __sim: true
    };
    if (bid != null) sim.__bid = bid;
    runPlayout(sim);
    let bidderPoints = 0;
    sim.players.forEach(p => { if (p.team === 'BIDDER_TEAM') bidderPoints += p.points; });
    return bidderPoints;
}

function simulateHandAsBidder(hand, numPlayers) {
    const oppHands = dealOpponentHands(hand, numPlayers);
    if (!oppHands) return null;
    const meSim = { hand, team: 'BIDDER_TEAM' };
    const choice = getCpuTrumpChoiceHeuristic(meSim, numPlayers);   // heuristic: no nested simulation
    return playBidderSim(hand, oppHands, choice, null);
}

function getTeamStructure(numPlayers) {
    const cardsPerPlayer = Math.min(13, Math.trunc(52 / numPlayers));
    const calls = Math.floor((numPlayers - 2) / 2);
    const teamSize = 1 + calls;
    return { cardsPerPlayer, calls, teamSize, share: teamSize / numPlayers };
}

/**
 * Plays this hand out `samples` times as the bidder against randomly dealt (evicted-aware)
 * opponents and returns the distribution of bidder-team points. Everything that depends on
 * player count - cards per hand, how many partners get called, who holds what - is baked into
 * the simulation itself, so small / odd tables come out lower and riskier on their own.
 * With 2 players the opponent's hand is fully determined by the public eviction list, so the
 * spread collapses and the estimate becomes (near) exact.
 */
function estimateBidDistribution(hand, numPlayers, samples) {
    const results = [];
    for (let s = 0; s < samples; s++) {
        try {
            const r = simulateHandAsBidder(hand, numPlayers);
            if (r !== null && !isNaN(r)) results.push(r);
        } catch (e) {
            // Skip a bad sample rather than let one failure sink the estimate.
            console.warn('[ai] A bidding simulation sample failed and was skipped:', e);
        }
    }
    if (results.length < Math.min(5, samples)) return null;
    const mean = results.reduce((a, b) => a + b, 0) / results.length;
    const variance = results.reduce((a, b) => a + (b - mean) * (b - mean), 0) / results.length;
    return { mean, sd: Math.sqrt(variance), n: results.length };
}

/**
 * The highest amount this CPU is willing to bid this hand: expected bidder-team points minus
 * a risk margin proportional to how much the outcome swings (more players / more trump and
 * partner luck = bigger swings = lower bids). A result below MIN_BID means "fold" - the bot
 * doesn't think the hand is worth even the minimum bid.
 */
function getCpuMaxBid(hand, numPlayers) {
    if (!numPlayers) numPlayers = Math.max(2, Math.round(52 / Math.max(1, hand.length)));

    let dist = null;
    try {
        dist = estimateBidDistribution(hand, numPlayers, BID_SIM_SAMPLES);
    } catch (e) {
        console.error('[ai] estimateBidDistribution failed; using the share-based estimate.', e);
    }
    let ceiling;
    if (dist) {
        ceiling = dist.mean - BID_RISK_LAMBDA * Math.max(dist.sd, BID_MIN_SIGMA);
    } else {
        ceiling = TOTAL_POINTS * getTeamStructure(numPlayers).share * 0.95;
    }
    ceiling = Math.min(MAX_BID, ceiling);
    return Math.floor(ceiling / 5) * 5;
}

const evictedSetCache = {};
function getEvictedCardSet(numPlayers) {
    if (!numPlayers || typeof EVICTION_ORDER === 'undefined') return new Set();
    if (evictedSetCache[numPlayers]) {
        return evictedSetCache[numPlayers];
    }
    const cardsPerPlayer = Math.min(13, Math.trunc(52 / numPlayers));
    const totalDealt = cardsPerPlayer * numPlayers;
    const toRemove = Math.max(0, 52 - totalDealt);
    const newSet = new Set(EVICTION_ORDER.slice(0, toRemove));
    evictedSetCache[numPlayers] = newSet;
    return newSet;
}

/**
 * Trump suit + partner calls, heuristic version (cheap; used inside the bidding simulations).
 * Trump is whichever suit the hand holds the most (and highest-value) cards of; partner calls
 * prioritise the strongest ranks the bidder does NOT hold, skipping cards this deal doesn't
 * contain - calling a card in your own hand, or one cut from the deck, can never find a teammate.
 */
function trumpSuitRanking(hand) {
    const bySuit = {};
    suits.forEach(s => bySuit[s] = []);
    hand.forEach(c => { if (bySuit[c.suit]) bySuit[c.suit].push(c); });
    const ranked = suits.map(s => {
        const cards = bySuit[s];
        return { suit: s, score: cards.length * 10 + cards.reduce((sum, c) => sum + getCardPoints(c), 0) };
    });
    ranked.sort((a, b) => b.score - a.score);   // stable: ties keep suit order
    return ranked;
}

function scoreCallCard(v, s, trumpSuit) {
    const isTrump = s === trumpSuit;
    const isSpade = s === '♠';
    if (isTrump) {
        if (v === 'A') return 200;
        if (v === 'K') return 180;
        if (v === 'Q') return 160;
        if (v === 'J') return 70;
        if (v === '10') return 65;
        return getCardRank({ value: v }) + 10;
    }
    if (isSpade) {
        if (v === 'A') return 150;
        if (v === 'K') return 130;
        if (v === 'Q') return 110;
        if (v === 'J') return 50;
        if (v === '10') return 45;
        return getCardRank({ value: v });
    }
    if (v === 'A') return 100;
    if (v === 'K') return 80;
    if (v === 'Q') return 60;
    if (v === 'J') return 40;
    if (v === '10') return 35;
    return getCardRank({ value: v });
}

// mode: 'top' (best-scoring cards), 'spread' (at most one call per suit first),
//       'trumpFirst' (the trump suit's top cards first).
function buildCalls(player, numPlayers, trumpSuit, mode) {
    const allowed = Math.floor((numPlayers - 2) / 2);
    if (allowed <= 0) return [];
    const ownSet = new Set(player.hand.map(c => `${c.value}${c.suit}`));
    const evicted = getEvictedCardSet(numPlayers);
    const cands = [];
    suits.forEach(s => values.forEach(v => {
        const code = `${v}${s}`;
        if (ownSet.has(code) || evicted.has(code)) return;
        if (v === '3' && s === '♠') return;
        cands.push({ code, suit: s, score: scoreCallCard(v, s, trumpSuit) });
    }));
    cands.sort((a, b) => b.score - a.score);

    if (mode === 'spread') {
        const picked = [], usedSuits = new Set();
        for (const c of cands) {
            if (picked.length >= allowed) break;
            if (!usedSuits.has(c.suit)) { picked.push(c); usedSuits.add(c.suit); }
        }
        for (const c of cands) {
            if (picked.length >= allowed) break;
            if (!picked.includes(c)) picked.push(c);
        }
        return picked.map(c => c.code);
    }
    if (mode === 'trumpFirst') {
        const ordered = cands.filter(c => c.suit === trumpSuit).concat(cands.filter(c => c.suit !== trumpSuit));
        return ordered.slice(0, allowed).map(c => c.code);
    }
    return cands.slice(0, allowed).map(c => c.code);
}

function getCpuTrumpChoiceHeuristic(player, numPlayers) {
    const ranked = trumpSuitRanking(player.hand);
    const suit = ranked[0].suit;
    return { suit, calls: buildCalls(player, numPlayers, suit, 'top') };
}

const TRUMP_SIM_SAMPLES = 24;
const TRUMP_SIM_TIME_BUDGET_MS = 700;

/**
 * Chooses trump and partner calls by simulation: the top suits crossed with a few call styles
 * are all played out on the SAME random deals (paired), and the option that wins the bid most
 * often (points only as tie-break; plain points when the bid is unknown) is picked. The
 * heuristic choice is the default and is only replaced by a clearly better option.
 */
function chooseTrumpAndCallsBySimulation(player, numPlayers, bid, base) {
    const ranked = trumpSuitRanking(player.hand);
    const combos = [{ suit: base.suit, calls: base.calls }];
    const seen = new Set([base.suit + base.calls.join(',')]);
    ranked.slice(0, 3).forEach(r => {
        ['top', 'spread', 'trumpFirst'].forEach(mode => {
            const choice = { suit: r.suit, calls: buildCalls(player, numPlayers, r.suit, mode) };
            const key = choice.suit + choice.calls.join(',');
            if (!seen.has(key)) { seen.add(key); combos.push(choice); }
        });
    });
    if (combos.length < 2) return base;

    const wins = combos.map(() => 0), pts = combos.map(() => 0);
    const t0 = Date.now();
    let done = 0;
    for (let s = 0; s < TRUMP_SIM_SAMPLES; s++) {
        const oppHands = dealOpponentHands(player.hand, numPlayers);
        if (!oppHands) return base;
        combos.forEach((choice, i) => {
            const p = playBidderSim(player.hand, oppHands, choice, bid);
            pts[i] += p;
            if (bid != null && p >= bid) wins[i]++;
        });
        done++;
        if (done >= 8 && Date.now() - t0 > TRUMP_SIM_TIME_BUDGET_MS) break;
    }
    if (done < 8) return base;

    let best = 0;
    const better = (i, j) => bid != null
        ? (wins[i] > wins[j] || (wins[i] === wins[j] && pts[i] > pts[j]))
        : pts[i] > pts[j];
    for (let i = 1; i < combos.length; i++) if (better(i, best)) best = i;
    if (best === 0) return base;

    // Switch away from the heuristic only on a clear margin (guards against sampling noise).
    const clear = bid != null
        ? (wins[best] - wins[0] >= 2 || (wins[best] === wins[0] && (pts[best] - pts[0]) / done >= 3))
        : (pts[best] - pts[0]) / done >= 2;
    return clear ? combos[best] : base;
}

/**
 * Entry point used by game.js after the bid is won. Pass the winning bid as the third argument
 * (getCpuTrumpChoice(player, numPlayers, bidAmount)); without it the choice is scored on
 * expected points instead of on winning the bid.
 */
function getCpuTrumpChoice(player, numPlayers, bidAmount) {
    const base = getCpuTrumpChoiceHeuristic(player, numPlayers);
    if (!AI_FLAGS.simTrumpChoice) return base;
    try {
        const bid = (typeof bidAmount === 'number' && bidAmount > 0) ? bidAmount : null;
        return chooseTrumpAndCallsBySimulation(player, numPlayers, bid, base) || base;
    } catch (e) {
        console.error('[ai] Simulated trump choice failed; using the heuristic choice.', e);
        return base;
    }
}
