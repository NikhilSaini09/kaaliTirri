// Fairness rule for every function in this file: a CPU only ever reads its OWN player.hand,
// plus purely public information - state.board, everyone's wonCards, revealed team status,
// and how many cards an opponent has left (a count, never contents). It never reads another
// player's real hand. Where this file needs to reason about opponents' likely cards (the
// endgame lookahead, the bidding estimate), it does so by SAMPLING plausible hands from the
// unseen-card pool - never by peeking at what's actually in anyone's hand.

function reconstructTrickHistory(state) {
    const numPlayers = state.players.length;
    if (!numPlayers) return [];
    const tricks = [];
    state.players.forEach(p => {
        const won = p.wonCards || [];
        for (let i = 0; i + numPlayers <= won.length; i += numPlayers) {
            tricks.push(won.slice(i, i + numPlayers));
        }
    });
    return tricks;
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
    const voidMap = {};
    state.players.forEach(p => { voidMap[p.id] = new Set(); });

    const markTrick = (trick) => {
        if (!trick || trick.length === 0) return;
        const leadSuit = trick[0].suit;
        for (let i = 1; i < trick.length; i++) {
            const c = trick[i];
            if (c.suit !== leadSuit && c.playedBy && voidMap[c.playedBy]) {
                voidMap[c.playedBy].add(leadSuit);
            }
        }
    };

    reconstructTrickHistory(state).forEach(markTrick);
    markTrick(state.board);
    return voidMap;
}

function computeTeamAffinity(state) {
    const affinity = {};
    state.players.forEach(p => { affinity[p.id] = 0; });
    const teamOf = {};
    state.players.forEach(p => { teamOf[p.id] = p.team; });
    let affinityFactor = 2.4;

    reconstructTrickHistory(state).forEach(trick => {
        const leadSuit = trick[0].suit;
        const winnerCard = resolveTrickWinnerCard(trick, state.trumpSuit);
        if (!winnerCard) return;
        const winnerTeam = teamOf[winnerCard.playedBy];
        if (winnerTeam !== 'BIDDER_TEAM' && winnerTeam !== 'DEFENDER_TEAM') return;
        const sign = winnerTeam === 'BIDDER_TEAM' ? affinityFactor : -affinityFactor;
        affinityFactor -= 0.15;

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
function guessTeam(playerId, state, affinity) {
    const p = state.players.find(pl => pl.id === playerId);
    if (!p) return 'UNKNOWN';
    if (p.team !== 'UNKNOWN') return p.team;
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
// KAALI TIRRI (3♠, 30 pts) GATE
// The 3♠ is worth 30 points, so it is only ever played voluntarily when our team is very
// likely to take the trick it lands in (or it's forced). estimateTeamTrickProb() is a cheap
// analytic estimate built ONLY from our own hand + public information (cards already played,
// the evicted set, void map, opponents' hand SIZES, revealed/guessed teams). It is cheap
// enough to also run inside the bidding / endgame rollouts.
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
function makeEnemyProbFn(playerId, state, myTeam) {
    const me = state.players.find(p => p.id === playerId);
    const affinity = computeTeamAffinity(state);
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
        const g = guessTeam(r.id, state, affinity);
        if (g !== 'UNKNOWN') return g === myTeam ? 0.15 : 0.85;
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
    const enemyProb = makeEnemyProbFn(playerId, state, myTeam);

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

    const legal = getLegalCards(player, state);
    if (legal.length === 1) return legal[0];

    const candidates = gateKaaliCandidates(playerId, state, legal);
    if (candidates.length === 1) return candidates[0];

    const excludeKaali = legal.some(isKaali) && !candidates.some(isKaali);
    return chooseCardHeuristic(playerId, state, excludeKaali);
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

    // 2. REBUILD MEMORY (Card Counting)
    const playedCards = [];
    state.players.forEach(p => {
        if (p.wonCards) playedCards.push(...p.wonCards);
    });
    playedCards.push(...state.board);

    const evictedCodes = getEvictedCardSet(state.players.length);
    const isBoss = (card) => {
        const rankIdx = getCardRank(card);
        for (let r = rankIdx + 1; r < values.length; r++) {
            const higherVal = values[r];
            const isPlayed = evictedCodes.has(`${higherVal}${card.suit}`) ||
                playedCards.some(pc => pc.value === higherVal && pc.suit === card.suit);
            const inHand = player.hand.some(hc => hc.value === higherVal && hc.suit === card.suit);
            if (!isPlayed && !inHand) return false; // Someone else still holds a higher card
        }
        return true;
    };

    // 3. DETERMINE TRUE TEAM ALLIANCE (certain, from our own hand vs. the full call list)
    let myTrueTeam = determineMyTeam(playerId, state);

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
            const effectiveWinnerTeam = guessTeam(currentWinnerId, state, affinity);
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
            return safeCards.sort((a, b) => getCardRank(a) - getCardRank(b))[0];
        }

        // Priority 1: play a non-trump Boss card (Guaranteed trick win without wasting trump)
        let nonTrumpBosses = validCards.filter(c => c.suit !== state.trumpSuit && isBoss(c));
        if (nonTrumpBosses.length > 0) {
            return nonTrumpBosses.sort((a,b) => getCardPoints(b) - getCardPoints(a))[0];
        }

        // Priority 2: Bleed a worthless non-trump card to void a suit safely
        let trash = validCards.filter(c => c.suit !== state.trumpSuit && getCardPoints(c) === 0);
        if (trash.length > 0) {
            return trash.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
        }
        
        // Priority 3: Forced to play trump or point cards; play the lowest rank
        return validCards.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
    }

    // --- STRATEGY SCENARIO 2: MUST FOLLOW SUIT ---
    if (hasLead) {
        let winningCards = validCards.filter(c => {
            if (currentWinnerCard.suit === state.trumpSuit && leadSuit !== state.trumpSuit) return false;
            return getCardRank(c) > getCardRank(currentWinnerCard);
        });

        if (isTeammateWinning) {
            // Teammate has it. Duck safely by playing the lowest card.
            return validCards.sort((a,b) => {
                if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(a) - getCardPoints(b);
                return getCardRank(a) - getCardRank(b);
            })[0];
        } else {
            // Enemy/Unknown is winning.
            if (winningCards.length > 0) {
                // Try to beat them as cheaply as possible
                return winningCards.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
            } else {
                // Cannot win. Dump lowest value trash.
                return validCards.sort((a,b) => {
                    if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(a) - getCardPoints(b);
                    return getCardRank(a) - getCardRank(b);
                })[0];
            }
        }
    }

    // --- STRATEGY SCENARIO 3: VOID IN LEAD SUIT (Can Trump or Discard) ---
    let trumps = validCards.filter(c => c.suit === state.trumpSuit);
    let nonTrumps = validCards.filter(c => c.suit !== state.trumpSuit);

    if (isTeammateWinning) {
        // Teammate is winning! Feed them points (up to 10pts, keep 30pt Kaali Tirri safe just in case).
        if (nonTrumps.length > 0) {
            let safePointsToFeed = nonTrumps.filter(c => getCardPoints(c) <= 10);
            if (safePointsToFeed.length > 0) return safePointsToFeed.sort((a,b) => getCardPoints(b) - getCardPoints(a))[0];
            return nonTrumps.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
        }
        // Forced to trump a trick our team is already winning. Play lowest trump.
        return trumps.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
    } else {
        // Enemy is winning. Should we trump it?
        let winningTrumps = trumps.filter(c => {
            if (currentWinnerCard.suit === state.trumpSuit) return getCardRank(c) > getCardRank(currentWinnerCard);
            return true;
        });

        if (winningTrumps.length > 0) {
            // Trump if the trick is juicy (>= 10 points) OR if we have a cheap 0-point trump to spare
            if (trickPoints >= 10 || getCardPoints(winningTrumps[0]) === 0) {
                return winningTrumps.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
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
    state.players.forEach(p => (p.wonCards || []).forEach(c => seen.add(`${c.value}${c.suit}`)));
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

const ENDGAME_SEARCH_MAX_HAND = 3;
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
        const need = p.hand.length; // only ever the count - never real contents
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

    return {
        players: simPlayers,
        board: state.board.map(c => ({ ...c })),
        trumpSuit: state.trumpSuit,
        calledCards: [...(state.calledCards || [])],
        turnIndex: state.turnIndex
    };
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
const BID_RISK_LAMBDA = 0.75;   // std-devs below the expected score we bid (tuned via self-play sweep)
const BID_MIN_SIGMA = 8;        // floor on the spread so a near-deterministic sim (2p) still gets a margin
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

/**
 * Team structure that follows directly from the game rules (no per-player-count tables):
 * the bid winner may call floor((n-2)/2) partner cards, so the bidder's side is 1 + calls
 * players out of n. Odd counts leave the defenders a player (or more) up.
 */
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
        // Simulation unavailable: fall back to the bidder side's plain share of the points.
        ceiling = TOTAL_POINTS * getTeamStructure(numPlayers).share * 0.9;
    }
    ceiling = Math.min(MAX_BID, ceiling);
    return Math.floor(ceiling / 5) * 5;
}

/**
 * Which exact cards this deal cut from the deck (when 52 doesn't divide evenly across
 * `numPlayers`, startDeal() trims a deterministic set down to size). This is public info -
 * anyone applying the same formula from the same player count gets the same answer - so
 * using it isn't peeking at anything hidden, and it's essential: calling a partner card that
 * was cut from this deal entirely can never find a teammate.
 */
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
    const calls = [];
    const priorityValues = ['A', 'K', 'Q', 'J', '10'];
    outer:
    for (const v of priorityValues) {
        for (const s of suits) {
            if (calls.length >= allowedCards) break outer;
            const code = `${v}${s}`;
            if (evicted.has(code)) continue; // doesn't exist in this deal at all
            if (!ownSet.has(code) && calls.indexOf(code) === -1) calls.push(code);
        }
    }
    // Extremely unlikely (would need most of A/K/Q/J/10 across all suits owned or evicted),
    // but fall back to the full rank list rather than ever call fewer cards than allowed.
    if (calls.length < allowedCards) {
        outerFallback:
        for (let i = values.length - 1; i >= 0; i--) {
            for (const s of suits) {
                if (calls.length >= allowedCards) break outerFallback;
                const code = `${values[i]}${s}`;
                if (evicted.has(code) || ownSet.has(code) || calls.indexOf(code) !== -1) continue;
                calls.push(code);
            }
        }
    }
    return { suit: bestSuit, calls: calls };
}