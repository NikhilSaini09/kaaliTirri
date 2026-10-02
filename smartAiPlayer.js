// Fairness rule for every function in this file: a CPU only ever reads its OWN player.hand,
// plus purely public information - state.board, everyone's wonCards, revealed team status,
// and how many cards an opponent has left (a count, never contents). It never reads another
// player's real hand. Where this file needs to reason about opponents' likely cards (the
// endgame lookahead, the bidding estimate), it does so by SAMPLING plausible hands from the
// unseen-card pool - never by peeking at what's actually in anyone's hand.

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

    // Has the table changed underneath us (new deal, loaded save, different players)?
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
 * Hook for game.js: call from evaluateTrick() BEFORE the trick is pushed onto the winner's
 * wonCards. Catches the memory up first, then records this trick in exact order.
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

// Kept for callers that want the plain list of completed tricks, in memory order.
function reconstructTrickHistory(state) {
    return getTrickMemory(state).tricks.map(t => t.cards);
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
    // Logical deduction beats the statistical affinity guess.
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
    const everCalled = (state.originalCalledCards && state.originalCalledCards.length > 0)
        ? state.originalCalledCards
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
//     (assumes the bidder's own team is already marked, as it is in the simulations; switch
//      ENABLE_DEFENDER_INFERENCE off if the live game leaves the bidder as UNKNOWN)
//   - otherwise each card is split evenly over its remaining holders to give a per-player
//     chance of being a partner, which is sharper than one flat prior for every seat.
// Only public facts plus our own hand are read; opponents' hand SIZES, never contents.
// ---------------------------------------------------------------------------------------

const ENABLE_DEFENDER_INFERENCE = true;

function inferTeamBeliefs(playerId, state, voidMapIn) {
    const beliefs = {};
    const me = state.players.find(p => p.id === playerId);
    if (!me) return beliefs;

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
        if (ENABLE_DEFENDER_INFERENCE && !canHoldAny) { beliefs[p.id] = { team: 'DEFENDER_TEAM', pBidder: 0 }; return; }
        beliefs[p.id] = { team: 'UNKNOWN', pBidder: 1 - pNone };
    });
    return beliefs;
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

// P(at least one of K "marked" cards is among h cards drawn from a pool of U).
function probHoldsAny(h, U, K) {
    if (K <= 0 || h <= 0 || U <= 0) return 0;
    if (K >= U || U - K < h) return 1;
    let pNone = 1;
    for (let i = 0; i < h; i++) pNone *= (U - K - i) / (U - i);
    return 1 - pNone;
}

// Chance a given other player is on the OTHER team from `myTeam`.
function makeEnemyProbFn(playerId, state, myTeam, voidMap) {
    const me = state.players.find(p => p.id === playerId);
    const affinity = computeTeamAffinity(state);
    const beliefs = inferTeamBeliefs(playerId, state, voidMap);
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
 * Probability that OUR TEAM ends up taking the current trick if `playerId` plays `card` now.
 * Assumes opponents beat the trick whenever they're able to (deliberately pessimistic).
 */
function estimateTeamTrickProb(playerId, state, card) {
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

    const unseen = listUnseenCards(state, me.hand);
    const voidMap = computeVoidMap(state);
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

function getBestCardToPlay(playerId, state) {
    const player = state.players.find(p => p.id === playerId);
    if (!player || player.hand.length === 0) return null;
    getTrickMemory(state);

    if (player.hand.length <= ENDGAME_SEARCH_MAX_HAND && state.board.length < state.players.length) {
        try {
            const legal = getLegalCards(player, state);
            if (legal.length > 1) {
                const candidates = gateKaaliCandidates(playerId, state, legal);
                if (candidates.length === 1) return candidates[0];
                const choice = getBestCardToPlayEndgame(playerId, state, candidates);
                if (choice) return choice;
            }
        } catch (e) {}
    }

    let choice = getBestCardToPlayInner(playerId, state);
    return choice || player.hand[0];
}

function getBestCardToPlayInner(playerId, state) {
    const player = state.players.find(p => p.id === playerId);
    if (!player || player.hand.length === 0) return null;
    getTrickMemory(state);

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
    const cardsPlayedSoFar = state.board.length + 1; 
    if (cardsPlayedSoFar >= state.players.length) return true;

    const leadSuit = state.board[0].suit;
    const trumpSuit = state.trumpSuit;
    const isWinnerTrump = currentWinnerCard.suit === trumpSuit;
    const winnerRank = getCardRank(currentWinnerCard);

    const playedPlayerIds = new Set(state.board.map(c => c.playedBy));
    const pendingPlayers = state.players.filter(p => !playedPlayerIds.has(p.id));

    for (const opp of pendingPlayers) {
        const oppVoids = voidMap[opp.id] || new Set();
        if (!isWinnerTrump) {
            if (oppVoids.has(leadSuit) && !oppVoids.has(trumpSuit)) return false;
        }
        if (!oppVoids.has(currentWinnerCard.suit) && winnerRank < values.length - 1) {
            return false;
        }
    }
    return true;
}

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

    const voidMap = computeVoidMap(state);

    // 2. CARD COUNTING
    const playedCodes = getTrickMemory(state).played;
    const boardCodes = new Set(state.board.map(cardCode));

    const evictedCodes = getEvictedCardSet(state.players.length);
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

    // 3. DETERMINE TRUE TEAM ALLIANCE (certain, from our own hand vs. the full call list)
    let myTrueTeam = determineMyTeam(playerId, state);

    const beliefs = inferTeamBeliefs(playerId, state, voidMap);

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
            const isTrump = c.suit === state.trumpSuit;
            const winIsTrump = currentWinnerCard.suit === state.trumpSuit;
            
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
            const affinity = computeTeamAffinity(state);
            const effectiveWinnerTeam = guessTeam(currentWinnerId, state, affinity, beliefs);
            if (effectiveWinnerTeam !== 'UNKNOWN' && effectiveWinnerTeam === myTrueTeam) {
                isTeammateWinning = true;
            }
        }
    }

    // --- STRATEGY SCENARIO 1: LEADING THE TRICK ---
    if (state.board.length === 0) {
        const others = state.players.filter(p => p.id !== playerId && p.hand.length > 0);

        const guaranteedSuits = suits.filter(s =>
            s !== state.trumpSuit &&
            others.length > 0 &&
            others.every(p => (voidMap[p.id] || new Set()).has(s)) &&
            validCards.some(c => c.suit === s)
        );
        if (guaranteedSuits.length > 0) {
            const safeCards = validCards.filter(c => guaranteedSuits.includes(c.suit));
            return safeCards.sort((a, b) => {
                if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(a) - getCardPoints(b);
                return getCardRank(a) - getCardRank(b);
            })[0];
        }

        const affinity = computeTeamAffinity(state);
        const enemiesHaveNoTrump = others.every(p => {
            const effectiveTeam = p.team !== 'UNKNOWN' ? p.team : guessTeam(p.id, state, affinity, beliefs);
            if (effectiveTeam === myTrueTeam) return true; // Ignore teammates
            return (voidMap[p.id] || new Set()).has(state.trumpSuit);
        });
        
        // Priority 1: play a Boss card (Guaranteed trick win without wasting trump)
        let thischanceBosses = validCards.filter(c => isBoss(c) && !isPrematureAceLead(c, player, state));
        if (thischanceBosses.length > 0) {
            return thischanceBosses.sort((a,b) => {
                const aIsTrump = a.suit === state.trumpSuit;
                const bIsTrump = b.suit === state.trumpSuit;
                if (aIsTrump !== bIsTrump) {
                    if (enemiesHaveNoTrump) return aIsTrump ? 1 : -1;
                    return aIsTrump ? -1 : 1;
                }
                return getCardPoints(b) - getCardPoints(a);
            })[0];
        }

        // Priority 2: play a card (Guaranteed trick win even sometimes making other loose trumps)
        let highWinCards = [];
        for (let c of validCards) {
            if (isPrematureAceLead(c, player, state)) continue;
            const prob = estimateTeamTrickProb(playerId, state, c);
            if (prob >= 0.82) highWinCards.push(c);
        }
        if (highWinCards.length > 0) {
            return highWinCards.sort((a, b) => {
                if (a.suit === state.trumpSuit && b.suit !== state.trumpSuit) return 1;
                if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(b) - getCardPoints(a);
                return getCardRank(b) - getCardRank(a);
            })[0];
        }

        // Priority 3: Bleed a worthless non-trump card to void a suit safely
        let trash = validCards.filter(c => c.suit !== state.trumpSuit && getCardPoints(c) === 0);
        if (trash.length > 0) {
            return trash.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
        }
        
        // Priority 4: Forced to play trump or point cards; play the lowest rank
        return validCards.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
    }

    // --- STRATEGY SCENARIO 2: MUST FOLLOW SUIT ---
    if (hasLead) {
        if (isTeammateWinning) {
            const isTeammateWinGuaranteed = isTrickWinGuaranteed(state, currentWinnerCard, voidMap);
            const prob = estimateTeamTrickProb(playerId, state, validCards[0]);
            if (isTeammateWinGuaranteed || prob >= KAALI_FEED_PROB) {
                const pointCards = validCards.filter(c => getCardPoints(c) > 0 && !keepForHome(c));
                if (pointCards.length > 0) {
                    return pointCards.sort((a, b) => {
                        if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(b) - getCardPoints(a);
                        return getCardRank(a) - getCardRank(b); 
                    })[0];
                }
            }

            // Duck safely
            const safeDuck = validCards.filter(c => !isKaali(c));
            const pool = safeDuck.length > 0 ? safeDuck : validCards;
            return pool.sort((a, b) => {
                if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(a) - getCardPoints(b);
                return getCardRank(a) - getCardRank(b);
            })[0];
        } else {
            // Enemy/Unknown is winning
            let winningCards = validCards.filter(c => {
                if (currentWinnerCard.suit === state.trumpSuit && leadSuit !== state.trumpSuit) return false;
                return getCardRank(c) > getCardRank(currentWinnerCard);
            });

            if (winningCards.length > 0) {
                let bestProb = -1;
                for (let c of winningCards) {
                    const prob = estimateTeamTrickProb(playerId, state, c);
                    if (prob > bestProb) bestProb = prob;
                }

                // If the chance of holding the trick is good enough, play it
                if (bestProb >= 0.55 || state.board.length + 1 === state.players.length) {
                    const viable = winningCards.filter(c => estimateTeamTrickProb(playerId, state, c) >= bestProb - 0.05);
                    return viable.sort((a, b) => getCardRank(a) - getCardRank(b))[0];
                }
            }
            
            // Winning is too risky or impossible. Dump lowest value trash.
            const nonKaali = validCards.filter(c => !isKaali(c));
            const dumpPool = nonKaali.length > 0 ? nonKaali : validCards;
            return dumpPool.sort((a, b) => {
                if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(a) - getCardPoints(b);
                return getCardRank(a) - getCardRank(b);
            })[0];
        }
    }

    // --- STRATEGY SCENARIO 3: VOID IN LEAD SUIT (Can Trump or Discard) ---
    let trumps = validCards.filter(c => c.suit === state.trumpSuit);
    let nonTrumps = validCards.filter(c => c.suit !== state.trumpSuit);

    if (isTeammateWinning) {
        const isTeammateWinGuaranteed = isTrickWinGuaranteed(state, currentWinnerCard, voidMap);
        const prob = estimateTeamTrickProb(playerId, state, validCards[0]);
        if (isTeammateWinGuaranteed || prob >= KAALI_FEED_PROB) {
            const pointCards = validCards.filter(c => getCardPoints(c) > 0 && !keepForHome(c));
            if (pointCards.length > 0) {
                return pointCards.sort((a, b) => {
                    if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(b) - getCardPoints(a);
                    return getCardRank(a) - getCardRank(b); 
                })[0];
            }
        }

        if (nonTrumps.length > 0 && prob >= 0.60) {
            let safePointsToFeed = nonTrumps.filter(c => getCardPoints(c) > 0 && getCardPoints(c) <= 10 && !keepForHome(c));
            if (safePointsToFeed.length > 0) {
                return safePointsToFeed.sort((a, b) => {
                    if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(b) - getCardPoints(a);
                    return getCardRank(a) - getCardRank(b);
                })[0];
            }

            return nonTrumps.sort((a, b) => getCardPoints(a) - getCardPoints(b))[0];
        }
        
        if (nonTrumps.length > 0) {
            let safeZero = nonTrumps.filter(c => getCardPoints(c) === 0);
            if (safeZero.length > 0) return safeZero.sort((a, b) => getCardRank(a) - getCardRank(b))[0];

            return nonTrumps.sort((a, b) => getCardPoints(a) - getCardPoints(b))[0];
        }
        return trumps.sort((a, b) => getCardRank(a) - getCardRank(b))[0];
    } else {
        // Enemy is winning. Should we trump it?
        let winningTrumps = trumps.filter(c => {
            if (currentWinnerCard.suit === state.trumpSuit) return getCardRank(c) > getCardRank(currentWinnerCard);
            return true;
        });

        if (winningTrumps.length > 0) {
            let bestProb = -1;
            for (let c of winningTrumps) {
                const prob = estimateTeamTrickProb(playerId, state, c);
                if (prob > bestProb) bestProb = prob;
            }

            if (bestProb >= 0.45 || state.board.length + 1 === state.players.length) {
                const viable = winningTrumps.filter(c => estimateTeamTrickProb(playerId, state, c) >= bestProb - 0.05);
                const cheapest = viable.sort((a, b) => getCardRank(a) - getCardRank(b))[0];
                if (trickPoints >= 10 || getCardPoints(cheapest) === 0 || bestProb >= 0.8) {
                    return cheapest;
                }
            }
        }

        // Refuse to waste a high trump on a 0-point trick, or we simply have no trumps. Dump trash.
        if (nonTrumps.length > 0) {
            let zeroPointTrash = nonTrumps.filter(c => getCardPoints(c) === 0);
            if (zeroPointTrash.length > 0) {
                // Dump highest rank 0-point card to clear out high-liability garbage
                return zeroPointTrash.sort((a,b) => getCardRank(b) - getCardRank(a))[0];
            }
            // Forced to dump points. Dump the lowest points possible.
            return nonTrumps.sort((a,b) => getCardPoints(a) - getCardPoints(b))[0];
        }

        // Absolutely forced to play a trump on a lost trick
        return validCards.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
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
// 4. ENDGAME LOOKAHEAD - last few tricks only. For each of our legal plays, sample a few
//    plausible worlds (opponents dealt random-but-void-respecting hands of the right size),
//    play the rest of the hand out with the shared heuristic, and see which of our own
//    choices actually scored best on average. This is a Monte Carlo rollout, not exhaustive
//    minimax - deliberately bounded (small hand sizes, few samples) so it's cheap enough to
//    run on every relevant turn without any risk of hitching the page.
// ---------------------------------------------------------------------------------------

const ENDGAME_SEARCH_MAX_HAND = 6;
const ENDGAME_SAMPLES = 8;

function buildDeterminizedSimState(state, myId, voidMap) {
    const me = state.players.find(p => p.id === myId);
    const pool = unseenCardPool(state, me.hand);

    const simPlayers = state.players.map(p => {
        if (p.id === myId) {
            return {
                id: p.id, hand: me.hand.map(c => ({ ...c })),
                wonCards: (p.wonCards || []).map(c => ({ ...c })), team: p.team, points: p.points || 0
            };
        }
        return {
            id: p.id, hand: [],
            wonCards: (p.wonCards || []).map(c => ({ ...c })), team: p.team, points: p.points || 0
        };
    });

    state.players.forEach(p => {
        if (p.id === myId) return;
        const target = simPlayers.find(sp => sp.id === p.id);
        const need = p.hand.length;
        const voids = voidMap[p.id] || new Set();
        let taken = 0;
        for (let i = 0; i < pool.length && taken < need; i++) {
            if (pool[i] && !voids.has(pool[i].suit)) {
                target.hand.push(pool[i]);
                pool[i] = null;
                taken++;
            }
        }
        if (taken < need) {
            // Voids left too few "safe" cards to fill this sample (can happen with several
            // simultaneous voids) - fall back to whatever's left so the sample stays complete.
            for (let i = 0; i < pool.length && taken < need; i++) {
                if (pool[i]) { target.hand.push(pool[i]); pool[i] = null; taken++; }
            }
        }
    });

    const simState = {
        players: simPlayers,
        board: state.board.map(c => ({ ...c })),
        trumpSuit: state.trumpSuit,
        calledCards: [...(state.calledCards || [])],
        turnIndex: state.turnIndex
    };
    seedTrickMemory(simState, state);
    return simState;
}

function teamPointsIn(sim, myId, myTeam) {
    let total = 0;
    sim.players.forEach(p => {
        const t = p.team !== 'UNKNOWN' ? p.team : (p.id === myId ? myTeam : 'UNKNOWN');
        if (t === myTeam) total += p.points || 0;
    });
    return total;
}

function getBestCardToPlayEndgame(playerId, state, legalCards) {
    const myTeam = determineMyTeam(playerId, state);
    const voidMap = computeVoidMap(state);

    let bestCard = legalCards[0];
    let bestScore = -Infinity;

    legalCards.forEach(candidate => {
        let total = 0;
        let samples = 0;
        for (let s = 0; s < ENDGAME_SAMPLES; s++) {
            const sim = buildDeterminizedSimState(state, playerId, voidMap);
            simPlayCard(sim, playerId, candidate);
            runPlayout(sim);
            total += teamPointsIn(sim, playerId, myTeam);
            samples++;
        }
        const avg = samples > 0 ? total / samples : 0;
        if (avg > bestScore) { bestScore = avg; bestCard = candidate; }
    });

    return bestCard;
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

function simulateHandAsBidder(hand, numPlayers) {
    const cardsPerPlayer = Math.min(13, Math.floor(52 / numPlayers));
    if (hand.length > cardsPerPlayer) return null; // inconsistent guess at numPlayers - skip this sample

    const pool = unseenCardPool({ players: [], board: [] }, hand, numPlayers);
    const myId = 'sim_me';
    const simPlayers = [{ id: myId, hand: hand.map(c => ({ ...c })), wonCards: [], team: 'UNKNOWN', points: 0 }];

    let cursor = 0;
    for (let i = 1; i < numPlayers; i++) {
        simPlayers.push({
            id: 'sim_opp_' + i,
            hand: pool.slice(cursor, cursor + cardsPerPlayer),
            wonCards: [], team: 'UNKNOWN', points: 0
        });
        cursor += cardsPerPlayer;
    }

    const meSim = simPlayers[0];
    meSim.team = 'BIDDER_TEAM';
    const trumpChoice = getCpuTrumpChoice(meSim, numPlayers);

    const sim = {
        players: simPlayers,
        board: [],
        trumpSuit: trumpChoice.suit,
        calledCards: [...trumpChoice.calls],
        turnIndex: 0
    };

    runPlayout(sim);

    let bidderPoints = 0;
    sim.players.forEach(p => { if (p.team === 'BIDDER_TEAM') bidderPoints += p.points; });
    return bidderPoints;
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
        } catch (e) { /* skip a bad sample rather than let one failure sink the estimate */ }
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

    const dist = estimateBidDistribution(hand, numPlayers, BID_SIM_SAMPLES);
    let ceiling;
    if (dist) {
        ceiling = dist.mean - BID_RISK_LAMBDA * Math.max(dist.sd, BID_MIN_SIGMA);
    } else {
        ceiling = TOTAL_POINTS * getTeamStructure(numPlayers).share * 0.95;
    }
    ceiling = Math.min(MAX_BID, ceiling);
    return Math.floor(ceiling / 5) * 5;
}

function getEvictedCardSet(numPlayers) {
    if (!numPlayers || typeof EVICTION_ORDER === 'undefined') return new Set();
    const cardsPerPlayer = Math.min(13, Math.trunc(52 / numPlayers));
    const totalDealt = cardsPerPlayer * numPlayers;
    const toRemove = Math.max(0, 52 - totalDealt);
    return new Set(EVICTION_ORDER.slice(0, toRemove));
}

/**
 * Trump suit + partner calls for a CPU that won the bid. Trump is whichever suit it holds
 * the most (and highest-value) cards of; partner calls prioritize the strongest ranks it
 * does NOT hold itself, spread across suits, skipping any card this deal doesn't even
 * contain - calling a card already in your own hand, or one that was cut from the deck
 * entirely, can never find a teammate.
 */
function getCpuTrumpChoice(player, numPlayers) {
    const bySuit = {};
    suits.forEach(s => bySuit[s] = []);
    player.hand.forEach(c => { if (bySuit[c.suit]) bySuit[c.suit].push(c); });

    let bestSuit = suits[0], bestScore = -1;
    suits.forEach(s => {
        const cards = bySuit[s];
        const score = cards.length * 10 + cards.reduce((sum, c) => sum + getCardPoints(c), 0);
        if (score > bestScore) { bestScore = score; bestSuit = s; }
    });

    const allowedCards = Math.floor((numPlayers - 2) / 2);
    const ownSet = new Set(player.hand.map(c => `${c.value}${c.suit}`));
    const evicted = getEvictedCardSet(numPlayers);
    
    let candidateScores = [];
    suits.forEach(s => {
        values.forEach(v => {
            const code = `${v}${s}`;
            if (ownSet.has(code) || evicted.has(code)) return;
            if (v === '3' && s === '♠') return; 
            
            let score = 0;
            const isTrump = s === bestSuit;
            const isSpade = s === '♠';
            
            if (isTrump) {
                if (v === 'A') score = 200;
                else if (v === 'K') score = 180;
                else if (v === 'Q') score = 160;
                else if (v === 'J') score = 70;
                else if (v === '10') score = 65;
                else score = getCardRank({value: v}) + 10;
            } else if (isSpade) {
                if (v === 'A') score = 150;
                else if (v === 'K') score = 130;
                else if (v === 'Q') score = 110;
                else if (v === 'J') score = 50;
                else if (v === '10') score = 45;
                else score = getCardRank({value: v});
            } else {
                if (v === 'A') score = 100;
                else if (v === 'K') score = 80;
                else if (v === 'Q') score = 60;
                else if (v === 'J') score = 40;
                else if (v === '10') score = 35;
                else score = getCardRank({value: v});
            }
            candidateScores.push({ code, score });
        });
    });

    candidateScores.sort((a, b) => b.score - a.score);
    const calls = candidateScores.slice(0, allowedCards).map(c => c.code);

    return { suit: bestSuit, calls: calls };
}
